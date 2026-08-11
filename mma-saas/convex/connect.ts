// Stripe Connect member billing — the database half. Stage C of the Connect
// build (see the Connect member-billing spec in the claude.ai project, §5.1).
//
// The Stripe calls live in convex/connectOnboarding.ts, which must be a
// "use node" module for the Stripe SDK. Convex only allows ACTIONS in a
// "use node" file, so every query and mutation the onboarding flow needs lives
// here in the default runtime — the same split as convex/http.ts and
// convex/stripeWebhookAction.ts, and for the same reason.
//
// THE NAMING RULE (spec §2): anything belonging to a gym's CONNECTED account is
// stripeConnect*, locals included. gyms.stripeCustomerId / stripeSubscriptionId
// are the PLATFORM account — this gym's own KombatDesk SaaS subscription — and
// gyms.by_stripe_customer backs subscriptions.updatePlanStatusByCustomer. The
// two money systems must be distinguishable by reading.
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { hasWriteAccess, requireGym, requireWriteAccess, tryGetGym } from "./gyms";

// An IANA zone name we are willing to store. See spec §3 for why this field
// exists at all when lib/localDate.ts deliberately refuses to add one.
//
// Validated on the way IN, not at render time, and that is the whole point.
// This string's only job is to be handed to Intl as a `timeZone` option when a
// member-facing charge date is rendered. An invalid zone throws a RangeError
// there — inside the code path that produces a statutory renewal disclosure,
// long after the owner who typed it has gone. Reject it here, where there is
// someone to tell.
//
// Intl is the authority rather than a hardcoded list: the zone database gains
// and renames entries, and a list in this file would rot silently.
function isValidIanaTimeZone(timezone: string): boolean {
  // Bound the input before handing it to Intl — this arrives from a browser.
  if (!timezone || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// Resolves the caller's gym for a Connect action, which cannot touch ctx.db.
//
// The action verifies the Clerk identity itself and passes the verified subject
// down as an argument, rather than leaning on auth propagating through
// ctx.runQuery. Internal, so the only reachable caller is a trusted Convex
// function — and being explicit means the trust boundary is legible at both
// ends instead of resting on framework behaviour a reader has to know.
//
// Applies the same gates a mutation would: requireGym's read check (an
// "inactive" gym never subscribed and has no claim to gym-scoped anything) plus
// write access, because starting Connect onboarding creates a real Stripe
// object. A canceled/past_due gym keeps its read-only grace period elsewhere;
// it does not get to open a merchant account.
export const getGymForConnect = internalQuery({
  args: { clerkUserId: v.string() },
  handler: async (ctx, { clerkUserId }) => {
    const gym = await ctx.db
      .query("gyms")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();
    if (!gym) throw new ConvexError("No gym found for this account");
    if (!hasWriteAccess(gym)) {
      // ConvexError, not Error — production redacts plain Error messages to a
      // generic "Server Error" and the owner would see a dead end. See
      // convex/gyms.ts:assertReadAccess.
      throw new ConvexError(
        "Your subscription isn't active — reactivate billing before setting up member billing."
      );
    }
    return gym;
  },
});

// Records the connected-account id, but only if the gym doesn't already have
// one, and reports which way it went.
//
// Creating a Stripe account and storing its id cannot be one transaction: the
// first half is an HTTP call from an action. Two rapid clicks can therefore
// both create an account before either stores one. This makes the STORE the
// point of resolution — the first write wins, the loser is told it lost and
// gets back the id that actually stuck, so the owner still lands in the right
// onboarding flow.
//
// The losing account is then orphaned at Stripe: created, empty, referenced by
// nothing. That is deliberate and is the better failure — the alternative is
// overwriting a gym's live account id, which would strand real dues against an
// account the gym can no longer see. The caller logs the orphan loudly so it
// can be removed by hand.
export const claimStripeConnectAccountId = internalMutation({
  args: { gymId: v.id("gyms"), stripeConnectAccountId: v.string() },
  handler: async (ctx, { gymId, stripeConnectAccountId }) => {
    const gym = await ctx.db.get(gymId);
    if (!gym) throw new Error(`No gym found with id ${gymId}`);
    if (gym.stripeConnectAccountId) {
      return { stored: false, stripeConnectAccountId: gym.stripeConnectAccountId };
    }
    await ctx.db.patch(gymId, { stripeConnectAccountId });
    return { stored: true, stripeConnectAccountId };
  },
});

// Mirrors Stripe's view of the connected account onto the gym row.
//
// Never written optimistically at the moment onboarding is launched. Express
// onboarding is abandoned partway all the time — the account exists and
// charges_enabled stays false — so "we sent them to Stripe" and "this gym can
// take money" are different facts and only Stripe knows the second one.
//
// connectOnboardedAt is stamped once, the first time charges actually go live,
// and never moved afterwards: it records when this gym became able to bill, and
// a later capability blip re-enabling charges is not a second onboarding.
export const setConnectAccountStatus = internalMutation({
  args: {
    gymId: v.id("gyms"),
    chargesEnabled: v.boolean(),
    payoutsEnabled: v.boolean(),
  },
  handler: async (ctx, { gymId, chargesEnabled, payoutsEnabled }) => {
    const gym = await ctx.db.get(gymId);
    if (!gym) throw new Error(`No gym found with id ${gymId}`);
    await ctx.db.patch(gymId, {
      connectChargesEnabled: chargesEnabled,
      connectPayoutsEnabled: payoutsEnabled,
      ...(chargesEnabled && !gym.connectOnboardedAt ? { connectOnboardedAt: Date.now() } : {}),
    });
  },
});

// The gym's billing timezone, collected during Connect onboarding.
//
// Deliberately its own mutation, run before onboarding begins, so an abandoned
// attempt still leaves the zone recorded rather than losing it along with the
// rest of the attempt.
//
// Read spec §3 before touching this. lib/localDate.ts states there is no
// timezone on gyms because "the device is physically in the gym, so its clock
// is the gym's clock" — true for attendance and the kiosk, where a real device
// stands in the building. A member-facing charge date has no device in the
// loop: it is server-rendered into an email for a gym that may not be in
// Colorado. Do not unify the two.
//
// TWO SOURCES EXIST FOR THIS FACT. THIS ONE IS AUTHORITATIVE.
//
// Stripe's Accounts v2 exposes `defaults.timezone` on the connected account
// (confirmed on a real account 2026-08-09 — it read null). Two fields holding
// one fact will drift, so the choice is written down here rather than left to
// whoever notices second.
//
// gyms.timezone wins because of who renders the date. Stripe's field scopes
// their own reporting surfaces; it is not consulted when WE compose a renewal
// notice, and nothing guarantees an owner who changes one has changed the
// other. The date in a member-facing email is produced by our code, on our
// server, so the zone that formats it has to be one we own and can validate on
// write — which is what isValidIanaTimeZone above exists to do. Reading
// Stripe's value at send time would also put a network call, and a Stripe
// outage, inside the path that produces a statutory disclosure.
//
// Stripe's field is not wrong, just answering a different question. Do not
// sync them, and do not read theirs as a fallback: a silent fallback is how
// two sources become indistinguishable at the moment one is stale.
export const setTimezone = mutation({
  args: { timezone: v.string() },
  handler: async (ctx, { timezone }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    if (!isValidIanaTimeZone(timezone)) {
      throw new ConvexError(
        `"${timezone}" isn't a timezone we recognize. Pick one like America/Denver.`
      );
    }
    await ctx.db.patch(gym._id, { timezone });
  },
});

// What the dashboard card renders.
//
// tryGetGym, not requireGym — this is read through useQuery from a "use client"
// component, so it fires before Clerk's session has hydrated. requireGym throws
// a plain Error there, production redacts it to "Server Error", and with no
// error boundary on the route that took the whole dashboard down once already
// (518ad18). Null means "not ready or no gym", and the card renders nothing.
//
// stripeConnectAccountId is deliberately NOT returned. The browser has no use
// for it and the narrowed-field-map discipline that keeps checkInToken off the
// wire (convex/members.ts:getAtRiskMembers) applies to connected-account
// identifiers too — spec §6 says so for the at-risk map and the reasoning is
// not specific to that map.
export const getConnectStatus = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetGym(ctx);
    if (!gym) return null;
    return {
      connected: !!gym.stripeConnectAccountId,
      chargesEnabled: gym.connectChargesEnabled ?? false,
      payoutsEnabled: gym.connectPayoutsEnabled ?? false,
      onboardedAt: gym.connectOnboardedAt ?? null,
      timezone: gym.timezone ?? null,
    };
  },
});
