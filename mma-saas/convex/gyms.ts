import { query, mutation, QueryCtx, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { assertMaxLength } from "./validate";

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
// against by_slug.
//
// Same shape as members.ts:112's generateUniqueCheckInToken: generate, check
// the candidate against an index, retry a bounded number of times, throw
// rather than loop forever. Both exist and both are the precedent for any
// future generated identifier in this codebase — see also generateUniqueSmsCode
// below.
//
// (A previous version of this comment asserted that generateUniqueCheckInToken
// and the by_check_in_token index "do not exist anywhere in this codebase."
// That was false when written. The function landed in 94bbf45 on 2026-07-22 at
// members.ts:112, uses the index at members.ts:117, and the index is defined at
// schema.ts:78; the comment denying them landed in 7efaccb on 2026-08-02,
// eleven days later. It was added to stop someone designing around something
// nonexistent and was itself the thing that did not exist — which is the
// failure mode in AGENTS.md §2, committed inside a warning about it. Corrected
// 2026-08-03 by grepping, not by remembering.)
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

// Alphabet for gyms.smsCode. 30 characters: 2-9 and A-Z with 0, O, 1, I, L and
// U removed.
//
// 0/O, 1/I/L are dropped because this code is READ OFF A PRINTED POSTER AND
// TYPED INTO A PHONE by someone who will never see it again — the one context
// where a glyph collision costs a real opt-in. U is dropped separately: it is
// not confusable, it is the letter that makes most four-letter profanity
// constructible, and removing it does more than the blocklist below does.
//
// STILL CONFUSABLE AND DELIBERATELY KEPT: S/5, Z/2, B/8, G/6. Dropping those
// too would cost a third of the alphabet, and a mistyped code degrades
// gracefully rather than failing — it matches no gym and falls through to the
// roster-match arm of the resolver. See the note on collision risk there.
const SMS_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

// 4 characters total: 3 random plus 1 COMPUTED CHECK CHARACTER (Luhn mod 30).
//
// WHY A CHECK CHARACTER, GIVEN A TYPO ALREADY FALLS THROUGH TO THE ROSTER
// MATCH. Because a typo that lands on ANOTHER GYM'S LIVE CODE does not fall
// through — it resolves, confidently, to the wrong gym. That is the failure
// this whole design exists to prevent: consent recorded for a gym the person
// never contacted.
//
// And it is not self-limiting. A wrong-gym row with no roster match is not
// inert: it lands in that gym's consent-gap panel, whose copy tells the owner
// "Add them as members with this exact phone number, then come back and apply
// their consent" (app/dashboard/owner-links.tsx:274), and
// consent.ts:applyPendingConsent then stamps smsConsentConfirmed. The
// conversion from unmatched row to live consent is a designed feature the UI
// actively prompts. The fuse is just days long instead of instant.
//
// WHAT LUHN MOD 30 CATCHES: every single-character substitution, provably.
// The doubling map d -> floor(2d/30) + (2d mod 30) sends d < 15 to the even
// residues and d >= 15 to the odd ones, all distinct, so it is injective mod
// 30 and any one wrong character changes the sum.
//
// WHAT IT DOES NOT CATCH: some adjacent transpositions — the same residual
// classic Luhn mod 10 has, where 09 and 90 check identically. That gap is
// covered separately in the resolver, which refuses a code-resolved gym when
// the sender's phone is on a different gym's roster and not on that one's.
//
// COST: 30^3 = 27,000 codes instead of 810,000. At any gym count this product
// will plausibly reach, ample.
const SMS_CODE_RANDOM_LENGTH = 3;
const SMS_CODE_LENGTH = SMS_CODE_RANDOM_LENGTH + 1;

// Codes that must never be printed on a wall in someone's gym. Only strings
// constructible from the alphabet above are listed — most English profanity
// already needs a dropped letter (FUCK/CUNT need U, SHIT/PISS/DICK need I,
// COCK/HOMO need O, HELL/SLUT need L), so this list is short by construction
// rather than by optimism. Checked case-insensitively; codes are uppercase.
//
// APPLIED TO THE FINAL 4-CHARACTER STRING, NOT THE 3 RANDOM ONES, and a hit
// retries the whole generation rather than just recomputing the check
// character. The check character is derived from the other three, so it can
// complete a word the random part didn't — screening before it is appended
// would miss exactly the codes that end up printed.
//
// A hit costs one retry out of the attempt budget below. At 30^3 = 27,000
// reachable codes the odds of drawing one are ~0.07%, so this is a guard,
// not a hot path.
const SMS_CODE_BLOCKLIST = new Set([
  "TWAT", "WANK", "ARSE", "CRAP", "FART", "DAMN", "SPAZ", "PAKI", "CHNK",
  "FAGS", "DYKE", "RAPE", "SEXY", "KKKK", "JEWS", "NAZ2", "KYS2", "TARD",
]);

// Luhn mod N, weighting from the right with the check character in the
// rightmost position. Shared by the generator (which appends the result) and
// the validator (which recomputes and compares), so the two can never drift —
// a validator that disagreed with its generator would reject every real code.
function luhnSum(chars: string, startFactor: 1 | 2): number | null {
  const n = SMS_CODE_ALPHABET.length;
  let factor = startFactor;
  let sum = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const codePoint = SMS_CODE_ALPHABET.indexOf(chars[i]);
    if (codePoint < 0) return null; // character outside the alphabet
    const addend = factor * codePoint;
    factor = factor === 2 ? 1 : 2;
    sum += Math.floor(addend / n) + (addend % n);
  }
  return sum;
}

function smsCodeCheckChar(randomPart: string): string {
  const n = SMS_CODE_ALPHABET.length;
  const sum = luhnSum(randomPart, 2);
  if (sum === null) throw new Error("smsCodeCheckChar received a character outside the alphabet");
  return SMS_CODE_ALPHABET[(n - (sum % n)) % n];
}

// Exported for the inbound-SMS resolver (convex/twilioWebhookAction.ts), which
// must validate BEFORE the by_sms_code lookup. A malformed or mistyped code
// should never reach the index — resolving it is what produces a wrong-gym
// consent row, and an index hit is exactly the thing that looks authoritative.
export function isValidSmsCode(code: string): boolean {
  if (code.length !== SMS_CODE_LENGTH) return false;
  const sum = luhnSum(code, 1);
  return sum !== null && sum % SMS_CODE_ALPHABET.length === 0;
}

function generateSmsCode(): string {
  const bytes = new Uint8Array(SMS_CODE_RANDOM_LENGTH);
  crypto.getRandomValues(bytes);
  // Modulo bias is real here (256 % 30 = 16, so the first 16 characters are
  // drawn ~12% more often) and deliberately ignored: this is a public
  // identifier printed on a poster, not a credential. Nothing about the
  // product's security depends on it being uniformly distributed, and
  // rejection sampling would add a loop to guard a property nobody relies on.
  // If this ever becomes a secret, that reasoning stops holding.
  const randomPart = Array.from(
    bytes,
    (b) => SMS_CODE_ALPHABET[b % SMS_CODE_ALPHABET.length]
  ).join("");
  return randomPart + smsCodeCheckChar(randomPart);
}

// Same shape as members.ts:112's generateUniqueCheckInToken and
// generateGymSlug above: generate, reject the unusable, check the candidate
// against an index rather than trusting randomness, cap the retries, throw
// instead of looping forever so a broken index write fails loudly.
//
// Uniqueness is GLOBAL, not per-gym, and must stay that way — the whole point
// is that an inbound SMS carrying only this code identifies exactly one gym,
// and there is no other scoping signal in a Twilio webhook.
export async function generateUniqueSmsCode(ctx: MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateSmsCode();
    if (SMS_CODE_BLOCKLIST.has(candidate)) continue;
    const collision = await ctx.db
      .query("gyms")
      .withIndex("by_sms_code", (q) => q.eq("smsCode", candidate))
      .unique();
    if (!collision) return candidate;
  }
  throw new Error("Failed to generate a unique SMS code after 5 attempts");
}

// Public, unauthenticated — resolves the human-readable slug in a consent
// link to just the gym's name for display. Deliberately returns nothing but
// the name: the public consent page needs it to render "Welcome to X" and
// nothing else, so there's no reason for this to ever hand back a gym's
// Convex document id (or any other field) to an unauthenticated caller.
// The automatic winback message is the one text that goes out in a gym
// owner's name without them writing it. This lets them write it.
//
// 480 matches MAX_MESSAGE_LENGTH in convex/sendRetentionTexts.ts — roughly
// three SMS segments once the opt-out footer is appended. Deliberately the
// same ceiling as a manual send: the automatic path is not a more permissive
// channel just because it fires on a schedule.
//
// The STOP footer is NOT part of what's stored and cannot be removed by an
// owner — sendRetentionTextsCore appends it to every branch. That is a TCPA
// requirement, not a formatting preference.
//
// An empty string clears the override and restores the built-in default,
// which is why this stores `undefined` rather than "" for a blank submission:
// a stored empty template would send a text consisting of nothing but the
// opt-out footer.
export const setRetentionMessageTemplate = mutation({
  args: { template: v.string() },
  handler: async (ctx, { template }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);

    const trimmed = template.trim();
    assertMaxLength(trimmed, 480, "Message");

    await ctx.db.patch(gym._id, {
      retentionMessageTemplate: trimmed.length > 0 ? trimmed : undefined,
    });
  },
});

// What the owner has saved, for the settings field to render. Null means
// they've never set one and the built-in default is in use.
export const getRetentionMessageTemplate = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetGym(ctx);
    return gym?.retentionMessageTemplate ?? null;
  },
});

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
