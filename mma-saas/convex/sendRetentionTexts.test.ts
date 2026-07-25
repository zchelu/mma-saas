/// <reference types="vite/client" />
// Verifies the smsConsentConfirmed gate in getAtRiskMembers. Previously this
// only checked phone/status/smsOptedOut, relying on the invariant that
// add/update never let a phone number in without confirmed consent - an
// invariant scripts/import-members.js's adminImportBatch mutation
// deliberately does NOT uphold (migrated CSV data carries no proof consent
// was obtained). This seeds a member the way that bulk-import path does - a
// direct db.insert with a phone but no smsConsentConfirmed - and confirms
// it's excluded from the at-risk list that feeds actual SMS sends.
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

test("getAtRiskMembers excludes members with a phone but unconfirmed SMS consent", async () => {
  const t = convexTest(schema, modules);

  const gymId = await t.run(async (ctx) => ctx.db.insert("gyms", {}));

  await t.run(async (ctx) => {
    // Mirrors adminImportBatch: a phone number imported from migrated CSV
    // data, consent deliberately never confirmed.
    await ctx.db.insert("members", {
      name: "Imported Member",
      plan: "Imported",
      status: "active",
      phone: "7205550100",
      gymId,
    });
    // A normal member created through the app's add/update mutations, which
    // require smsConsentConfirmed before a phone number can be saved at all.
    await ctx.db.insert("members", {
      name: "Consented Member",
      plan: "BJJ Monthly",
      status: "active",
      phone: "7205550101",
      smsConsentConfirmed: true,
      gymId,
    });
  });

  const atRisk = await t.query(internal.sendRetentionTexts.getAtRiskMembers, { gymId });

  expect(atRisk.map((m) => m.name)).toEqual(["Consented Member"]);
});

// The three-attempt termination cap. These cover the gate, the counter, and
// the reset independently, because each one failing silently looks the same
// from the outside: a member who just stops getting texts.
const textable = {
  plan: "BJJ Monthly",
  status: "active" as const,
  smsConsentConfirmed: true,
};

test("getAtRiskMembers excludes members who used all three winback attempts", async () => {
  const t = convexTest(schema, modules);
  const gymId = await t.run(async (ctx) => ctx.db.insert("gyms", {}));

  await t.run(async (ctx) => {
    // Mid-sequence — still owed a third text.
    await ctx.db.insert("members", {
      ...textable,
      name: "Two Attempts",
      phone: "7205550102",
      winbackAttempts: 2,
      gymId,
    });
    await ctx.db.insert("members", {
      ...textable,
      name: "Three Attempts",
      phone: "7205550103",
      winbackAttempts: 3,
      winbackDormantAt: Date.now(),
      gymId,
    });
    // No winback fields at all: a member predating the cap must not be read
    // as already exhausted.
    await ctx.db.insert("members", {
      ...textable,
      name: "Legacy Member",
      phone: "7205550104",
      gymId,
    });
  });

  const atRisk = await t.query(internal.sendRetentionTexts.getAtRiskMembers, { gymId });

  expect(atRisk.map((m) => m.name).sort()).toEqual(["Legacy Member", "Two Attempts"]);
});

test("recordRetentionText counts the attempt and marks dormant on the third", async () => {
  const t = convexTest(schema, modules);
  const gymId = await t.run(async (ctx) => ctx.db.insert("gyms", {}));
  const memberId = await t.run(async (ctx) =>
    ctx.db.insert("members", { ...textable, name: "Cold Member", phone: "7205550105", gymId })
  );

  for (const expected of [1, 2]) {
    await t.mutation(internal.sendRetentionTexts.recordRetentionText, { memberId, gymId });
    const m = await t.run(async (ctx) => ctx.db.get(memberId));
    expect(m?.winbackAttempts).toBe(expected);
    expect(m?.lastRetentionTextAt).toBeGreaterThan(0);
    expect(m?.winbackDormantAt).toBeUndefined();
  }

  await t.mutation(internal.sendRetentionTexts.recordRetentionText, { memberId, gymId });
  const dormant = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(dormant?.winbackAttempts).toBe(3);
  expect(dormant?.winbackDormantAt).toBeGreaterThan(0);

  // And the gate now excludes them, which is the whole point of the counter.
  const atRisk = await t.query(internal.sendRetentionTexts.getAtRiskMembers, { gymId });
  expect(atRisk).toEqual([]);
});

test("recordRetentionText refuses to write across gyms", async () => {
  const t = convexTest(schema, modules);
  const gymId = await t.run(async (ctx) => ctx.db.insert("gyms", {}));
  const otherGymId = await t.run(async (ctx) => ctx.db.insert("gyms", {}));
  const memberId = await t.run(async (ctx) =>
    ctx.db.insert("members", { ...textable, name: "Other Gym Member", phone: "7205550106", gymId })
  );

  await expect(
    t.mutation(internal.sendRetentionTexts.recordRetentionText, { memberId, gymId: otherGymId })
  ).rejects.toThrow(/Member not found/);
});

test("checking in resets a dormant member's winback sequence", async () => {
  const t = convexTest(schema, modules);
  const gymId = await t.run(async (ctx) => ctx.db.insert("gyms", {}));
  const memberId = await t.run(async (ctx) =>
    ctx.db.insert("members", {
      ...textable,
      name: "Returning Member",
      phone: "7205550107",
      winbackAttempts: 3,
      winbackDormantAt: Date.now(),
      gymId,
    })
  );

  await t.mutation(api.members.checkIn, { id: memberId, gymId });

  const after = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(after?.winbackAttempts).toBe(0);
  expect(after?.winbackDormantAt).toBeUndefined();

  // Rearmed, not just silenced: the next cold streak has to text them again.
  await t.run(async (ctx) => ctx.db.patch(memberId, { lastVisit: undefined }));
  const atRisk = await t.query(internal.sendRetentionTexts.getAtRiskMembers, { gymId });
  expect(atRisk.map((m) => m.name)).toEqual(["Returning Member"]);
});

test("a same-day second check-in still clears the winback sequence", async () => {
  const t = convexTest(schema, modules);
  const gymId = await t.run(async (ctx) => ctx.db.insert("gyms", {}));
  // lastVisit already set to today, so checkIn's once-per-day branch is
  // skipped — the reset must not be trapped inside it.
  const memberId = await t.run(async (ctx) =>
    ctx.db.insert("members", {
      ...textable,
      name: "Second Scan Today",
      phone: "7205550108",
      lastVisit: new Date().toISOString(),
      winbackAttempts: 2,
      gymId,
    })
  );

  await t.mutation(api.members.checkIn, { id: memberId, gymId });

  const after = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(after?.winbackAttempts).toBe(0);
});
