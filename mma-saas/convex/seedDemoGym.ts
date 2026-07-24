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
