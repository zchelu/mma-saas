import { internalMutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { validateRank, disciplineValidator } from "./beltTaxonomy";
import {
  DEMO_GUARDIAN_SIGNATURE_PNG,
  DEMO_SIGNATURE_PNG,
  DEMO_WAIVER_CONTENT,
  DEMO_WAIVER_TITLE,
} from "./demoWaiverText";
import {
  buildPlaceholderValues,
  isMinorOnDate,
  parseCalendarDate,
  resolvePlaceholders,
  shiftCalendarDate,
  DEFAULT_MINOR_AGE_THRESHOLD,
} from "../lib/documents";

// One-time full-gym demo seeder for scripts/seed-demo-gym.js. All randomized
// data (check-in timestamps, class assignments) is computed in the CLI
// script, not here, so this mutation stays fully deterministic (no Math.random
// inside a mutation).
//
// It writes the rows it is given, PLUS the Documents & Waivers demo block at
// the bottom, whose text, signer list and signature images originate here
// rather than in the payload — see convex/demoWaiverText.ts for why that text
// must never escape a demo gym.
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
        // "YYYY-MM-DD". Supplied for only some demo members on purpose: an
        // owner mid-rollout has dates of birth for some of their roster and
        // not others, and the kiosk's "we need a date of birth" step should be
        // reachable on a demo gym.
        dob: v.optional(v.string()),
      })
    ),
    // The CALLING MACHINE's calendar date, "YYYY-MM-DD" — see lib/localDate.ts.
    // Needed because seeded waivers render {{today}} into frozen text, and this
    // deployment runs in UTC: deriving it here would date a demo signature to
    // tomorrow whenever the seeder is run in the evening. scripts/
    // seed-demo-gym.js computes it with the local getters and passes it in,
    // exactly as the kiosk does.
    todayLocalDate: v.string(),
  },
  handler: async (ctx, { gymId, classes, members, todayLocalDate }) => {
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

    // AND refuse if the gym already has any document template.
    //
    // The members check above is not sufficient cover for the waiver block at
    // the bottom of this file. A real gym that has finished onboarding and
    // pasted its own waiver, but hasn't imported its roster yet — or a
    // mistyped --gym-id — would otherwise receive a SECOND isWaiver row
    // titled "(DEMO)". That row cannot be removed from the product:
    // deleteTemplate refuses any isWaiver row and updateTemplate cannot demote
    // one, so it would take a Convex dashboard delete. Until then it gates the
    // door, and every real member gets stopped at check-in and asked to sign
    // text that says it is not a valid legal agreement.
    const existingTemplates = await ctx.db
      .query("documentTemplates")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .collect();
    if (existingTemplates.length > 0) {
      throw new Error(
        `Gym ${gymId} already has ${existingTemplates.length} document template(s) — refusing to seed a demo waiver on top of a real one.`
      );
    }

    // The seeded waivers freeze this into their stored text. Validated for the
    // same reason documents.ts validates it on the signing path: this is an
    // internalMutation driven by a hand-assembled JSON payload, and a missing
    // or malformed value would silently render every seeded waiver's date line
    // as a blank rule instead of a date.
    if (!parseCalendarDate(todayLocalDate)) {
      throw new Error(
        `todayLocalDate must be a real calendar date, "YYYY-MM-DD" — got ${JSON.stringify(todayLocalDate)}.`
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
    // Name -> id, so the waiver seeding below can pick specific members
    // (including the one minor) without depending on insertion order.
    const memberIdsByName = new Map<string, Id<"members">>();

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
        ...(m.dob ? { dob: m.dob } : {}),
      });
      membersCreated++;
      memberIdsByName.set(m.name, memberId);
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

    // --- Documents & Waivers demo data ------------------------------------
    //
    // A gym owner on a sales call opens a member's Documents tab. If it's
    // empty the feature looks unbuilt, so the demo gym ships with a waiver and
    // a few signed copies of it.
    //
    // THESE ARE FABRICATED SIGNATURE RECORDS, and that is a real thing to be
    // careful with — a signedDocuments row asserts that a named human accepted
    // a liability release, which is the whole evidentiary point of the table.
    // This file already carries the same rule for consent ("no other seeded
    // member may ever be given a fabricated consent record"), so these follow
    // the strictest reading of it that still leaves a demoable screen:
    //
    //   - the template is titled "(DEMO)" and its text is topped and tailed
    //     with a marker saying it is not a valid legal agreement, so the
    //     FROZEN renderedContent on every seeded row says so too;
    //   - the signature images literally read "DEMO" when rendered;
    //   - the whole block only runs behind this mutation's existing refusal to
    //     seed a gym that already has members.
    //
    // Nothing here is ever created for a real signup. Production ships with no
    // template at all and an empty editor — see convex/demoWaiverText.ts.
    const waiverTemplateId = await ctx.db.insert("documentTemplates", {
      gymId,
      title: DEMO_WAIVER_TITLE,
      content: DEMO_WAIVER_CONTENT,
      isWaiver: true,
      requiresGuardianForMinors: true,
      requiredAtSignup: true,
      createdAt: Date.now(),
    });

    // Four signed copies: three adults and one minor countersigned by a
    // guardian, so the guardian block on the member profile is demoable
    // without anyone having to sign on the spot. Names must match MEMBER_DEFS
    // in scripts/seed-demo-gym.js; a rename there simply seeds fewer rows
    // rather than failing, which is the right failure for demo tooling.
    const SIGNERS: Array<{ name: string; guardian?: string; daysAgo: number }> = [
      { name: "Tyler Brandt", daysAgo: 46 },
      { name: "Hannah Cortez", daysAgo: 31 },
      { name: "Jordan Reyes", daysAgo: 12 },
      // The minor. MEMBER_DEFS gives Casey Whitfield a date of birth that puts
      // them under 18, which is what makes signDocument's guardian branch —
      // and this row — meaningful rather than decorative.
      { name: "Casey Whitfield", guardian: "Dana Whitfield", daysAgo: 5 },
    ];

    const minorAgeThreshold = gym.minorAgeThreshold ?? DEFAULT_MINOR_AGE_THRESHOLD;
    let signedDocumentsCreated = 0;
    const skippedSigners: string[] = [];

    for (const signer of SIGNERS) {
      const memberId = memberIdsByName.get(signer.name);
      if (!memberId) {
        skippedSigners.push(signer.name);
        continue;
      }
      const member = await ctx.db.get(memberId);
      if (!member) {
        skippedSigners.push(signer.name);
        continue;
      }

      // The date this signature is BACK-DATED to, and the date frozen into its
      // text — the same one. Rendering {{today}} as the day the seeder ran
      // while stamping signedAt six weeks earlier puts two contradicting dates
      // on the member's Documents tab, one in the header and one in the body,
      // on the exact screen this block exists to populate.
      const signedOn = shiftCalendarDate(todayLocalDate, -signer.daysAgo);
      if (!signedOn) throw new Error(`Could not back-date ${signer.daysAgo} days from ${todayLocalDate}`);

      // A guardian block on an adult's record is something the real signing
      // path cannot produce — signDocument stores one only when a guardian was
      // genuinely required. Rather than let a demo row drift into a shape the
      // product can't create, fail loudly: this only trips if someone edits
      // MEMBER_DEFS' dates without editing SIGNERS.
      const minorOnSigningDay = isMinorOnDate(member.dob, signedOn, minorAgeThreshold);
      if (signer.guardian && minorOnSigningDay !== true) {
        throw new Error(
          `SIGNERS lists a guardian for ${signer.name}, but their date of birth (${member.dob ?? "unset"}) does not make them a minor on ${signedOn}. Fix MEMBER_DEFS or SIGNERS.`
        );
      }
      if (!signer.guardian && minorOnSigningDay === true) {
        throw new Error(
          `${signer.name} is a minor on ${signedOn} but SIGNERS gives them no guardian — the real signing path would refuse this.`
        );
      }

      // Resolved and frozen exactly the way documents.ts:signDocument does it,
      // through the same pure helpers — so a demo row is structurally
      // identical to a real one and the Documents tab is showing the real
      // rendering path, not a mock of it.
      const renderedContent = resolvePlaceholders(
        DEMO_WAIVER_CONTENT,
        buildPlaceholderValues({
          memberName: member.name,
          memberDob: member.dob,
          memberAddress: member.address,
          gymName: gym.name,
          todayLocalDate: signedOn,
        })
      );

      await ctx.db.insert("signedDocuments", {
        gymId,
        memberId,
        templateId: waiverTemplateId,
        renderedContent,
        signatureData: DEMO_SIGNATURE_PNG,
        signerName: signer.name,
        ...(signer.guardian
          ? {
              guardianName: signer.guardian,
              guardianSignatureData: DEMO_GUARDIAN_SIGNATURE_PNG,
            }
          : {}),
        // Matches signedOn above, so the header date and the frozen body date
        // agree. Midday, so a timezone shift on the viewer's side can't slide
        // the displayed date off the frozen one.
        signedAt: Date.now() - signer.daysAgo * 24 * 60 * 60 * 1000,
      });
      signedDocumentsCreated++;
    }

    if (skippedSigners.length > 0) {
      console.log(
        `Seeded waivers skipped for ${skippedSigners.join(", ")} — no such member in MEMBER_DEFS.`
      );
    }

    return {
      waiverTemplateCreated: 1,
      signedDocumentsCreated,
      skippedSigners,
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
