/// <reference types="vite/client" />
// Covers convex/members.ts:update — specifically the branch that clears
// smsOptedOut when a member's phone number changes.
//
// This exists because that branch shipped as `fields.phone !== existing.phone`,
// a raw-string comparison against a free-typed field. Re-saving a member after
// retyping "(720) 555-0100" as "720-555-0100" therefore counted as a NEW NUMBER
// and silently cleared a live STOP — an owner-reachable path to undoing a
// member's opt-out, at the same time as the Members table's tooltip told that
// owner "Only they can undo it". The bug was invisible from the UI: nothing on
// screen distinguishes a reformat from a replacement.
//
// Four behaviours are load-bearing enough to pin down here, because the diff
// that reintroduces any of them looks like a simplification:
//
//   1. A reformat of the SAME number must not touch smsOptedOut.
//   2. A genuinely DIFFERENT number with no opt-out history clears it — this is
//      the branch's legitimate purpose and must keep working, or a member who
//      opted out on an old number is silently untextable forever with no UI to
//      fix it.
//   3. A genuinely different number that ALREADY carries an opt-out on another
//      row inherits it. Opt-out state is number-scoped (setSmsOptOutByPhone
//      patches every row holding the number), so adopting a number must adopt
//      its instruction too.
//   4. CLEARING the phone number retains the opt-out. Otherwise "delete the
//      number, save, retype the same number, save" launders a STOP in two
//      clicks — which is exactly the shape of #1 the fix was meant to close.
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// Base member payload for members.update. Every field in memberFields is
// resent on each call because update patches with `...fields` — omitting one
// would be a separate change and would muddy what these tests are asserting.
// smsConsentConfirmed stays true throughout: assertSmsConsent rejects saving a
// phone number without it, so it is a precondition of the path under test, not
// part of what's being tested.
const BASE = {
  name: "Opted Out Member",
  plan: "BJJ Monthly",
  status: "active" as const,
  smsConsentConfirmed: true,
};

async function seedGymWithOptedOutMember(
  t: ReturnType<typeof convexTest>,
  phone = "(720) 555-0100"
) {
  const clerkUserId = `user_${Math.random().toString(36).slice(2)}`;
  const { gymId, memberId } = await t.run(async (ctx) => {
    const gymId = await ctx.db.insert("gyms", {
      clerkUserId,
      name: "Opt-Out Test Gym",
      plan: "fightteam",
      planStatus: "active",
    });
    const memberId = await ctx.db.insert("members", {
      ...BASE,
      phone,
      smsConsentConfirmedAt: Date.now(),
      smsConsentSource: "member_modal",
      // The member texted STOP. This is the state the whole file is protecting.
      smsOptedOut: true,
      gymId,
    });
    return { gymId, memberId };
  });
  return { asOwner: t.withIdentity({ subject: clerkUserId }), gymId, memberId };
}

test("reformatting the same phone number does NOT clear a STOP", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, memberId } = await seedGymWithOptedOutMember(t, "(720) 555-0100");

  // Same digits, different punctuation — what an owner does when tidying a
  // roster or fixing a stray character. This is the regression.
  await asOwner.mutation(api.members.update, {
    id: memberId,
    ...BASE,
    phone: "720-555-0100",
  });

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member!.smsOptedOut).toBe(true);
});

test("a leading +1 is the same number, not a new one", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, memberId } = await seedGymWithOptedOutMember(t, "(720) 555-0100");

  // normalizePhoneDigits strips a leading country code, so E.164 and the
  // free-typed form must compare equal. Twilio's inbound `From` is E.164, so an
  // owner copying the number out of a text message hits exactly this case.
  await asOwner.mutation(api.members.update, {
    id: memberId,
    ...BASE,
    phone: "+17205550100",
  });

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member!.smsOptedOut).toBe(true);
});

test("a genuinely different number with no opt-out history clears the flag", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, memberId } = await seedGymWithOptedOutMember(t, "(720) 555-0100");

  await asOwner.mutation(api.members.update, {
    id: memberId,
    ...BASE,
    phone: "(719) 555-0199",
  });

  // Not a regression — this is the branch working as designed. The old number's
  // STOP does not apply to whoever holds the new one.
  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member!.smsOptedOut).toBe(false);
});

test("adopting a number that already opted out inherits the opt-out", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, gymId, memberId } = await seedGymWithOptedOutMember(t, "(720) 555-0100");

  // A second member — a different person — who has opted out on the number our
  // first member is about to be given.
  await t.run(async (ctx) => {
    await ctx.db.insert("members", {
      ...BASE,
      name: "Other Member",
      phone: "(719) 555-0199",
      smsConsentConfirmedAt: Date.now(),
      smsOptedOut: true,
      gymId,
    });
  });

  await asOwner.mutation(api.members.update, {
    id: memberId,
    ...BASE,
    phone: "(719) 555-0199",
  });

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member!.smsOptedOut).toBe(true);
});

test("adding a NEW member on an opted-out number inherits the opt-out", async () => {
  const t = convexTest(schema, modules);
  const { asOwner } = await seedGymWithOptedOutMember(t, "(720) 555-0100");

  // The other half of the same hole. `update` refusing to clear an opt-out is
  // worth nothing if `add` hands out a fresh row with the field unset — which
  // isTextEligibleMember reads as textable. "Remove the member, add them back"
  // is two clicks in the dashboard.
  const newId = await asOwner.mutation(api.members.add, {
    ...BASE,
    name: "Re-added Under A New Row",
    phone: "720-555-0100",
  });

  const member = await t.run(async (ctx) => ctx.db.get(newId));
  expect(member!.smsOptedOut).toBe(true);
});

test("adding a member on a number with no opt-out history leaves the field unset", async () => {
  const t = convexTest(schema, modules);
  const { asOwner } = await seedGymWithOptedOutMember(t, "(720) 555-0100");

  const newId = await asOwner.mutation(api.members.add, {
    ...BASE,
    name: "Unrelated Member",
    phone: "(719) 555-0123",
  });

  // Unset, not false. "We have never heard from this number" and "this number
  // opted back in" are different facts; stamping false would erase that.
  const member = await t.run(async (ctx) => ctx.db.get(newId));
  expect(member!.smsOptedOut).toBeUndefined();
});

test("an archived member's opt-out still blocks a re-add on that number", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, memberId } = await seedGymWithOptedOutMember(t, "(720) 555-0100");

  await asOwner.mutation(api.members.archiveMember, { memberId });

  // The removed row is exactly the one a re-add would sail past, and the
  // privacy policy commits to honoring an opt-out after roster removal. This
  // is why numberHasOptOutOnRecord does not filter archived rows.
  const newId = await asOwner.mutation(api.members.add, {
    ...BASE,
    name: "Same Number, New Row",
    phone: "+1 720 555 0100",
  });

  const member = await t.run(async (ctx) => ctx.db.get(newId));
  expect(member!.smsOptedOut).toBe(true);
});

test("clearing the phone number retains the opt-out on the row", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, memberId } = await seedGymWithOptedOutMember(t, "(720) 555-0100");

  // No phone at all. assertSmsConsent permits this (its guard is
  // `fields.phone && !fields.smsConsentConfirmed`), so it's a reachable save.
  await asOwner.mutation(api.members.update, {
    id: memberId,
    ...BASE,
    phone: undefined,
  });

  // Retained, not cleared: this is the first half of the two-click laundering
  // path. If this ever flips to false, retyping the original number on the next
  // save clears the STOP and the fix above is defeated.
  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member!.smsOptedOut).toBe(true);
});
