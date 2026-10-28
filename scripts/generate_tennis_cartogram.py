#!/usr/bin/env python3
"""Generate a non-contiguous ATP player-count cartogram GeoJSON.

Run from your repository root:
    python3 generate_tennis_cartogram.py

Input:
    datasets/Tennis/tennis_players_by_country.csv

Output:
    datasets/Tennis/tennis_players_cartogram.geojson

Dependencies:
    python3 -m pip install pandas requests shapely pyproj
"""
from pathlib import Path
import json
import sys

import pandas as pd
import requests
from pyproj import Transformer
from shapely.geometry import shape, mapping, Point, Polygon, MultiPolygon, GeometryCollection
from shapely.affinity import scale as scale_geometry
from shapely.ops import transform as transform_geometry
try:
    from shapely import make_valid
except ImportError:  # Compatibility with older Shapely releases
    make_valid = None

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "datasets" / "Tennis" / "tennis_players_by_country.csv"
OUT_PATH = ROOT / "datasets" / "Tennis" / "tennis_players_cartogram.geojson"
WORLD_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
    "master/geojson/ne_110m_admin_0_countries.geojson"
)

# Mollweide is an equal-area projection, so polygon areas can be compared.
TO_EQUAL_AREA = Transformer.from_crs("EPSG:4326", "ESRI:54009", always_xy=True).transform
TO_LONLAT = Transformer.from_crs("ESRI:54009", "EPSG:4326", always_xy=True).transform

# Mollweide's valid world extent is approximately an ellipse. Enlarged country
# polygons can extend beyond the projection domain; inverse-projecting those
# coordinates can yield Infinity, which is illegal in GeoJSON. Clip slightly
# inside the ellipse before converting back to longitude/latitude.
WORLD_CLIP = scale_geometry(
    Point(0, 0).buffer(1, quad_segs=256),
    xfact=18000000, yfact=8990000, origin=(0, 0)
)


def repair_polygonal(geom):
    """Repair invalid geometry and keep only polygonal components."""
    if geom is None or geom.is_empty:
        return Polygon()
    if not geom.is_valid:
        if make_valid is not None:
            geom = make_valid(geom)
        else:
            # buffer(0) is a practical fallback for older Shapely versions.
            geom = geom.buffer(0)

    if isinstance(geom, (Polygon, MultiPolygon)):
        return geom
    if isinstance(geom, GeometryCollection):
        polygons = []
        for part in geom.geoms:
            if isinstance(part, Polygon) and not part.is_empty:
                polygons.append(part)
            elif isinstance(part, MultiPolygon):
                polygons.extend(p for p in part.geoms if not p.is_empty)
        if not polygons:
            return Polygon()
        from shapely.ops import unary_union
        merged = unary_union(polygons)
        if not merged.is_valid:
            merged = make_valid(merged) if make_valid is not None else merged.buffer(0)
        return merged
    return Polygon()


def get_iso3(properties):
    for key in ("ADM0_A3", "ISO_A3", "SOV_A3", "GU_A3"):
        value = properties.get(key)
        if value and value != "-99":
            return str(value).upper()
    return None


def main():
    if not CSV_PATH.exists():
        sys.exit(f"CSV not found: {CSV_PATH}\nRun this script from your repository root, or move it there.")

    df = pd.read_csv(CSV_PATH)
    required = {"country_code", "player_count", "avg_win_rate", "avg_age"}
    missing = required - set(df.columns)
    if missing:
        sys.exit(f"CSV is missing required columns: {', '.join(sorted(missing))}")

    df["country_code"] = df["country_code"].astype(str).str.upper().str.strip()
    df = df.drop_duplicates("country_code", keep="first")
    counts = {row.country_code: float(row.player_count) for row in df.itertuples()}
    rows = {row.country_code: row._asdict() for row in df.itertuples(index=False)}

    print("Downloading Natural Earth country boundaries...")
    response = requests.get(WORLD_URL, timeout=60)
    response.raise_for_status()
    world = response.json()

    # Only include countries represented in the player dataset. Their final
    # polygon areas are proportional to player_count; total area is preserved.
    matched = []
    for feature in world.get("features", []):
        iso3 = get_iso3(feature.get("properties", {}))
        if iso3 not in counts or counts[iso3] <= 0:
            continue
        # Repair Natural Earth polygons before projection; projection and
        # later intersections are much more reliable with valid input geometry.
        geom = repair_polygonal(shape(feature["geometry"]))
        if geom.is_empty:
            continue
        geom = repair_polygonal(transform_geometry(TO_EQUAL_AREA, geom))
        if geom.is_empty or not geom.is_valid or geom.area <= 0:
            continue
        matched.append((iso3, geom, feature.get("properties", {})))

    matched_codes = {item[0] for item in matched}
    missing_codes = sorted(set(counts) - matched_codes)
    if not matched:
        sys.exit("No country codes matched the Natural Earth ISO-3 country codes.")

    total_area = sum(geom.area for _, geom, _ in matched)
    total_players = sum(counts[code] for code, _, _ in matched)
    target_area_per_player = total_area / total_players

    features = []
    for code, geom, original_props in matched:
        target_area = counts[code] * target_area_per_player
        factor = (target_area / geom.area) ** 0.5
        centroid = geom.centroid
        resized = repair_polygonal(
            scale_geometry(geom, xfact=factor, yfact=factor, origin=centroid)
        )
        # Repair both operands before intersection to avoid GEOS topology errors.
        clip = repair_polygonal(WORLD_CLIP)
        try:
            resized = repair_polygonal(resized.intersection(clip))
        except Exception as exc:
            # A final zero-width buffer can resolve occasional GEOS side-location
            # conflicts caused by tiny boundary defects in source polygons.
            print(f"Retrying intersection for {code} after geometry repair: {exc}")
            resized = repair_polygonal(resized.buffer(0).intersection(clip.buffer(0)))
        if resized.is_empty:
            print(f"Skipping {code}: geometry fell outside projection bounds")
            continue
        resized_lonlat = transform_geometry(TO_LONLAT, resized)
        # Projection edge cases must never leak non-finite coordinates into JSON.
        if not resized_lonlat.is_valid:
            resized_lonlat = repair_polygonal(resized_lonlat)
        row = rows[code]
        props = {
            "country_code": code,
            "country_name": original_props.get("ADMIN") or original_props.get("NAME") or code,
            "player_count": int(float(row["player_count"])),
            "avg_win_rate": float(row["avg_win_rate"]),
            "avg_age": float(row["avg_age"]),
            "area_scale_factor": round(factor, 5),
        }
        features.append({"type": "Feature", "properties": props, "geometry": mapping(resized_lonlat)})

    output = {"type": "FeatureCollection", "name": "tennis_players_cartogram", "features": features}
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(output, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(f"Wrote {len(features)} countries to: {OUT_PATH}")
    print("Country polygon area is now proportional to ATP player_count.")
    if missing_codes:
        print("Codes not matched to Natural Earth and therefore omitted:", ", ".join(missing_codes))


if __name__ == "__main__":
    main()
