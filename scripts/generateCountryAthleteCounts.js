
import { csvParse, csvFormat } from "d3-dsv";
import { geoCentroid } from "d3-geo";
import { feature } from "topojson-client";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ATHLETES_URL =
  "https://raw.githubusercontent.com/rgriff23/Olympic_history/master/data/athlete_events.csv";

const NOC_URL =
  "https://raw.githubusercontent.com/rgriff23/Olympic_history/master/data/noc_regions.csv";

const WORLD_URL =
  "https://cdn.jsdelivr.net/npm/vega-datasets@3/data/world-110m.json";

const GROUPS = ["Under20", "Age20_24", "Age25_29", "Age30Plus"];

function ageGroup(age) {
  if (age < 20) return "Under20";
  if (age < 25) return "Age20_24";
  if (age < 30) return "Age25_29";
  return "Age30Plus";
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${url}`);
  return response;
}

async function main() {
  const [athleteRes, nocRes, worldRes] = await Promise.all([
    download(ATHLETES_URL),
    download(NOC_URL),
    download(WORLD_URL)
  ]);

  const [athleteText, nocText, world] = await Promise.all([
    athleteRes.text(),
    nocRes.text(),
    worldRes.json()
  ]);

  const athletes = csvParse(athleteText);
  const nocRows = csvParse(nocText);
  const countryByNoc = new Map(
    nocRows.map(row => [row.NOC, row.region])
  );

  const countries = feature(
    world,
    world.objects.countries
  ).features;

  const coordinates = new Map();

  for (const country of countries) {
    const name = country.properties.name;
    const [longitude, latitude] = geoCentroid(country);
    coordinates.set(name, { longitude, latitude });
  }

  // Count athlete-event appearances by country and age group.
  const counts = new Map();

  for (const athlete of athletes) {
    const age = Number(athlete.Age);
    if (athlete.Age === "" || !Number.isFinite(age) ||
        age < 0 || age > 100) continue;

    const country = countryByNoc.get(athlete.NOC);
    if (!country || !coordinates.has(country)) continue;

    const group = ageGroup(age);

    if (!counts.has(country)) {
      counts.set(country, {
        Country: country,
        ...Object.fromEntries(GROUPS.map(g => [g, 0]))
      });
    }

    counts.get(country)[group]++;
  }

  const output = [];

  for (const record of counts.values()) {
    const coord = coordinates.get(record.Country);
    output.push({
      Country: record.Country,
      longitude: coord.longitude,
      latitude: coord.latitude,
      ...Object.fromEntries(
        GROUPS.map(g => [g, record[g]])
      )
    });
  }

  output.sort((a, b) => a.Country.localeCompare(b.Country));

  const csv = csvFormat(output, [
    "Country", "longitude", "latitude", ...GROUPS
  ]);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(here, "../datasets");
  await mkdir(outDir, { recursive: true });

  const outPath = path.join(outDir, "country_athlete_counts.csv");
  await writeFile(outPath, csv, "utf8");

  console.log(`Saved ${output.length} countries to ${outPath}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
