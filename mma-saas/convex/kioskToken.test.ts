/// <reference types="vite/client" />
// Covers gyms.kioskToken — the credential the front-desk tablet carries.
//
// WHY THIS FILE EXISTS. Every kiosk function is unauthenticated by necessity
// (the device at the door has no Clerk session) and used to take a raw
// `gymId`, which meant the gym's own document id, sitting in a bookmark, WAS
// the credential: members.getActiveForGym enumerated the roster and
// documents.getUnsignedRequiredDocs then resolved each member's date of birth,
// home address and minor status into the document preview. A gym id is not a
// secret — it appears in demo scripts and in anything an owner forwards.
//
// Three properties are load-bearing enough that a comment isn't enough:
//
//   1. The empty-token guard. by_kiosk_token would happily match the first row
//      with kioskToken unset, which is EVERY gym on a fresh deployment, so an
//      empty string must be rejected before the index is ever queried.
//   2. Cross-tenant isolation. One gym's token must not reach another gym's
//      roster or check anyone in there.
//   3. Rotation actually revokes. The whole reason this is a token and not a
//      gym id is that an owner can kill a lost tablet's access.
//
// Plus one REGRESSION guard, item 4 below, which is the bug this file was
// written after: rotateKioskToken shipped a first draft calling
// requireWriteAccess, which would have meant a past_due gym could never issue
// a token and its front door went permanently dark while it was still being
// billed.
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seedGym(
  t: ReturnType<typeof convexTest>,
  planStatus: string,
  name = "Kiosk Test Gym"
) {
  const clerkUserId = `user_${Math.random().toString(36).slice(2)}`;
  const { gymId, memberId } = await t.run(async (ctx) => {
    const gymId = await ctx.db.insert("gyms", {
      clerkUserId,
      name,
      plan: "fightteam",
      planStatus,
    });
    const memberId = await ctx.db.insert("members", {
      name: "Walk In",
      plan: "BJJ Monthly",
      status: "active",
      gymId,
    });
    return { gymId, memberId };
  });
  return { asOwner: t.withIdentity({ subject: clerkUserId }), gymId, memberId };
}

// --- 1. Shape and the empty-token guard ------------------------------------

test("rotateKioskToken issues 24 hex characters and getKioskToken returns it", async () => {
  const t = convexTest(schema, modules);
  const { asOwner } = await seedGym(t, "active");

  expect(await asOwner.query(api.gyms.getKioskToken, {})).toEqual({
    kioskToken: null,
    kioskTokenIssuedAt: null,
  });

  const before = Date.now();
  const token = await asOwner.mutation(api.gyms.rotateKioskToken, {});
  const after = Date.now();

  // The shape the kiosk pages gate on client-side before they call anything.
  // If this ever widens, app/checkin/page.tsx and app/kiosk/signup/page.tsx
  // start rejecting valid bookmarks before the server ever sees them.
  expect(token).toMatch(/^[a-f0-9]{24}$/);

  const stored = await asOwner.query(api.gyms.getKioskToken, {});
  expect(stored?.kioskToken).toBe(token);
  expect(stored?.kioskTokenIssuedAt).toBeGreaterThanOrEqual(before);
  expect(stored?.kioskTokenIssuedAt).toBeLessThanOrEqual(after);
});

test("an empty token matches nothing, even when gyms exist with no token set", async () => {
  const t = convexTest(schema, modules);
  // Deliberately NO rotateKioskToken call: both gyms have kioskToken unset,
  // which is what a fresh deployment looks like. An unguarded index lookup
  // returns one of these rows for "".
  await seedGym(t, "active", "Gym One");
  await seedGym(t, "active", "Gym Two");

  expect(await t.query(api.members.getActiveForGym, { kioskToken: "" })).toEqual([]);
  expect(await t.query(api.classes.listForKiosk, { kioskToken: "" })).toEqual([]);
  expect(await t.query(api.documents.getKioskGym, { kioskToken: "" })).toBeNull();
});

test("an unknown token reads as an empty kiosk rather than an error", async () => {
  const t = convexTest(schema, modules);
  const { asOwner } = await seedGym(t, "active");
  await asOwner.mutation(api.gyms.rotateKioskToken, {});

  // A stale bookmark is an expected state on a tablet nobody is watching, not
  // an exception — a throw here renders as a crashed kiosk at the door.
  const wrong = "ffffffffffffffffffffffff";
  expect(await t.query(api.members.getActiveForGym, { kioskToken: wrong })).toEqual([]);
  expect(await t.query(api.classes.listForKiosk, { kioskToken: wrong })).toEqual([]);
  expect(await t.query(api.documents.getKioskGym, { kioskToken: wrong })).toBeNull();
});

// --- 2. Cross-tenant isolation ---------------------------------------------

test("one gym's token cannot read or check in against another gym", async () => {
  const t = convexTest(schema, modules);
  const a = await seedGym(t, "active", "Gym A");
  const b = await seedGym(t, "active", "Gym B");
  const tokenA = await a.asOwner.mutation(api.gyms.rotateKioskToken, {});
  await b.asOwner.mutation(api.gyms.rotateKioskToken, {});

  // Gym A's token sees only gym A's roster.
  const roster = await t.query(api.members.getActiveForGym, { kioskToken: tokenA });
  expect(roster.map((m) => m._id)).toEqual([a.memberId]);

  // And cannot check in gym B's member, even with a valid member id in hand —
  // the same IDOR class the old gymId argument was checked against.
  await expect(
    t.mutation(api.members.checkIn, { id: b.memberId, kioskToken: tokenA })
  ).rejects.toThrow(/Member not found/);
});

// --- 3. Rotation revokes ---------------------------------------------------

test("rotating invalidates the previous token", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, memberId } = await seedGym(t, "active");

  const oldToken = await asOwner.mutation(api.gyms.rotateKioskToken, {});
  expect(
    (await t.query(api.members.getActiveForGym, { kioskToken: oldToken })).map((m) => m._id)
  ).toEqual([memberId]);

  const newToken = await asOwner.mutation(api.gyms.rotateKioskToken, {});
  expect(newToken).not.toBe(oldToken);

  // The lost-tablet control. If this ever regresses, "Regenerate code" becomes
  // a button that lies to the owner.
  expect(await t.query(api.members.getActiveForGym, { kioskToken: oldToken })).toEqual([]);
  expect(
    (await t.query(api.members.getActiveForGym, { kioskToken: newToken })).map((m) => m._id)
  ).toEqual([memberId]);
});

// --- 4. THE REGRESSION GUARD -----------------------------------------------

// A gym whose card bounced must still be able to open its doors. members.checkIn
// has never had a plan-status check, on purpose, and issuing the credential that
// check-in depends on has to follow the same rule — otherwise a gym that lapses
// before it ever generates a token can never get one.
//
// The first draft of rotateKioskToken called requireWriteAccess and would have
// failed exactly this test. Do not "fix" it by adding one.
test("a past_due gym can still issue a kiosk token and check members in", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, memberId } = await seedGym(t, "past_due");

  const token = await asOwner.mutation(api.gyms.rotateKioskToken, {});
  expect(token).toMatch(/^[a-f0-9]{24}$/);

  expect(
    (await t.query(api.members.getActiveForGym, { kioskToken: token })).map((m) => m._id)
  ).toEqual([memberId]);

  await t.mutation(api.members.checkIn, { id: memberId, kioskToken: token });
  const after = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(after?.lastVisit).toBeTruthy();
});

// The other half of the same rule: the door opens, but the roster doesn't grow.
// Operational continuity is free; the thing a subscription buys is new members.
test("a past_due gym cannot add a new member from the kiosk", async () => {
  const t = convexTest(schema, modules);
  const { asOwner } = await seedGym(t, "past_due");
  const token = await asOwner.mutation(api.gyms.rotateKioskToken, {});

  await expect(
    t.mutation(api.documents.createMemberFromKiosk, {
      kioskToken: token,
      name: "New Walk In",
      dob: "1990-03-04",
      smsConsent: false,
    })
  ).rejects.toThrow(/subscription isn't active/);
});

test("an active gym can add a new member from the kiosk", async () => {
  const t = convexTest(schema, modules);
  const { asOwner } = await seedGym(t, "active");
  const token = await asOwner.mutation(api.gyms.rotateKioskToken, {});

  // Guards the negative test above against passing vacuously — if
  // createMemberFromKiosk threw for some unrelated reason (a missing gym name,
  // a validation change), the past_due assertion would still "pass".
  const newMemberId = await t.mutation(api.documents.createMemberFromKiosk, {
    kioskToken: token,
    name: "New Walk In",
    dob: "1990-03-04",
    smsConsent: false,
  });
  const created = await t.run(async (ctx) => ctx.db.get(newMemberId));
  expect(created?.name).toBe("New Walk In");
  expect(created?.dob).toBe("1990-03-04");
  // No phone given, so no consent row and no phone stored — the kiosk must not
  // invent either.
  expect(created?.phone).toBeUndefined();
});

// A gym that never subscribed has no claim on gym-scoped data at all, so it
// doesn't get a kiosk either. This is requireGym's existing read gate, not a
// new rule — asserted here so the "no plan-status check" comment on
// rotateKioskToken isn't read as "no check whatsoever".
test("an inactive gym cannot issue a kiosk token", async () => {
  const t = convexTest(schema, modules);
  const { asOwner } = await seedGym(t, "inactive");

  await expect(asOwner.mutation(api.gyms.rotateKioskToken, {})).rejects.toThrow(
    /active subscription is required/
  );
});

test("an unauthenticated caller cannot issue a kiosk token", async () => {
  const t = convexTest(schema, modules);
  await seedGym(t, "active");

  // The one place the credential is handed out is the authenticated owner
  // asking for their own. Without this, the token is no better than the gym id
  // it replaced.
  await expect(t.mutation(api.gyms.rotateKioskToken, {})).rejects.toThrow(/Unauthenticated/);
});
