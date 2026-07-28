import { query, internalQuery } from "./_generated/server";
import { QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { tryGetReadableGym } from "./gyms";

async function fetchWinbackRecoveries(ctx: QueryCtx, gymId: Id<"gyms">, startMs: number, endMs: number) {
  const rows = await ctx.db
    .query("winbackRecoveries")
    .withIndex("by_gym_returnedAt", (q) =>
      q.eq("gymId", gymId).gte("returnedAt", startMs).lte("returnedAt", endMs)
    )
    .collect();

  const recoveries = await Promise.all(
    rows.map(async (r) => {
      const member = await ctx.db.get(r.memberId);
      return {
        memberId: r.memberId,
        name: member?.name ?? "Unknown Member",
        returnedAt: r.returnedAt,
        lastTextedAt: r.lastTextedAt,
        attemptsUsed: r.attemptsUsed,
        daysToReturn: r.daysToReturn,
      };
    })
  );

  recoveries.sort((a, b) => b.returnedAt - a.returnedAt);
  return { count: recoveries.length, recoveries };
}

// Given a gym and a date range, exactly who came back after a winback text
// and how long it took — the number Zain reads out loud on a day-14 call.
// Auth-scoped like getDormantMembers: requireGym resolves the caller's own
// gym, and the passed gymId must match it, so this can't be pointed at
// another gym's roster.
//
// memberId is never cascade-deleted (see winbackRecoveries in schema.ts), so
// a member removed after being won back still counts — falls back to
// "Unknown Member" the same way invoices.getAll does, rather than dropping
// the row and retroactively shrinking a number that may already have been
// quoted to the gym owner.
export const getWinbackRecoveries = query({
  args: { gymId: v.id("gyms"), startMs: v.number(), endMs: v.number() },
  handler: async (ctx, { gymId, startMs, endMs }) => {
    const gym = await tryGetReadableGym(ctx);
    if (!gym) return { count: 0, recoveries: [] };
    if (gym._id !== gymId) throw new Error("Gym not found");
    return fetchWinbackRecoveries(ctx, gymId, startMs, endMs);
  },
});

// Internal counterpart for convex/winbackReportEmail.ts's cron job — that
// action iterates every textable gym server-side with no caller identity to
// check against (there's no signed-in user in a cron run), so it can't go
// through requireGym the way the dashboard-facing query above does. Trusted
// caller only (ctx.runQuery from within this deployment), same reasoning as
// sendRetentionTexts.ts's internal getAtRiskMembers.
export const getWinbackRecoveriesInternal = internalQuery({
  args: { gymId: v.id("gyms"), startMs: v.number(), endMs: v.number() },
  handler: async (ctx, { gymId, startMs, endMs }) => fetchWinbackRecoveries(ctx, gymId, startMs, endMs),
});
