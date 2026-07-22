#!/usr/bin/env node
// One-off seeder: writes migration-assets/defaultPromotionCriteria.json's
// draft defaults into a single gym's promotionCriteria table.
//
// Usage:
//   node scripts/seed-promotion-criteria.js --gym-id=<convexGymId> [--commit] [--prod]
//
// Without --commit this is a dry run: prints every row that would be written
// and the exact underlying invocation, nothing touches Convex. Safe to
// re-run — promotionCriteria:seedDefaults (convex/promotionCriteria.ts) skips
// any (discipline, belt) pair the gym already has a row for, and rejects (with
// a reason, doesn't throw) any belt validateRank doesn't recognize — same
// posture as scripts/import-members.js's email-based dedupe and flag-don't-
// crash rank handling.
//
// Find a gym's Convex _id in the Convex dashboard (Data tab -> gyms table)
// for the target deployment first — same as scripts/import-members.js's
// --gym-id.

const path = require("path");
const { execFileSync } = require("child_process");

const defaults = require(path.join(__dirname, "..", "migration-assets", "defaultPromotionCriteria.json"));

// Invoke the Convex CLI's JS entrypoint directly with node, instead of "npx
// convex ...": execFileSync("npx", ...) throws ENOENT on Windows (CreateProcess
// can't resolve the .cmd extension without a shell), naming npx.cmd directly
// throws EINVAL instead (.cmd files need cmd.exe to launch them), and
// shell: true is a JSON-injection/quoting risk. See scripts/import-members.js
// for the full writeup — same fix, same reasoning.
const CONVEX_BIN = path.join(__dirname, "..", "node_modules", "convex", "bin", "main.js");

// Filters out any entry whose belt is literally "no_rank" — the JSON stores
// canonical belt values already (not display labels/aliases), so a plain
// string check is enough here; no need for validateRank's alias-matching.
// promotionCriteria:seedDefaults has this same check server-side (belt-and-
// suspenders: the mutation is also reachable directly via the Convex CLI,
// not just through this script), but filtering here means the "N default
// row(s)" summary printed below reflects what will actually be written,
// not what will immediately be discarded.
function buildRows() {
  const rows = [];
  const filteredOut = [];
  for (const [discipline, entry] of Object.entries(defaults)) {
    if (discipline.startsWith("_")) continue;
    for (const c of entry.criteria) {
      if (c.belt.trim().toLowerCase() === "no_rank") {
        filteredOut.push({ discipline, belt: c.belt });
        continue;
      }
      rows.push({
        discipline,
        belt: c.belt,
        requiredSessions: c.requiredSessions,
        requiredDaysAtRank: c.requiredDaysAtRank,
      });
    }
  }
  return { rows, filteredOut };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const gymIdArg = args.find((a) => a.startsWith("--gym-id="));
  const gymId = gymIdArg && gymIdArg.split("=")[1];
  const commit = args.includes("--commit");
  const prod = args.includes("--prod");

  if (!gymId) {
    console.error("Usage: node scripts/seed-promotion-criteria.js --gym-id=<convexGymId> [--commit] [--prod]");
    process.exit(1);
  }
  return { gymId, commit, prod };
}

function main() {
  const { gymId, commit, prod } = parseArgs();
  const { rows, filteredOut } = buildRows();
  const disciplineCount = Object.keys(defaults).filter((k) => !k.startsWith("_")).length;

  console.log(
    `${rows.length} default promotion-criteria row(s) across ${disciplineCount} discipline(s) for gym ${gymId}${prod ? " (PRODUCTION)" : " (dev)"}:\n`
  );
  for (const row of rows) {
    console.log(`  - ${row.discipline} / ${row.belt}: sessions=${row.requiredSessions ?? "-"} daysAtRank=${row.requiredDaysAtRank ?? "-"}`);
  }

  if (filteredOut.length) {
    console.log(`\nFiltered out ${filteredOut.length} no_rank entry(ies) before building rows (nothing to promote into):`);
    for (const f of filteredOut) {
      console.log(`  - ${f.discipline} / ${f.belt}`);
    }
  }

  const payload = JSON.stringify({ gymId, rows });
  const runArgs = [CONVEX_BIN, "run", "promotionCriteria:seedDefaults", payload, ...(prod ? ["--prod"] : [])];

  if (!commit) {
    console.log(`\nDry run only — nothing written. Re-run with --commit to actually seed.`);
    console.log(`Would run: npx convex run promotionCriteria:seedDefaults '${payload}'${prod ? " --prod" : ""}`);
    return;
  }

  console.log(`\nWriting to ${prod ? "PRODUCTION" : "dev"} deployment...`);
  const out = execFileSync(process.execPath, runArgs, { encoding: "utf8", cwd: path.join(__dirname, "..") });
  console.log(out.trim());
}

main();
