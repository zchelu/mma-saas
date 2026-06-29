// Required environment variables (set in .env.local AND Convex dashboard > Settings > Environment Variables):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_PHONE_NUMBER

import { internalAction, internalQuery, mutation } from "./_generated/server";
import { internal } from "./_generated/api";


const GYM_NAME = "KombatDesk";

export const getAtRiskMembers = internalQuery({
  args: {},
  handler: async (ctx) => {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const threshold = sevenDaysAgo.toISOString();
    const all = await ctx.db.query("members").collect();
    return all.filter(
      (m) => !!m.phone && m.status === "active" && (!m.lastVisit || m.lastVisit < threshold)
    );
  },
});

export const sendRetentionTextsSMS = internalAction({
  args: {},
  handler: async (ctx) => {
    const isPro = await ctx.runQuery(internal.subscriptions.hasProGym);
    if (!isPro) {
      console.log("No active Pro gym — skipping automated retention texts");
      return;
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;

    if (!accountSid || !authToken || !fromNumber) {
      console.error("Missing Twilio env vars — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER");
      return;
    }

    const members = await ctx.runQuery(internal.sendRetentionTexts.getAtRiskMembers);
    const credentials = btoa(`${accountSid}:${authToken}`);
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

    await Promise.all(members.map(async (member) => {
      const firstName = member.name.trim().split(/\s+/)[0];
      const body = `Hey ${firstName}, we missed you at the gym! Come back this week and keep that momentum going. - ${GYM_NAME}. Reply STOP to opt out.`;

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

export const triggerRetentionTexts = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    await ctx.scheduler.runAfter(0, internal.sendRetentionTexts.sendRetentionTextsSMS);
  },
});
