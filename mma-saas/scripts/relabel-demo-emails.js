#!/usr/bin/env node
// Rewrites an already-seeded demo gym's member emails from the old
// "@demo.kombatdesk.test" domain to "@demo.kombatdesk.com".
//
// Usage:
//   node scripts/relabel-demo-emails.js --gym-id=<convexGymId> [--commit] [--prod]
//
// Without --commit this is a dry run: the mutation computes every rename and
// prints it, and writes nothing.
//
// WHY: `.test` is RFC 2606 reserved, so the seeded addresses could never reach a
// real person — the correct instinct (see the DEMO_PHONE comment in
// convex/seedDemoGym.ts), but it renders as visibly fake in the /members Email
// column, which a prospect is looking at during the demo. The seeder now writes
// a subdomain of kombatdesk.com: still ours, still unroutable to a stranger,
// but it reads as an ordinary address. This backfills gyms seeded before that
// change, since seedDemoGym refuses to run on a gym that already has members.
//
// Safe to re-run: it only matches addresses ending in the old reserved-TLD
// suffix, so a second run finds nothing and reports zero changes.
//
// Find the gym's Convex _id in the Convex dashboard (Data tab -> gyms table) for
// the target deployment first — same as scripts/refresh-demo-gym.js's --gym-id.

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

  if (!gymId) {
    console.error("Usage: node scripts/relabel-demo-emails.js --gym-id=<convexGymId> [--commit] [--prod]");
    process.exit(1);
  }
  return { gymId, commit, prod };
}

function main() {
  const { gymId, commit, prod } = parseArgs();

  // dryRun is decided here and passed into the mutation rather than the script
  // declining to call it: the value of the dry run is seeing the actual
  // from -> to list, and only the mutation can read the rows to build it.
  const payload = { gymId, dryRun: !commit };

  console.log(
    `${commit ? "Relabeling" : "Dry run for"} gym ${gymId} on the ${prod ? "PRODUCTION" : "dev"} deployment...\n`
  );

  const runArgs = [
    CONVEX_BIN,
    "run",
    "relabelDemoEmails:relabelDemoEmails",
    JSON.stringify(payload),
    ...(prod ? ["--prod"] : []),
  ];

  let out;
  try {
    out = execFileSync(process.execPath, runArgs, { encoding: "utf8", cwd: path.join(__dirname, "..") });
  } catch (err) {
    // The mutation's guards throw with an explanatory message. Surface it
    // plainly instead of a node stack trace, because the message is the point.
    const detail = (err.stderr || err.stdout || err.message || "").toString().trim();
    console.error(`Relabel refused or failed:\n\n${detail}\n`);
    process.exit(1);
  }

  console.log(out.trim());

  if (!commit) {
    console.log(`\nDry run only — nothing written. Re-run with --commit to apply.`);
  } else {
    console.log(`\nDone. Reload /members and confirm the Email column.`);
  }
}

main();
