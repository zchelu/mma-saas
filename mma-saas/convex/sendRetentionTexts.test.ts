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
import { internal } from "./_generated/api";
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

// Retention texting used to be tiered (isProPlan/isElitePlan, removed): only
// fightteam/blackbelt got automated texts, only blackbelt got manual.
// academy/fightteam/blackbelt now get identical access, gated on billing
// status alone (requireWriteAccess/hasWriteAccess in convex/gyms.ts) — same
// bar as any other gym-scoped write. The one plan-based exclusion that
// survived is legacy "starter" rows (planHasTexting in lib/plans.ts): that
// slug never had texting under the old pricing, and switching the gate to
// billing-status-only shouldn't silently grant it retroactively just because
// the tier split it used to depend on is gone.
test("listTextableGyms includes every current tier, excludes starter, gated on billing status", async () => {
  const t = convexTest(schema, modules);

  const [academyActive, fightteamCanceled, blackbeltTrialing, starterActive] = await t.run(async (ctx) => [
    await ctx.db.insert("gyms", { plan: "academy", planStatus: "active" }),
    await ctx.db.insert("gyms", { plan: "fightteam", planStatus: "canceled" }),
    await ctx.db.insert("gyms", { plan: "blackbelt", planStatus: "trialing" }),
    await ctx.db.insert("gyms", { plan: "starter", planStatus: "active" }),
  ]);

  const textable = await t.query(internal.subscriptions.listTextableGyms, {});
  const textableIds = textable.map((g) => g._id).sort();

  expect(textableIds).toEqual([academyActive, blackbeltTrialing].sort());
  expect(textableIds).not.toContain(fightteamCanceled);
  expect(textableIds).not.toContain(starterActive);
});
