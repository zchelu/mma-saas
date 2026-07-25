/// <reference types="vite/client" />
// Covers convex/members.ts's checkInToken issuance: generateUniqueCheckInToken's
// distinctness, regenerateCheckInToken's actual write behavior, and that
// overwriting checkInToken really does invalidate the old value against the
// by_check_in_token index — there's no separate revocation list, so that
// index behavior IS the entire invalidation mechanism and needs direct
// coverage, not just an assumption that it works.
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { generateUniqueCheckInToken } from "./members";

const modules = import.meta.glob("./**/*.ts");

async function seedGymAndMember(t: ReturnType<typeof convexTest>) {
  const clerkUserId = `user_${Math.random().toString(36).slice(2)}`;
  const { gymId, memberId } = await t.run(async (ctx) => {
    const gymId = await ctx.db.insert("gyms", {
      clerkUserId,
      plan: "fightteam",
      planStatus: "active",
    });
    const memberId = await ctx.db.insert("members", {
      name: "Test Member",
      plan: "BJJ Monthly",
      status: "active",
      gymId,
    });
    return { gymId, memberId };
  });
  return { asOwner: t.withIdentity({ subject: clerkUserId }), gymId, memberId };
}

test("generateUniqueCheckInToken produces distinct tokens across many calls", async () => {
  const t = convexTest(schema, modules);

  const tokens = await t.run(async (ctx) => {
    const results: string[] = [];
    for (let i = 0; i < 1000; i++) {
      results.push(await generateUniqueCheckInToken(ctx));
    }
    return results;
  });

  expect(new Set(tokens).size).toBe(1000);
});

test("regenerateCheckInToken changes checkInToken and sets checkInTokenIssuedAt", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, memberId } = await seedGymAndMember(t);

  await t.run(async (ctx) => {
    await ctx.db.patch(memberId, { checkInToken: "old-token-value", checkInTokenIssuedAt: 1 });
  });

  const before = Date.now();
  const newToken = await asOwner.mutation(api.members.regenerateCheckInToken, { memberId });
  const after = Date.now();

  const member = await t.run(async (ctx) => ctx.db.get(memberId));

  expect(newToken).not.toBe("old-token-value");
  expect(member!.checkInToken).toBe(newToken);
  expect(member!.checkInTokenIssuedAt).toBeGreaterThanOrEqual(before);
  expect(member!.checkInTokenIssuedAt).toBeLessThanOrEqual(after);
});

test("after regenerating, the old token no longer resolves via by_check_in_token", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, memberId } = await seedGymAndMember(t);

  const OLD_TOKEN = "old-token-value";
  await t.run(async (ctx) => {
    await ctx.db.patch(memberId, { checkInToken: OLD_TOKEN, checkInTokenIssuedAt: 1 });
  });

  await asOwner.mutation(api.members.regenerateCheckInToken, { memberId });

  const matches = await t.run(async (ctx) =>
    ctx.db
      .query("members")
      .withIndex("by_check_in_token", (q) => q.eq("checkInToken", OLD_TOKEN))
      .collect()
  );

  expect(matches).toHaveLength(0);
});

test("resolveCheckInToken returns the correct member for a valid token, null for an unknown one", async () => {
  const t = convexTest(schema, modules);
  const { gymId, memberId } = await seedGymAndMember(t);

  const TOKEN = "a-real-token-value";
  await t.run(async (ctx) => {
    await ctx.db.patch(memberId, { checkInToken: TOKEN, checkInTokenIssuedAt: Date.now() });
  });

  const resolved = await t.query(api.members.resolveCheckInToken, { token: TOKEN });
  expect(resolved).toEqual({ memberId, gymId, name: "Test Member" });

  const unresolved = await t.query(api.members.resolveCheckInToken, { token: "not-a-real-token" });
  expect(unresolved).toBeNull();
});
