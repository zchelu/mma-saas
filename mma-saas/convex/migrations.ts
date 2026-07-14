import { mutation } from "./_generated/server";
import { v } from "convex/values";

// One-time backfill: ensures a gyms row exists for the given owner and that
// every pre-multi-tenancy members row (gymId === undefined) gets pointed at it.
// Safe to re-run — only touches rows missing data, never overwrites existing gymId.
//
// Run via: npx convex run migrations:backfillFirstGym '{"clerkUserId":"user_xxx","gymName":"KombatDesk"}'
export const backfillFirstGym = mutation({
  args: { clerkUserId: v.string(), gymName: v.string() },
  handler: async (ctx, { clerkUserId, gymName }) => {
    const existingGym = await ctx.db
      .query("gyms")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    let gymId;
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

    const members = await ctx.db.query("members").collect();
    let updated = 0;
    for (const member of members) {
      if (member.gymId === undefined) {
        await ctx.db.patch(member._id, { gymId });
        updated++;
      }
    }

    return { gymId, membersUpdated: updated, totalMembers: members.length };
  },
});
