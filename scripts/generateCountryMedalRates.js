import { csvParse, csvFormat } from "d3-dsv";
import { geoCentroid, geoArea } from "d3-geo";
import { feature } from "topojson-client";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Source datasets
// ---------------------------------------------------------------------------
const ATHLETES_URL =
  "https://raw.githubusercontent.com/rgriff23/Olympic_history/master/data/athlete_events.csv";

const NOC_URL =
  "https://raw.githubusercontent.com/rgriff23/Olympic_history/master/data/noc_regions.csv";

// 50m includes many small Olympic nations (Singapore, Malta, Bahrain, ...)
// that the 110m file leaves out. Country names are in properties.name.
const WORLD_URL =
  "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json";

const AGE_GROUPS = ["Under20", "Age20_24", "Age25_29", "Age30Plus"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Normalise names so punctuation, accents and capitalisation
// differences don't prevent a match.
function normaliseName(name) {
  return String(name ?? "")
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

function getAgeGroup(age) {
  if (age < 20) return "Under20";
  if (age < 25) return "Age20_24";
  if (age < 30) return "Age25_29";
  return "Age30Plus";
}

// Olympic (noc_regions.csv) name -> list of possible map names.
// The first candidate that exists in the map file is used, so this works
// across different Natural Earth versions of world-atlas.
const ALIASES = {
  "USA": ["United States of America"],
  "UK": ["United Kingdom"],
  "Boliva": ["Bolivia"], // typo in the source dataset
  "Czech Republic": ["Czechia", "Czech Rep."],
  "Ivory Coast": ["Côte d'Ivoire", "Ivory Coast"],
  "Macedonia": ["North Macedonia", "Macedonia"],
  "Swaziland": ["eSwatini", "Eswatini", "Swaziland"],
  "Cape Verde": ["Cabo Verde", "Cape Verde"],
  "Republic of Congo": ["Congo", "Republic of the Congo"],
  "Democratic Republic of the Congo": ["Dem. Rep. Congo", "Democratic Republic of the Congo"],
  "Dominican Republic": ["Dominican Rep."],
  "Bosnia and Herzegovina": ["Bosnia and Herz."],
  "South Sudan": ["S. Sudan"],
  "Central African Republic": ["Central African Rep."],
  "Equatorial Guinea": ["Eq. Guinea"],
  "Solomon Islands": ["Solomon Is."],
  "Marshall Islands": ["Marshall Is."],
  "Cook Islands": ["Cook Is."],
  "Cayman Islands": ["Cayman Is."],
  "Trinidad": ["Trinidad and Tobago"],
  "Antigua": ["Antigua and Barb.", "Antigua and Barbuda"],
  "Saint Kitts": ["St. Kitts and Nevis", "Saint Kitts and Nevis"],
  "Saint Vincent": ["St. Vin. and Gren.", "Saint Vincent and the Grenadines"],
  "Sao Tome and Principe": ["São Tomé and Principe", "São Tomé and Príncipe"],
  "Virgin Islands, US": ["U.S. Virgin Is.", "United States Virgin Islands"],
  "Virgin Islands, British": ["British Virgin Is.", "British Virgin Islands"],
  "Micronesia": ["Micronesia", "Federated States of Micronesia"]
};

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} downloading ${url}`);
  }
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} downloading ${url}`);
  }
  return response.json();
}

// For multi-part countries (USA, France, Russia, ...), use the centroid of
// the largest polygon so overseas territories don't drag the point away.
function getCentroid(country) {
  const geometry = country.geometry;

  if (geometry?.type === "MultiPolygon") {
    let largest = null;
    let largestArea = -1;

    for (const coordinates of geometry.coordinates) {
      const polygon = { type: "Polygon", coordinates };
      const area = geoArea(polygon);
      if (area > largestArea) {
        largestArea = area;
        largest = polygon;
      }
    }

    if (largest) return geoCentroid(largest);
  }

  return geoCentroid(country);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("Downloading Olympic and geographic datasets...");

  const [athleteText, nocText, world] = await Promise.all([
    fetchText(ATHLETES_URL),
    fetchText(NOC_URL),
    fetchJson(WORLD_URL)
  ]);

  const athletes = csvParse(athleteText);
  const nocRows = csvParse(nocText);

  console.log(`Loaded ${athletes.length} athlete-event rows.`);
  console.log(`Loaded ${nocRows.length} NOC mappings.`);

  if (athletes.length === 0 || nocRows.length === 0) {
    throw new Error(
      "A source CSV contains no data. Check the source URLs and file headers."
    );
  }

  // NOC code -> Olympic dataset country name.
  const countryByNoc = new Map(
    nocRows
      .map(row => [row.NOC?.trim(), row.region?.trim()])
      .filter(([noc, country]) => noc && country)
  );

  // Map features: names come from properties.name in the TopoJSON.
  const geoCountries = feature(world, world.objects.countries).features;

  const canonicalNameByKey = new Map(); // normalised name -> map name
  const coordinates = new Map(); //          map name -> {longitude, latitude}

  for (const country of geoCountries) {
    const name = country.properties?.name;
    if (!name) continue;

    canonicalNameByKey.set(normaliseName(name), name);

    const [longitude, latitude] = getCentroid(country);
    if (Number.isFinite(longitude) && Number.isFinite(latitude)) {
      coordinates.set(name, { longitude, latitude });
    }
  }

  console.log(`Built ${coordinates.size} country/territory coordinates.`);

  if (coordinates.size === 0) {
    throw new Error(
      "No geographic coordinates were created. Check that the TopoJSON features have properties.name."
    );
  }

  // Resolve aliases against the names actually present in the map file.
  const aliasLookup = new Map();
  const unresolvedAliases = [];

  for (const [sourceName, targets] of Object.entries(ALIASES)) {
    const actual = targets
      .map(target => canonicalNameByKey.get(normaliseName(target)))
      .find(Boolean);

    if (actual) {
      aliasLookup.set(normaliseName(sourceName), actual);
    } else {
      unresolvedAliases.push(sourceName);
    }
  }

  // Count athlete-event appearances by country and age group.
  // These are appearances, not unique individual athletes.
  const counts = new Map();
  const unmatchedCountries = new Set();
  let processedRows = 0;
  let skippedMissingAge = 0;
  let skippedMissingNoc = 0;
  let skippedUnmatched = 0;

  for (const athlete of athletes) {
    const ageText = athlete.Age?.trim();
    const age = Number(ageText);

    if (!ageText || ageText === "NA" || !Number.isFinite(age) || age < 0 || age > 100) {
      skippedMissingAge++;
      continue;
    }

    const sourceCountry = countryByNoc.get(athlete.NOC?.trim());

    if (!sourceCountry) {
      skippedMissingNoc++;
      continue;
    }

    const key = normaliseName(sourceCountry);
    const country = aliasLookup.get(key) ?? canonicalNameByKey.get(key);

    if (!country || !coordinates.has(country)) {
      unmatchedCountries.add(sourceCountry);
      skippedUnmatched++;
      continue;
    }

    if (!counts.has(country)) {
      counts.set(country, {
        Country: country,
        Under20: 0,
        Age20_24: 0,
        Age25_29: 0,
        Age30Plus: 0
      });
    }

    counts.get(country)[getAgeGroup(age)]++;
    processedRows++;
  }

  if (counts.size === 0) {
    console.error("No countries matched.");
    console.error(
      "Example map names:",
      [...canonicalNameByKey.values()].slice(0, 15)
    );
    console.error(
      "Example Olympic names:",
      [...new Set(countryByNoc.values())].slice(0, 15)
    );
    throw new Error("Zero countries were matched. Review the names above.");
  }

  // Add coordinates and sort by country name.
  const output = [...counts.values()]
    .map(record => {
      const location = coordinates.get(record.Country);
      return {
        Country: record.Country,
        longitude: Number(location.longitude.toFixed(5)),
        latitude: Number(location.latitude.toFixed(5)),
        ...Object.fromEntries(AGE_GROUPS.map(g => [g, record[g]]))
      };
    })
    .sort((a, b) => a.Country.localeCompare(b.Country));

  // Write CSV to ../datasets relative to this script.
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const outputDirectory = path.resolve(scriptDirectory, "../datasets");
  await mkdir(outputDirectory, { recursive: true });

  const outputPath = path.join(outputDirectory, "country_athlete_counts.csv");
  const csv = csvFormat(output, ["Country", "longitude", "latitude", ...AGE_GROUPS]);
  await writeFile(outputPath, csv, "utf8");

  console.log("\nGeneration complete.");
  console.log(`Countries matched: ${output.length}`);
  console.log(`Athlete-event rows counted: ${processedRows}`);
  console.log(`Rows skipped (missing/invalid age): ${skippedMissingAge}`);
  console.log(`Rows skipped (no NOC mapping): ${skippedMissingNoc}`);
  console.log(`Rows skipped (no map match): ${skippedUnmatched}`);
  console.log(`CSV saved to: ${outputPath}`);

  if (unresolvedAliases.length > 0) {
    console.log(
      `\nAliases with no matching map name (harmless if the country isn't in the map): ${unresolvedAliases.join(", ")}`
    );
  }

  if (unmatchedCountries.size > 0) {
    console.log(`\nUnmatched country names (${unmatchedCountries.size}):`);
    console.log([...unmatchedCountries].sort().join(", "));
  } else {
    console.log("All source country names were matched.");
  }
}

main().catch(error => {
  console.error("\nFailed to generate country athlete counts:");
  console.error(error);
  process.exitCode = 1;
});