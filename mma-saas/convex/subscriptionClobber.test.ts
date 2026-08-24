/// <reference types="vite/client" />
// Regression suite for claude/gym-row-clobber-2026-08-20.md.
//
// On 2026-08-20 a gym row was found by clerkUserId alone and rewritten by an
// event belonging to a DIFFERENT Stripe subscription: cancelling a duplicate
// fired customer.subscription.deleted carrying the same clerkUserId, and it
// took a live trialing gym to canceled, repointed at the dead customer. One
// Clerk user can own several Stripe customers because the checkout route
// passes customer_email but never customer, so this is reachable any time a
// buyer checks out twice.
//
// Runs against convex-test's simulated backend — no deployment, no Stripe.
import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const CLERK_USER = "user_clobber_fixture";
const LIVE_SUB = "sub_live";
const LIVE_CUS = "cus_live";
const DEAD_SUB = "sub_dead";
const DEAD_CUS = "cus_dead";

async function seedLiveGym(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("gyms", {
      clerkUserId: CLERK_USER,
      stripeCustomerId: LIVE_CUS,
      stripeSubscriptionId: LIVE_SUB,
      plan: "academy",
      planStatus: "trialing",
    });
  });
}

// Collect-and-find rather than withIndex("by_clerk_user"): inside t.run,
// convex-test types ctx.db without the schema's own indexes, so an index name
// fails `tsc` even though it runs fine. Each test seeds one row, so a full
// collect is cheaper than the workaround would be.
async function readGym(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const gyms = await ctx.db.query("gyms").collect();
    return gyms.find((g) => g.clerkUserId === CLERK_USER) ?? null;
  });
}

describe("upsertSubscription: a dead sibling must not outrank a live subscription", () => {
  // THE INCIDENT. Without the guard this leaves the gym canceled and pointing
  // at the cancelled subscription's customer.
  test("REGRESSION a canceled event for a DIFFERENT subscription leaves the row untouched", async () => {
    const t = convexTest(schema, modules);
    await seedLiveGym(t);

    await t.mutation(internal.subscriptions.upsertSubscription, {
      clerkUserId: CLERK_USER,
      stripeCustomerId: DEAD_CUS,
      stripeSubscriptionId: DEAD_SUB,
      plan: "academy",
      planStatus: "canceled",
    });

    const gym = await readGym(t);
    expect(gym?.planStatus).toBe("trialing");
    expect(gym?.stripeSubscriptionId).toBe(LIVE_SUB);
    expect(gym?.stripeCustomerId).toBe(LIVE_CUS);
  });

  // The guard must not swallow a REAL cancellation — same subscription id.
  test("a canceled event for the row's OWN subscription still writes", async () => {
    const t = convexTest(schema, modules);
    await seedLiveGym(t);

    await t.mutation(internal.subscriptions.upsertSubscription, {
      clerkUserId: CLERK_USER,
      stripeCustomerId: LIVE_CUS,
      stripeSubscriptionId: LIVE_SUB,
      plan: "academy",
      planStatus: "canceled",
    });

    expect((await readGym(t))?.planStatus).toBe("canceled");
  });

  // A genuine resubscribe/upgrade legitimately takes the row over.
  test("a DIFFERENT subscription that is trialing takes the row", async () => {
    const t = convexTest(schema, modules);
    await seedLiveGym(t);

    await t.mutation(internal.subscriptions.upsertSubscription, {
      clerkUserId: CLERK_USER,
      stripeCustomerId: "cus_new",
      stripeSubscriptionId: "sub_new",
      plan: "fightteam",
      planStatus: "trialing",
    });

    const gym = await readGym(t);
    expect(gym?.stripeSubscriptionId).toBe("sub_new");
    expect(gym?.stripeCustomerId).toBe("cus_new");
    expect(gym?.plan).toBe("fightteam");
  });

  // past_due on the row's own subscription is a real state change, and the
  // guard never fires on a matching id.
  test("past_due on the row's own subscription still writes", async () => {
    const t = convexTest(schema, modules);
    await seedLiveGym(t);

    await t.mutation(internal.subscriptions.upsertSubscription, {
      clerkUserId: CLERK_USER,
      stripeCustomerId: LIVE_CUS,
      stripeSubscriptionId: LIVE_SUB,
      planStatus: "past_due",
    });

    expect((await readGym(t))?.planStatus).toBe("past_due");
  });

  // A gym that has never had a subscription must still be provisionable, even
  // by an event that arrives already canceled.
  test("a row with no stripeSubscriptionId accepts any event", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gyms", { clerkUserId: CLERK_USER, planStatus: "inactive" });
    });

    await t.mutation(internal.subscriptions.upsertSubscription, {
      clerkUserId: CLERK_USER,
      stripeCustomerId: DEAD_CUS,
      stripeSubscriptionId: DEAD_SUB,
      plan: "academy",
      planStatus: "canceled",
    });

    const gym = await readGym(t);
    expect(gym?.stripeSubscriptionId).toBe(DEAD_SUB);
    expect(gym?.onboardingCompleted).toBe(true);
  });
});

describe("updatePlanStatusByCustomer refuses to fail silently", () => {
  // The repair tool is only ever run by hand via `npx convex run`, which prints
  // nothing for a void mutation — so a no-op on a stale customer id looked
  // exactly like success and hid a broken gym for two rounds of "fixing" it.
  test("REGRESSION an unknown stripeCustomerId throws rather than no-opping", async () => {
    const t = convexTest(schema, modules);
    await seedLiveGym(t);

    await expect(
      t.mutation(internal.subscriptions.updatePlanStatusByCustomer, {
        stripeCustomerId: "cus_does_not_exist",
        planStatus: "trialing",
      })
    ).rejects.toThrow("nothing was updated");

    expect((await readGym(t))?.planStatus).toBe("trialing");
  });

  test("a matching customer is patched and the gym id returned", async () => {
    const t = convexTest(schema, modules);
    await seedLiveGym(t);

    const result = await t.mutation(internal.subscriptions.updatePlanStatusByCustomer, {
      stripeCustomerId: LIVE_CUS,
      planStatus: "past_due",
    });

    expect(result.planStatus).toBe("past_due");
    expect((await readGym(t))?.planStatus).toBe("past_due");
  });
});
