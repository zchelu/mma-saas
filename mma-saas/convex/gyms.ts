import { QueryCtx, MutationCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";

// Shared helper: resolves the calling user's gym from their Clerk identity.
// Used by every members.ts / sendRetentionTexts.ts query+mutation that must
// stay scoped to a single gym's data.
export async function requireGym(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"gyms">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");

  const gym = await ctx.db
    .query("gyms")
    .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", identity.subject))
    .unique();

  if (!gym) throw new Error("No gym found for this account");
  return gym;
}
