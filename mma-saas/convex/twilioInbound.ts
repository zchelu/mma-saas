import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Retention for the replay-protection table. This value is NOT a free knob: the
// table is what makes a replayed Twilio POST a no-op, so shortening it reopens
// the replay window for anything older. One year because inbound volume here is
// tiny (opt-out/opt-in keywords only — this is not a conversational number), so
// the row count stays negligible for the security it buys. Shorten only if the
// table ever becomes a real cost, and understand what you're trading.
const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

// Bounded so cleanup can never blow up the transaction that carries a real
// opt-out. Steady state deletes at most one row per message anyway; a backlog
// drains a few at a time across subsequent messages.
const CLEANUP_BATCH = 20;

// Atomically claims a Twilio MessageSid, returning true if this is the first
// time we've seen it and false if it's a replay. Check and insert happen in one
// mutation, which is one transaction — Convex serializes mutations touching the
// same document, so two concurrent replays can't both read "unseen" before
// either writes the claim. Same pattern and reasoning as
// convex/sendRetentionTexts.ts:claimRetentionRunLock.
//
// Lives here rather than in convex/twilioWebhookAction.ts because that file is
// "use node" (it needs Node's crypto for HMAC-SHA1 + timingSafeEqual) and
// Convex only permits actions in Node-runtime modules — no mutations, so no
// ctx.db. Same split, same reason, as http.ts vs the webhook action files.
export const claimMessageSid = internalMutation({
  args: { messageSid: v.string() },
  handler: async (ctx, { messageSid }): Promise<boolean> => {
    const existing = await ctx.db
      .query("twilioInboundMessages")
      .withIndex("by_message_sid", (q) => q.eq("messageSid", messageSid))
      .unique();
    if (existing) return false;

    const now = Date.now();
    await ctx.db.insert("twilioInboundMessages", { messageSid, processedAt: now });

    // Opportunistic pruning instead of a cron: keeps the cleanup path in the
    // same file as the thing it cleans up, and avoids touching convex/crons.ts.
    // Runs only on a first delivery (replays return above), so it costs nothing
    // on the duplicate path this table exists to catch.
    const stale = await ctx.db
      .query("twilioInboundMessages")
      .withIndex("by_processed_at", (q) => q.lt("processedAt", now - RETENTION_MS))
      .take(CLEANUP_BATCH);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }

    return true;
  },
});
