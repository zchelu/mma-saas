/// <reference types="vite/client" />
// Verifies the planStatus enforcement added to requireGym()/requireWriteAccess()
// (convex/gyms.ts) and the isProPlan/isElitePlan retention-text gating
// (convex/subscriptions.ts). Runs entirely against convex-test's local
// simulated backend — no real Convex deployment, Clerk session, or Stripe
// call involved, so this is safe to run anytime with `npm run test:once`.
//
// t.withIdentity({ subject }) fakes ctx.auth.getUserIdentity() — requireGym
// resolves the gym by identity.subject === gyms.clerkUserId, so seeding a
// gym row with a matching clerkUserId is enough to act "as" that gym's
// owner without a real Clerk JWT.
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { expect, test, describe } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { isProPlan, isElitePlan } from "./subscriptions";

const modules = import.meta.glob("./**/*.ts");

async function seedGym(
  t: ReturnType<typeof convexTest>,
  fields: { plan?: string; planStatus?: string }
) {
  const clerkUserId = `user_${Math.random().toString(36).slice(2)}`;
  await t.run(async (ctx) => {
    await ctx.db.insert("gyms", { clerkUserId, ...fields });
  });
  return t.withIdentity({ subject: clerkUserId });
}

// --- Scenario 1: "inactive" (or no plan at all) blocks read entirely ---
describe("requireGym blocks inactive gyms outright", () => {
  test.each([undefined, "inactive"])("planStatus=%s -> getAll rejects", async (planStatus) => {
    const t = convexTest(schema, modules);
    const asOwner = await seedGym(t, { plan: "pro", planStatus });

    await expect(asOwner.query(api.members.getAll, {})).rejects.toThrow(
      "An active subscription is required to access this feature"
    );
  });

  test("the read-gate error is a ConvexError, not a plain Error (prod would redact a plain Error's message)", async () => {
    const t = convexTest(schema, modules);
    const asOwner = await seedGym(t, { planStatus: "inactive" });

    let threw = false;
    try {
      await asOwner.query(api.members.getAll, {});
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(ConvexError);
      expect((err as ConvexError<string>).data).toBe(
        "An active subscription is required to access this feature"
      );
    }
    expect(threw).toBe(true);
  });
});

// --- Scenario 2: canceled/past_due can read but not write ---
describe("canceled/past_due gyms: read allowed, write blocked", () => {
  test.each(["canceled", "past_due"])("planStatus=%s -> getAll resolves", async (planStatus) => {
    const t = convexTest(schema, modules);
    const asOwner = await seedGym(t, { plan: "pro", planStatus });

    await expect(asOwner.query(api.members.getAll, {})).resolves.toEqual([]);
  });

  const memberFields = {
    name: "Test Member",
    plan: "BJJ Monthly",
    status: "active" as const,
  };

  test.each(["canceled", "past_due"])(
    "planStatus=%s -> members.add rejects with the reactivate-billing message",
    async (planStatus) => {
      const t = convexTest(schema, modules);
      const asOwner = await seedGym(t, { plan: "pro", planStatus });

      await expect(asOwner.mutation(api.members.add, memberFields)).rejects.toThrow(
        "Your subscription isn't active — reactivate billing to make changes. You can still view your existing data."
      );
    }
  );

  test("the write-gate error is a ConvexError (survives prod redaction)", async () => {
    const t = convexTest(schema, modules);
    const asOwner = await seedGym(t, { plan: "pro", planStatus: "past_due" });

    let threw = false;
    try {
      await asOwner.mutation(api.members.add, memberFields);
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(ConvexError);
      expect((err as ConvexError<string>).data).toContain("reactivate billing");
    }
    expect(threw).toBe(true);
  });

  // Spot-check the other gym-scoped write mutations are actually wired to
  // requireWriteAccess too, not just members.add - each of these previously
  // had zero planStatus enforcement (see convex/gyms.ts's requireGym
  // comment history) and it'd be easy for a new mutation to forget the call.
  test("classes.add is also blocked when past_due", async () => {
    const t = convexTest(schema, modules);
    const asOwner = await seedGym(t, { plan: "pro", planStatus: "past_due" });

    await expect(
      asOwner.mutation(api.classes.add, {
        name: "Fundamentals",
        instructor: "Coach",
        dayOfWeek: "Monday",
        time: "6:00 PM",
      })
    ).rejects.toThrow("reactivate billing");
  });

  test("invoices.add is also blocked when canceled", async () => {
    const t = convexTest(schema, modules);
    const asOwner = await seedGym(t, { plan: "pro", planStatus: "active" });
    const memberId = await t.run(async (ctx) =>
      ctx.db.insert("members", { ...memberFields, gymId: (await ctx.db.query("gyms").first())!._id })
    );

    // Flip the same gym to canceled after the member exists, mirroring a
    // real lapse - the member was created while paying, the invoice attempt
    // happens after the subscription lapsed.
    await t.run(async (ctx) => {
      const gym = await ctx.db.query("gyms").first();
      await ctx.db.patch(gym!._id, { planStatus: "canceled" });
    });

    await expect(
      asOwner.mutation(api.invoices.add, {
        memberId,
        amount: 150,
        status: "unpaid",
        dueDate: "2026-08-01",
      })
    ).rejects.toThrow("reactivate billing");
  });
});

// --- active/trialing: full read+write ---
describe("active/trialing gyms have full read+write access", () => {
  test.each(["active", "trialing"])("planStatus=%s -> members.add resolves and getAll sees it", async (planStatus) => {
    const t = convexTest(schema, modules);
    const asOwner = await seedGym(t, { plan: "pro", planStatus });

    await asOwner.mutation(api.members.add, {
      name: "Test Member",
      plan: "BJJ Monthly",
      status: "active",
    });
    const members = await asOwner.query(api.members.getAll, {});
    expect(members).toHaveLength(1);
  });
});

// --- Scenario 3 (partial): reactivation restores write access at the data
// layer. The real Stripe-checkout path itself needs a live browser + Clerk
// session (see manual steps) - what IS scriptable is confirming that once
// planStatus flips back to an allowed value (exactly what
// claimGymBySessionId/the webhook do), write access returns immediately
// with no other state change needed. ---
test("flipping planStatus from canceled to active immediately restores write access", async () => {
  const t = convexTest(schema, modules);
  const asOwner = await seedGym(t, { plan: "pro", planStatus: "canceled" });

  await expect(
    asOwner.mutation(api.members.add, { name: "Blocked", plan: "x", status: "active" })
  ).rejects.toThrow("reactivate billing");

  await t.run(async (ctx) => {
    const gym = await ctx.db.query("gyms").first();
    await ctx.db.patch(gym!._id, { planStatus: "active" });
  });

  await expect(
    asOwner.mutation(api.members.add, { name: "Allowed", plan: "x", status: "active" })
  ).resolves.toBeDefined();
});

// --- Scenario 4: isProPlan/isElitePlan retention-text gating is unaffected
// by the planStatus write-gate work - these are separate, pure functions. ---
describe("isProPlan / isElitePlan", () => {
  test.each([
    [{ plan: "starter", planStatus: "active" }, false, false],
    [{ plan: "pro", planStatus: "active" }, true, false],
    [{ plan: "pro", planStatus: "trialing" }, true, false],
    [{ plan: "pro", planStatus: "canceled" }, false, false],
    [{ plan: "pro", planStatus: "past_due" }, false, false],
    [{ plan: "elite", planStatus: "active" }, true, true],
    [{ plan: "elite", planStatus: "trialing" }, true, true],
    [{ plan: "elite", planStatus: "canceled" }, false, false],
    [{ plan: "elite", planStatus: "past_due" }, false, false],
  ] as const)("%o -> isProPlan=%s isElitePlan=%s", (gym, pro, elite) => {
    expect(isProPlan(gym)).toBe(pro);
    expect(isElitePlan(gym)).toBe(elite);
  });

  test("null/undefined gym is neither", () => {
    expect(isProPlan(null)).toBe(false);
    expect(isElitePlan(null)).toBe(false);
  });
});
