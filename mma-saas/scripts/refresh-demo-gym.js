#!/usr/bin/env node
// Re-anchors a seeded demo gym's check-in history to today, so the At-Risk list
// on the dashboard is correct at demo time instead of correct on the day the gym
// was seeded. Run it before every demo.
//
// Usage:
//   node scripts/refresh-demo-gym.js --gym-id=<convexGymId> [--commit] [--prod] [--allow-send-capable]
//
// Without --commit this is a dry run: the mutation computes the whole shift and
// reports what the At-Risk list would contain, and writes nothing.
//
// WHY: scripts/seed-demo-gym.js builds 60 days of check-ins relative to the
// moment it runs, and marks at-risk members by stopping their history 12 days
// before that moment. convex/members.ts:getAtRiskMembers is just "active AND
// lastVisit older than 7 days", so that distribution decays in one direction —
// every day, more of the roster crosses the line, until all of it is at-risk and
// the list looks broken instead of persuasive.
//
// Unlike seed-demo-gym.js this IS safe to re-run: it shifts existing rows rather
// than inserting, and a second run the same day computes a ~0 delta and no-ops.
//
// Find the gym's Convex _id in the Convex dashboard (Data tab -> gyms table) for
// the target deployment first — same as scripts/seed-demo-gym.js's --gym-id.

const path = require("path");
const { execFileSync } = require("child_process");

// See scripts/import-members.js for the full writeup on why this invokes node
// directly on the Convex CLI's JS entrypoint instead of "npx convex ...".
const CONVEX_BIN = path.join(__dirname, "..", "node_modules", "convex", "bin", "main.js");

function parseArgs() {
  const args = process.argv.slice(2);
  const gymIdArg = args.find((a) => a.startsWith("--gym-id="));
  const gymId = gymIdArg && gymIdArg.split("=")[1];
  const commit = args.includes("--commit");
  const prod = args.includes("--prod");
  const allowSendCapable = args.includes("--allow-send-capable");

  if (!gymId) {
    console.error(
      "Usage: node scripts/refresh-demo-gym.js --gym-id=<convexGymId> [--commit] [--prod] [--allow-send-capable]"
    );
    process.exit(1);
  }
  return { gymId, commit, prod, allowSendCapable };
}

function main() {
  const { gymId, commit, prod, allowSendCapable } = parseArgs();

  // dryRun is decided here and passed into the mutation, rather than the script
  // just declining to call it. The whole value of the dry run is seeing the
  // resulting At-Risk list, and only the mutation can read the data to compute
  // it — so the dry run has to go all the way to the server and stop short of
  // the writes.
  const payload = { gymId, dryRun: !commit, ...(allowSendCapable ? { allowSendCapable: true } : {}) };

  console.log(
    `${commit ? "Refreshing" : "Dry run for"} gym ${gymId} on the ${prod ? "PRODUCTION" : "dev"} deployment...\n`
  );

  const runArgs = [
    CONVEX_BIN,
    "run",
    "refreshDemoGym:refreshDemoGym",
    JSON.stringify(payload),
    ...(prod ? ["--prod"] : []),
  ];

  let out;
  try {
    out = execFileSync(process.execPath, runArgs, { encoding: "utf8", cwd: path.join(__dirname, "..") });
  } catch (err) {
    // The mutation's guards (real-customer gym, send-capable members, wrong row
    // counts) all throw with an explanatory message. Surface it plainly instead
    // of a node stack trace, because the message is the point.
    const detail = (err.stderr || err.stdout || err.message || "").toString().trim();
    console.error(`Refresh refused or failed:\n\n${detail}\n`);
    process.exit(1);
  }

  console.log(out.trim());

  if (!commit) {
    console.log(`\nDry run only — nothing written. Re-run with --commit to apply.`);
  } else {
    console.log(
      `\nDone. Open the dashboard's At-Risk view and confirm the names above are the ones showing.`
    );
  }
}

main();
