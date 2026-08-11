import { mutation, query, QueryCtx, MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { hasWriteAccess, requireGym, requireWriteAccess, tryGetReadableGym } from "./gyms";
import { assertMaxLength } from "./validate";
import { consumeRateLimit } from "./rateLimit";
import { getConsentText, CONSENT_VERSION } from "../lib/consentText";
import { numberHasOptOutOnRecord, normalizePhoneDigits } from "./members";
import {
  buildPlaceholderValues,
  DEFAULT_MINOR_AGE_THRESHOLD,
  isValidSignatureData,
  parseCalendarDate,
  placeholdersUsed,
  reconcileSigningDate as reconcile,
  resolvePlaceholders,
} from "../lib/documents";

// Documents & Waivers — the signing rail. The gym owner supplies their own
// waiver text; this product never generates legal language and must not start.
//
// TWO INVARIANTS, both enforced in signDocument below:
//
//   1. A signed document is FROZEN. Placeholders resolve once, at signing
//      time, into signedDocuments.renderedContent. Nothing re-renders a
//      signed record from its template, ever — an owner fixing a typo next
//      month must not retroactively alter what a member put their name to.
//   2. A minor cannot sign alone. Age is computed from the member's date of
//      birth against the gym's minorAgeThreshold, and an unknown date of
//      birth is refused rather than assumed adult. Kids programs are a large
//      share of a martial arts gym's revenue, which makes this the part of
//      the feature most likely to be exercised and least forgiving if wrong.
//
// AUTH SHAPE. Two audiences, deliberately split:
//   - Owner surfaces (/settings/documents, the member profile's Documents
//     tab) go through requireGym / tryGetReadableGym, like every other
//     dashboard function in this codebase.
//   - The kiosk is a tablet at the door with no Clerk session, exactly like
//     /checkin. Those functions take an explicit gymId, re-derive everything
//     else from the database, and never trust a client-supplied relationship
//     between two ids — see members.ts:checkIn, whose shape this follows.

// A waiver is a few pages of text; 50k characters is roughly 15 pages, well
// past any real liability waiver and far below Convex's 1 MB document limit
// once two signature PNGs are also in the row.
const MAX_TEMPLATE_CONTENT = 50_000;
const MAX_TEMPLATE_TITLE = 200;
const MAX_TEMPLATES_PER_GYM = 25;
const MAX_SIGNER_NAME = 200;
const MAX_MEMBER_ADDRESS = 500;

// Double-tap window for signDocument. A member hitting Accept twice, or a
// flaky tablet retrying the mutation, must not produce two signature records
// for one physical signing — an owner showing a lawyer a duplicate would have
// to explain it. Inside this window a repeat returns the existing row's id;
// OUTSIDE it, a second signature for the same document is refused outright —
// see the one-per-member-per-document rule in signDocument, which this window
// sits in front of rather than replaces.
const RESIGN_DEDUPE_WINDOW_MS = 60_000;

// The DEPLOYMENT's UTC calendar date. Used in exactly one place — as a
// second opinion on the signer's age (see signDocument) — and nowhere else.
//
// AGENTS.md §3 bans deriving a calendar date server-side, and rightly: this
// deployment runs in UTC, so after 6pm Mountain this returns TOMORROW, which
// is precisely why nothing may bucket, compare or display a gym's day from
// it. This is not that. The signing device's date remains authoritative; this
// exists only so an unauthenticated client can't declare an implausible
// "today" and turn a child into an adult. How the two dates are combined lives
// in reconcileSigningDate below — do not re-derive that rule here. Written out
// from the UTC getters rather than `toISOString().slice(0, 10)` so it can't be
// mistaken for the banned idiom, or copied into somewhere it would be one.
function utcCalendarDateNow(): string {
  const d = new Date(Date.now());
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Thin wrapper over the pure rule in lib/documents.ts — this file's only job
// is to supply the deployment's UTC date. Both getUnsignedRequiredDocs and
// signDocument go through here, which is what keeps the screen and the
// enforcement in agreement.
function reconcileSigningDate(todayLocalDate: string, dob: string | undefined) {
  return reconcile(todayLocalDate, utcCalendarDateNow(), dob);
}

// Kiosk-facing validation that survives production's error redaction. The
// helpers in convex/validate.ts throw plain Error, which production replaces
// with a generic "Server Error" (convex/gyms.ts explains why ConvexError is
// the exception) — fine on the dashboard, useless at the door, where the
// person reads "check the connection and try again" and retries the same
// invalid input forever. A mistyped email is the common case: HTML5
// type="email" accepts "maya@email", validate.ts's EMAIL_RE does not.
function assertKioskMaxLength(value: string | undefined, max: number, field: string): void {
  if (value !== undefined && value.length > max) {
    throw new ConvexError(`${field} is too long (max ${max} characters).`);
  }
}

const KIOSK_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertKioskEmail(value: string | undefined): void {
  if (value !== undefined && value.length > 0 && !KIOSK_EMAIL_RE.test(value)) {
    throw new ConvexError("That email address doesn't look right.");
  }
}

function minorAgeThresholdFor(gym: Doc<"gyms">): number {
  return gym.minorAgeThreshold ?? DEFAULT_MINOR_AGE_THRESHOLD;
}

// Must this document be signed before the member trains? That is a property of
// the document, NOT of whether it happens to be the waiver — a gym can mark a
// second document mandatory, or add a photo release that is genuinely optional.
// Optional documents are still collected at new-member signup; they just never
// block the door, because stopping a paying member mid-check-in over a photo
// release is how a gym switches this feature off.
//
// Falls back to isWaiver for rows written before the flag existed, which is the
// behaviour they were created under. One named predicate, so the check-in gate
// and the signup flow cannot drift apart.
function isRequired(template: Doc<"documentTemplates">): boolean {
  return template.requiredAtSignup ?? template.isWaiver;
}

async function listTemplatesForGym(
  ctx: QueryCtx | MutationCtx,
  gymId: Id<"gyms">
): Promise<Doc<"documentTemplates">[]> {
  return await ctx.db
    .query("documentTemplates")
    .withIndex("by_gym", (q) => q.eq("gymId", gymId))
    .collect();
}

// ---------------------------------------------------------------------------
// Owner: templates
// ---------------------------------------------------------------------------

// tryGetReadableGym, not requireGym — this renders in a "use client" component
// via useQuery, so it fires before Clerk's session has hydrated. requireGym
// throws a plain Error there, which production redacts to "Server Error", and
// with no error boundary that takes the whole route down. See the long comment
// on tryGetReadableGym in convex/gyms.ts.
export const listTemplates = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetReadableGym(ctx);
    if (!gym) return [];
    const templates = await listTemplatesForGym(ctx, gym._id);
    return templates
      .sort((a, b) => {
        // Waiver first, always — it is the one row an owner is looking for.
        if (a.isWaiver !== b.isWaiver) return a.isWaiver ? -1 : 1;
        return a.createdAt - b.createdAt;
      })
      .map((t) => ({
        _id: t._id,
        title: t.title,
        content: t.content,
        isWaiver: t.isWaiver,
        requiresGuardianForMinors: t.requiresGuardianForMinors,
        requiredAtSignup: isRequired(t),
        createdAt: t.createdAt,
      }));
  },
});

// The gym's minor threshold, for the settings screen to display and edit.
// Separate from listTemplates so the templates list isn't refetched when the
// number changes.
export const getDocumentSettings = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetReadableGym(ctx);
    if (!gym) return null;
    return {
      gymName: gym.name ?? null,
      minorAgeThreshold: minorAgeThresholdFor(gym),
    };
  },
});

export const setMinorAgeThreshold = mutation({
  args: { minorAgeThreshold: v.number() },
  handler: async (ctx, { minorAgeThreshold }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    if (!Number.isInteger(minorAgeThreshold) || minorAgeThreshold < 13 || minorAgeThreshold > 25) {
      throw new ConvexError("Minor age must be a whole number between 13 and 25.");
    }
    await ctx.db.patch(gym._id, { minorAgeThreshold });
  },
});

function validateTemplateFields(fields: { title: string; content: string }) {
  assertMaxLength(fields.title, MAX_TEMPLATE_TITLE, "Title");
  assertMaxLength(fields.content, MAX_TEMPLATE_CONTENT, "Document text");
  if (!fields.title.trim()) throw new ConvexError("Give this document a title.");
  if (!fields.content.trim()) {
    // Deliberately blunt: an empty waiver that members can still "sign"
    // produces signed records attesting to nothing, which is worse than
    // having no waiver at all.
    throw new ConvexError("A document with no text can't be signed. Paste your waiver text in.");
  }
}

export const createTemplate = mutation({
  args: {
    title: v.string(),
    content: v.string(),
    isWaiver: v.boolean(),
    requiresGuardianForMinors: v.boolean(),
    requiredAtSignup: v.boolean(),
  },
  handler: async (ctx, args) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    validateTemplateFields(args);

    const existing = await listTemplatesForGym(ctx, gym._id);
    if (existing.length >= MAX_TEMPLATES_PER_GYM) {
      throw new ConvexError(`You can have at most ${MAX_TEMPLATES_PER_GYM} documents.`);
    }
    // Exactly one waiver per gym. getUnsignedRequiredDocs and the check-in
    // gate both treat "the waiver" as singular; two of them would mean a
    // member could be blocked at the door by a document nobody remembers
    // creating, with no UI that explains which one.
    if (args.isWaiver && existing.some((t) => t.isWaiver)) {
      throw new ConvexError("You already have a waiver. Edit it instead of adding a second one.");
    }

    return await ctx.db.insert("documentTemplates", {
      gymId: gym._id,
      title: args.title.trim(),
      content: args.content,
      isWaiver: args.isWaiver,
      requiresGuardianForMinors: args.requiresGuardianForMinors,
      // The waiver is what gates the door, so it is required by definition —
      // an owner cannot accidentally switch the gate off by unticking a box.
      requiredAtSignup: args.isWaiver ? true : args.requiredAtSignup,
      createdAt: Date.now(),
    });
  },
});

// isWaiver is deliberately NOT editable. Promoting an ordinary document to
// the waiver, or demoting the waiver, would change what gates check-in for
// every member at once — and demoting is the delete block's back door.
export const updateTemplate = mutation({
  args: {
    templateId: v.id("documentTemplates"),
    title: v.string(),
    content: v.string(),
    requiresGuardianForMinors: v.boolean(),
    requiredAtSignup: v.boolean(),
  },
  handler: async (ctx, { templateId, ...fields }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    validateTemplateFields(fields);

    const existing = await ctx.db.get(templateId);
    if (!existing || existing.gymId !== gym._id) throw new ConvexError("Document not found");

    // Editing the template does NOT touch any signedDocuments row. Each one
    // carries its own frozen renderedContent, captured at signing time. This
    // is the invariant the whole feature is built around — see the header.
    await ctx.db.patch(templateId, {
      title: fields.title.trim(),
      content: fields.content,
      requiresGuardianForMinors: fields.requiresGuardianForMinors,
      // Same rule as createTemplate: the waiver is always required. See there.
      requiredAtSignup: existing.isWaiver ? true : fields.requiredAtSignup,
    });
  },
});

export const deleteTemplate = mutation({
  args: { templateId: v.id("documentTemplates") },
  handler: async (ctx, { templateId }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);

    const existing = await ctx.db.get(templateId);
    if (!existing || existing.gymId !== gym._id) throw new ConvexError("Document not found");
    if (existing.isWaiver) {
      throw new ConvexError(
        "The waiver can't be deleted — it's what gates check-in. Edit its text instead."
      );
    }

    // signedDocuments rows are NOT cascade-deleted. They are the evidence a
    // specific person signed a specific text on a specific day; deleting the
    // template must not destroy that. listSignedDocuments already tolerates a
    // missing template, since renderedContent is self-contained.
    await ctx.db.delete(templateId);
  },
});

// ---------------------------------------------------------------------------
// Kiosk: what still needs signing, and signing it
// ---------------------------------------------------------------------------

// PUBLIC AND UNAUTHENTICATED, same posture as members.getActiveForGym and
// members.checkIn: the caller supplies a gymId and every relationship is
// re-derived here rather than trusted.
//
// KNOWN EXPOSURE, stated at its real size rather than glossed.
//
// READ. This returns the document with placeholders already resolved, so if a
// gym's waiver uses {{member_address}} or {{member_dob}} those values come
// back over the wire, along with `isMinor`. The credential is the gym id in
// the kiosk URL — and members.getActiveForGym, which the kiosk also needs,
// hands out every active member id for that gym with no credential at all. So
// the accurate statement is: anyone holding a gym's kiosk URL can enumerate
// that roster and read each member's date of birth, home address and minor
// status, children included.
//
// The alternative — showing the signer blanks while STORING their real
// details — was rejected because a signed record that doesn't match what was
// on screen is worse on the axis this feature exists for.
//
// WRITE. signDocument below is public too, and this is not only a read gap.
// It can insert a signature row for any member of that gym (bounded to one
// per document, and rate-limited), and it can set a date of birth on a member
// who has none. That second one matters beyond tampering: the designed flow
// hands the tablet to the signer and treats the date they type as
// authoritative from then on, so a 12-year-old who enters an adult date has
// permanently disabled their own guardian requirement. An owner correcting
// the date in the member modal is the only remedy today.
//
// THE FIX, not made here: gate every kiosk function behind the per-member
// checkInToken that already exists on the members table
// (members.resolveCheckInToken), so possession of a gym id stops being
// sufficient. That is a separate change with its own migration. Do not
// describe this endpoint as closed.
export const getUnsignedRequiredDocs = query({
  args: {
    gymId: v.id("gyms"),
    memberId: v.id("members"),
    // The signing device's own calendar date, "YYYY-MM-DD". NOT derived here.
    // This deployment runs in UTC and gyms sign people up in the evening, when
    // UTC is already tomorrow — see lib/localDate.ts for the four times that
    // has gone wrong. It decides both the {{today}} placeholder and, on a
    // birthday, whether a guardian signature is required.
    todayLocalDate: v.string(),
    // What the signer has typed into the step's own date-of-birth / address
    // fields, for a member whose record doesn't have them yet. Used ONLY to
    // resolve the preview, and only where the stored field is empty — nothing
    // is written by a query. They exist so the document on screen is the
    // document that gets signed: without them the member would read a waiver
    // showing "__________" and signDocument would store one showing their real
    // details, which is a mismatch on a legal record.
    dobDraft: v.optional(v.string()),
    addressDraft: v.optional(v.string()),
    // New-member signup collects EVERYTHING outstanding — the waiver plus any
    // photo release or rental agreement the gym has added. The check-in gate
    // passes this false (or omits it) and sees only required documents,
    // because the door must not be blocked by an optional form.
    includeOptional: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { gymId, memberId, todayLocalDate, dobDraft, addressDraft, includeOptional }
  ) => {
    // A malformed date here would silently produce a null age, which reads as
    // "unknown" everywhere downstream. Rejecting outright keeps the one input
    // the minor rule depends on from being quietly discardable.
    if (!parseCalendarDate(todayLocalDate)) return null;
    const gym = await ctx.db.get(gymId);
    if (!gym) return null;
    const member = await ctx.db.get(memberId);
    if (!member || member.gymId !== gymId || member.archived) return null;

    const threshold = minorAgeThresholdFor(gym);
    const effectiveDob = member.dob ?? (dobDraft?.trim() || undefined);
    const effectiveAddress = member.address ?? (addressDraft?.trim() || undefined);
    // THE SAME reconciliation signDocument uses. It has to be: this query
    // decides whether the guardian pad is rendered, and signDocument decides
    // whether a guardian signature is demanded. When the two disagreed, a
    // tablet with a badly wrong clock produced a screen with no guardian pad
    // and a mutation that refused to sign without one — unrecoverable, since
    // the error text names a field that isn't on screen. The mirror case was
    // worse: the pad shown, the parent signs, and the mutation drops it.
    const { today: effectiveToday, age } = reconcileSigningDate(todayLocalDate, effectiveDob);

    const templates = await listTemplatesForGym(ctx, gymId);
    const signed = await ctx.db
      .query("signedDocuments")
      .withIndex("by_gym_member", (q) => q.eq("gymId", gymId).eq("memberId", memberId))
      .collect();
    const signedTemplateIds = new Set(signed.map((s) => s.templateId));

    const values = buildPlaceholderValues({
      memberName: member.name,
      memberDob: effectiveDob,
      memberAddress: effectiveAddress,
      gymName: gym.name,
      todayLocalDate: effectiveToday,
    });

    const outstanding = templates
      .filter((t) => (includeOptional === true || isRequired(t)) && !signedTemplateIds.has(t._id))
      // Waiver first: if a member walks away halfway through signup, the one
      // document that had to be signed is the one that was.
      .sort((a, b) => (a.isWaiver === b.isWaiver ? a.createdAt - b.createdAt : a.isWaiver ? -1 : 1));

    return {
      memberName: member.name,
      gymName: gym.name ?? null,
      minorAgeThreshold: threshold,
      // Derived, not the raw date of birth — the signing step only needs to
      // know whether to show the guardian pad.
      isMinor: age === null ? null : age < threshold,
      // Which details the step has to ask for before anything can be signed.
      // Booleans, not values: the member's stored date of birth and address
      // never cross this unauthenticated boundary on their own.
      //
      // A date of birth is needed whenever an outstanding document either
      // requires a guardian for minors (age has to be known to apply the rule)
      // or prints {{member_dob}} into its text.
      needsDob:
        member.dob === undefined &&
        outstanding.some(
          (t) =>
            t.requiresGuardianForMinors ||
            placeholdersUsed(t.content).includes("member_dob")
        ),
      needsAddress:
        member.address === undefined &&
        outstanding.some((t) => placeholdersUsed(t.content).includes("member_address")),
      documents: outstanding.map((t) => ({
        _id: t._id,
        title: t.title,
        isWaiver: t.isWaiver,
        requiresGuardianForMinors: t.requiresGuardianForMinors,
        // Resolved for display. signDocument resolves again from the
        // authoritative record at write time; it never trusts this string.
        renderedContent: resolvePlaceholders(t.content, values),
      })),
    };
  },
});

export const signDocument = mutation({
  args: {
    gymId: v.id("gyms"),
    memberId: v.id("members"),
    templateId: v.id("documentTemplates"),
    signatureData: v.string(),
    signerName: v.string(),
    // See getUnsignedRequiredDocs — supplied by the signing device, never
    // derived here.
    todayLocalDate: v.string(),
    guardianName: v.optional(v.string()),
    guardianSignatureData: v.optional(v.string()),
    // Collected in the signing step when the member record doesn't have them
    // yet. Written ONLY into a currently-empty field (see below) — this is an
    // unauthenticated endpoint and must not be a way to overwrite roster data.
    dob: v.optional(v.string()),
    address: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const {
      gymId,
      memberId,
      templateId,
      signatureData,
      signerName,
      todayLocalDate,
      guardianName,
      guardianSignatureData,
    } = args;

    // Same bucket shape as the kiosk's check-in limiter: a per-gym ceiling
    // that a real front desk cannot hit, consumed in this transaction rather
    // than via a round trip. See convex/rateLimit.ts.
    const allowed = await consumeRateLimit(ctx, "documentSign", gymId);
    if (!allowed) {
      throw new ConvexError("Too many signatures right now — try again in a few minutes.");
    }

    const gym = await ctx.db.get(gymId);
    if (!gym) throw new ConvexError("Gym not found");

    const member = await ctx.db.get(memberId);
    if (!member || member.gymId !== gymId || member.archived) {
      throw new ConvexError("Member not found");
    }

    const template = await ctx.db.get(templateId);
    if (!template || template.gymId !== gymId) throw new ConvexError("Document not found");

    // The signing device's date is load-bearing — it decides {{today}} and it
    // decides the signer's age. An unparseable one must not fall through to
    // "unknown", because the age check below would then run on the server's
    // UTC date alone, and after 6pm Mountain that is tomorrow. On a member's
    // 18th birthday-eve that difference is the whole guardian requirement.
    if (!parseCalendarDate(todayLocalDate)) {
      throw new ConvexError("This device's date looks wrong — check its clock and try again.");
    }

    const trimmedSigner = signerName.trim();
    assertKioskMaxLength(trimmedSigner, MAX_SIGNER_NAME, "Name");
    if (!trimmedSigner) throw new ConvexError("Type the signer's name.");
    if (!isValidSignatureData(signatureData)) {
      throw new ConvexError("That signature didn't come through — clear it and sign again.");
    }

    // Fill in details the member record is missing, and ONLY those. An
    // unauthenticated caller must not be able to rewrite a date of birth that
    // is already on file — that value decides whether a guardian signature is
    // required, so an overwrite here would be a way to sign a child's waiver
    // as an adult.
    const memberPatch: { dob?: string; address?: string } = {};
    if (member.dob === undefined && args.dob !== undefined) {
      const parsed = parseCalendarDate(args.dob);
      if (!parsed) throw new ConvexError("That date of birth doesn't look right.");
      memberPatch.dob = args.dob.trim();
    }
    if (member.address === undefined && args.address !== undefined) {
      const address = args.address.trim();
      assertKioskMaxLength(address, MAX_MEMBER_ADDRESS, "Address");
      if (address) memberPatch.address = address;
    }

    const effectiveDob = memberPatch.dob ?? member.dob;
    const effectiveAddress = memberPatch.address ?? member.address;
    const threshold = minorAgeThresholdFor(gym);

    // VALIDATED UNCONDITIONALLY, not inside the minor branch below. These two
    // fields are stored whenever they're present, so validating them only when
    // a guardian was required left a hole: sign an ADULT's copy of a
    // guardian-requiring waiver, pass a megabyte of text and an SVG data URL,
    // and both land in the row that the owner's dashboard renders as an
    // <img src>. Shape and size are properties of the input, so they're
    // checked where the input arrives.
    const trimmedGuardian = (guardianName ?? "").trim();
    assertKioskMaxLength(trimmedGuardian, MAX_SIGNER_NAME, "Guardian name");
    if (guardianSignatureData !== undefined && !isValidSignatureData(guardianSignatureData)) {
      throw new ConvexError("That guardian signature didn't come through — clear it and sign again.");
    }

    // Reconciled ONCE, and used for both things that depend on the date: the
    // age check below and the {{today}} frozen into the document. An earlier
    // version reconciled only the age and then froze the raw client string, so
    // the one value it had just decided was untrustworthy was still what got
    // printed into a permanent legal record — a tablet whose battery died and
    // came back on its RTC default would stamp the waiver "January 1, 2020".
    const { today: effectiveToday, age } = reconcileSigningDate(todayLocalDate, effectiveDob);

    // Was a guardian actually required for THIS signing? Computed once and
    // used both to enforce and to decide what gets stored, so a guardian
    // signature can never be recorded for a signing that didn't need one.
    let guardianRequired = false;
    if (template.requiresGuardianForMinors) {
      if (age === null) {
        // Unknown age is refused, never assumed adult. lib/documents.ts
        // returns null rather than false for exactly this branch.
        throw new ConvexError(
          "We need this member's date of birth before this document can be signed."
        );
      }

      guardianRequired = age < threshold;
      if (guardianRequired) {
        if (!trimmedGuardian) {
          throw new ConvexError("A parent or guardian must print their name.");
        }
        if (!guardianSignatureData) {
          throw new ConvexError(
            `A parent or guardian must sign for a member under ${threshold}.`
          );
        }
      }
    }

    const now = Date.now();

    const priorSignatures = await ctx.db
      .query("signedDocuments")
      .withIndex("by_gym_member", (q) => q.eq("gymId", gymId).eq("memberId", memberId))
      .collect();
    const prior = priorSignatures.filter((s) => s.templateId === templateId);

    // Double-tap guard. See RESIGN_DEDUPE_WINDOW_MS.
    const duplicate = prior.find((s) => now - s.signedAt < RESIGN_DEDUPE_WINDOW_MS);
    if (duplicate) return duplicate._id;

    // ONE SIGNATURE PER MEMBER PER DOCUMENT. This endpoint is unauthenticated
    // and the gym id travels in a kiosk URL, so without this anyone holding
    // that URL could append unlimited rows to the one table whose value is
    // being trustworthy evidence — an owner opening a member's Documents tab
    // would find a stack of signatures they'd have to explain. There is no
    // legitimate re-sign today: templates aren't versioned, and editing one
    // deliberately leaves signed records alone. Adding versioning later means
    // relaxing this to "once per template version", not deleting it.
    if (prior.length > 0) {
      throw new ConvexError("This document has already been signed.");
    }

    if (Object.keys(memberPatch).length > 0) {
      await ctx.db.patch(memberId, memberPatch);
    }

    // THE FREEZE. Resolved here, from the authoritative gym/member record and
    // this template's text as it exists right now, and stored. Never resolved
    // again. The client's rendered copy is display only and is not trusted.
    const renderedContent = resolvePlaceholders(
      template.content,
      buildPlaceholderValues({
        memberName: member.name,
        memberDob: effectiveDob,
        memberAddress: effectiveAddress,
        gymName: gym.name,
        todayLocalDate: effectiveToday,
      })
    );

    // Stored only when a guardian was genuinely required. An adult's record
    // must never carry a guardian block — reading one there would imply the
    // gym believed this member was a child. `guardianRequired` is sufficient
    // on its own: the branch above throws unless both the name and the
    // signature are present, so there is nothing further to re-test here.
    const storeGuardian = guardianRequired;

    return await ctx.db.insert("signedDocuments", {
      gymId,
      memberId,
      templateId,
      renderedContent,
      signatureData,
      signerName: trimmedSigner,
      ...(storeGuardian
        ? { guardianName: trimmedGuardian, guardianSignatureData: guardianSignatureData! }
        : {}),
      signedAt: now,
      // ipAddress is left unset on purpose. Convex mutations cannot see the
      // caller's address, and accepting one as an argument from an
      // unauthenticated kiosk would put a client-asserted string into a field
      // whose only value is being trustworthy evidence. The schema field
      // stays so a future server-side signing route (the shape
      // convex/consent.ts:submitConsent already uses, where a Next.js action
      // passes the edge-verified IP) can populate it honestly.
    });
  },
});

// ---------------------------------------------------------------------------
// Owner: a member's signed documents
// ---------------------------------------------------------------------------

export const listSignedDocuments = query({
  args: { memberId: v.id("members") },
  handler: async (ctx, { memberId }) => {
    const gym = await tryGetReadableGym(ctx);
    if (!gym) return [];

    const member = await ctx.db.get(memberId);
    if (!member || member.gymId !== gym._id) return [];

    const signed = await ctx.db
      .query("signedDocuments")
      .withIndex("by_gym_member", (q) => q.eq("gymId", gym._id).eq("memberId", memberId))
      .collect();

    // Templates are looked up only for the CURRENT title. renderedContent is
    // self-contained by design, so a deleted template leaves the record fully
    // readable — same reasoning as invoices.getAll's "Unknown Member".
    return await Promise.all(
      signed
        .sort((a, b) => b.signedAt - a.signedAt)
        .map(async (s) => {
          const template = await ctx.db.get(s.templateId);
          return {
            _id: s._id,
            title: template?.title ?? "Document",
            isWaiver: template?.isWaiver ?? false,
            renderedContent: s.renderedContent,
            signatureData: s.signatureData,
            signerName: s.signerName,
            guardianName: s.guardianName,
            guardianSignatureData: s.guardianSignatureData,
            signedAt: s.signedAt,
          };
        })
    );
  },
});

// Roster-wide count of members with an unsigned waiver, for the /members
// screen's summary row. Owner-facing, so it goes through the authenticated
// path and never takes a gymId from the client.
export const getUnsignedWaiverCount = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetReadableGym(ctx);
    if (!gym) return null;

    // EVERY required document, not just the waiver. Once a second template can
    // be marked required, keying this on isWaiver would leave an owner who
    // ticked that box blocking their roster at the door with no number
    // anywhere telling them so.
    const required = (await listTemplatesForGym(ctx, gym._id)).filter(isRequired);
    if (required.length === 0) return null; // Nothing required — nothing to be behind on.

    const members = await ctx.db
      .query("members")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .filter((q) => q.neq(q.field("archived"), true))
      .collect();

    // A member counts once if they are missing ANY required document, which is
    // what "would be stopped at check-in" actually means.
    const signedPairs = new Set<string>();
    for (const template of required) {
      const signed = await ctx.db
        .query("signedDocuments")
        .withIndex("by_gym_template", (q) =>
          q.eq("gymId", gym._id).eq("templateId", template._id)
        )
        .collect();
      for (const s of signed) signedPairs.add(`${s.memberId}:${template._id}`);
    }

    return members.filter((m) => required.some((t) => !signedPairs.has(`${m._id}:${t._id}`)))
      .length;
  },
});

// ---------------------------------------------------------------------------
// Kiosk: new member signup
// ---------------------------------------------------------------------------

// PUBLIC AND UNAUTHENTICATED — the front-desk tablet, same posture as
// members.checkIn. Creates the member row so the waiver step immediately
// after it has something to attach a signature to.
//
// GATED ON BILLING, unlike members.checkIn. Checking an existing member in is
// operational continuity and must keep working at the door even if a card
// bounced; adding a NEW member to the roster is roster growth, which is the
// thing a subscription buys. requireWriteAccess can't be used directly (it
// takes the authenticated gym), so the same predicate is applied by hand.
//
// SMS CONSENT. A phone number cannot be saved without consent —
// members.ts:assertSmsConsent enforces that on the authenticated path and the
// same rule applies here. The member is consenting for themselves, so this
// writes a consentSubmissions row with source "member_self_serve", exactly
// like /consent/[gymSlug], and the caller must have shown them the verbatim
// text from lib/consentText.ts. If consent isn't given, the signup still
// succeeds — with no phone number stored at all.
export const createMemberFromKiosk = mutation({
  args: {
    gymId: v.id("gyms"),
    name: v.string(),
    dob: v.string(),
    address: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    smsConsent: v.boolean(),
  },
  handler: async (ctx, args) => {
    const allowed = await consumeRateLimit(ctx, "kioskSignup", args.gymId);
    if (!allowed) {
      throw new ConvexError("Too many signups right now — try again in a few minutes.");
    }

    const gym = await ctx.db.get(args.gymId);
    // The name is required, not merely nice to have: it is interpolated into
    // the SMS consent sentence stored as TCPA evidence below, and the kiosk
    // form shows that same sentence. A fallback string here would mean the
    // text on the tablet and the text on the evidence row could differ, which
    // is the one thing consentSubmissions exists to make impossible.
    // getKioskGym returns null for an unnamed gym, so the page never renders.
    if (!gym?.name) throw new ConvexError("Gym not found");
    if (!hasWriteAccess(gym)) {
      throw new ConvexError(
        "This gym's subscription isn't active, so new members can't be added right now."
      );
    }

    const name = args.name.trim();
    assertKioskMaxLength(name, 200, "Name");
    if (!name) throw new ConvexError("Enter the member's full name.");

    if (!parseCalendarDate(args.dob)) {
      throw new ConvexError("Enter a valid date of birth.");
    }

    const address = args.address?.trim();
    assertKioskMaxLength(address, MAX_MEMBER_ADDRESS, "Address");

    const email = args.email?.trim();
    assertKioskMaxLength(email, 254, "Email");
    assertKioskEmail(email);

    const phone = args.phone?.trim();
    assertKioskMaxLength(phone, 30, "Phone");
    // Mirrors members.ts:assertSmsConsent. A number saved without consent can
    // never be lawfully texted, and a row that looks textable but isn't is the
    // failure mode convex/consent.ts's header warns about at length. Dropping
    // the number is the honest outcome.
    const storePhone = phone && args.smsConsent ? phone : undefined;

    // A NEW ROW IS NOT A CLEAN SLATE FOR A NUMBER THAT ALREADY OPTED OUT.
    // members.ts:add carries this exact check with a long comment; without it
    // here, "text STOP, then re-register at the front desk" launders an
    // opt-out — and does so from an UNAUTHENTICATED endpoint, which is worse
    // than the dashboard hole that check was written to close. Ticking the
    // consent box on this screen cannot override an instruction the member
    // gave from their own handset; only an inbound START can.
    const optedOut = storePhone
      ? await numberHasOptOutOnRecord(ctx, normalizePhoneDigits(storePhone))
      : false;

    const now = Date.now();

    const memberId = await ctx.db.insert("members", {
      name,
      // Free-text display copy, same as the member modal's default. Money
      // lives on planId (see the schema comment on members.plan).
      plan: "New member",
      status: "active",
      gymId: args.gymId,
      dob: args.dob.trim(),
      ...(address ? { address } : {}),
      ...(email ? { email } : {}),
      ...(storePhone
        ? {
            phone: storePhone,
            smsConsentConfirmed: true,
            smsConsentConfirmedAt: now,
            smsConsentSource: "member_self_serve" as const,
            // Only ever written as `true`, mirroring members.ts:add — "we have
            // never heard from this number" and "this number opted back in"
            // are different facts and the schema distinguishes them.
            ...(optedOut ? { smsOptedOut: true } : {}),
          }
        : {}),
    });

    // TCPA evidence row, same shape and source literal as
    // convex/consent.ts:submitConsent. Written only when a number was
    // actually stored, so the audit trail can't claim consent for a number
    // this gym doesn't hold.
    if (storePhone) {
      await ctx.db.insert("consentSubmissions", {
        gymId: args.gymId,
        memberId,
        submittedName: name,
        submittedPhone: storePhone,
        normalizedPhone: normalizePhoneDigits(storePhone),
        consentedAt: now,
        consentText: getConsentText(gym.name),
        consentVersion: CONSENT_VERSION,
        source: "member_self_serve" as const,
      });
    }

    return memberId;
  },
});

// Public — what the kiosk signup screen needs to render itself, and nothing
// more. Deliberately narrow, same reasoning as gyms.getBySlug: no ids, no
// roster, no member data.
export const getKioskGym = query({
  args: { gymId: v.id("gyms") },
  handler: async (ctx, { gymId }) => {
    const gym = await ctx.db.get(gymId);
    if (!gym?.name) return null;

    // Whether the signup form should ask for an address, and mark it REQUIRED
    // rather than optional.
    //
    // Without this the form labelled address "optional", the signer skipped
    // it, and the very next screen refused to continue without it — because
    // the gym's waiver prints {{member_address}} and the document has to be
    // rendered with it. Telling someone a field is optional and then blocking
    // them on it one tap later is how a tablet gets handed back at the desk.
    //
    // A boolean, computed from the templates the signup flow would collect
    // (all of them — signup passes includeOptional). The template text itself
    // never leaves the server here.
    const templates = await listTemplatesForGym(ctx, gymId);
    const collectsAddress = templates.some((t) =>
      placeholdersUsed(t.content).includes("member_address")
    );

    return {
      name: gym.name,
      minorAgeThreshold: minorAgeThresholdFor(gym),
      collectsAddress,
    };
  },
});
