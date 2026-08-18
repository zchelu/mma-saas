import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Duplicate-delivery guard for the CONNECT webhook stream.
//
// A SEPARATE TABLE FROM stripeWebhookEvents, and not because event ids could
// collide — Stripe's `evt_` ids are globally unique, so one table would work.
// It is for operational isolation (spec §1). The platform stream is
// load-bearing for provisioning a gym that has already paid; the dues stream
// must be purgeable, replayable and debuggable without any chance of disturbing
// it. Sharing a table would mean a "clear the Connect dedupe rows and replay"
// could take the platform stream's guard with it.
//
// Everything else mirrors convex/stripeEvents.ts deliberately. If you change
// the retention or cleanup rules there, ask whether they should change here —
// but note they are the same shape by coincidence of mechanism, not because
// they are the same control.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Bounded so cleanup can never blow up the transaction carrying a real account
// state change.
const CLEANUP_BATCH = 20;

// Atomically claims a Connect event id, returning true on first sight and false
// for a duplicate delivery. Check and insert are one mutation, so two
// concurrent retries cannot both read "unseen".
//
// Lives here rather than in convex/connectWebhookAction.ts because that file is
// "use node" (the Stripe SDK's constructEvent needs it) and Convex permits only
// actions in Node-runtime modules — no mutations, so no ctx.db.
export const claimConnectEventId = internalMutation({
  args: { eventId: v.string() },
  handler: async (ctx, { eventId }): Promise<boolean> => {
    const existing = await ctx.db
      .query("stripeConnectWebhookEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", eventId))
      .unique();
    if (existing) return false;

    const now = Date.now();
    await ctx.db.insert("stripeConnectWebhookEvents", { eventId, processedAt: now });

    // Opportunistic pruning instead of a cron. Runs only on a first delivery,
    // so duplicates stay cheap.
    const stale = await ctx.db
      .query("stripeConnectWebhookEvents")
      .withIndex("by_processed_at", (q) => q.lt("processedAt", now - RETENTION_MS))
      .take(CLEANUP_BATCH);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }

    return true;
  },
});

// Counterpart to claimConnectEventId, called when processing threw after the
// claim landed. Without this a transient failure would leave the id marked
// processed, and Stripe's retry — the whole recovery mechanism — would be
// discarded as a duplicate.
//
// That matters more here than on the platform stream. account.updated is the
// ONLY event that ever learns a connected account went live: embedded
// components never redirect, so there is no arrival signal, and the owner may
// have closed the panel long before Stripe finished reviewing. Swallow one
// retry and a gym can sit enabled at Stripe and "Setup incomplete" here with
// nothing scheduled to correct it.
export const releaseConnectEventId = internalMutation({
  args: { eventId: v.string() },
  handler: async (ctx, { eventId }) => {
    const existing = await ctx.db
      .query("stripeConnectWebhookEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", eventId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
