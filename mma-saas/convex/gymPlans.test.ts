/// <reference types="vite/client" />
// Covers convex/gymPlans.ts — the money object behind member billing.
//
// WHY THIS FILE EXISTS. Two properties in that module are load-bearing enough
// that a comment isn't enough, and neither was covered when stage 3 shipped:
//
//   1. CROSS-TENANT ISOLATION. A plan id arrives from a browser. It is not a
//      capability, so every function taking one re-checks it against the
//      caller's own gym. Without that check any signed-in owner could name
//      another gym's plan id and archive it, or stamp a Stripe Price onto it.
//   2. THE INTEGER-CENTS GUARD. `invoices.amount` is dollars-as-a-float and
//      lives one table away from `gymPlans.amountCents`. A float reaching
//      amountCents means someone passed dollars, and the row would bill 1/100th
//      of the intended amount while looking completely normal on screen.
//      lib/money.test.ts covers the parser; this covers the last line of
//      defence, which is the only one a caller bypassing the form still hits.
//
// Plus one narrowing guard: listPlans must not put a connected-account
// identifier on the wire, the same discipline that keeps checkInToken out of
// members.getAtRiskMembers.
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seedGym(
  t: ReturnType<typeof convexTest>,
  planStatus = "active",
  name = "Plans Test Gym"
) {
  const clerkUserId = `user_${Math.random().toString(36).slice(2)}`;
  const gymId = await t.run(async (ctx) =>
    ctx.db.insert("gyms", { clerkUserId, name, plan: "fightteam", planStatus })
  );
  return { asOwner: t.withIdentity({ subject: clerkUserId }), gymId };
}

// --- 1. Cross-tenant isolation ---------------------------------------------

test("REGRESSION one gym cannot archive another gym's plan", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedGym(t, "active", "Alice BJJ");
  const bob = await seedGym(t, "active", "Bob MMA");

  const alicePlanId = await t.mutation(internal.gymPlans.createPlanRow, {
    gymId: alice.gymId,
    name: "Adult Unlimited",
    amountCents: 15000,
    interval: "month",
  });

  // Bob is a perfectly legitimate signed-in owner with write access. The only
  // thing standing between him and Alice's plan is the gymId check.
  await expect(
    bob.asOwner.mutation(api.gymPlans.archivePlan, { planId: alicePlanId })
  ).rejects.toThrow(/no longer exists/);

  // Same message a genuinely missing plan gets, on purpose — a distinct error
  // would confirm that Alice's plan id is real.
  const stillThere = await t.run(async (ctx) => ctx.db.get(alicePlanId));
  expect(stillThere?.active).toBe(true);
});

test("getPlanForGym refuses to resolve another gym's plan", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedGym(t, "active", "Alice BJJ");
  const bob = await seedGym(t, "active", "Bob MMA");

  const alicePlanId = await t.mutation(internal.gymPlans.createPlanRow, {
    gymId: alice.gymId,
    name: "Adult Unlimited",
    amountCents: 15000,
    interval: "month",
  });

  // This is what the Stripe action calls before creating a Price. A null here
  // is what stops a Price for Bob's account being stamped onto Alice's plan.
  expect(
    await t.query(internal.gymPlans.getPlanForGym, {
      gymId: bob.gymId,
      planId: alicePlanId,
    })
  ).toBeNull();

  expect(
    await t.query(internal.gymPlans.getPlanForGym, {
      gymId: alice.gymId,
      planId: alicePlanId,
    })
  ).toMatchObject({ name: "Adult Unlimited", amountCents: 15000 });
});

test("setPlanStripeConnectPriceId refuses a plan belonging to another gym", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedGym(t, "active", "Alice BJJ");
  const bob = await seedGym(t, "active", "Bob MMA");

  const alicePlanId = await t.mutation(internal.gymPlans.createPlanRow, {
    gymId: alice.gymId,
    name: "Adult Unlimited",
    amountCents: 15000,
    interval: "month",
  });

  await expect(
    t.mutation(internal.gymPlans.setPlanStripeConnectPriceId, {
      gymId: bob.gymId,
      planId: alicePlanId,
      stripeConnectPriceId: "price_bob",
    })
  ).rejects.toThrow();

  const plan = await t.run(async (ctx) => ctx.db.get(alicePlanId));
  expect(plan?.stripeConnectPriceId).toBeUndefined();
});

// --- 2. The integer-cents guard ---------------------------------------------

test("REGRESSION createPlanRow rejects a float amount, which means dollars were passed", async () => {
  const t = convexTest(schema, modules);
  const { gymId } = await seedGym(t);

  // 150.5 is what arrives if a caller hands over dollars. Stored, it would be
  // a plan that bills a dollar fifty instead of a hundred and fifty.
  await expect(
    t.mutation(internal.gymPlans.createPlanRow, {
      gymId,
      name: "Adult Unlimited",
      amountCents: 150.5,
      interval: "month",
    })
  ).rejects.toThrow(/whole number of cents/);
});

test("createPlanRow holds the floor and the ceiling", async () => {
  const t = convexTest(schema, modules);
  const { gymId } = await seedGym(t);

  await expect(
    t.mutation(internal.gymPlans.createPlanRow, {
      gymId,
      name: "Too cheap",
      amountCents: 99,
      interval: "month",
    })
  ).rejects.toThrow(/at least/);

  await expect(
    t.mutation(internal.gymPlans.createPlanRow, {
      gymId,
      name: "Typo",
      amountCents: 1_000_001,
      interval: "month",
    })
  ).rejects.toThrow(/typo/);

  // Both boundaries themselves are allowed.
  await t.mutation(internal.gymPlans.createPlanRow, {
    gymId,
    name: "Floor",
    amountCents: 100,
    interval: "month",
  });
  await t.mutation(internal.gymPlans.createPlanRow, {
    gymId,
    name: "Ceiling",
    amountCents: 1_000_000,
    interval: "year",
  });
});

// --- 3. Duplicate names, which is what a double-submit produces -------------

test("createPlanRow rejects a duplicate active name, case- and space-insensitively", async () => {
  const t = convexTest(schema, modules);
  const { gymId } = await seedGym(t);

  const planId = await t.mutation(internal.gymPlans.createPlanRow, {
    gymId,
    name: "  Adult   Unlimited ",
    amountCents: 15000,
    interval: "month",
  });

  // Whitespace is normalized on the way in, so the stored name is clean.
  const stored = await t.run(async (ctx) => ctx.db.get(planId));
  expect(stored?.name).toBe("Adult Unlimited");

  await expect(
    t.mutation(internal.gymPlans.createPlanRow, {
      gymId,
      name: "adult unlimited",
      amountCents: 15000,
      interval: "month",
    })
  ).rejects.toThrow(/already have a plan/);

  // Archiving frees the name — an owner who removed a plan by mistake must be
  // able to recreate it.
  await t.run(async (ctx) => ctx.db.patch(planId, { active: false }));
  await t.mutation(internal.gymPlans.createPlanRow, {
    gymId,
    name: "Adult Unlimited",
    amountCents: 16000,
    interval: "month",
  });
});

test("another gym may use the same plan name", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedGym(t, "active", "Alice BJJ");
  const bob = await seedGym(t, "active", "Bob MMA");

  for (const gymId of [alice.gymId, bob.gymId]) {
    await t.mutation(internal.gymPlans.createPlanRow, {
      gymId,
      name: "Adult Unlimited",
      amountCents: 15000,
      interval: "month",
    });
  }
});

// --- 4. The Price id is written once ----------------------------------------

test("setPlanStripeConnectPriceId will not overwrite a different Price", async () => {
  const t = convexTest(schema, modules);
  const { gymId } = await seedGym(t);

  const planId = await t.mutation(internal.gymPlans.createPlanRow, {
    gymId,
    name: "Adult Unlimited",
    amountCents: 15000,
    interval: "month",
  });

  expect(
    await t.mutation(internal.gymPlans.setPlanStripeConnectPriceId, {
      gymId,
      planId,
      stripeConnectPriceId: "price_first",
    })
  ).toEqual({ stored: true, stripeConnectPriceId: "price_first" });

  // A Price is immutable at Stripe and a member may already be subscribed to
  // it. Taking the newer id would leave two Prices with only one reachable.
  expect(
    await t.mutation(internal.gymPlans.setPlanStripeConnectPriceId, {
      gymId,
      planId,
      stripeConnectPriceId: "price_second",
    })
  ).toEqual({ stored: false, stripeConnectPriceId: "price_first" });

  const plan = await t.run(async (ctx) => ctx.db.get(planId));
  expect(plan?.stripeConnectPriceId).toBe("price_first");

  // Re-sending the SAME id is the idempotent retry path and must succeed.
  expect(
    await t.mutation(internal.gymPlans.setPlanStripeConnectPriceId, {
      gymId,
      planId,
      stripeConnectPriceId: "price_first",
    })
  ).toEqual({ stored: true, stripeConnectPriceId: "price_first" });
});

// --- 5. What listPlans puts on the wire -------------------------------------

test("listPlans hides archived plans, sorts by name, and never returns a Stripe id", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, gymId } = await seedGym(t);

  const zebra = await t.mutation(internal.gymPlans.createPlanRow, {
    gymId,
    name: "Zebra Plan",
    amountCents: 20000,
    interval: "month",
  });
  const adult = await t.mutation(internal.gymPlans.createPlanRow, {
    gymId,
    name: "Adult Unlimited",
    amountCents: 15000,
    interval: "month",
  });
  const gone = await t.mutation(internal.gymPlans.createPlanRow, {
    gymId,
    name: "Retired Plan",
    amountCents: 12000,
    interval: "month",
  });

  await t.mutation(internal.gymPlans.setPlanStripeConnectPriceId, {
    gymId,
    planId: adult,
    stripeConnectPriceId: "price_adult",
  });
  await t.run(async (ctx) => ctx.db.patch(gone, { active: false }));

  const plans = await asOwner.query(api.gymPlans.listPlans, {});
  expect(plans).not.toBeNull();
  expect(plans!.map((p) => p.name)).toEqual(["Adult Unlimited", "Zebra Plan"]);

  // billable is the flag that lets the card say "not set up at Stripe yet"
  // instead of showing an un-priced plan as if it were ready to bill.
  expect(plans![0]).toMatchObject({ billable: true, amountCents: 15000 });
  expect(plans![1]).toMatchObject({ billable: false });

  // THE NARROWING GUARD. The browser has no use for a connected-account
  // identifier, and this is the assertion that keeps it that way when someone
  // later "simplifies" the map to a spread.
  for (const plan of plans!) {
    expect(plan).not.toHaveProperty("stripeConnectPriceId");
    expect(plan).not.toHaveProperty("gymId");
  }

  expect(zebra).toBeDefined();
});

test("listPlans returns null rather than throwing when nobody is signed in", async () => {
  const t = convexTest(schema, modules);
  await seedGym(t);
  // Fires from a "use client" component before Clerk hydrates. A throw here
  // renders as "Server Error" and, with no error boundary, took the whole
  // dashboard down once already (518ad18).
  expect(await t.query(api.gymPlans.listPlans, {})).toBeNull();
});

// --- 6. Write access, and why it is the opposite call to the kiosk ----------

test("a lapsed gym cannot archive a plan", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, gymId } = await seedGym(t, "past_due");

  const planId = await t.mutation(internal.gymPlans.createPlanRow, {
    gymId,
    name: "Adult Unlimited",
    amountCents: 15000,
    interval: "month",
  });

  // DELIBERATE, and the opposite answer to gyms.rotateKioskToken, which has no
  // write gate so a past_due gym can still open its front door. A lapsed gym
  // keeps its doors; it does not get to reshape a merchant account. Same
  // reasoning as connect.ts:getGymForConnect.
  await expect(
    asOwner.mutation(api.gymPlans.archivePlan, { planId })
  ).rejects.toThrow(/subscription isn't active/);
});

test("archivePlan hides the plan without deleting the row", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, gymId } = await seedGym(t, "active");

  const planId = await t.mutation(internal.gymPlans.createPlanRow, {
    gymId,
    name: "Adult Unlimited",
    amountCents: 15000,
    interval: "month",
  });

  await asOwner.mutation(api.gymPlans.archivePlan, { planId });

  // Soft, never a delete: duesInvoices rows and (from stage 4) members.planId
  // reference this row, and a delete would break the join that tells an owner
  // what a past charge was for.
  const plan = await t.run(async (ctx) => ctx.db.get(planId));
  expect(plan).not.toBeNull();
  expect(plan?.active).toBe(false);
  expect(await asOwner.query(api.gymPlans.listPlans, {})).toEqual([]);
});

// --- 7. The in-use guard ----------------------------------------------------

test("REGRESSION archivePlan refuses while a member is still being billed on it", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, gymId } = await seedGym(t, "active");

  const planId = await t.mutation(internal.gymPlans.createPlanRow, {
    gymId,
    name: "Adult Unlimited",
    amountCents: 15000,
    interval: "month",
  });

  await t.run(async (ctx) => {
    await ctx.db.insert("members", {
      name: "Paying Member",
      plan: "BJJ Monthly",
      status: "active",
      gymId,
      planId,
      stripeConnectSubscriptionId: "sub_live",
      duesStatus: "active",
    });
  });

  // Archiving hides the plan from the picker but does NOT touch its Stripe
  // Price, so the member keeps being charged. An owner who "removed" a plan
  // and then sees charges still landing has been lied to by the UI, and the
  // member is the one paying for it.
  await expect(
    asOwner.mutation(api.gymPlans.archivePlan, { planId })
  ).rejects.toThrow(/1 member is still being billed/);

  const plan = await t.run(async (ctx) => ctx.db.get(planId));
  expect(plan?.active).toBe(true);
  expect(await asOwner.query(api.gymPlans.listPlans, {})).toHaveLength(1);
});

test("archivePlan succeeds when a member holds the plan but has no subscription", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, gymId } = await seedGym(t, "active");

  const planId = await t.mutation(internal.gymPlans.createPlanRow, {
    gymId,
    name: "Adult Unlimited",
    amountCents: 15000,
    interval: "month",
  });

  await t.run(async (ctx) => {
    await ctx.db.insert("members", {
      name: "Assigned But Unbilled",
      plan: "BJJ Monthly",
      status: "active",
      gymId,
      planId,
    });
  });

  // planId alone bills nobody. Blocking on it would make a plan unremovable
  // for a reason the owner can neither see nor fix.
  await asOwner.mutation(api.gymPlans.archivePlan, { planId });

  const plan = await t.run(async (ctx) => ctx.db.get(planId));
  expect(plan?.active).toBe(false);
});
