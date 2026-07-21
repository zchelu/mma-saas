import { QueryCtx, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { ConvexError } from "convex/values";

// Statuses that unlock write access — deliberately the same set
// isProPlan/isElitePlan already treat as "really subscribed" in
// subscriptions.ts. Neither "inactive" (never subscribed) nor a lapsed
// "canceled"/"past_due" qualifies.
const WRITE_ALLOWED_STATUSES = new Set(["active", "trialing"]);

// requireGym blocks "inactive" gyms (never completed checkout — the default
// planStatus getOrCreateGym assigns before any Stripe purchase) outright,
// since they have no legitimate claim to gym-scoped data at all. Lapsed
// ("canceled"/"past_due") gyms are allowed past this check — see
// requireWriteAccess below for why.
// ConvexError, not a plain Error — production deployments redact plain Error
// messages to a generic "Server Error" before they reach the client (dev
// deployments don't, which is why this could look fine locally and still
// ship broken). ConvexError's .data payload survives the redaction, which is
// the only way the UI can show the real reason instead of a dead end.
function assertReadAccess(gym: Doc<"gyms">) {
  if (!gym.planStatus || gym.planStatus === "inactive") {
    throw new ConvexError("An active subscription is required to access this feature");
  }
}

// Shared helper: resolves the calling user's gym from their Clerk identity.
// Used by every members.ts / classes.ts / invoices.ts / attendance.ts /
// enrollments.ts query+mutation that must stay scoped to a single gym's
// data. Previously resolved identity + gym only, with no planStatus check at
// all — meaning any gym (never paid, canceled, past_due) had full CRUD
// access via a direct Convex call, bypassing the dashboard's UI-only
// planStatus redirect entirely. Now enforces read access here; mutations
// must additionally call requireWriteAccess (see below) since a
// canceled/past_due gym keeps read access (a grace-period view of its own
// existing data) but not write access.
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
  assertReadAccess(gym);
  return gym;
}

// Call after requireGym() in every mutation that creates, edits, or deletes
// gym-scoped data. A canceled/past_due gym still passes requireGym (can view
// its existing members/classes/invoices/attendance — a grace-period read,
// e.g. to export data before deciding whether to resubscribe) but is blocked
// here from making any change until billing is reactive again. "inactive"
// gyms never reach this point at all — requireGym already rejected them.
export function requireWriteAccess(gym: Doc<"gyms">): void {
  if (!gym.planStatus || !WRITE_ALLOWED_STATUSES.has(gym.planStatus)) {
    // ConvexError, not a plain Error — see assertReadAccess above.
    throw new ConvexError(
      "Your subscription isn't active — reactivate billing to make changes. You can still view your existing data."
    );
  }
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
