import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

// Rewrites the seeded demo roster's email domain in place.
//
// WHY THIS EXISTS. scripts/seed-demo-gym.js originally generated addresses at
// "@demo.kombatdesk.test". `.test` is RFC 2606 reserved, which made every
// address guaranteed undeliverable — the same safety property the DEMO_PHONE
// comment in seedDemoGym.ts insists on for phone numbers. It was the right
// instinct with the wrong output: the /members Email column shows the domain on
// every row, and a reserved TLD reads as obviously fabricated to the one person
// we are trying to convince. The seeder now writes "@demo.kombatdesk.com" —
// still a domain we own, so still unroutable to a stranger, but it does not
// announce itself as fake.
//
// Changing the seeder does nothing for a gym that is already seeded, and
// seedDemoGym refuses to run against a gym that has members, so a reseed would
// mean hard-deleting member rows. Members are archived and never deleted
// because their consent fields are TCPA evidence (see the members table comment
// in schema.ts). Hence a patch of one field, in the same spirit as
// refreshDemoGym: touch nothing but the thing that is wrong.
//
// Idempotent. A second run finds no rows matching the old domain and no-ops.

const OLD_DOMAIN = "demo.kombatdesk.test";
const NEW_DOMAIN = "demo.kombatdesk.com";

export const relabelDemoEmails = internalMutation({
  args: {
    gymId: v.id("gyms"),
    // Compute and report everything, write nothing.
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { gymId, dryRun }) => {
    const gym = await ctx.db.get(gymId);
    if (!gym) throw new Error(`No gym found with id ${gymId}`);

    // GUARD 1 — never a paying customer. Mirrors refreshDemoGym's first guard.
    // A real gym's member emails are its own contact records; rewriting them
    // would be indistinguishable from data corruption.
    if (gym.stripeSubscriptionId) {
      throw new Error(
        `Refusing to relabel emails on gym ${gymId}: it has stripeSubscriptionId ${gym.stripeSubscriptionId}. ` +
          `This is a real customer, not a demo gym.`
      );
    }

    const members = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .collect();
    if (members.length === 0) {
      throw new Error(`Gym ${gymId} has no members — run scripts/seed-demo-gym.js first.`);
    }

    // GUARD 2 — the guard that matters, and the reason this is safe to point at
    // anything. Only addresses ending in the seeder's own reserved-TLD suffix
    // are eligible. A real address cannot end in "@demo.kombatdesk.test",
    // because `.test` can never be registered by anyone. So even a
    // mis-typed --gym-id cannot damage a member's real contact detail: the
    // filter simply matches nothing and the run reports zero changes.
    const suffix = `@${OLD_DOMAIN}`;
    const changes: { memberId: Id<"members">; name: string; from: string; to: string }[] = [];
    const otherDomains: { name: string; email: string }[] = [];

    for (const m of members) {
      const email = m.email;
      if (email === undefined) continue;
      const lower = email.toLowerCase();
      if (lower.endsWith(suffix)) {
        const local = email.slice(0, email.length - suffix.length);
        changes.push({ memberId: m._id, name: m.name, from: email, to: `${local}@${NEW_DOMAIN}` });
      } else if (!lower.endsWith(`@${NEW_DOMAIN}`)) {
        // Worth surfacing rather than silently ignoring: on a demo gym it means
        // a row was hand-edited, and the Email column will read inconsistently
        // on the call.
        otherDomains.push({ name: m.name, email });
      }
    }

    if (!dryRun) {
      for (const c of changes) {
        await ctx.db.patch(c.memberId, { email: c.to });
      }
    }

    return {
      dryRun: dryRun === true,
      totalMembers: members.length,
      // Members with no email at all — the DEMO_PHONE winback member is one.
      withoutEmail: members.filter((m) => m.email === undefined).length,
      relabeled: changes.length,
      changes,
      otherDomains,
    };
  },
});
