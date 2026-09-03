/// <reference types="vite/client" />
// Covers convex/memberBilling.ts — the database half of Connect member dues.
//
// WHY THIS FILE EXISTS. Nothing in that module talks to Stripe; every mutation
// mirrors a fact Stripe already confirmed. That makes the module's whole value
// its refusals, and a refusal that isn't tested is a comment. Four properties
// are load-bearing:
//
//   1. CROSS-TENANT ISOLATION. A member id arrives from a browser. It is not a
//      capability, so every function taking one re-checks it against the
//      caller's own gym — the same property convex/gymPlans.test.ts pins for
//      plan ids. Without it, any signed-in owner could name another gym's
//      member id and read or bill them.
//   2. UNBACKFILLED MEMBERS. members.gymId is optional-until-backfilled, so a
//      row predating the migration belongs to NO gym. That is a separate case
//      from "belongs to someone else" and must also be refused.
//   3. FIRST WRITE WINS on the connected-account Customer id. Overwriting it
//      strands the card already attached to the original Customer, which is
//      the exact re-entry the whole migration story exists to avoid.
//   4. NARROWING. getMemberBillingState feeds a browser, and no stripeConnect*
//      identifier may cross that line — the same discipline that keeps
//      checkInToken out of members.getAtRiskMembers and the Price id out of
//      gymPlans.listPlans.
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

async function seedGym(
  t: ReturnType<typeof convexTest>,
  name = "Dues Test Gym",
  planStatus = "active"
) {
  const clerkUserId = `user_${Math.random().toString(36).slice(2)}`;
  const { gymId, memberId } = await t.run(async (ctx) => {
    const gymId = await ctx.db.insert("gyms", {
      clerkUserId,
      name,
      plan: "fightteam",
      planStatus,
      stripeConnectAccountId: "acct_test",
      connectChargesEnabled: true,
    });
    const memberId = await ctx.db.insert("members", {
      name: "Dues Payer",
      plan: "BJJ Monthly",
      status: "active",
      gymId,
    });
    return { gymId, memberId };
  });
  return { asOwner: t.withIdentity({ subject: clerkUserId }), gymId, memberId };
}

async function seedPlan(
  t: ReturnType<typeof convexTest>,
  gymId: Id<"gyms">,
  name = "Adult Unlimited"
) {
  return await t.mutation(internal.gymPlans.createPlanRow, {
    gymId,
    name,
    amountCents: 15000,
    interval: "month",
  });
}

// --- 1. Cross-tenant isolation ----------------------------------------------

test("REGRESSION getMemberForBilling refuses another gym's member", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedGym(t, "Alice BJJ");
  const bob = await seedGym(t, "Bob MMA");

  // Bob is a legitimate signed-in owner. The gymId check is the only thing
  // between him and Alice's member — and this is the query every Stripe action
  // calls before it creates a Customer or a subscription.
  expect(
    await t.query(internal.memberBilling.getMemberForBilling, {
      gymId: bob.gymId,
      memberId: alice.memberId,
    })
  ).toBeNull();

  expect(
    await t.query(internal.memberBilling.getMemberForBilling, {
      gymId: alice.gymId,
      memberId: alice.memberId,
    })
  ).toMatchObject({ name: "Dues Payer" });
});

test("getMemberForBilling refuses a member with no gymId at all", async () => {
  const t = convexTest(schema, modules);
  const { gymId } = await seedGym(t);

  // The optional-until-backfilled case (schema members.gymId, migrations.ts).
  // Not someone else's member — nobody's. Distinct from the wrong-gym case
  // above because the action turns it into a different owner-facing message.
  const orphanId = await t.run(async (ctx) =>
    ctx.db.insert("members", {
      name: "Pre-backfill",
      plan: "BJJ Monthly",
      status: "active",
    })
  );

  expect(
    await t.query(internal.memberBilling.getMemberForBilling, {
      gymId,
      memberId: orphanId,
    })
  ).toBeNull();
});

test("getMemberPlan and getMemberBillingState refuse another gym's member", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedGym(t, "Alice BJJ");
  const bob = await seedGym(t, "Bob MMA");

  const alicePlanId = await seedPlan(t, alice.gymId);
  await t.mutation(internal.memberBilling.setMemberPlanId, {
    gymId: alice.gymId,
    memberId: alice.memberId,
    planId: alicePlanId,
  });

  expect(
    await t.query(internal.memberBilling.getMemberPlan, {
      gymId: bob.gymId,
      memberId: alice.memberId,
    })
  ).toBeNull();

  // Bob signed in, naming Alice's member id. Null, not a billing drawer.
  expect(
    await bob.asOwner.query(api.memberBilling.getMemberBillingState, {
      memberId: alice.memberId,
    })
  ).toBeNull();

  // And Alice still sees her own.
  expect(
    await alice.asOwner.query(api.memberBilling.getMemberBillingState, {
      memberId: alice.memberId,
    })
  ).toMatchObject({ planId: alicePlanId, planName: "Adult Unlimited" });
});

// --- 2. getMemberPlan's two null cases --------------------------------------

test("getMemberPlan returns null for an archived plan and for another gym's plan", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedGym(t, "Alice BJJ");
  const bob = await seedGym(t, "Bob MMA");

  const planId = await seedPlan(t, alice.gymId);
  await t.mutation(internal.memberBilling.setMemberPlanId, {
    gymId: alice.gymId,
    memberId: alice.memberId,
    planId,
  });

  expect(
    await t.query(internal.memberBilling.getMemberPlan, {
      gymId: alice.gymId,
      memberId: alice.memberId,
    })
  ).toMatchObject({ name: "Adult Unlimited" });

  // Archived: the action must not create a subscription against a plan the
  // owner has already removed from the picker.
  await t.run(async (ctx) => ctx.db.patch(planId, { active: false }));
  expect(
    await t.query(internal.memberBilling.getMemberPlan, {
      gymId: alice.gymId,
      memberId: alice.memberId,
    })
  ).toBeNull();

  // Cross-tenant: a planId pointing at Bob's plan must not resolve for Alice's
  // member, or the subscription would bill against Bob's connected account.
  const bobPlanId = await seedPlan(t, bob.gymId, "Bob Plan");
  await t.run(async (ctx) =>
    ctx.db.patch(alice.memberId, { planId: bobPlanId })
  );
  expect(
    await t.query(internal.memberBilling.getMemberPlan, {
      gymId: alice.gymId,
      memberId: alice.memberId,
    })
  ).toBeNull();
});

// --- 3. The Customer id is written once -------------------------------------

test("REGRESSION claimMemberStripeConnectCustomerId never overwrites the first id", async () => {
  const t = convexTest(schema, modules);
  const { gymId, memberId } = await seedGym(t);

  expect(
    await t.mutation(internal.memberBilling.claimMemberStripeConnectCustomerId, {
      gymId,
      memberId,
      stripeConnectCustomerId: "cus_first",
    })
  ).toEqual({ stored: true, stripeConnectCustomerId: "cus_first" });

  // Two rapid clicks can each create a Customer at Stripe. The loser is told it
  // lost and gets back the id that actually stuck; taking the newer one would
  // strand whatever card is already attached to cus_first.
  expect(
    await t.mutation(internal.memberBilling.claimMemberStripeConnectCustomerId, {
      gymId,
      memberId,
      stripeConnectCustomerId: "cus_second",
    })
  ).toEqual({ stored: false, stripeConnectCustomerId: "cus_first" });

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member?.stripeConnectCustomerId).toBe("cus_first");
});

// --- 4. setMemberPlanId under a live subscription ---------------------------

test("setMemberPlanId refuses while a subscription is live, unless Stripe moved it first", async () => {
  const t = convexTest(schema, modules);
  const { gymId, memberId } = await seedGym(t);

  const oldPlanId = await seedPlan(t, gymId, "Old Plan");
  const newPlanId = await seedPlan(t, gymId, "New Plan");

  await t.mutation(internal.memberBilling.setMemberPlanId, {
    gymId,
    memberId,
    planId: oldPlanId,
  });
  await t.mutation(internal.memberBilling.setMemberDuesSubscription, {
    gymId,
    memberId,
    stripeConnectSubscriptionId: "sub_live",
    status: "active",
  });

  // Flipping planId under a running subscription would leave the row claiming
  // one price while Stripe bills another, with nothing on screen to show the
  // disagreement.
  await expect(
    t.mutation(internal.memberBilling.setMemberPlanId, {
      gymId,
      memberId,
      planId: newPlanId,
    })
  ).rejects.toThrow(/already has dues running/);

  expect(await t.run(async (ctx) => (await ctx.db.get(memberId))?.planId)).toBe(
    oldPlanId
  );

  // changeMemberPlan sets this once Stripe has confirmed the move.
  await t.mutation(internal.memberBilling.setMemberPlanId, {
    gymId,
    memberId,
    planId: newPlanId,
    allowWhileSubscribed: true,
  });
  expect(await t.run(async (ctx) => (await ctx.db.get(memberId))?.planId)).toBe(
    newPlanId
  );
});

// --- 5. Failure bookkeeping -------------------------------------------------

test("recordDuesFailure increments the count rather than overwriting it", async () => {
  const t = convexTest(schema, modules);
  const { gymId, memberId } = await seedGym(t);

  await t.mutation(internal.memberBilling.recordDuesFailure, {
    gymId,
    memberId,
    failedAt: 1000,
    status: "past_due",
  });
  await t.mutation(internal.memberBilling.recordDuesFailure, {
    gymId,
    memberId,
    failedAt: 2000,
    status: "unpaid",
  });

  // Consecutive failures are what make this a ranking signal getAtRiskMembers
  // can trust; a flat overwrite would make every member look equally at risk.
  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member?.duesFailureCount).toBe(2);
  expect(member?.duesFailedAt).toBe(2000);
  expect(member?.duesStatus).toBe("unpaid");
});

test("setMemberDuesSubscription clears the failure state only on an active status", async () => {
  const t = convexTest(schema, modules);
  const { gymId, memberId } = await seedGym(t);

  await t.mutation(internal.memberBilling.recordDuesFailure, {
    gymId,
    memberId,
    failedAt: 1000,
    status: "past_due",
  });

  // A non-active status leaves the failure state alone — the member has not
  // paid, so nothing has been resolved.
  await t.mutation(internal.memberBilling.setMemberDuesSubscription, {
    gymId,
    memberId,
    stripeConnectSubscriptionId: "sub_1",
    status: "past_due",
  });
  const stillFailing = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(stillFailing?.duesFailedAt).toBe(1000);
  expect(stillFailing?.duesFailureCount).toBe(1);

  // Active means Stripe collected. CLEARED, not decremented: the count is
  // consecutive failures, not a lifetime tally.
  await t.mutation(internal.memberBilling.setMemberDuesSubscription, {
    gymId,
    memberId,
    stripeConnectSubscriptionId: "sub_1",
    status: "active",
  });
  const recovered = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(recovered?.duesFailedAt).toBeUndefined();
  expect(recovered?.duesFailureCount).toBe(0);
  expect(recovered?.duesStatus).toBe("active");
});

// --- 6. Cancellation keeps the saved card -----------------------------------

test("REGRESSION clearMemberDuesSubscription keeps the Customer id and the plan", async () => {
  const t = convexTest(schema, modules);
  const { gymId, memberId } = await seedGym(t);

  const planId = await seedPlan(t, gymId);
  await t.mutation(internal.memberBilling.setMemberPlanId, {
    gymId,
    memberId,
    planId,
  });
  await t.mutation(internal.memberBilling.claimMemberStripeConnectCustomerId, {
    gymId,
    memberId,
    stripeConnectCustomerId: "cus_keep",
  });
  await t.mutation(internal.memberBilling.setMemberDuesSubscription, {
    gymId,
    memberId,
    stripeConnectSubscriptionId: "sub_live",
    status: "active",
  });

  await t.mutation(internal.memberBilling.clearMemberDuesSubscription, {
    gymId,
    memberId,
  });

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member?.stripeConnectSubscriptionId).toBeUndefined();
  expect(member?.duesStatus).toBe("canceled");
  // The Customer holds the saved card. A member who pauses over the summer and
  // returns in September must not have to re-enter it — re-entry is where the
  // whole migration objection lives. planId survives so the roster still shows
  // what they were on.
  expect(member?.stripeConnectCustomerId).toBe("cus_keep");
  expect(member?.planId).toBe(planId);
});

// --- 7. What getMemberBillingState puts on the wire -------------------------

test("getMemberBillingState never puts a connected-account identifier on the wire", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, gymId, memberId } = await seedGym(t);

  const planId = await seedPlan(t, gymId);
  await t.mutation(internal.gymPlans.setPlanStripeConnectPriceId, {
    gymId,
    planId,
    stripeConnectPriceId: "price_adult",
  });
  await t.mutation(internal.memberBilling.setMemberPlanId, {
    gymId,
    memberId,
    planId,
  });
  await t.mutation(internal.memberBilling.claimMemberStripeConnectCustomerId, {
    gymId,
    memberId,
    stripeConnectCustomerId: "cus_secret",
  });
  await t.mutation(internal.memberBilling.setMemberDuesSubscription, {
    gymId,
    memberId,
    stripeConnectSubscriptionId: "sub_secret",
    status: "active",
  });

  const state = await asOwner.query(api.memberBilling.getMemberBillingState, {
    memberId,
  });
  expect(state).not.toBeNull();
  expect(state).toMatchObject({
    connectReady: true,
    billable: true,
    planName: "Adult Unlimited",
    planAmountCents: 15000,
    planInterval: "month",
    planBillable: true,
    hasCustomer: true,
    hasSubscription: true,
    duesStatus: "active",
    duesFailureCount: 0,
  });

  // THE NARROWING GUARD. The two booleans are all the drawer needs. ABSENT,
  // not falsy — an undefined-but-present key is what a "simplifying" spread
  // would produce, and a leak the moment the field is populated.
  expect(state).not.toHaveProperty("stripeConnectCustomerId");
  expect(state).not.toHaveProperty("stripeConnectSubscriptionId");
  expect(state).not.toHaveProperty("stripeConnectPriceId");
  expect(state).not.toHaveProperty("stripeConnectAccountId");
  for (const key of Object.keys(state!)) {
    expect(key.startsWith("stripeConnect")).toBe(false);
  }
});

test("getMemberBillingState refuses a member with no gymId at all", async () => {
  const t = convexTest(schema, modules);
  const { asOwner } = await seedGym(t);

  // No gymId, so the signed-in owner does not own it — null, and the drawer
  // renders its empty state rather than offering to bill someone it cannot.
  const orphanId = await t.run(async (ctx) =>
    ctx.db.insert("members", {
      name: "Pre-backfill",
      plan: "BJJ Monthly",
      status: "active",
    })
  );

  expect(
    await asOwner.query(api.memberBilling.getMemberBillingState, {
      memberId: orphanId,
    })
  ).toBeNull();
});

test("getMemberBillingState returns null rather than throwing when nobody is signed in", async () => {
  const t = convexTest(schema, modules);
  const { memberId } = await seedGym(t);
  // Read through useQuery from a "use client" component, so it fires before
  // Clerk hydrates. A throw here renders as "Server Error" with no boundary to
  // catch it (518ad18).
  expect(
    await t.query(api.memberBilling.getMemberBillingState, { memberId })
  ).toBeNull();
});
