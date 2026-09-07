import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Duplicate-delivery guard for the MEMBER DUES webhook stream.
//
// A THIRD table, beside stripeWebhookEvents (platform) and
// stripeConnectWebhookEvents (Accounts v2). Not because `evt_` ids could
// collide — they are globally unique, so one table would serve all three. It is
// the same operational-isolation argument convex/stripeConnectEvents.ts makes,
// applied one level down.
//
// The two Connect streams are NOT one stream. The v2 account stream is the only
// thing that ever learns a gym went live; this one carries members' money.
// "Clear the dedupe rows and replay" is a thing someone will do to one of them
// while debugging, and it must not take the other's guard with it — replaying
// the account stream to fix a stuck "Setup incomplete" should not re-run a
// month of invoice events, and clearing dues rows should not risk a gym
// silently never going live.
//
// Note for whoever reads the older comments: the header on stripeConnectEvents
// .ts and the schema comment on stripeConnectWebhookEvents both call that table
// "the dues stream". They were written before this file existed and the label
// is wrong — that table is the ACCOUNT stream. The schema comment is corrected;
// this note is here in case a stale copy of the other survives somewhere.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Bounded so cleanup can never blow up the transaction carrying a real dues
// state change.
const CLEANUP_BATCH = 20;

// Atomically claims a dues event id, returning true on first sight and false for
// a duplicate delivery. Check and insert are one mutation, so two concurrent
// retries cannot both read "unseen".
//
// Lives here rather than in convex/connectDuesWebhookAction.ts because that file
// is "use node" (the Stripe SDK's constructEvent needs the Node crypto
// provider) and Convex permits only actions in Node-runtime modules — no
// mutations, so no ctx.db.
export const claimDuesEventId = internalMutation({
  args: { eventId: v.string() },
  handler: async (ctx, { eventId }): Promise<boolean> => {
    const existing = await ctx.db
      .query("stripeDuesWebhookEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", eventId))
      .unique();
    if (existing) return false;

    const now = Date.now();
    await ctx.db.insert("stripeDuesWebhookEvents", { eventId, processedAt: now });

    // Opportunistic pruning instead of a cron. Runs only on a first delivery, so
    // duplicates stay cheap.
    const stale = await ctx.db
      .query("stripeDuesWebhookEvents")
      .withIndex("by_processed_at", (q) => q.lt("processedAt", now - RETENTION_MS))
      .take(CLEANUP_BATCH);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }

    return true;
  },
});

// Counterpart to claimDuesEventId, called when processing threw after the claim
// landed. Without this a transient failure would leave the id marked processed
// and Stripe's retry — the whole recovery mechanism — would be discarded as a
// duplicate.
//
// The consequence here is money, not status. A dropped
// `checkout.session.completed` means a member entered a card and is never
// subscribed; a dropped `invoice.payment_failed` means duesFailedAt never fires
// and the at-risk signal that justifies putting payments in this product at all
// (spec §6) silently misses the member it exists to catch.
export const releaseDuesEventId = internalMutation({
  args: { eventId: v.string() },
  handler: async (ctx, { eventId }) => {
    const existing = await ctx.db
      .query("stripeDuesWebhookEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", eventId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
