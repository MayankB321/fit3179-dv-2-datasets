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
from shapely.geometry import shape, mapping
from shapely.affinity import scale as scale_geometry
from shapely.ops import transform as transform_geometry

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
        geom = transform_geometry(TO_EQUAL_AREA, shape(feature["geometry"]))
        if geom.is_empty or geom.area <= 0:
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
        resized = scale_geometry(geom, xfact=factor, yfact=factor, origin=centroid)
        resized_lonlat = transform_geometry(TO_LONLAT, resized)
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
    OUT_PATH.write_text(json.dumps(output, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(features)} countries to: {OUT_PATH}")
    print("Country polygon area is now proportional to ATP player_count.")
    if missing_codes:
        print("Codes not matched to Natural Earth and therefore omitted:", ", ".join(missing_codes))


if __name__ == "__main__":
    main()
