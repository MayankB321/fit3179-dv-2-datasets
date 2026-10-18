
import { csvParse, csvFormat } from "d3-dsv";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ATHLETES_URL =
  "https://raw.githubusercontent.com/rgriff23/Olympic_history/master/data/athlete_events.csv";

const NOC_URL =
  "https://raw.githubusercontent.com/rgriff23/Olympic_history/master/data/noc_regions.csv";

const AGE_GROUPS = [
  "Under20",
  "Age20_24",
  "Age25_29",
  "Age30Plus"
];

function getAgeGroup(age) {
  if (age < 20) return "Under20";
  if (age < 25) return "Age20_24";
  if (age < 30) return "Age25_29";
  return "Age30Plus";
}

async function getCountryMedalRates() {
  console.log("Downloading Olympic datasets...");

  const [athleteResponse, nocResponse] = await Promise.all([
    fetch(ATHLETES_URL),
    fetch(NOC_URL)
  ]);

  if (!athleteResponse.ok) {
    throw new Error(
      `Failed to download athlete dataset: HTTP ${athleteResponse.status}`
    );
  }

  if (!nocResponse.ok) {
    throw new Error(
      `Failed to download NOC dataset: HTTP ${nocResponse.status}`
    );
  }

  const [athleteText, nocText] = await Promise.all([
    athleteResponse.text(),
    nocResponse.text()
  ]);

  const athletes = csvParse(athleteText);
  const nocRows = csvParse(nocText);

  console.log(`Loaded ${athletes.length} athlete-event records.`);
  console.log(`Loaded ${nocRows.length} NOC mappings.`);

  // Map each Olympic NOC code to its country/region.
  const countryByNoc = new Map(
    nocRows.map(row => [row.NOC, row.region])
  );

  // Accumulate total entries and medal-winning entries.
  const totals = new Map();

  for (const athlete of athletes) {
    const age = Number(athlete.Age);
    const country = countryByNoc.get(athlete.NOC);

    // Ignore missing or invalid ages and unknown country mappings.
    if (athlete.Age === "" || !Number.isFinite(age)) continue;
    if (age < 0 || age > 100 || !country) continue;

    const ageGroup = getAgeGroup(age);
    const key = `${country}|${ageGroup}`;

    if (!totals.has(key)) {
      totals.set(key, {
        Country: country,
        AgeGroup: ageGroup,
        Entries: 0,
        Medals: 0
      });
    }

    const record = totals.get(key);
    record.Entries++;

    // Count Gold, Silver, and Bronze as medal-winning entries.
    if (
      athlete.Medal &&
      athlete.Medal !== "NA" &&
      athlete.Medal !== ""
    ) {
      record.Medals++;
    }
  }

  // Convert rates to one row per country.
  const countries = new Map();

  for (const record of totals.values()) {
    if (!countries.has(record.Country)) {
      countries.set(record.Country, {
        Country: record.Country
      });
    }

    countries.get(record.Country)[record.AgeGroup] =
      record.Medals / record.Entries;
  }

  const result = Array.from(countries.values()).map(country => {
    for (const group of AGE_GROUPS) {
      if (!(group in country)) {
        country[group] = null;
      }
    }

    return country;
  });

  // Sort countries alphabetically for easier inspection.
  result.sort((a, b) => a.Country.localeCompare(b.Country));

  // Format as CSV.
  const csv = csvFormat(result, [
    "Country",
    ...AGE_GROUPS
  ]);

  // Resolve ../datasets relative to this script.
  const currentFile = fileURLToPath(import.meta.url);
  const currentDirectory = path.dirname(currentFile);
  const outputDirectory = path.resolve(
    currentDirectory,
    "../datasets"
  );

  await mkdir(outputDirectory, { recursive: true });

  const outputPath = path.join(
    outputDirectory,
    "country_medal_rates.csv"
  );

  await writeFile(outputPath, csv, "utf8");

  console.log(`Processed ${result.length} countries.`);
  console.log(`CSV successfully saved to:\n${outputPath}`);
}

getCountryMedalRates().catch(error => {
  console.error("Failed to generate country medal rates:", error);
  process.exitCode = 1;
});
