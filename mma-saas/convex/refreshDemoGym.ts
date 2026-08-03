import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Re-anchors a seeded demo gym's check-in history to "now" so the At-Risk list
// still reads correctly at demo time.
//
// WHY THIS EXISTS. scripts/seed-demo-gym.js generates 60 days of check-ins
// relative to the moment it runs, and marks role:"at_risk" members by stopping
// their history 12 days before that moment. members.ts:getAtRiskMembers is
// purely "active AND lastVisit older than 7 days", so the seeded distribution is
// only correct on the day it was seeded. Left alone it decays in one direction:
// every day that passes moves more of the roster past the 7-day line, until the
// whole gym is at-risk and the list reads as broken rather than persuasive. A
// demo gym seeded three weeks ago shows 18 of 18 at-risk.
//
// This shifts every checkIns row for the gym forward by a single delta, so the
// *shape* the seeder designed — healthy regulars near the present, at-risk
// members' history drying up ~12 days back — is preserved exactly and re-hung on
// today's date. Idempotent: run it before every demo. A second run inside the
// same day computes a delta of ~0 and no-ops.
//
// Deliberately NOT a delete-and-reseed. seedDemoGym refuses to run on a gym that
// already has members, so reseeding would mean hard-deleting member rows — and
// members are archived, never deleted, precisely because their consent/opt-out
// fields are TCPA evidence (see the members table comment in schema.ts). Shifting
// timestamps touches no identity, no consent field, and no member _id, so
// enrollments, ranks, and Tyler Brandt's promotion state all survive untouched.
const DAY_MS = 24 * 60 * 60 * 1000;

// Where the freshest check-in in the gym should land after the shift. The seeder
// walks `daysAgo` from 60 down to `> stopDaysAgo`, so a healthy member's newest
// check-in is 1 day before seed time. Targeting now-1day reproduces the state the
// seeder produces on the day it runs.
const TARGET_NEWEST_LAG_DAYS = 1;

// Bound on rows touched in one transaction. A seeded gym is ~450 checkIns
// (18 members x 60 days x up to 4/7 daily odds), so this is roughly 4x headroom.
// If a gym ever exceeds it, that gym is not a demo gym and this tool is the wrong
// thing to be pointing at it — hence a hard error rather than silent batching.
const MAX_CHECKINS = 2000;

export const refreshDemoGym = internalMutation({
  args: {
    gymId: v.id("gyms"),
    // Compute and report everything, write nothing.
    dryRun: v.optional(v.boolean()),
    // Escape hatch for the one legitimate send-capable case: the
    // DEMO_PHONE member seedDemoGym adds using the OWNER'S OWN number. Never
    // pass this to move a gym holding a member's real number.
    allowSendCapable: v.optional(v.boolean()),
  },
  handler: async (ctx, { gymId, dryRun, allowSendCapable }) => {
    const gym = await ctx.db.get(gymId);
    if (!gym) throw new Error(`No gym found with id ${gymId}`);

    // GUARD 1 — never a paying customer. A real gym's check-in history is its
    // own operating record and its at-risk list drives texts that actually
    // send. Rewriting either would be indistinguishable from data corruption.
    if (gym.stripeSubscriptionId) {
      throw new Error(
        `Refusing to refresh gym ${gymId}: it has stripeSubscriptionId ${gym.stripeSubscriptionId}. ` +
          `This is a real customer, not a demo gym.`
      );
    }

    const members = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .collect();
    if (members.length === 0) {
      throw new Error(`Gym ${gymId} has no members — run scripts/seed-demo-gym.js first.`);
    }

    // GUARD 2 — the guard that matters. This tool's entire job is to move
    // members across the at-risk threshold, and the at-risk list is the send
    // audience. Tied to the actual send gate rather than to "has a phone",
    // because that gate (sendRetentionTexts.ts:getAtRiskMembers) is the thing
    // that decides whether a human receives a message. Keep these conditions
    // in sync with it.
    const sendCapable = members.filter(
      (m) => !m.archived && !!m.phone && m.smsConsentConfirmed === true && m.status === "active" && !m.smsOptedOut
    );
    if (sendCapable.length > 0 && !allowSendCapable) {
      throw new Error(
        `Refusing to refresh gym ${gymId}: ${sendCapable.length} member(s) would pass the retention-text send ` +
          `gate (phone + confirmed consent + active + not opted out). Refreshing makes members at-risk, and ` +
          `at-risk is the send audience — so this would queue real texts. Names: ` +
          `${sendCapable.map((m) => m.name).join(", ")}. ` +
          `If every one of those is the DEMO_PHONE member on your own number, re-run with allowSendCapable: true.`
      );
    }

    const checkIns = await ctx.db
      .query("checkIns")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .collect();
    if (checkIns.length === 0) {
      throw new Error(
        `Gym ${gymId} has ${members.length} member(s) but no checkIns rows — nothing to shift. ` +
          `This gym wasn't created by scripts/seed-demo-gym.js.`
      );
    }
    if (checkIns.length > MAX_CHECKINS) {
      throw new Error(
        `Gym ${gymId} has ${checkIns.length} checkIns rows, over the ${MAX_CHECKINS} cap. ` +
          `That is far more than seed-demo-gym.js creates — verify this is really a demo gym.`
      );
    }

    const currentNewest = checkIns.reduce((max, c) => (c.timestamp > max ? c.timestamp : max), -Infinity);
    const target = Date.now() - TARGET_NEWEST_LAG_DAYS * DAY_MS;
    const deltaMs = target - currentNewest;

    // Forward only. A negative delta means the newest check-in is already more
    // recent than the target — which happens when real kiosk activity has landed
    // since the seed — and dragging history backwards would erase that.
    if (deltaMs <= 0) {
      return {
        skipped: true as const,
        reason: `Newest check-in is already ${Math.abs(Math.round(deltaMs / DAY_MS))} day(s) newer than the target; nothing to shift.`,
        checkInsShifted: 0,
        membersRepointed: 0,
        invoicesShifted: 0,
        atRisk: summarizeAtRisk(members),
      };
    }

    const shiftedByMember = new Map<string, number>();
    for (const c of checkIns) {
      const next = c.timestamp + deltaMs;
      const prev = shiftedByMember.get(c.memberId);
      if (prev === undefined || next > prev) shiftedByMember.set(c.memberId, next);
      if (!dryRun) {
        // clientScannedAt belongs to offline-queue replays and is the moment a
        // member physically scanned. Shifted in the SAME patch so the two can
        // never diverge; leaving it behind would make a replayed check-in look
        // like it was scanned three weeks before it was recorded.
        await ctx.db.patch(c._id, {
          timestamp: next,
          ...(c.clientScannedAt !== undefined ? { clientScannedAt: c.clientScannedAt + deltaMs } : {}),
        });
      }
    }

    // lastVisit is what getAtRiskMembers actually reads. Recomputed from the
    // shifted check-ins, but never moved BACKWARD: attendance logging
    // (app/classes/[id]) patches lastVisit without inserting a checkIns row, so
    // a member marked present in a real production test has a lastVisit with no
    // check-in behind it. Taking the max means this tool can never push a member
    // with genuine recent activity back across the at-risk line and fabricate an
    // absence that didn't happen.
    const projected = members.map((m) => {
      const shifted = shiftedByMember.get(m._id);
      if (shifted === undefined) return { ...m };
      const shiftedISO = new Date(shifted).toISOString();
      const nextLastVisit = !m.lastVisit || m.lastVisit < shiftedISO ? shiftedISO : m.lastVisit;
      return { ...m, lastVisit: nextLastVisit };
    });
    const lastVisitPatches = projected.filter((m, i) => m.lastVisit !== members[i].lastVisit);
    if (!dryRun) {
      for (const m of lastVisitPatches) {
        await ctx.db.patch(m._id, { lastVisit: m.lastVisit });
      }
    }
    const membersRepointed = lastVisitPatches.length;

    // Past-due invoices drift too: seeded 7-11 days overdue, they read as months
    // overdue on a gym seeded weeks ago, which makes the demo look neglected
    // rather than realistic. Shifted by the same delta and clamped so a due date
    // never lands in the future — an "unpaid" invoice that isn't due yet isn't
    // past due, and the demo point is that it is.
    const invoices = await ctx.db
      .query("invoices")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .collect();
    let invoicesShifted = 0;
    const todayISODate = new Date(Date.now()).toISOString().slice(0, 10);
    for (const inv of invoices) {
      if (inv.status !== "unpaid") continue;
      const shifted = new Date(new Date(`${inv.dueDate}T00:00:00.000Z`).getTime() + deltaMs)
        .toISOString()
        .slice(0, 10);
      const next = shifted > todayISODate ? todayISODate : shifted;
      if (next === inv.dueDate) continue;
      if (!dryRun) await ctx.db.patch(inv._id, { dueDate: next });
      invoicesShifted++;
    }

    return {
      skipped: false as const,
      dryRun: dryRun === true,
      shiftedDays: Math.round(deltaMs / DAY_MS),
      checkInsShifted: checkIns.length,
      membersRepointed,
      invoicesShifted,
      // The whole point of the run. Mirrors members.ts:getAtRiskMembers exactly —
      // if that query's conditions change, change these with it or this output
      // starts lying about what the dashboard will show.
      atRisk: summarizeAtRisk(projected),
    };
  },
});

type AtRiskInput = { name: string; status: string; lastVisit?: string; archived?: boolean };

function summarizeAtRisk(members: AtRiskInput[]) {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const threshold = sevenDaysAgo.toISOString();
  const names = members
    .filter((m) => !m.archived && m.status === "active" && (!m.lastVisit || m.lastVisit < threshold))
    .map((m) => m.name);
  return { count: names.length, of: members.length, names };
}
