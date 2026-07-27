import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Retention for the Stripe duplicate-delivery guard. Deliberately much shorter
// than convex/twilioInbound.ts's year: that table IS Twilio's replay
// protection, whereas Stripe's constructEvent already bounds replay to a ~5
// minute signature tolerance. This only has to outlive Stripe's retry window,
// which tops out around 3 days. Do not copy the 365 across — they are different
// controls that happen to share a shape.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Bounded so cleanup can never blow up the transaction carrying a real billing
// state change.
const CLEANUP_BATCH = 20;

// Atomically claims a Stripe event id, returning true on first sight and false
// for a duplicate delivery. Check and insert are one mutation, so two
// concurrent retries can't both read "unseen". Same pattern as
// convex/sendRetentionTexts.ts:claimRetentionRunLock.
//
// Lives here rather than in convex/stripeWebhookAction.ts because that file is
// "use node" (the Stripe SDK's constructEvent needs it) and Convex only permits
// actions in Node-runtime modules — no mutations, so no ctx.db.
export const claimEventId = internalMutation({
  args: { eventId: v.string() },
  handler: async (ctx, { eventId }): Promise<boolean> => {
    const existing = await ctx.db
      .query("stripeWebhookEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", eventId))
      .unique();
    if (existing) return false;

    const now = Date.now();
    await ctx.db.insert("stripeWebhookEvents", { eventId, processedAt: now });

    // Opportunistic pruning instead of a cron, same as convex/twilioInbound.ts.
    // Runs only on a first delivery, so duplicates stay cheap.
    const stale = await ctx.db
      .query("stripeWebhookEvents")
      .withIndex("by_processed_at", (q) => q.lt("processedAt", now - RETENTION_MS))
      .take(CLEANUP_BATCH);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }

    return true;
  },
});

// Counterpart to claimEventId, called when processing threw after the claim
// landed. Without this a transient failure (a Stripe API blip during the
// re-fetch) would leave the id marked processed, and Stripe's retry — which is
// the whole recovery mechanism — would be discarded as a duplicate. The event
// would then be lost permanently, with a paying customer's billing state
// silently stale. Mirrors sendRetentionTexts.ts:releaseRetentionRunLock.
export const releaseEventId = internalMutation({
  args: { eventId: v.string() },
  handler: async (ctx, { eventId }) => {
    const existing = await ctx.db
      .query("stripeWebhookEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", eventId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
