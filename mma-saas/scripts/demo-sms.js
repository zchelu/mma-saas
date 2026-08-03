#!/usr/bin/env node
// Puts one demo-gym member into a state where a retention text is actually
// attempted, so the manual and automatic winback paths can be rehearsed.
//
// Usage:
//   node scripts/demo-sms.js --gym-id=<id> [--member="Avery Simmons"] [--commit] [--prod]
//   node scripts/demo-sms.js --gym-id=<id> --revert [--commit] [--prod]
//
// Dry run by default. The dry run still calls the server, so it reports the gym's
// real plan gates before you change anything.
//
// THE PHONE NUMBER IS NOT AN ARGUMENT TO THIS SCRIPT. It comes from the
// DEMO_PHONE Convex environment variable — set it in
// Convex dashboard > Settings > Environment Variables, on the deployment you're
// targeting. Passing it on the command line would put your own number in shell
// history and in the Convex function log; see the comment at the top of
// convex/demoSmsMember.ts.
//
// RE-RUN THIS TO RESET between rehearsals. The send gate refuses a member texted
// within the last 7 days or one who has used all 3 winback attempts, and `prepare`
// clears both — so a second run is a fresh test, with no 7-day wait. Note that
// "check the member in to reset" does NOT work: checking in sets lastVisit to now,
// which drops her off the At-Risk list, and refreshDemoGym never moves lastVisit
// backward.
//
// When you're done rehearsing, --revert strips the phone and consent and puts hard
// rule #5 (demo gym holds zero phone numbers) back in force.

const path = require("path");
const { execFileSync } = require("child_process");

// See scripts/import-members.js for why this invokes node directly on the Convex
// CLI's JS entrypoint instead of "npx convex ...".
const CONVEX_BIN = path.join(__dirname, "..", "node_modules", "convex", "bin", "main.js");

const DEFAULT_MEMBER = "Avery Simmons";

function parseArgs() {
  const args = process.argv.slice(2);
  const gymIdArg = args.find((a) => a.startsWith("--gym-id="));
  const memberArg = args.find((a) => a.startsWith("--member="));
  const gymId = gymIdArg && gymIdArg.split("=")[1];
  const memberName = memberArg ? memberArg.slice("--member=".length) : DEFAULT_MEMBER;

  if (!gymId) {
    console.error(
      `Usage: node scripts/demo-sms.js --gym-id=<id> [--member="${DEFAULT_MEMBER}"] [--revert] [--commit] [--prod]`
    );
    process.exit(1);
  }
  return {
    gymId,
    memberName,
    revert: args.includes("--revert"),
    commit: args.includes("--commit"),
    prod: args.includes("--prod"),
  };
}

function explainGates(gates) {
  if (!gates) return;
  console.log(`\nGym texting gates:`);
  console.log(`  plan               ${gates.plan === undefined ? "(unset)" : gates.plan}`);
  console.log(`  planStatus         ${gates.planStatus === undefined ? "(unset)" : gates.planStatus}`);
  console.log(`  planHasTexting     ${gates.planHasTexting}`);
  console.log(`  hasWriteAccess     ${gates.hasWriteAccess}`);
  console.log(`  => texting will run ${gates.textingWillRun ? "YES" : "NO"}`);

  if (gates.textingWillRun) return;

  // Both the cron path and the manual button check these two together, so a
  // failure here blocks the rehearsal no matter what the member row looks like.
  console.log(`\n  Texting is BLOCKED on this gym, independent of the member's phone:`);
  if (!gates.planHasTexting) {
    console.log(
      `    - planHasTexting is false. lib/plans.ts requires plan to be set and not "starter". ` +
        `Set the gym's plan field (Convex dashboard > Data > gyms).`
    );
  }
  if (!gates.hasWriteAccess) {
    console.log(
      `    - hasWriteAccess is false. convex/gyms.ts requires planStatus to be "active" or "trialing". ` +
        `Current value above.`
    );
  }
}

function main() {
  const { gymId, memberName, revert, commit, prod } = parseArgs();
  const fn = revert ? "demoSmsMember:revert" : "demoSmsMember:prepare";
  const payload = { gymId, memberName, dryRun: !commit };

  console.log(
    `${commit ? "Applying" : "Dry run:"} ${revert ? "REVERT" : "PREPARE"} for "${memberName}" ` +
      `in gym ${gymId} on the ${prod ? "PRODUCTION" : "dev"} deployment...`
  );

  const runArgs = [CONVEX_BIN, "run", fn, JSON.stringify(payload), ...(prod ? ["--prod"] : [])];

  let out;
  try {
    out = execFileSync(process.execPath, runArgs, { encoding: "utf8", cwd: path.join(__dirname, "..") });
  } catch (err) {
    // Every guard in the mutation throws with an explanatory message; the message
    // is the whole value, so surface it instead of a node stack trace.
    const detail = (err.stderr || err.stdout || err.message || "").toString().trim();
    console.error(`\nRefused or failed:\n\n${detail}\n`);
    process.exit(1);
  }

  const raw = out.trim();
  console.log(`\n${raw}`);

  // The CLI prints the mutation's return value as JSON; parse it for the gate
  // explanation, but never fail the run over a parse problem.
  let parsed;
  try {
    const start = raw.indexOf("{");
    if (start !== -1) parsed = JSON.parse(raw.slice(start));
  } catch {
    parsed = undefined;
  }
  if (parsed) explainGates(parsed.gates);

  if (!commit) {
    console.log(`\nDry run only — nothing written. Re-run with --commit to apply.`);
    return;
  }

  if (revert) {
    console.log(`\nReverted. Hard rule #5 is back in force: no member of this gym can be texted.`);
    return;
  }

  console.log(
    `\nPrepared. While the A2P campaign is in vetting, a send attempt will FAIL with error 30034 ` +
      `(campaign not approved) — that is expected, and it still proves the plumbing up to the carrier. ` +
      `\nRun --revert when you're done rehearsing.`
  );
}

main();
