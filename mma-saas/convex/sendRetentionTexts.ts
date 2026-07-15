// Required environment variables (set in .env.local AND Convex dashboard > Settings > Environment Variables):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_PHONE_NUMBER

import { internalAction, internalMutation, internalQuery, mutation, ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireGym } from "./gyms";
import { isProPlan, isElitePlan } from "./subscriptions";

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
      if (!m.phone || m.status !== "active") return false;
      const inactiveEnough = !m.lastVisit || m.lastVisit < sevenDaysAgoISO;
      const notRecentlyTexted = !m.lastRetentionTextAt || m.lastRetentionTextAt < sevenDaysAgoMs;
      return inactiveEnough && notRecentlyTexted;
    });
  },
});

export const recordRetentionText = internalMutation({
  args: { memberId: v.id("members") },
  handler: async (ctx, { memberId }) => {
    await ctx.db.patch(memberId, { lastRetentionTextAt: Date.now() });
  },
});

// Bounds how many texts a single run (automated or manual) will send. A large
// at-risk backlog gets spread across subsequent runs instead of firing
// unbounded SMS in one shot — real cost and Twilio rate-limit protection.
const MAX_TEXTS_PER_RUN = 200;

async function sendRetentionTextsCore(ctx: ActionCtx, gymId: Id<"gyms">, gymName: string) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    console.error("Missing Twilio env vars — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER");
    return;
  }

  const atRisk = await ctx.runQuery(internal.sendRetentionTexts.getAtRiskMembers, { gymId });
  const members = atRisk.slice(0, MAX_TEXTS_PER_RUN);
  if (atRisk.length > members.length) {
    console.log(`Gym ${gymId}: ${atRisk.length} at-risk members, capping this run to ${members.length}`);
  }

  const credentials = btoa(`${accountSid}:${authToken}`);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  await Promise.all(members.map(async (member) => {
    const firstName = member.name.trim().split(/\s+/)[0];
    const body = `Hey ${firstName}, we missed you at the gym! Come back this week and keep that momentum going. - ${gymName}. Reply STOP to opt out.`;

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
        await ctx.runMutation(internal.sendRetentionTexts.recordRetentionText, { memberId: member._id });
      } else {
        const text = await res.text();
        console.error(`Failed for ${member.name}: ${text}`);
      }
    } catch (e) {
      console.error(`Error sending to ${member.name}:`, e);
    }
  }));
}

// Automated cron path — Pro/Elite only. Automation is the paid differentiator;
// the manual button below is available to any active plan, including Starter.
export const sendRetentionTextsForGym = internalAction({
  args: { gymId: v.id("gyms") },
  handler: async (ctx, { gymId }) => {
    const gym = await ctx.runQuery(internal.subscriptions.getGymById, { gymId });
    if (!gym || !isProPlan(gym)) {
      console.log(`Gym ${gymId} is not an active Pro/Elite gym — skipping automated retention texts`);
      return;
    }
    await sendRetentionTextsCore(ctx, gymId, gym.name ?? "your gym");
  },
});

// Manual "Send Retention Texts" button path — Elite only. Starter gets no
// texting at all; Pro gets automatic only; Elite gets both.
export const sendManualRetentionTextsForGym = internalAction({
  args: { gymId: v.id("gyms") },
  handler: async (ctx, { gymId }) => {
    const gym = await ctx.runQuery(internal.subscriptions.getGymById, { gymId });
    if (!gym || !isElitePlan(gym)) {
      console.log(`Gym ${gymId} is not an active Elite gym — skipping manual retention texts`);
      return;
    }
    await sendRetentionTextsCore(ctx, gymId, gym.name ?? "your gym");
  },
});

// Cron entry point — fans out to every active Pro/Elite gym individually so
// one gym's plan never gates or blends into another gym's retention texts.
export const sendRetentionTextsSMS = internalAction({
  args: {},
  handler: async (ctx) => {
    const proGyms = await ctx.runQuery(internal.subscriptions.listProGyms);
    for (const gym of proGyms) {
      await ctx.runAction(internal.sendRetentionTexts.sendRetentionTextsForGym, { gymId: gym._id });
    }
  },
});

// Manual "Send Retention Texts" button — scoped to the caller's own gym, and
// rejected outright for anything but an active Elite plan. Enforced here (not
// just hidden in the UI) so a direct call to this mutation can't bypass the
// Elite gate the way relying solely on the downstream action's silent no-op
// would.
export const triggerRetentionTexts = mutation({
  args: {},
  handler: async (ctx) => {
    const gym = await requireGym(ctx);
    if (!isElitePlan(gym)) {
      throw new Error("Manual retention texts are an Elite-plan feature");
    }
    await ctx.scheduler.runAfter(0, internal.sendRetentionTexts.sendManualRetentionTextsForGym, { gymId: gym._id });
  },
});
