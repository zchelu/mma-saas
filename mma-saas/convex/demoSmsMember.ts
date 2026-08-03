import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { hasWriteAccess } from "./gyms";
import { planHasTexting } from "../lib/plans";

// Puts ONE member of a demo gym into a state where a retention text will
// actually be attempted, so the manual and automatic winback paths can be
// rehearsed end to end. Companion to scripts/demo-sms.js.
//
// THE PHONE NUMBER NEVER APPEARS IN SOURCE OR IN ARGS. It is read from the
// DEMO_PHONE Convex environment variable, the same way
// seedDemoGym.ts's demo-winback block does, and for the same reason stated
// there: a realistic-looking hardcoded number belongs to a real person. Passing
// it as a CLI arg would also put it in shell history and in the Convex function
// log. Set it in Convex dashboard > Settings > Environment Variables.
//
// HARD RULE #5 ("the demo gym holds zero member phone numbers") is deliberately
// suspended by this tool, for the one case seedDemoGym.ts already carved out:
// DEMO_PHONE is the OWNER'S OWN number, knowingly opted in. That is why
// smsConsentConfirmed can be stamped here at all. No other member may ever be
// given a fabricated consent record. Run `revert` when you're done rehearsing to
// put the rule back.

const DAY_MS = 24 * 60 * 60 * 1000;

// How stale to make lastVisit. members.ts:getAtRiskMembers uses a 7-day cutoff;
// 12 days matches what seed-demo-gym.js gives its designated at-risk members, so
// the prepared member looks identical to the seeded ones rather than sitting
// suspiciously right on the boundary.
const AT_RISK_DAYS = 12;

// Twilio requires E.164. Validated here rather than letting the send fail at the
// API with a 21211, because that error surfaces in a Convex action log the day
// you're rehearsing, not at the moment you set the variable.
const E164 = /^\+[1-9]\d{7,14}$/;

type GymGateReport = {
  plan: string | undefined;
  planStatus: string | undefined;
  planHasTexting: boolean;
  hasWriteAccess: boolean;
  textingWillRun: boolean;
};

// Reuses the REAL gates rather than reimplementing them, so this report can't
// drift away from what sendRetentionTexts.ts actually enforces. Both the cron
// path (sendRetentionTextsForGym) and the manual button
// (sendManualRetentionTextsForGym) require hasWriteAccess AND planHasTexting.
function reportGymGates(gym: { plan?: string; planStatus?: string }): GymGateReport {
  const texting = planHasTexting(gym.plan);
  const write = hasWriteAccess(gym);
  return {
    plan: gym.plan,
    planStatus: gym.planStatus,
    planHasTexting: texting,
    hasWriteAccess: write,
    textingWillRun: texting && write,
  };
}

export const prepare = internalMutation({
  args: {
    gymId: v.id("gyms"),
    memberName: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { gymId, memberName, dryRun }) => {
    const phone = process.env.DEMO_PHONE;
    if (!phone) {
      throw new Error(
        "DEMO_PHONE is not set on this deployment. Set it in Convex dashboard > Settings > " +
          "Environment Variables (use the --prod deployment's settings if you're targeting prod). " +
          "It must be your own number in E.164 form, e.g. +17195551234."
      );
    }
    if (!E164.test(phone)) {
      throw new Error(
        `DEMO_PHONE is set but is not valid E.164: "${phone.slice(0, 3)}…". ` +
          `Twilio needs a leading + and country code, e.g. +17195551234.`
      );
    }

    const gym = await ctx.db.get(gymId);
    if (!gym) throw new Error(`No gym found with id ${gymId}`);

    // Same guard as refreshDemoGym: never a paying customer. Stamping consent and
    // backdating lastVisit on a real gym's member would both corrupt its records
    // and queue a text to an actual person.
    if (gym.stripeSubscriptionId) {
      throw new Error(
        `Refusing: gym ${gymId} has stripeSubscriptionId ${gym.stripeSubscriptionId}. ` +
          `This is a real customer, not a demo gym.`
      );
    }

    const members = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .collect();
    const matches = members.filter((m) => m.name === memberName);
    if (matches.length === 0) {
      throw new Error(
        `No member named "${memberName}" in gym ${gymId}. Roster: ${members.map((m) => m.name).join(", ")}`
      );
    }
    if (matches.length > 1) {
      throw new Error(`${matches.length} members named "${memberName}" in gym ${gymId} — ambiguous, refusing.`);
    }
    const member = matches[0];

    // Don't clobber a different number. If this member already carries a phone
    // that isn't DEMO_PHONE, something unexpected is true about this gym and
    // overwriting it could destroy a real member's contact record.
    if (member.phone && member.phone !== phone) {
      throw new Error(
        `Member "${memberName}" already has a different phone number on file. Refusing to overwrite it. ` +
          `Investigate before re-running — this gym may not be the demo gym.`
      );
    }

    // Anyone ELSE in this gym holding a phone is a red flag worth stopping on:
    // this tool is supposed to create exactly one send-capable member.
    const othersWithPhone = members.filter((m) => m._id !== member._id && !!m.phone);
    if (othersWithPhone.length > 0) {
      throw new Error(
        `${othersWithPhone.length} other member(s) in this gym already have phone numbers ` +
          `(${othersWithPhone.map((m) => m.name).join(", ")}). This tool creates exactly one send-capable ` +
          `member; more than that means hard rule #5 broke somewhere else. Investigate before re-running.`
      );
    }

    const atRiskSince = new Date(Date.now() - AT_RISK_DAYS * DAY_MS).toISOString();

    // Everything needed to pass sendRetentionTexts.ts:getAtRiskMembers in one
    // patch, so re-running this is how you reset between rehearsals — no separate
    // reset command, and no 7-day wait.
    //
    // Clearing lastRetentionTextAt/winbackAttempts is what makes it re-runnable:
    // the send gate refuses a member texted within 7 days, and refuses one who
    // has used all MAX_WINBACK_ATTEMPTS. members.ts:checkIn clears both too, but
    // checking in also sets lastVisit to now — which makes the member no longer
    // at-risk, and refreshDemoGym deliberately never moves lastVisit backward. So
    // "check her in to reset" deadlocks. This does both halves at once.
    const patch = {
      phone,
      smsConsentConfirmed: true,
      smsConsentConfirmedAt: Date.now(),
      smsConsentSource: "owner_attestation" as const,
      // Clears a STOP from a previous rehearsal, so opt-out can be tested more
      // than once. This is legitimate ONLY because the number is the operator's
      // own; clearing a real member's opt-out would be a TCPA violation.
      smsOptedOut: false,
      status: "active" as const,
      archived: false,
      lastVisit: atRiskSince,
      lastRetentionTextAt: undefined,
      winbackAttempts: undefined,
      winbackDormantAt: undefined,
    };

    if (!dryRun) {
      await ctx.db.patch(member._id, patch);

      // Leave evidence for the consent stamp above. A member row carrying
      // smsConsentConfirmed with nothing explaining where it came from is exactly
      // the gap that makes a later compliance question unanswerable. The
      // attestedByClerkUserId is a synthetic marker rather than a Clerk subject
      // because this runs from the CLI with no authenticated identity — it is
      // deliberately not a real user id so this row can never be mistaken for a
      // gym owner's in-product attestation.
      await ctx.db.insert("consentAttestations", {
        gymId,
        attestedByClerkUserId: "cli:demoSmsMember.prepare",
        attestedAt: Date.now(),
        memberCount: 1,
        memberIds: [member._id],
        attestationVersion: "demo-owner-own-number",
      });
    }

    return {
      mode: "prepare" as const,
      dryRun: dryRun === true,
      member: member.name,
      // Last 4 only. The full number stays out of the CLI output, the Convex
      // function log, and any transcript of this run.
      phoneEndsWith: phone.slice(-4),
      atRiskSince,
      gates: reportGymGates(gym),
      // Mirrors sendRetentionTexts.ts:getAtRiskMembers' member-level conditions.
      memberWillBeInSendAudience: true,
    };
  },
});

export const revert = internalMutation({
  args: {
    gymId: v.id("gyms"),
    memberName: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { gymId, memberName, dryRun }) => {
    const gym = await ctx.db.get(gymId);
    if (!gym) throw new Error(`No gym found with id ${gymId}`);
    if (gym.stripeSubscriptionId) {
      throw new Error(
        `Refusing: gym ${gymId} has stripeSubscriptionId ${gym.stripeSubscriptionId} — real customer.`
      );
    }

    const members = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .collect();
    const member = members.find((m) => m.name === memberName);
    if (!member) {
      throw new Error(`No member named "${memberName}" in gym ${gymId}.`);
    }

    if (!dryRun) {
      // Strips everything that makes the member send-capable, restoring hard
      // rule #5. lastVisit is left backdated on purpose: it is not a send-gate
      // field, and leaving it keeps the member on the At-Risk list where the
      // sales demo wants her.
      //
      // The consentAttestations row from prepare is NOT deleted. Consent
      // evidence is append-only by design everywhere else in this codebase
      // (see the members table comment in schema.ts on why members are archived
      // rather than deleted); a tool that erases its own audit trail is worse
      // than one that leaves a stale row explaining what happened.
      await ctx.db.patch(member._id, {
        phone: undefined,
        smsConsentConfirmed: undefined,
        smsConsentConfirmedAt: undefined,
        smsConsentSource: undefined,
        smsOptedOut: undefined,
        lastRetentionTextAt: undefined,
        winbackAttempts: undefined,
        winbackDormantAt: undefined,
      });
    }

    const remainingWithPhone = members.filter((m) => m._id !== member._id && !!m.phone).map((m) => m.name);

    return {
      mode: "revert" as const,
      dryRun: dryRun === true,
      member: member.name,
      hadPhone: !!member.phone,
      // Should be empty. If it isn't, hard rule #5 is still broken somewhere.
      otherMembersStillHoldingPhones: remainingWithPhone,
    };
  },
});
