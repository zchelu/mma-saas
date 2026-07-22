#!/usr/bin/env node
// DEV/TEST-ONLY. Do not run against production.
//
// Seeds a handful of fake members into a test/dev gym that look like what a
// real Tier 1 CSV import produced BEFORE discipline/stripes existed: each row
// has beltRank + plan (like every row scripts/import-members.js has always
// written), but no discipline field, so adminImportBatch skips inserting a
// `ranks` row for it — same as every member imported before the ranks table
// existed. Gives the upcoming backfill migration (which has to infer
// discipline from plan text) real, varied data to run against:
//
//   - beltRank + a plan that maps cleanly to a discipline (e.g. "BJJ
//     Fundamentals" -> bjj_adult, same keyword matching as
//     scripts/import-members.js's detectDiscipline())
//   - beltRank + a plan with no discipline signal at all (e.g. "Monthly
//     Unlimited") — the case the backfill can't infer and has to flag/skip
//   - no beltRank at all — nothing to backfill, should be left alone
//
// Usage:
//   node scripts/seed-legacy-members.js --gym-id=<convexDevGymId> [--commit]
//
// Without --commit this is a dry run: prints the rows and the exact
// `npx convex run` invocation without writing anything. Find a dev gym's
// Convex _id in the Convex dashboard (Data tab -> gyms table) for the target
// dev deployment first — same as scripts/import-members.js's --gym-id.
//
// Deliberately has no --prod flag, unlike scripts/import-members.js — this
// writes recognizable fake data and should never touch a real deployment.
// Seeded members are easy to find and delete afterward: every one has an
// @legacy-seed.test email and a "[SEED]" name prefix.

const { execFileSync } = require("child_process");
const path = require("path");

const ROWS = [
  // beltRank + plan that maps cleanly to a discipline via detectDiscipline()
  { name: "[SEED] Marcus Fundamentals", email: "marcus.fundamentals@legacy-seed.test", plan: "BJJ Fundamentals", beltRank: "Blue", status: "active" },
  { name: "[SEED] Priya Kids", email: "priya.kids@legacy-seed.test", plan: "BJJ Kids Program", beltRank: "Yellow", status: "active" },
  { name: "[SEED] Devon Thai", email: "devon.thai@legacy-seed.test", plan: "Muay Thai Unlimited", beltRank: "No Rank", status: "active" },
  { name: "[SEED] Grace Wrestler", email: "grace.wrestler@legacy-seed.test", plan: "Wrestling Club", beltRank: "N/A", status: "active" },
  { name: "[SEED] Omar Cage", email: "omar.cage@legacy-seed.test", plan: "MMA Unlimited", beltRank: "No Rank", status: "active" },

  // beltRank present, but plan has no discipline signal for detectDiscipline()
  { name: "[SEED] Isabella Unlimited", email: "isabella.unlimited@legacy-seed.test", plan: "Monthly Unlimited", beltRank: "Purple", status: "active" },
  { name: "[SEED] Tyler Founding", email: "tyler.founding@legacy-seed.test", plan: "Founding Member", beltRank: "White", status: "active" },
  { name: "[SEED] Kayla Annual", email: "kayla.annual@legacy-seed.test", plan: "Annual Membership", beltRank: "Brown", status: "inactive" },

  // no beltRank at all
  { name: "[SEED] Andre Noshow", email: "andre.noshow@legacy-seed.test", plan: "BJJ Fundamentals", status: "active" },
  { name: "[SEED] Ellis Blank", email: "ellis.blank@legacy-seed.test", plan: "Monthly Unlimited", status: "inactive" },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const gymIdArg = args.find((a) => a.startsWith("--gym-id="));
  const gymId = gymIdArg && gymIdArg.split("=")[1];
  const commit = args.includes("--commit");

  if (!gymId) {
    console.error("Usage: node scripts/seed-legacy-members.js --gym-id=<convexDevGymId> [--commit]");
    process.exit(1);
  }
  return { gymId, commit };
}

function main() {
  const { gymId, commit } = parseArgs();

  console.log(`Seeding ${ROWS.length} fake legacy member(s) into dev gym ${gymId}:\n`);
  for (const row of ROWS) {
    const beltNote = row.beltRank ? `beltRank="${row.beltRank}"` : "no beltRank";
    console.log(`  - ${row.name} | plan="${row.plan}" | ${beltNote}`);
  }

  const runArgs = ["convex", "run", "members:adminImportBatch", JSON.stringify({ gymId, rows: ROWS })];

  if (!commit) {
    console.log(`\nDry run only — nothing written. Re-run with --commit to actually seed.`);
    console.log(`Would run: npx ${runArgs.join(" ")}`);
    return;
  }

  console.log(`\nWriting to dev deployment...`);
  const out = execFileSync("npx", runArgs, { encoding: "utf8", cwd: path.join(__dirname, "..") });
  console.log(out.trim());
}

main();
