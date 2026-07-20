import { QueryCtx, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";

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

// Non-throwing counterpart to requireGym, for dashboard stat-card reads that
// fire during the brief window right after a Stripe->/welcome->/dashboard
// redirect, before Clerk's client-side session has finished hydrating. An
// unauthenticated instant there is expected, not exceptional — throwing
// crashes the whole page with no loading state or error boundary to catch it.
export async function tryGetGym(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"gyms"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  return await ctx.db
    .query("gyms")
    .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", identity.subject))
    .unique();
}

// Shared ownership checks — throw for mutations and any read where a missing/
// foreign-gym doc should hard-fail. Read paths that need to degrade
// gracefully (e.g. a page that already handles "not found" for a sibling
// query) should do their own inline check instead of calling these.
export async function requireOwnClass(
  ctx: QueryCtx | MutationCtx,
  gymId: Id<"gyms">,
  classId: Id<"classes">
): Promise<Doc<"classes">> {
  const cls = await ctx.db.get(classId);
  if (!cls || cls.gymId !== gymId) throw new Error("Class not found");
  return cls;
}

export async function requireOwnMember(
  ctx: QueryCtx | MutationCtx,
  gymId: Id<"gyms">,
  memberId: Id<"members">
): Promise<Doc<"members">> {
  const member = await ctx.db.get(memberId);
  if (!member || member.gymId !== gymId) throw new Error("Member not found");
  return member;
}
