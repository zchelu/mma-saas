#!/usr/bin/env node
// One-off seeder: stands up a full realistic-looking demo gym (members,
// classes, enrollments, 60 days of check-in history, past-due invoices) for
// a live sales demo — see docs handoff notes for the Colorado Springs BJJ
// demo this was built for.
//
// Usage:
//   node scripts/seed-demo-gym.js --gym-id=<convexGymId> [--commit] [--prod]
//
// Without --commit this is a dry run: prints exactly what would be created,
// nothing touches Convex. The underlying mutation (seedDemoGym:seedDemoGym)
// refuses to run if the target gym already has any members, so this is a
// one-shot operation, not safe to blindly re-run like scripts/import-members.js.
//
// Find the gym's Convex _id in the Convex dashboard (Data tab -> gyms table)
// for the target deployment first — same as scripts/import-members.js's
// --gym-id.

const path = require("path");
const { execFileSync } = require("child_process");

// See scripts/import-members.js for the full writeup on why this invokes
// node directly on the Convex CLI's JS entrypoint instead of "npx convex ...".
const CONVEX_BIN = path.join(__dirname, "..", "node_modules", "convex", "bin", "main.js");

const DAY_MS = 24 * 60 * 60 * 1000;

const CLASS_DEFS = [
  { name: "Fundamentals BJJ", instructor: "Coach Mike Alvarez", dayOfWeek: "Monday", time: "6:00 AM" },
  { name: "Advanced BJJ", instructor: "Coach Mike Alvarez", dayOfWeek: "Monday", time: "6:00 PM" },
  { name: "No-Gi BJJ", instructor: "Coach Sarah Kim", dayOfWeek: "Tuesday", time: "7:00 PM" },
  { name: "Open Mat", instructor: "Coach Mike Alvarez", dayOfWeek: "Wednesday", time: "6:00 AM" },
  { name: "Fundamentals BJJ", instructor: "Coach Sarah Kim", dayOfWeek: "Wednesday", time: "6:00 PM" },
  { name: "Competition Training", instructor: "Coach Owen Castellanos", dayOfWeek: "Thursday", time: "7:00 PM" },
  { name: "Advanced BJJ", instructor: "Coach Owen Castellanos", dayOfWeek: "Friday", time: "6:00 AM" },
  { name: "Open Mat", instructor: "Coach Mike Alvarez", dayOfWeek: "Saturday", time: "8:00 AM" },
];

// role: "past_due" -> gets one unpaid invoice. "at_risk" -> check-in history
// stops ~12 days ago (active status + stale lastVisit = the real At-Risk
// query's condition, convex/members.ts:getAtRiskMembers). "promotable" ->
// Tyler Brandt, maxed white belt (4 stripes), the live promotion demo moment.
const MEMBER_DEFS = [
  { name: "Tyler Brandt", belt: "white", stripes: 4, role: "promotable", checkInsPerWeek: 3 },
  { name: "Jordan Reyes", belt: "white", stripes: 2, checkInsPerWeek: 2 },
  { name: "Casey Whitfield", belt: "white", stripes: 1, checkInsPerWeek: 3 },
  { name: "Morgan Ellis", belt: "white", stripes: 0, checkInsPerWeek: 2 },
  { name: "Avery Simmons", belt: "white", stripes: 3, role: "at_risk", checkInsPerWeek: 3 },
  { name: "Riley Dawson", belt: "white", stripes: 1, role: "past_due", checkInsPerWeek: 2 },
  { name: "Hannah Cortez", belt: "blue", stripes: 2, checkInsPerWeek: 4 },
  { name: "Diego Marsh", belt: "blue", stripes: 3, checkInsPerWeek: 3 },
  { name: "Sam Whitaker", belt: "blue", stripes: 0, role: "past_due", checkInsPerWeek: 2 },
  { name: "Nate Fischer", belt: "blue", stripes: 1, checkInsPerWeek: 3 },
  { name: "Paige Donovan", belt: "blue", stripes: 4, role: "at_risk", checkInsPerWeek: 4 },
  { name: "Marcus Holloway", belt: "purple", stripes: 1, checkInsPerWeek: 3 },
  { name: "Elena Vasquez", belt: "purple", stripes: 2, checkInsPerWeek: 4 },
  { name: "Trevor Nakamura", belt: "purple", stripes: 0, role: "past_due", checkInsPerWeek: 2 },
  { name: "Grace Bellamy", belt: "purple", stripes: 3, checkInsPerWeek: 3 },
  { name: "Andre Kowalski", belt: "brown", stripes: 2, checkInsPerWeek: 4 },
  { name: "Julia Petrov", belt: "brown", stripes: 1, checkInsPerWeek: 3 },
  { name: "Owen Castellanos", belt: "black", stripes: 1, checkInsPerWeek: 4 },
];

function beltLabel(belt, stripes) {
  const cap = belt.charAt(0).toUpperCase() + belt.slice(1);
  if (!stripes) return cap;
  return `${cap} (${stripes} stripe${stripes === 1 ? "" : "s"})`;
}

function slugEmail(name) {
  return name.toLowerCase().replace(/[^a-z\s]/g, "").trim().replace(/\s+/g, ".") + "@demo.kombatdesk.test";
}

// Walks the last 60 days backward from "now", rolling a per-day chance of a
// check-in derived from checkInsPerWeek (checkInsPerWeek/7 odds per day), at
// a random time in either the 6-8am or 5-8pm window. stopDaysAgo lets
// at-risk members' history dry up before the present (10-15 days ago),
// leaving genuine older history so they still read as a real member who
// stopped showing up, not a blank slate.
function generateCheckIns(now, checkInsPerWeek, stopDaysAgo) {
  const timestamps = [];
  for (let daysAgo = 60; daysAgo > stopDaysAgo; daysAgo--) {
    if (Math.random() < checkInsPerWeek / 7) {
      const dayStart = now - daysAgo * DAY_MS;
      const isMorning = Math.random() < 0.4;
      const startHour = isMorning ? 6 : 17;
      const endHour = isMorning ? 8 : 20;
      const hour = startHour + Math.random() * (endHour - startHour);
      timestamps.push(Math.round(dayStart + hour * 60 * 60 * 1000));
    }
  }
  return timestamps;
}

function buildPayload(gymId) {
  const now = Date.now();
  const members = MEMBER_DEFS.map((def, i) => {
    const stopDaysAgo = def.role === "at_risk" ? 12 : 0;
    const checkInTimestamps = generateCheckIns(now, def.checkInsPerWeek, stopDaysAgo);
    // Each member enrolled in 2 of the 8 classes, spread round-robin so
    // classes end up with a realistic, uneven roster size instead of every
    // class having exactly the same headcount.
    const classIndexes = [i % CLASS_DEFS.length, (i + 3) % CLASS_DEFS.length];

    return {
      name: def.name,
      email: slugEmail(def.name),
      plan: "Adult BJJ Unlimited",
      discipline: "bjj_adult",
      belt: def.belt,
      stripes: def.stripes,
      beltLabel: beltLabel(def.belt, def.stripes),
      checkInTimestamps,
      classIndexes,
      ...(def.role === "past_due"
        ? { pastDueAmount: 150, pastDueDaysAgo: 7 + Math.floor(Math.random() * 5) }
        : {}),
    };
  });

  return { gymId, classes: CLASS_DEFS, members };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const gymIdArg = args.find((a) => a.startsWith("--gym-id="));
  const gymId = gymIdArg && gymIdArg.split("=")[1];
  const commit = args.includes("--commit");
  const prod = args.includes("--prod");

  if (!gymId) {
    console.error("Usage: node scripts/seed-demo-gym.js --gym-id=<convexGymId> [--commit] [--prod]");
    process.exit(1);
  }
  return { gymId, commit, prod };
}

function printSummary(payload, prod) {
  const belts = { white: 0, blue: 0, purple: 0, brown: 0, black: 0 };
  let pastDue = 0;
  let atRisk = 0;
  let totalCheckIns = 0;
  for (const m of payload.members) {
    belts[m.belt] = (belts[m.belt] || 0) + 1;
    if (m.pastDueAmount) pastDue++;
    totalCheckIns += m.checkInTimestamps.length;
  }
  for (const def of MEMBER_DEFS) if (def.role === "at_risk") atRisk++;

  console.log(`Seeding gym ${payload.gymId}${prod ? " (PRODUCTION)" : " (dev)"}:\n`);
  console.log(`  ${payload.members.length} members — white:${belts.white} blue:${belts.blue} purple:${belts.purple} brown:${belts.brown} black:${belts.black}`);
  console.log(`  ${payload.classes.length} classes with enrollments (2 per member)`);
  console.log(`  ~${totalCheckIns} check-in rows across 60 days`);
  console.log(`  ${pastDue} past-due invoice(s)`);
  console.log(`  ${atRisk} at-risk member(s) (check-ins stop ~12 days ago)`);
  console.log(`  Promotion-ready: Tyler Brandt, White (4 stripes)`);
}

function main() {
  const { gymId, commit, prod } = parseArgs();
  const payload = buildPayload(gymId);
  printSummary(payload, prod);

  const runArgs = [CONVEX_BIN, "run", "seedDemoGym:seedDemoGym", JSON.stringify(payload), ...(prod ? ["--prod"] : [])];

  if (!commit) {
    console.log(`\nDry run only — nothing written. Re-run with --commit to actually seed.`);
    console.log(`Would run: npx convex run seedDemoGym:seedDemoGym <payload> ${prod ? "--prod" : ""}`);
    return;
  }

  console.log(`\nWriting to ${prod ? "PRODUCTION" : "dev"} deployment...`);
  const out = execFileSync(process.execPath, runArgs, { encoding: "utf8", cwd: path.join(__dirname, "..") });
  console.log(out.trim());
}

main();
