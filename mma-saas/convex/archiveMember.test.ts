/// <reference types="vite/client" />
// Covers convex/members.ts:archiveMember — the dashboard's "Remove" action.
// Three things here are load-bearing enough to need direct coverage rather than
// an assumption that the code reads correctly:
//
//   1. Cross-tenant rejection. archiveMember takes a memberId directly, so a
//      memberId from another gym must throw, not archive — the same IDOR class
//      of bug the gym-scoping work fixed across the rest of this file.
//   2. Archived members must never receive a retention text. That claim is made
//      to the gym owner in the confirmation dialog's copy, and
//      sendRetentionTexts.ts:getAtRiskMembers is the ONLY audience query the
//      sender reads, so that query is where the promise is either kept or
//      broken.
//   3. The consent/opt-out fields must survive archival. The privacy policy
//      commits to honoring an opt-out after a member is removed, so a patch
//      that clobbered them would be a compliance regression, not just a bug.
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// A gym that passes requireGym + requireWriteAccess, holding one textable
// member: phone present, consent confirmed, active, and lapsed well past the
// 7-day at-risk threshold, so getAtRiskMembers returns them until something
// deliberately excludes them.
async function seedTextableGymWithLapsedMember(t: ReturnType<typeof convexTest>) {
  const clerkUserId = `user_${Math.random().toString(36).slice(2)}`;
  const { gymId, memberId } = await t.run(async (ctx) => {
    const gymId = await ctx.db.insert("gyms", {
      clerkUserId,
      name: "Archive Test Gym",
      plan: "fightteam",
      planStatus: "active",
    });
    const memberId = await ctx.db.insert("members", {
      name: "Lapsed Member",
      plan: "BJJ Monthly",
      status: "active",
      phone: "(720) 555-0100",
      smsConsentConfirmed: true,
      smsConsentConfirmedAt: Date.now(),
      smsConsentSource: "member_modal",
      lastVisit: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      gymId,
    });
    return { gymId, memberId };
  });
  return { asOwner: t.withIdentity({ subject: clerkUserId }), gymId, memberId };
}

test("archiveMember sets archived + archivedAt without deleting the document", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, memberId } = await seedTextableGymWithLapsedMember(t);

  const before = Date.now();
  await asOwner.mutation(api.members.archiveMember, { memberId });
  const after = Date.now();

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member).not.toBeNull();
  expect(member!.archived).toBe(true);
  expect(member!.archivedAt).toBeGreaterThanOrEqual(before);
  expect(member!.archivedAt).toBeLessThanOrEqual(after);
});

test("archiveMember preserves consent and opt-out fields", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, memberId } = await seedTextableGymWithLapsedMember(t);

  await t.run(async (ctx) => {
    await ctx.db.patch(memberId, { smsOptedOut: true });
  });

  await asOwner.mutation(api.members.archiveMember, { memberId });

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  // Every one of these is TCPA evidence — archival must not touch any of them.
  expect(member!.smsOptedOut).toBe(true);
  expect(member!.smsConsentConfirmed).toBe(true);
  expect(member!.smsConsentConfirmedAt).toBeDefined();
  expect(member!.smsConsentSource).toBe("member_modal");
  expect(member!.phone).toBe("(720) 555-0100");
});

test("archiveMember rejects a member id belonging to another gym", async () => {
  const t = convexTest(schema, modules);
  const gymA = await seedTextableGymWithLapsedMember(t);
  const gymB = await seedTextableGymWithLapsedMember(t);

  // Gym A's owner pointing archiveMember at gym B's member.
  await expect(
    gymA.asOwner.mutation(api.members.archiveMember, { memberId: gymB.memberId })
  ).rejects.toThrow(/Member not found/);

  // And the foreign member must be untouched, not merely un-returned.
  const victim = await t.run(async (ctx) => ctx.db.get(gymB.memberId));
  expect(victim!.archived).toBeUndefined();
  expect(victim!.archivedAt).toBeUndefined();
});

test("archiveMember is idempotent and does not move archivedAt", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, memberId } = await seedTextableGymWithLapsedMember(t);

  await asOwner.mutation(api.members.archiveMember, { memberId });
  const firstArchivedAt = await t.run(async (ctx) => (await ctx.db.get(memberId))!.archivedAt);

  await asOwner.mutation(api.members.archiveMember, { memberId });
  const secondArchivedAt = await t.run(async (ctx) => (await ctx.db.get(memberId))!.archivedAt);

  expect(secondArchivedAt).toBe(firstArchivedAt);
});

// The critical one: the retention-text audience.
test("getAtRiskMembers excludes archived members (no retention text after removal)", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, gymId, memberId } = await seedTextableGymWithLapsedMember(t);

  // Baseline: this member IS in the texting audience before archival, so the
  // assertion after it can't pass vacuously (e.g. from a bad seed that never
  // qualified in the first place).
  const before = await t.run(async (ctx) =>
    ctx.runQuery(internal.sendRetentionTexts.getAtRiskMembers, { gymId })
  );
  expect(before.map((m) => m._id)).toContain(memberId);

  await asOwner.mutation(api.members.archiveMember, { memberId });

  const after = await t.run(async (ctx) =>
    ctx.runQuery(internal.sendRetentionTexts.getAtRiskMembers, { gymId })
  );
  expect(after.map((m) => m._id)).not.toContain(memberId);
  expect(after).toHaveLength(0);
});

test("archived members disappear from list and count queries", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, gymId, memberId } = await seedTextableGymWithLapsedMember(t);

  expect((await asOwner.query(api.members.getAll, {})).map((m) => m._id)).toContain(memberId);
  expect(await asOwner.query(api.members.getActiveCount, {})).toBe(1);
  expect((await asOwner.query(api.members.getAtRiskMembers, {})).map((m) => m._id)).toContain(memberId);
  expect((await asOwner.query(api.members.getActiveForGym, { gymId })).map((m) => m._id)).toContain(memberId);

  await asOwner.mutation(api.members.archiveMember, { memberId });

  expect(await asOwner.query(api.members.getAll, {})).toHaveLength(0);
  expect(await asOwner.query(api.members.getActiveCount, {})).toBe(0);
  expect(await asOwner.query(api.members.getAtRiskMembers, {})).toHaveLength(0);
  expect(await asOwner.query(api.members.getActiveForGym, { gymId })).toHaveLength(0);
});

test("an archived member's check-in token stops resolving and check-in is rejected", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, gymId, memberId } = await seedTextableGymWithLapsedMember(t);
  const token = await asOwner.mutation(api.members.regenerateCheckInToken, { memberId });

  expect(await t.query(api.members.resolveCheckInToken, { token })).not.toBeNull();

  await asOwner.mutation(api.members.archiveMember, { memberId });

  expect(await t.query(api.members.resolveCheckInToken, { token })).toBeNull();
  await expect(
    t.mutation(api.members.checkIn, { id: memberId, gymId })
  ).rejects.toThrow(/Member not found/);
});

// Guards the deliberate exception documented at setSmsOptOutByPhone: an
// archived member texting STOP must still be recorded, or a re-added number
// loses its opt-out.
test("setSmsOptOutByPhone still records an opt-out for an archived member", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, memberId } = await seedTextableGymWithLapsedMember(t);

  await asOwner.mutation(api.members.archiveMember, { memberId });

  await t.run(async (ctx) =>
    ctx.runMutation(internal.members.setSmsOptOutByPhone, {
      phone: "+17205550100",
      optedOut: true,
    })
  );

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member!.smsOptedOut).toBe(true);
});
