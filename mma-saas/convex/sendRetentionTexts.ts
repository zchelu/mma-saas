// Required environment variables (set in .env.local AND Convex dashboard > Settings > Environment Variables):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_PHONE_NUMBER

import { internalAction, internalMutation, internalQuery, mutation, ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireGym, requireWriteAccess, hasWriteAccess } from "./gyms";
import { assertMaxLength } from "./validate";

const MAX_MESSAGE_LENGTH = 480; // ~3 SMS segments once the STOP footer is appended

// Winback attempts a member gets per cold streak before going dormant. Paired
// with the per-member 7-day gate below, that's ~three weeks of outreach.
export const MAX_WINBACK_ATTEMPTS = 3;

export const getAtRiskMembers = internalQuery({
  args: { gymId: v.id("gyms") },
  handler: async (ctx, { gymId }) => {
    const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const sevenDaysAgoISO = new Date(sevenDaysAgoMs).toISOString();
    const all = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .collect();
    return all.filter((m) => {
      // smsConsentConfirmed gate: the public `add`/`update` mutations only
      // ever let a phone number in alongside confirmed consent, so this was
      // previously implied rather than checked here. That invariant breaks
      // for members created by scripts/import-members.js's bulk import path
      // (migrated CSV data has no proof consent was obtained) — check it
      // explicitly so an imported phone number can't get texted until a gym
      // owner confirms consent by editing + re-saving that member.
      if (!m.phone || !m.smsConsentConfirmed || m.status !== "active" || m.smsOptedOut) return false;
      const inactiveEnough = !m.lastVisit || m.lastVisit < sevenDaysAgoISO;
      const notRecentlyTexted = !m.lastRetentionTextAt || m.lastRetentionTextAt < sevenDaysAgoMs;
      // Termination cap, layered on top of (not replacing) the 7-day cadence
      // gate above: three confirmed sends over ~three weeks, then we leave
      // them alone permanently. Undefined counts as 0, so members predating
      // the field get all three attempts. Cleared by members.ts:checkIn, so
      // a member who comes back and lapses again starts a clean sequence.
      const attemptsLeft = (m.winbackAttempts ?? 0) < MAX_WINBACK_ATTEMPTS;
      return inactiveEnough && notRecentlyTexted && attemptsLeft;
    });
  },
});

// The single write that records a delivered winback text. Called from exactly
// one place — inside sendRetentionTextsCore's `if (res.ok)` branch, after
// Twilio has accepted the message — so the attempt counter can only advance on
// a confirmed send. A non-ok response or a thrown fetch never reaches here, and
// therefore never burns one of the member's three attempts.
//
// Cadence and cap are set in the same patch deliberately: they were never two
// writes, and keeping them in one transaction means there's no window where a
// member is marked as texted but not counted (or counted twice).
export const recordRetentionText = internalMutation({
  args: { memberId: v.id("members"), gymId: v.id("gyms") },
  handler: async (ctx, { memberId, gymId }) => {
    const member = await ctx.db.get(memberId);
    // gymId is passed and checked rather than trusted from the caller's loop
    // so this internal mutation can't be made to write across gym boundaries.
    if (!member || member.gymId !== gymId) throw new Error("Member not found");

    const attempts = (member.winbackAttempts ?? 0) + 1;
    await ctx.db.patch(memberId, {
      lastRetentionTextAt: Date.now(),
      winbackAttempts: attempts,
      // Stamped on the write that reaches the cap, so winbackDormantAt always
      // means "when the third text went out".
      ...(attempts >= MAX_WINBACK_ATTEMPTS ? { winbackDormantAt: Date.now() } : {}),
    });
  },
});

// Bounds how many texts a single run (automated or manual) will send. A large
// at-risk backlog gets spread across subsequent runs instead of firing
// unbounded SMS in one shot — real cost and Twilio rate-limit protection.
const MAX_TEXTS_PER_RUN = 200;

// Minimum time between actual send runs for a single gym, regardless of
// trigger path. Defense in depth beneath both the per-member 7-day
// lastRetentionTextAt gate and the daily cron schedule itself — protects
// against a double-fired cron, a scripted/looped call to the manual
// mutation, or two racing manual triggers, any of which would otherwise
// re-run the at-risk query and could send duplicate texts (real Twilio cost,
// and a TCPA problem if it defeats the per-member 7-day cap).
const RETENTION_RUN_COOLDOWN_MS = 15 * 60 * 1000;

// Atomically checks and claims the per-gym run lock in one transaction —
// Convex serializes mutations touching the same document, so two concurrent
// callers can't both read "not cooling down" before either writes the claim.
export const claimRetentionRunLock = internalMutation({
  args: { gymId: v.id("gyms") },
  handler: async (ctx, { gymId }) => {
    const gym = await ctx.db.get(gymId);
    if (!gym) return false;
    const now = Date.now();
    if (gym.lastRetentionRunAt && now - gym.lastRetentionRunAt < RETENTION_RUN_COOLDOWN_MS) {
      return false;
    }
    await ctx.db.patch(gymId, { lastRetentionRunAt: now });
    return true;
  },
});

// Counterpart to claimRetentionRunLock — clears the claim so a run that
// failed systemically (bad/missing Twilio credentials, Twilio outage) doesn't
// leave a gym locked out of retries for the full cooldown window. Only called
// when a run achieved zero successful sends; a run with at least one success
// keeps its claim, since the successful sends are already protected from
// re-texting by the per-member 7-day cap and don't need an immediate retry.
export const releaseRetentionRunLock = internalMutation({
  args: { gymId: v.id("gyms") },
  handler: async (ctx, { gymId }) => {
    await ctx.db.patch(gymId, { lastRetentionRunAt: undefined });
  },
});

// Reports how many sends were attempted vs actually succeeded so callers that
// hold the run-lock (sendRetentionTextsForGym below) can tell a systemic
// failure (bad credentials, Twilio outage — zero successes) apart from
// normal partial failure (a few bad numbers among an otherwise healthy
// batch), and release the lock only for the former.
async function sendRetentionTextsCore(
  ctx: ActionCtx,
  gymId: Id<"gyms">,
  gymName: string,
  customMessage?: string
): Promise<{ attempted: number; succeeded: number }> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    console.error("Missing Twilio env vars — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER");
    return { attempted: 0, succeeded: 0 };
  }

  const atRisk = await ctx.runQuery(internal.sendRetentionTexts.getAtRiskMembers, { gymId });
  const members = atRisk.slice(0, MAX_TEXTS_PER_RUN);
  if (atRisk.length > members.length) {
    console.log(`Gym ${gymId}: ${atRisk.length} at-risk members, capping this run to ${members.length}`);
  }

  const credentials = btoa(`${accountSid}:${authToken}`);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  let succeeded = 0;

  await Promise.all(members.map(async (member) => {
    const firstName = member.name.trim().split(/\s+/)[0];
    // {name} is an optional per-recipient token in a gym owner's custom
    // message (sendManualRetentionTextsForGym) — the automated cron path
    // never passes customMessage, so it always gets the original default
    // wording untouched. The opt-out footer is always appended server-side,
    // never left to the composed text, so an owner can't accidentally ship a
    // message with no STOP instructions (TCPA requirement).
    const body = customMessage
      ? `${customMessage.replace(/\{name\}/gi, firstName)} Reply STOP to opt out.`
      : `Hey ${firstName}, we missed you at the gym! Come back this week and keep that momentum going. - ${gymName}. Reply STOP to opt out.`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: member.phone!, From: fromNumber, Body: body }),
      });

      if (res.ok) {
        console.log(`SMS sent to ${member.name} (${member.phone})`);
        await ctx.runMutation(internal.sendRetentionTexts.recordRetentionText, { memberId: member._id, gymId });
        succeeded++;
      } else {
        const text = await res.text();
        console.error(`Failed for ${member.name}: ${text}`);
      }
    } catch (e) {
      console.error(`Error sending to ${member.name}:`, e);
    }
  }));

  return { attempted: members.length, succeeded };
}

// Automated cron path — every subscribed gym gets it, all three tiers alike;
// the only gate left is whether billing is actually active (same bar as any
// gym-scoped write, see hasWriteAccess).
export const sendRetentionTextsForGym = internalAction({
  args: { gymId: v.id("gyms") },
  handler: async (ctx, { gymId }) => {
    const gym = await ctx.runQuery(internal.subscriptions.getGymById, { gymId });
    if (!gym || !hasWriteAccess(gym)) {
      console.log(`Gym ${gymId} is not actively subscribed — skipping automated retention texts`);
      return;
    }
    const claimed = await ctx.runMutation(internal.sendRetentionTexts.claimRetentionRunLock, { gymId });
    if (!claimed) {
      console.log(`Gym ${gymId}: retention run cooldown active — skipping automated run`);
      return;
    }
    const { attempted, succeeded } = await sendRetentionTextsCore(ctx, gymId, gym.name ?? "your gym");
    if (succeeded === 0) {
      // Zero successes out of a non-empty attempt (or a config error before
      // any attempt) means the failure is systemic, not a few bad numbers —
      // don't let it burn the gym's cooldown and block a legitimate retry.
      console.error(`Gym ${gymId}: retention run had ${attempted} attempted sends and 0 successes — releasing run lock`);
      await ctx.runMutation(internal.sendRetentionTexts.releaseRetentionRunLock, { gymId });
    }
  },
});

// Manual "Send Retention Texts" button path — available to every subscribed
// gym, same as the automated path above; both read the same billing-status
// gate now that texting isn't tiered.
export const sendManualRetentionTextsForGym = internalAction({
  args: { gymId: v.id("gyms"), message: v.string() },
  handler: async (ctx, { gymId, message }) => {
    const gym = await ctx.runQuery(internal.subscriptions.getGymById, { gymId });
    if (!gym || !hasWriteAccess(gym)) {
      console.log(`Gym ${gymId} is not actively subscribed — skipping manual retention texts`);
      return;
    }
    const { attempted, succeeded } = await sendRetentionTextsCore(ctx, gymId, gym.name ?? "your gym", message);
    if (succeeded === 0) {
      // Mirrors sendRetentionTextsForGym's fix: triggerRetentionTexts claims
      // the run lock synchronously before scheduling this action, so a
      // systemic failure here would otherwise burn the manual-send cooldown
      // the same way it did on the automatic path.
      console.error(`Gym ${gymId}: manual retention run had ${attempted} attempted sends and 0 successes — releasing run lock`);
      await ctx.runMutation(internal.sendRetentionTexts.releaseRetentionRunLock, { gymId });
    }
  },
});

// Cron entry point — fans out to every actively-subscribed gym individually
// so one gym's status never gates or blends into another gym's retention texts.
export const sendRetentionTextsSMS = internalAction({
  args: {},
  handler: async (ctx) => {
    const textableGyms = await ctx.runQuery(internal.subscriptions.listTextableGyms);
    for (const gym of textableGyms) {
      await ctx.runAction(internal.sendRetentionTexts.sendRetentionTextsForGym, { gymId: gym._id });
    }
  },
});

// Manual "Send Retention Texts" button — scoped to the caller's own gym.
// requireWriteAccess is the same gate every other gym-scoped write goes
// through (members.add, classes.add, etc.) — texting isn't tier-gated
// anymore, but a canceled/past_due gym still can't trigger it, same as it
// can't create a member. Enforced here (not just hidden in the UI) so a
// direct call to this mutation can't bypass that the way relying solely on
// the downstream action's silent no-op would.
export const triggerRetentionTexts = mutation({
  args: { message: v.string() },
  handler: async (ctx, { message }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);

    const trimmed = message.trim();
    if (!trimmed) throw new Error("Message can't be empty");
    assertMaxLength(trimmed, MAX_MESSAGE_LENGTH, "Message");

    // Claimed synchronously here (not left to the scheduled action) so a
    // double-click or a scripted loop gets an immediate rejection instead of
    // silently no-op-ing after the fact, and so two racing calls can't both
    // pass the check before either claims — this mutation and the doc it
    // patches are the same transaction.
    const now = Date.now();
    if (gym.lastRetentionRunAt && now - gym.lastRetentionRunAt < RETENTION_RUN_COOLDOWN_MS) {
      const waitMin = Math.ceil((RETENTION_RUN_COOLDOWN_MS - (now - gym.lastRetentionRunAt)) / 60_000);
      throw new Error(`Retention texts were just sent — please wait ${waitMin} more minute(s) before sending again.`);
    }
    await ctx.db.patch(gym._id, { lastRetentionRunAt: now });

    await ctx.scheduler.runAfter(0, internal.sendRetentionTexts.sendManualRetentionTextsForGym, {
      gymId: gym._id,
      message: trimmed,
    });
  },
});
