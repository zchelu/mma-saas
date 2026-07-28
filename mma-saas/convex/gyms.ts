import { query, QueryCtx, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";

// Statuses that unlock write access. Neither "inactive" (never subscribed)
// nor a lapsed "canceled"/"past_due" qualifies. Also the definition of
// "actually subscribed" for retention texting (convex/sendRetentionTexts.ts)
// now that texting access no longer depends on plan tier — every
// academy/fightteam/blackbelt gym gets the same access, gated only on
// whether billing is live.
const WRITE_ALLOWED_STATUSES = new Set(["active", "trialing"]);

export function hasWriteAccess(gym: { planStatus?: string }): boolean {
  return !!gym.planStatus && WRITE_ALLOWED_STATUSES.has(gym.planStatus);
}

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
function hasReadAccess(gym: { planStatus?: string }): boolean {
  return !!gym.planStatus && gym.planStatus !== "inactive";
}

function assertReadAccess(gym: Doc<"gyms">) {
  if (!hasReadAccess(gym)) {
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
  if (!hasWriteAccess(gym)) {
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

// For QUERIES rendered inside "use client" components via useQuery. Separates
// the two reasons requireGym can fail, which are NOT the same kind of event:
//
//   TRANSIENT -> return null, caller renders its empty state:
//     - no identity yet  (Clerk's client-side session is still hydrating)
//     - no gyms row yet  (getOrCreateGym is still provisioning a new signup)
//   Both are expected instants during a normal load. requireGym threw a plain
//   Error here, prod redacted it to a generic "Server Error", and with no
//   error boundary that took down /dashboard, /classes and /invoices.
//
//   PERSISTENT -> still throws, unchanged:
//     - gym exists but has no read access (never subscribed)
//   This is a real permission state, not a loading instant. It must keep
//   throwing the ConvexError so the UI can show "An active subscription is
//   required" — collapsing it into an empty list would show a paying-to-be
//   customer an empty roster and imply their data vanished. It also preserves
//   the read gate added in the 7739cd4 security audit; a bare tryGetGym swap
//   would have dropped it and served full member/class/invoice records to
//   unpaid accounts. convex/planStatus.test.ts locks this in.
//
// MUTATIONS MUST KEEP USING requireGym. Throwing there is the tenant-isolation
// gate, it is the correct behaviour, and a mutation has no route to crash.
export async function tryGetReadableGym(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"gyms"> | null> {
  const gym = await tryGetGym(ctx);
  if (!gym) return null;
  assertReadAccess(gym);
  return gym;
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

function slugifyGymName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "gym";
}

// 3 random bytes -> 6 lowercase base36 chars, only used as a disambiguating
// suffix (see below) — collision odds within one retry loop are irrelevant
// since the loop itself re-checks by_slug either way.
function randomSlugSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36)).join("").slice(0, 6);
}

// Human-readable, never the raw Convex document id — this is what ends up in
// a URL a gym owner pastes into an email/text (see /consent/[gymSlug]).
// First attempt is the bare slugified name with no suffix, so the common
// case (one gym per name) gets a clean "colorado-springs-bjj" rather than
// always carrying a random tail; only a genuine collision (two gyms
// slugifying to the same base) falls through to a suffixed retry, checked
// against by_slug the same way generateUniqueCheckInToken checks
// by_check_in_token.
export async function generateGymSlug(ctx: MutationCtx, name: string): Promise<string> {
  const base = slugifyGymName(name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${randomSlugSuffix()}`;
    const collision = await ctx.db
      .query("gyms")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .unique();
    if (!collision) return candidate;
  }
  throw new Error("Failed to generate a unique gym slug after 5 attempts");
}

// Public, unauthenticated — resolves the human-readable slug in a consent
// link to just the gym's name for display. Deliberately returns nothing but
// the name: the public consent page needs it to render "Welcome to X" and
// nothing else, so there's no reason for this to ever hand back a gym's
// Convex document id (or any other field) to an unauthenticated caller.
export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const gym = await ctx.db
      .query("gyms")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!gym?.name) return null;
    return { name: gym.name };
  },
});
