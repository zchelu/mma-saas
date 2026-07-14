// Required environment variables (set in .env.local AND Convex dashboard > Settings > Environment Variables):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_PHONE_NUMBER

import { internalAction, internalMutation, internalQuery, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { requireGym } from "./gyms";
import { isProPlan } from "./subscriptions";

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

export const sendRetentionTextsForGym = internalAction({
  args: { gymId: v.id("gyms") },
  handler: async (ctx, { gymId }) => {
    const gym = await ctx.runQuery(internal.subscriptions.getGymById, { gymId });
    if (!gym || !isProPlan(gym)) {
      console.log(`Gym ${gymId} is not an active Pro/Elite gym — skipping automated retention texts`);
      return;
    }
    const gymName = gym.name ?? "your gym";

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;

    if (!accountSid || !authToken || !fromNumber) {
      console.error("Missing Twilio env vars — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER");
      return;
    }

    const members = await ctx.runQuery(internal.sendRetentionTexts.getAtRiskMembers, { gymId });
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

// Manual "Send Retention Texts" button — scoped to the caller's own gym only.
export const triggerRetentionTexts = mutation({
  args: {},
  handler: async (ctx) => {
    const gym = await requireGym(ctx);
    await ctx.scheduler.runAfter(0, internal.sendRetentionTexts.sendRetentionTextsForGym, { gymId: gym._id });
  },
});
