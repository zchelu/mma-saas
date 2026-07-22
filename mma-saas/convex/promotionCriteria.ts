import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { disciplineValidator, validateRank } from "./beltTaxonomy";

// Admin-only bulk seed path for scripts/seed-promotion-criteria.js, invoked
// via the Convex CLI directly (no Clerk session available from a script, so
// this can't go through a public mutation the way a gym-owner UI eventually
// would). Mirrors members.ts:adminImportBatch's idempotency posture: safe to
// re-run, skipping any (discipline, belt) pair the gym already has a row for
// rather than inserting a duplicate.
export const seedDefaults = internalMutation({
  args: {
    gymId: v.id("gyms"),
    rows: v.array(
      v.object({
        discipline: disciplineValidator,
        belt: v.string(),
        requiredSessions: v.optional(v.number()),
        requiredDaysAtRank: v.optional(v.number()),
      })
    ),
  },
  handler: async (ctx, { gymId, rows }) => {
    const gym = await ctx.db.get(gymId);
    if (!gym) throw new Error(`No gym found with id ${gymId}`);

    const existing = await ctx.db
      .query("promotionCriteria")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .collect();
    const existingKeys = new Set(existing.map((r) => `${r.discipline}:${r.belt}`));

    const results: Array<{
      discipline: string;
      belt: string;
      status: "inserted" | "skipped" | "rejected";
      reason?: string;
    }> = [];

    for (const row of rows) {
      // Same validateRank() used by members.ts:adminImportBatch for `ranks`
      // rows — a promotionCriteria row is a belt/discipline claim just like a
      // rank is, so it goes through the same taxonomy check rather than a
      // second hand-rolled one. canonicalBelt (not row.belt) is what gets
      // stored/keyed on, matching the canonical-vs-display-label convention
      // documented in docs/belt-tracking-system.md.
      const check = validateRank(row.discipline, row.belt);
      if (!check.valid) {
        results.push({ discipline: row.discipline, belt: row.belt, status: "rejected", reason: check.reason });
        continue;
      }

      // A no-rank discipline (or a belt-based discipline's own "no_rank"
      // entry, included in migration-assets/defaultPromotionCriteria.json
      // only for completeness) has nothing to promote into — there's no
      // preceding rank to have satisfied criteria from. Skip rather than
      // write a criteria row that could never mean anything.
      if (check.canonicalBelt === "no_rank") {
        results.push({
          discipline: row.discipline,
          belt: check.canonicalBelt,
          status: "skipped",
          reason: "no_rank has nothing to promote into",
        });
        continue;
      }

      const key = `${row.discipline}:${check.canonicalBelt}`;
      if (existingKeys.has(key)) {
        results.push({ discipline: row.discipline, belt: check.canonicalBelt, status: "skipped", reason: "already exists for this gym" });
        continue;
      }

      await ctx.db.insert("promotionCriteria", {
        gymId,
        discipline: row.discipline,
        belt: check.canonicalBelt,
        requiredSessions: row.requiredSessions,
        requiredDaysAtRank: row.requiredDaysAtRank,
      });
      existingKeys.add(key);
      results.push({ discipline: row.discipline, belt: check.canonicalBelt, status: "inserted" });
    }

    return results;
  },
});
