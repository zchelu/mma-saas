import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { validateRank, disciplineValidator } from "./beltTaxonomy";

// One-time full-gym demo seeder for scripts/seed-demo-gym.js. All randomized
// data (check-in timestamps, class assignments) is computed in the CLI
// script, not here — this mutation just writes exactly the rows it's given,
// so it stays fully deterministic (no Math.random inside a mutation).
//
// Refuses to run against a gym that already has members, rather than trying
// to merge/dedupe like adminImportBatch does for repeated CSV imports — this
// is a one-shot "stand up a demo gym" operation, not a safe-to-rerun import.
export const seedDemoGym = internalMutation({
  args: {
    gymId: v.id("gyms"),
    classes: v.array(
      v.object({
        name: v.string(),
        instructor: v.string(),
        dayOfWeek: v.string(),
        time: v.string(),
      })
    ),
    members: v.array(
      v.object({
        name: v.string(),
        email: v.optional(v.string()),
        plan: v.string(),
        discipline: disciplineValidator,
        belt: v.string(),
        stripes: v.optional(v.number()),
        beltLabel: v.string(),
        checkInTimestamps: v.array(v.number()),
        classIndexes: v.array(v.number()),
        pastDueAmount: v.optional(v.number()),
        pastDueDaysAgo: v.optional(v.number()),
      })
    ),
  },
  handler: async (ctx, { gymId, classes, members }) => {
    const gym = await ctx.db.get(gymId);
    if (!gym) throw new Error(`No gym found with id ${gymId}`);

    const existingMembers = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .collect();
    if (existingMembers.length > 0) {
      throw new Error(
        `Gym ${gymId} already has ${existingMembers.length} member(s) — refusing to seed on top of existing data.`
      );
    }

    const classIds = [];
    for (const c of classes) {
      classIds.push(await ctx.db.insert("classes", { ...c, gymId }));
    }

    let membersCreated = 0;
    let ranksCreated = 0;
    let checkInsCreated = 0;
    let enrollmentsCreated = 0;
    let invoicesCreated = 0;
    let tylerBrandtId: string | undefined;

    for (const m of members) {
      const lastVisit = m.checkInTimestamps.length
        ? new Date(Math.max(...m.checkInTimestamps)).toISOString()
        : undefined;

      const memberId = await ctx.db.insert("members", {
        name: m.name,
        email: m.email,
        plan: m.plan,
        status: "active",
        beltRank: m.beltLabel,
        lastVisit,
        gymId,
      });
      membersCreated++;
      if (m.name === "Tyler Brandt") tylerBrandtId = memberId;

      const rankCheck = validateRank(m.discipline, m.belt, m.stripes);
      if (rankCheck.valid) {
        await ctx.db.insert("ranks", {
          memberId,
          gymId,
          discipline: m.discipline,
          currentBelt: rankCheck.canonicalBelt,
          currentStripes: m.stripes,
        });
        ranksCreated++;
      }

      for (const ts of m.checkInTimestamps) {
        await ctx.db.insert("checkIns", { memberId, gymId, timestamp: ts });
        checkInsCreated++;
      }

      for (const idx of m.classIndexes) {
        const classId = classIds[idx];
        if (classId) {
          await ctx.db.insert("enrollments", { memberId, classId });
          enrollmentsCreated++;
        }
      }

      if (m.pastDueAmount) {
        const dueDate = new Date(Date.now() - (m.pastDueDaysAgo ?? 7) * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        await ctx.db.insert("invoices", { memberId, amount: m.pastDueAmount, status: "unpaid", dueDate, gymId });
        invoicesCreated++;
      }
    }

    // Every member above deliberately has no phone/smsConsentConfirmed, so a
    // live winback run on the demo gym would otherwise text nobody. This one
    // extra member exists purely to pass sendRetentionTexts.ts:
    // getAtRiskMembers' send gate. Consent is hardcoded true here ONLY
    // because DEMO_PHONE is expected to be the gym owner's own number that
    // they've knowingly opted in for demo purposes — no other seeded member
    // may ever be given a fabricated consent record. Phone comes from an env
    // var, never hardcoded in source, since a realistic-looking hardcoded
    // number belongs to a real person and this gym auto-texts.
    const demoPhone = process.env.DEMO_PHONE;
    if (demoPhone) {
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      await ctx.db.insert("members", {
        name: "Demo Winback (owner phone)",
        plan: "Adult BJJ Unlimited",
        status: "active",
        beltRank: "White",
        lastVisit: tenDaysAgo,
        phone: demoPhone,
        smsConsentConfirmed: true,
        smsConsentConfirmedAt: Date.now(),
        smsConsentSource: "owner_attestation",
        gymId,
      });
      membersCreated++;
    } else {
      console.log(
        "Demo winback member skipped: DEMO_PHONE env var isn't set, so no member can pass the send gate."
      );
    }

    return {
      classesCreated: classIds.length,
      membersCreated,
      ranksCreated,
      checkInsCreated,
      enrollmentsCreated,
      invoicesCreated,
      tylerBrandtId,
    };
  },
});
