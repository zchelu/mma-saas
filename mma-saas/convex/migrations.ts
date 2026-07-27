import { internalMutation, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { validateRank, type Discipline } from "./beltTaxonomy";
import { generateUniqueCheckInToken } from "./members";
import { generateGymSlug } from "./gyms";

// Shared by every table that has an optional gymId field awaiting backfill.
async function backfillGymId(
  ctx: MutationCtx,
  table: "members" | "classes" | "invoices",
  gymId: Id<"gyms">
) {
  const docs = await ctx.db.query(table).collect();
  let updated = 0;
  for (const doc of docs) {
    if (doc.gymId === undefined) {
      await ctx.db.patch(doc._id, { gymId });
      updated++;
    }
  }
  return { updated, total: docs.length };
}

// One-time backfill: ensures a gyms row exists for the given owner and that
// every pre-multi-tenancy members/classes/invoices row (gymId === undefined)
// gets pointed at it. Safe to re-run — only touches rows missing data, never
// overwrites an existing gymId.
//
// SAFETY: this assumes single-tenant history — every currently-orphaned row
// belongs to the ONE gym being backfilled. That's only true the first time
// this runs, before a second gym has ever created its own classes/invoices.
// Refuses to run once more than one gym exists, since at that point a blind
// "assign every orphaned row to this gymId" would misattribute a different
// gym's data. If that ever legitimately happens, backfill by hand per table
// instead of via this mutation.
//
// Internal — was a public mutation with no auth check, taking an arbitrary
// clerkUserId as a plain argument. The single-gym refusal guard below is a
// fragile safety net on its own (only holds until a second gym exists); this
// should never have been client-callable in the first place. Still runnable
// exactly the same way via the CLI: npx convex run
// migrations:backfillFirstGym '{"clerkUserId":"user_xxx","gymName":"KombatDesk"}'
// — the Convex CLI has deploy-admin access and can invoke internal functions
// directly, unlike the public client API.
export const backfillFirstGym = internalMutation({
  args: { clerkUserId: v.string(), gymName: v.string() },
  handler: async (ctx, { clerkUserId, gymName }) => {
    const allGyms = await ctx.db.query("gyms").collect();
    const existingGym = allGyms.find((g) => g.clerkUserId === clerkUserId);

    // Any orphaned row predates gym-scoping entirely, so it can only safely
    // be attributed to a single gym if that's the only gym that has ever
    // existed — a second gym (however it was created, including one newly
    // inserted by this very call) never has orphaned rows of its own, since
    // gymId is always set going forward. Safe iff every existing gym IS the
    // one being backfilled — i.e. there are no *other* gyms at all, whether
    // this call is reusing an existing gym or is about to create a new one.
    const otherGyms = allGyms.filter((g) => g._id !== existingGym?._id);
    if (otherGyms.length > 0) {
      throw new Error(
        `Refusing to backfill: ${otherGyms.length} other gym(s) already exist besides the target. ` +
          "This mutation assumes single-tenant history — a blind backfill now could misattribute another gym's data. Backfill by hand instead."
      );
    }

    let gymId: Id<"gyms">;
    if (existingGym) {
      gymId = existingGym._id;
      const patch: Record<string, unknown> = {};
      if (!existingGym.name) patch.name = gymName;
      if (!existingGym.createdAt) patch.createdAt = Date.now();
      if (Object.keys(patch).length > 0) await ctx.db.patch(gymId, patch);
    } else {
      gymId = await ctx.db.insert("gyms", {
        clerkUserId,
        name: gymName,
        plan: "academy",
        planStatus: "active",
        createdAt: Date.now(),
      });
    }

    const members = await backfillGymId(ctx, "members", gymId);
    const classes = await backfillGymId(ctx, "classes", gymId);
    const invoices = await backfillGymId(ctx, "invoices", gymId);

    return {
      gymId,
      membersUpdated: members.updated,
      totalMembers: members.total,
      classesUpdated: classes.updated,
      totalClasses: classes.total,
      invoicesUpdated: invoices.updated,
      totalInvoices: invoices.total,
    };
  },
});

// One-time backfill: assigns a checkInToken/checkInTokenIssuedAt to every
// existing member missing one — every member seeded/imported before
// regenerateCheckInToken existed has neither field set. Reuses
// generateUniqueCheckInToken (convex/members.ts) so the collision-check
// against by_check_in_token is identical to the one the real mutation uses,
// not a separate ad-hoc implementation that could drift out of sync. Safe to
// re-run — only touches members with no checkInToken yet.
//
// Run manually via the CLI:
//   npx convex run migrations:backfillCheckInTokens '{}'
export const backfillCheckInTokens = internalMutation({
  args: {},
  handler: async (ctx) => {
    const members = await ctx.db.query("members").collect();

    let updated = 0;
    let skippedAlreadySet = 0;

    for (const member of members) {
      if (member.checkInToken !== undefined) {
        skippedAlreadySet++;
        continue;
      }

      const token = await generateUniqueCheckInToken(ctx);
      await ctx.db.patch(member._id, { checkInToken: token, checkInTokenIssuedAt: Date.now() });
      updated++;
    }

    return { totalMembers: members.length, updated, skippedAlreadySet };
  },
});

// Duplicated from scripts/import-members.js's detectDiscipline() rather than
// imported from it — that script is a CommonJS CLI entrypoint with Node-only
// imports at module scope (fs/csv-parse/child_process) that can't be pulled
// into a Convex function bundle. Keep the keyword list in sync by hand if it
// ever changes there.
function detectDiscipline(programRaw: string | undefined): Discipline | undefined {
  const p = (programRaw || "").toLowerCase();
  if (p.includes("bjj") && p.includes("kid")) return "bjj_kids";
  if (p.includes("muay")) return "muay_thai";
  if (p.includes("wrestl")) return "wrestling";
  if (p.includes("mma")) return "mma";
  if (p.includes("bjj")) return "bjj_adult";
  return undefined;
}

// One-time backfill: infers a `ranks` row for every existing members row
// that has a beltRank but predates the ranks table (imported before
// adminImportBatch started writing ranks rows, or hand-typed via the
// dashboard, which has never validated beltRank against the taxonomy).
// Best-effort only, per the decision that scoped this: re-derives discipline
// from members.plan the same way the CSV importer does, and refuses to
// guess — a member is left with zero ranks rows (not a guessed one) if:
//   - plan text doesn't map to a known discipline
//   - beltRank doesn't validate against that discipline's taxonomy
//     (validateRank — the same check adminImportBatch uses)
//   - the member has no gymId yet (predates backfillFirstGym; ranks.gymId
//     is required, unlike members.gymId)
// Safe unscoped, same reasoning as markInactiveMembers below: each ranks row
// only ever uses that member's own gymId, never compares across gyms. Safe
// to re-run — skips any member that already has a ranks row for the
// detected discipline.
//
// Run manually, like backfillFirstGym above — not wired to any automatic
// trigger:
//   npx convex run migrations:backfillLegacyRanks '{}'
export const backfillLegacyRanks = internalMutation({
  args: {},
  handler: async (ctx) => {
    const members = await ctx.db.query("members").collect();

    let backfilled = 0;
    let skippedNoBeltRank = 0;
    let skippedNoDiscipline = 0;
    let skippedNoGymId = 0;
    let skippedInvalidBelt = 0;
    let skippedAlreadyBackfilled = 0;

    for (const member of members) {
      if (!member.beltRank) {
        skippedNoBeltRank++;
        continue;
      }

      const discipline = detectDiscipline(member.plan);
      if (!discipline) {
        skippedNoDiscipline++;
        continue;
      }

      if (!member.gymId) {
        skippedNoGymId++;
        continue;
      }

      const existing = await ctx.db
        .query("ranks")
        .withIndex("by_member_discipline", (q) =>
          q.eq("memberId", member._id).eq("discipline", discipline)
        )
        .first();
      if (existing) {
        skippedAlreadyBackfilled++;
        continue;
      }

      const check = validateRank(discipline, member.beltRank);
      if (!check.valid) {
        skippedInvalidBelt++;
        continue;
      }

      await ctx.db.insert("ranks", {
        memberId: member._id,
        gymId: member.gymId,
        discipline,
        currentBelt: check.canonicalBelt,
        promotionDate: member.beltPromotionDate,
      });
      backfilled++;
    }

    return {
      totalMembers: members.length,
      backfilled,
      skippedNoBeltRank,
      skippedNoDiscipline,
      skippedNoGymId,
      skippedInvalidBelt,
      skippedAlreadyBackfilled,
    };
  },
});

// One-time backfill: populates checkIns.gymId for rows written before the
// field existed, by resolving each row's memberId to that member's gymId.
// Unlike backfillFirstGym, this needs no single-tenant safety check — each
// checkIns row already encodes which member (and thus which gym) it belongs
// to via memberId, so there's no cross-gym misattribution risk even with
// multiple gyms now existing. Safe to re-run — only touches rows missing
// gymId, never overwrites an existing value. A row is left unbackfilled if
// its member has no gymId of its own yet (predates backfillFirstGym) or was
// deleted — both counted separately below so a non-zero total is visible
// rather than silently skipped.
//
// Run manually via the CLI:
//   npx convex run migrations:backfillCheckInsGymId '{}'
export const backfillCheckInsGymId = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("checkIns").collect();

    let updated = 0;
    let skippedAlreadySet = 0;
    let skippedNoMember = 0;
    let skippedMemberNoGymId = 0;

    for (const row of rows) {
      if (row.gymId !== undefined) {
        skippedAlreadySet++;
        continue;
      }

      const member = await ctx.db.get(row.memberId);
      if (!member) {
        skippedNoMember++;
        continue;
      }
      if (!member.gymId) {
        skippedMemberNoGymId++;
        continue;
      }

      await ctx.db.patch(row._id, { gymId: member.gymId });
      updated++;
    }

    return {
      totalCheckIns: rows.length,
      updated,
      skippedAlreadySet,
      skippedNoMember,
      skippedMemberNoGymId,
    };
  },
});

// Deletes every fake member scripts/seed-legacy-members.js created (matched
// by its @legacy-seed.test email suffix) along with any ranks rows already
// backfilled for them. adminImportBatch dedupes by email, so re-running the
// seed script after editing its ROWS data silently skips already-seeded
// rows instead of updating them — this clears the slate so a seed +
// backfill test cycle can be re-run from scratch. Dev-only in practice
// (nothing outside seed-legacy-members.js ever writes this email suffix),
// but not gym-scoped — matches every gym, same as markInactiveMembers.
export const deleteLegacySeedData = internalMutation({
  args: {},
  handler: async (ctx) => {
    const members = await ctx.db.query("members").collect();
    const seeded = members.filter((m) => m.email?.endsWith("@legacy-seed.test"));

    let ranksDeleted = 0;
    for (const member of seeded) {
      const ranks = await ctx.db
        .query("ranks")
        .withIndex("by_member", (q) => q.eq("memberId", member._id))
        .collect();
      for (const rank of ranks) {
        await ctx.db.delete(rank._id);
        ranksDeleted++;
      }
      await ctx.db.delete(member._id);
    }

    return { membersDeleted: seeded.length, ranksDeleted };
  },
});

// One-time backfill: assigns a slug (convex/gyms.ts:generateGymSlug) to every
// existing gym row created before onboarding.ts:completeOnboarding started
// doing this on new signups. A gym with no name yet never finished
// onboarding — nothing to slugify, and it'll get one the first time it does
// finish. Safe to re-run, like backfillCheckInTokens above — only touches
// gyms with no slug yet.
//
// Run manually via the CLI:
//   npx convex run migrations:backfillGymSlugs '{}'
export const backfillGymSlugs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const gyms = await ctx.db.query("gyms").collect();

    let updated = 0;
    let skippedAlreadySet = 0;
    let skippedNoName = 0;

    for (const gym of gyms) {
      if (gym.slug !== undefined) {
        skippedAlreadySet++;
        continue;
      }
      if (!gym.name) {
        skippedNoName++;
        continue;
      }

      const slug = await generateGymSlug(ctx, gym.name);
      await ctx.db.patch(gym._id, { slug });
      updated++;
    }

    return { totalGyms: gyms.length, updated, skippedAlreadySet, skippedNoName };
  },
});
