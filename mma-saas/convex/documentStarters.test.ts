/// <reference types="vite/client" />
// Covers the two places the starter library (lib/documentStarters.ts) meets
// Convex:
//
//   1. documents.createTemplate / updateTemplate refuse text that still has a
//      "[FILL IN: ...]" blank in it. The editor blocks this too, but the next
//      reader of a template is a member holding the tablet, and what they sign
//      is frozen — so the rule has to hold where it can't be bypassed.
//   2. seedDemoGym stands a demo gym up with the starter library as its
//      templates, every blank answered, while keeping the fabricated signed
//      copies marked as fake in their frozen text.
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { DEMO_WAIVER_MARKER } from "./demoWaiverText";
import { STARTER_DOCUMENTS, findStarter, unfilledBlanks } from "../lib/documentStarters";

const modules = import.meta.glob("./**/*.ts");

async function seedGym(t: ReturnType<typeof convexTest>) {
  const clerkUserId = `user_${Math.random().toString(36).slice(2)}`;
  const gymId = await t.run(async (ctx) =>
    ctx.db.insert("gyms", {
      clerkUserId,
      name: "Starter Test Academy",
      plan: "fightteam",
      planStatus: "active",
    })
  );
  return { asOwner: t.withIdentity({ subject: clerkUserId }), gymId };
}

test("every starter saves through createTemplate once its blanks are filled", async () => {
  const t = convexTest(schema, modules);
  const { asOwner } = await seedGym(t);

  for (const s of STARTER_DOCUMENTS) {
    // Stand-in for what an owner types over each blank in the editor.
    const content = s.content.replace(/\[FILL IN:[^\]]*\]/g, "as agreed with the front desk");
    await asOwner.mutation(api.documents.createTemplate, {
      title: s.title,
      content,
      isWaiver: s.isWaiver,
      requiresGuardianForMinors: s.requiresGuardianForMinors,
      requiredAtSignup: s.requiredAtSignup,
    });
  }

  const saved = await asOwner.query(api.documents.listTemplates, {});
  expect(saved).toHaveLength(STARTER_DOCUMENTS.length);
  expect(saved[0].isWaiver).toBe(true);
  expect(saved.filter((d) => d.requiredAtSignup).map((d) => d.title)).toEqual(["Liability Waiver"]);
});

test("a template with a blank left in it is refused on create and on update", async () => {
  const t = convexTest(schema, modules);
  const { asOwner } = await seedGym(t);
  const membership = findStarter("membership_agreement")!;
  expect(unfilledBlanks(membership.content).length).toBeGreaterThan(0);

  await expect(
    asOwner.mutation(api.documents.createTemplate, {
      title: membership.title,
      content: membership.content,
      isWaiver: false,
      requiresGuardianForMinors: true,
      requiredAtSignup: false,
    })
  ).rejects.toThrow(/Fill in the blanks/);

  const templateId = await asOwner.mutation(api.documents.createTemplate, {
    title: "House rules",
    content: "Be kind. Tap early.",
    isWaiver: false,
    requiresGuardianForMinors: false,
    requiredAtSignup: false,
  });
  await expect(
    asOwner.mutation(api.documents.updateTemplate, {
      templateId,
      title: "House rules",
      content: "Cancel by [FILL IN: how to cancel].",
      requiresGuardianForMinors: false,
      requiredAtSignup: false,
    })
  ).rejects.toThrow(/how to cancel/);

  // Ordinary square brackets are not blanks and must keep saving.
  await asOwner.mutation(api.documents.updateTemplate, {
    templateId,
    title: "House rules",
    content: "Be kind [always]. Tap early.",
    requiresGuardianForMinors: false,
    requiredAtSignup: false,
  });
});

test("seedDemoGym seeds the starter library, filled in, with marked signed copies", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, gymId } = await seedGym(t);

  const member = (name: string, dob?: string) => ({
    name,
    plan: "Adult BJJ Unlimited",
    discipline: "bjj_adult" as const,
    belt: "white",
    stripes: 0,
    beltLabel: "White",
    checkInTimestamps: [],
    classIndexes: [],
    ...(dob ? { dob } : {}),
  });

  const result = await t.mutation(internal.seedDemoGym.seedDemoGym, {
    gymId,
    classes: [],
    members: [
      member("Tyler Brandt", "1994-02-11"),
      member("Hannah Cortez"),
      member("Jordan Reyes"),
      // The seeded minor: under 18 on the back-dated signing day.
      member("Casey Whitfield", "2012-04-09"),
    ],
    todayLocalDate: "2026-10-03",
  });

  expect(result.documentTemplatesCreated).toBe(STARTER_DOCUMENTS.length);
  expect(result.signedDocumentsCreated).toBe(4);

  const templates = await asOwner.query(api.documents.listTemplates, {});
  expect(templates.map((d) => d.title)).toEqual(STARTER_DOCUMENTS.map((s) => s.title));
  expect(templates.filter((d) => d.isWaiver)).toHaveLength(1);
  for (const d of templates) {
    expect(unfilledBlanks(d.content), d.title).toEqual([]);
    // The template a live demo signer reads is the real starter text...
    expect(d.content).not.toContain(DEMO_WAIVER_MARKER);
  }

  // ...while every FABRICATED signature says, in its frozen text, that it is one.
  const signed = await t.run(async (ctx) => ctx.db.query("signedDocuments").collect());
  expect(signed).toHaveLength(4);
  for (const row of signed) {
    expect(row.renderedContent.startsWith(DEMO_WAIVER_MARKER)).toBe(true);
    expect(row.renderedContent.endsWith(DEMO_WAIVER_MARKER)).toBe(true);
    expect(row.renderedContent).toContain("Starter Test Academy");
    expect(row.renderedContent).not.toContain("{{");
  }
  const casey = signed.find((r) => r.signerName === "Casey Whitfield")!;
  expect(casey.guardianName).toBe("Dana Whitfield");
  expect(casey.renderedContent).toContain("September 28, 2026");

  // And it still refuses to run on top of a gym that has documents.
  await expect(
    t.mutation(internal.seedDemoGym.seedDemoGym, {
      gymId,
      classes: [],
      members: [],
      todayLocalDate: "2026-10-03",
    })
  ).rejects.toThrow(/already has/);
});
