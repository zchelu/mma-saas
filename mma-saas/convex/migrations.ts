import { mutation, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";

// Shared by every table that has an optional gymId field awaiting backfill.
async function backfillGymId(
  ctx: MutationCtx,
  table: "members" | "classes" | "invoices",
  gymId: Id<"gyms">
) {
  const docs = await ctx.db.query(table).collect();
  let updated = 0;
  for (const doc of docs) {
    if (doc.gymId === undefined) {
      await ctx.db.patch(doc._id, { gymId });
      updated++;
    }
  }
  return { updated, total: docs.length };
}

// One-time backfill: ensures a gyms row exists for the given owner and that
// every pre-multi-tenancy members/classes/invoices row (gymId === undefined)
// gets pointed at it. Safe to re-run — only touches rows missing data, never
// overwrites an existing gymId.
//
// SAFETY: this assumes single-tenant history — every currently-orphaned row
// belongs to the ONE gym being backfilled. That's only true the first time
// this runs, before a second gym has ever created its own classes/invoices.
// Refuses to run once more than one gym exists, since at that point a blind
// "assign every orphaned row to this gymId" would misattribute a different
// gym's data. If that ever legitimately happens, backfill by hand per table
// instead of via this mutation.
//
// Run via: npx convex run migrations:backfillFirstGym '{"clerkUserId":"user_xxx","gymName":"KombatDesk"}'
export const backfillFirstGym = mutation({
  args: { clerkUserId: v.string(), gymName: v.string() },
  handler: async (ctx, { clerkUserId, gymName }) => {
    const allGyms = await ctx.db.query("gyms").collect();
    const existingGym = allGyms.find((g) => g.clerkUserId === clerkUserId);

    // Any orphaned row predates gym-scoping entirely, so it can only safely
    // be attributed to a single gym if that's the only gym that has ever
    // existed — a second gym (however it was created, including one newly
    // inserted by this very call) never has orphaned rows of its own, since
    // gymId is always set going forward. Safe iff every existing gym IS the
    // one being backfilled — i.e. there are no *other* gyms at all, whether
    // this call is reusing an existing gym or is about to create a new one.
    const otherGyms = allGyms.filter((g) => g._id !== existingGym?._id);
    if (otherGyms.length > 0) {
      throw new Error(
        `Refusing to backfill: ${otherGyms.length} other gym(s) already exist besides the target. ` +
          "This mutation assumes single-tenant history — a blind backfill now could misattribute another gym's data. Backfill by hand instead."
      );
    }

    let gymId: Id<"gyms">;
    if (existingGym) {
      gymId = existingGym._id;
      const patch: Record<string, unknown> = {};
      if (!existingGym.name) patch.name = gymName;
      if (!existingGym.createdAt) patch.createdAt = Date.now();
      if (Object.keys(patch).length > 0) await ctx.db.patch(gymId, patch);
    } else {
      gymId = await ctx.db.insert("gyms", {
        clerkUserId,
        name: gymName,
        plan: "starter",
        planStatus: "active",
        createdAt: Date.now(),
      });
    }

    const members = await backfillGymId(ctx, "members", gymId);
    const classes = await backfillGymId(ctx, "classes", gymId);
    const invoices = await backfillGymId(ctx, "invoices", gymId);

    return {
      gymId,
      membersUpdated: members.updated,
      totalMembers: members.total,
      classesUpdated: classes.updated,
      totalClasses: classes.total,
      invoicesUpdated: invoices.updated,
      totalInvoices: invoices.total,
    };
  },
});
