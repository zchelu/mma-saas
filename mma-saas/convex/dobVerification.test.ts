/// <reference types="vite/client" />
// Covers members.dobUnverified — the flag that stops a self-reported date of
// birth from silently passing as checked.
//
// THE HOLE THIS ADDRESSES. The kiosk is unauthenticated and hands the tablet to
// the signer, so the date of birth it collects is typed by whoever is holding
// it. That date is the ONLY input to the guardian rule: a 12-year-old who types
// an adult date disables their own guardian requirement, signs alone, and
// nothing in the product ever says so. No software can verify an age at a
// kiosk — so the fix is not to pretend it did.
//
// Three properties, and the third is the one that makes the other two mean
// anything:
//
//   1. Both kiosk write paths flag the date they store.
//   2. Only an AUTHENTICATED owner can clear the flag. If the tablet could
//      clear it, the flag would be theatre.
//   3. It is NOT A GATE. Every kiosk signup starts out flagged, so if this ever
//      blocks a signature, a signup or a check-in, it has broken the front door
//      for exactly the people the kiosk exists to serve.
//
// Plus the freeze: signedDocuments.signerDobUnverified records what was true at
// signing, so confirming a date later cannot retroactively make an unchecked
// signature look checked.
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const TODAY = "2026-08-11";
const ADULT_DOB = "1990-03-04";
// 12 years old on TODAY. The case the whole flag exists for.
const CHILD_DOB = "2014-03-04";

async function seedGym(t: ReturnType<typeof convexTest>) {
  const clerkUserId = `user_${Math.random().toString(36).slice(2)}`;
  const gymId = await t.run(async (ctx) =>
    ctx.db.insert("gyms", {
      clerkUserId,
      name: "DOB Test Gym",
      plan: "fightteam",
      planStatus: "active",
    })
  );
  const asOwner = t.withIdentity({ subject: clerkUserId });
  const kioskToken = await asOwner.mutation(api.gyms.rotateKioskToken, {});
  return { asOwner, gymId, kioskToken };
}

async function seedWaiver(
  asOwner: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  requiresGuardianForMinors = true
) {
  return await asOwner.mutation(api.documents.createTemplate, {
    title: "Liability Waiver",
    content: "I, {{member_name}}, born {{member_dob}}, agree. Signed {{today}}.",
    isWaiver: true,
    requiresGuardianForMinors,
    requiredAtSignup: true,
  });
}

// A 1x1 PNG data URL — the shape lib/documents.ts:isValidSignatureData accepts.
const SIG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// --- 1. The kiosk flags what it collects -----------------------------------

test("createMemberFromKiosk flags the date of birth it stores", async () => {
  const t = convexTest(schema, modules);
  const { kioskToken } = await seedGym(t);

  const memberId = await t.mutation(api.documents.createMemberFromKiosk, {
    kioskToken,
    name: "Walk In",
    dob: ADULT_DOB,
    smsConsent: false,
  });

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member?.dob).toBe(ADULT_DOB);
  expect(member?.dobUnverified).toBe(true);
});

test("signDocument flags a date of birth it fills in for an existing member", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, gymId, kioskToken } = await seedGym(t);
  const templateId = await seedWaiver(asOwner, false);

  // Imported from a spreadsheet, no date of birth on file — the exact row the
  // signing step collects one for.
  const memberId = await t.run(async (ctx) =>
    ctx.db.insert("members", { name: "No DOB", plan: "BJJ", status: "active", gymId })
  );

  await t.mutation(api.documents.signDocument, {
    kioskToken,
    memberId,
    templateId,
    todayLocalDate: TODAY,
    dob: ADULT_DOB,
    signerName: "No DOB",
    signatureData: SIG,
  });

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member?.dob).toBe(ADULT_DOB);
  expect(member?.dobUnverified).toBe(true);
});

test("an owner-entered date of birth is NOT flagged", async () => {
  const t = convexTest(schema, modules);
  const { asOwner } = await seedGym(t);

  const memberId = await asOwner.mutation(api.members.add, {
    name: "Owner Typed",
    plan: "BJJ",
    status: "active",
    dob: ADULT_DOB,
  });

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  // Absent, not false — the flag is only ever written as true, so every row
  // that predates the field reads correctly with no backfill.
  expect(member?.dobUnverified).toBeUndefined();
});

// --- 2. Only an authenticated owner can clear it ---------------------------

test("confirmDob clears the flag and is idempotent", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, kioskToken } = await seedGym(t);
  const memberId = await t.mutation(api.documents.createMemberFromKiosk, {
    kioskToken,
    name: "Walk In",
    dob: ADULT_DOB,
    smsConsent: false,
  });

  const before = Date.now();
  await asOwner.mutation(api.members.confirmDob, { memberId });
  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member?.dobUnverified).toBeUndefined();
  // Clearing the flag without recording who cleared it would destroy the only
  // thing known and put nothing in its place — a date checked against a birth
  // certificate would be byte-identical to one clicked past. This is the same
  // evidence smsConsentSource carries for a smaller stake.
  expect(member?.dobConfirmedAt).toBeGreaterThanOrEqual(before);
  expect(member?.dobConfirmedByClerkUserId).toBeTruthy();

  // Clicking twice, or on a row a co-owner just confirmed, is not an error.
  await asOwner.mutation(api.members.confirmDob, { memberId });
  expect((await t.run(async (ctx) => ctx.db.get(memberId)))?.dobUnverified).toBeUndefined();
});

test("an unauthenticated caller cannot clear the flag", async () => {
  const t = convexTest(schema, modules);
  const { kioskToken } = await seedGym(t);
  const memberId = await t.mutation(api.documents.createMemberFromKiosk, {
    kioskToken,
    name: "Walk In",
    dob: ADULT_DOB,
    smsConsent: false,
  });

  // THE WHOLE POINT. If the tablet can mark its own work as checked, the flag
  // records nothing. There is deliberately no kiosk-token equivalent of
  // confirmDob; this asserts nobody adds one by making the mutation public.
  await expect(t.mutation(api.members.confirmDob, { memberId })).rejects.toThrow(
    /Unauthenticated/
  );
  expect((await t.run(async (ctx) => ctx.db.get(memberId)))?.dobUnverified).toBe(true);
});

test("a signature cannot overwrite a date already on file, so it cannot launder the flag", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, kioskToken } = await seedGym(t);
  const templateId = await seedWaiver(asOwner, false);
  const memberId = await t.mutation(api.documents.createMemberFromKiosk, {
    kioskToken,
    name: "Walk In",
    dob: CHILD_DOB,
    smsConsent: false,
  });

  // The attack this closes: a kiosk caller sends a DIFFERENT date alongside a
  // signature, hoping signDocument treats it as a correction. It must not —
  // documents.ts:signDocument only fills a currently-EMPTY dob. Without that
  // guard, a child could re-sign as an adult and the flag would go with it.
  await t.mutation(api.documents.signDocument, {
    kioskToken,
    memberId,
    templateId,
    todayLocalDate: TODAY,
    dob: ADULT_DOB,
    signerName: "Walk In",
    signatureData: SIG,
  });

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member?.dob).toBe(CHILD_DOB);
  expect(member?.dobUnverified).toBe(true);
});

test("another gym's owner cannot clear the flag", async () => {
  const t = convexTest(schema, modules);
  const a = await seedGym(t);
  const b = await seedGym(t);
  const memberId = await t.mutation(api.documents.createMemberFromKiosk, {
    kioskToken: a.kioskToken,
    name: "Gym A Walk In",
    dob: ADULT_DOB,
    smsConsent: false,
  });

  await expect(b.asOwner.mutation(api.members.confirmDob, { memberId })).rejects.toThrow(
    /Member not found/
  );
  expect((await t.run(async (ctx) => ctx.db.get(memberId)))?.dobUnverified).toBe(true);
});

// --- 3. update clears it only when the owner actually changed the date -----

test("update clears the flag when the owner corrects the date", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, kioskToken } = await seedGym(t);
  const memberId = await t.mutation(api.documents.createMemberFromKiosk, {
    kioskToken,
    name: "Walk In",
    dob: ADULT_DOB,
    smsConsent: false,
  });

  await asOwner.mutation(api.members.update, {
    id: memberId,
    name: "Walk In",
    plan: "New member",
    status: "active",
    dob: CHILD_DOB, // the owner looked, and the walk-in was lying
  });

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member?.dob).toBe(CHILD_DOB);
  expect(member?.dobUnverified).toBeUndefined();
  // Typing a value is its own attestation, so it leaves the same evidence
  // confirmDob does — otherwise "corrected it" and "clicked past it" are
  // indistinguishable a year later.
  expect(member?.dobConfirmedAt).toBeGreaterThan(0);
  expect(member?.dobConfirmedByClerkUserId).toBeTruthy();
});

test("a past_due gym can still confirm a date it can no longer edit", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, gymId, kioskToken } = await seedGym(t);
  const memberId = await t.mutation(api.documents.createMemberFromKiosk, {
    kioskToken,
    name: "Walk In",
    dob: ADULT_DOB,
    smsConsent: false,
  });

  // The card bounces AFTER the walk-in signed up. signDocument has no billing
  // gate on purpose (the door must stay open), so a lapsed gym keeps
  // accumulating flagged members. Gating the clear side would show it a
  // growing count about children's waivers with no way to act on it.
  await t.run(async (ctx) => ctx.db.patch(gymId, { planStatus: "past_due" }));

  await asOwner.mutation(api.members.confirmDob, { memberId });
  expect((await t.run(async (ctx) => ctx.db.get(memberId)))?.dobUnverified).toBeUndefined();
});

test("update does NOT clear the flag when an unrelated field changes", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, kioskToken } = await seedGym(t);
  const memberId = await t.mutation(api.documents.createMemberFromKiosk, {
    kioskToken,
    name: "Walk In",
    dob: ADULT_DOB,
    smsConsent: false,
  });

  // The modal resends every field on every save. Editing a belt rank must not
  // silently mark an unchecked date of birth as checked — if it did, the flag
  // would clear itself the first time anyone touched the record for any
  // reason, which is worth less than not having it.
  await asOwner.mutation(api.members.update, {
    id: memberId,
    name: "Walk In",
    plan: "New member",
    status: "active",
    beltRank: "White Belt",
    dob: ADULT_DOB, // unchanged
  });

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member?.beltRank).toBe("White Belt");
  expect(member?.dobUnverified).toBe(true);
});

test("update leaves the date and the flag alone when dob is omitted entirely", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, kioskToken } = await seedGym(t);
  const memberId = await t.mutation(api.documents.createMemberFromKiosk, {
    kioskToken,
    name: "Walk In",
    dob: ADULT_DOB,
    smsConsent: false,
  });

  // The `"dob" in fields` test exists for exactly this call shape, and nothing
  // else in the suite produces it. If normalizedDocumentFields is ever
  // "simplified" to emit `dob` unconditionally, every other test still passes
  // while this one fails — and the bug it catches is that any partial update
  // ERASES the stored date of birth, which is the hazard that function's own
  // comment warns about.
  await asOwner.mutation(api.members.update, {
    id: memberId,
    name: "Renamed",
    plan: "New member",
    status: "active",
  });

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member?.name).toBe("Renamed");
  expect(member?.dob).toBe(ADULT_DOB);
  expect(member?.dobUnverified).toBe(true);
});

test("update clears the flag when the owner ERASES the date", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, kioskToken } = await seedGym(t);
  const memberId = await t.mutation(api.documents.createMemberFromKiosk, {
    kioskToken,
    name: "Walk In",
    dob: ADULT_DOB,
    smsConsent: false,
  });

  // "" is how the modal expresses an explicit clear (see
  // members.ts:normalizedDocumentFields). Leaving the flag behind here would
  // strand a "nobody checked this date" warning on a member with no date.
  await asOwner.mutation(api.members.update, {
    id: memberId,
    name: "Walk In",
    plan: "New member",
    status: "active",
    dob: "",
  });

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member?.dob).toBeUndefined();
  expect(member?.dobUnverified).toBeUndefined();
});

// --- 4. NOT A GATE ---------------------------------------------------------

test("a flagged member can still sign, sign up and be checked in", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, kioskToken } = await seedGym(t);
  const templateId = await seedWaiver(asOwner);

  // Signup: creates a flagged member.
  const memberId = await t.mutation(api.documents.createMemberFromKiosk, {
    kioskToken,
    name: "Walk In",
    dob: ADULT_DOB,
    smsConsent: false,
  });
  expect((await t.run(async (ctx) => ctx.db.get(memberId)))?.dobUnverified).toBe(true);

  // Signing: must not be blocked by the flag.
  const signedId = await t.mutation(api.documents.signDocument, {
    kioskToken,
    memberId,
    templateId,
    todayLocalDate: TODAY,
    signerName: "Walk In",
    signatureData: SIG,
  });
  expect(signedId).toBeTruthy();

  // The door: must not be blocked either. If this ever fails, the flag has
  // taken the front desk offline for every new member.
  await t.mutation(api.members.checkIn, { id: memberId, kioskToken });
  expect((await t.run(async (ctx) => ctx.db.get(memberId)))?.lastVisit).toBeTruthy();
});

test("the guardian rule still fires for a flagged minor", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, kioskToken } = await seedGym(t);
  const templateId = await seedWaiver(asOwner);

  // A child who types their REAL date of birth is still stopped. The flag is
  // about the date being unchecked, and changes nothing about how the date is
  // used once it is there.
  const memberId = await t.mutation(api.documents.createMemberFromKiosk, {
    kioskToken,
    name: "Young Student",
    dob: CHILD_DOB,
    smsConsent: false,
  });

  await expect(
    t.mutation(api.documents.signDocument, {
      kioskToken,
      memberId,
      templateId,
      todayLocalDate: TODAY,
      signerName: "Young Student",
      signatureData: SIG,
    })
  ).rejects.toThrow(/parent or guardian/i);
});

// --- 5. The freeze on the signed record ------------------------------------

test("a signature taken on an unchecked date is marked, and confirming later does not rewrite it", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, kioskToken } = await seedGym(t);
  const templateId = await seedWaiver(asOwner, false);

  const memberId = await t.mutation(api.documents.createMemberFromKiosk, {
    kioskToken,
    name: "Walk In",
    dob: ADULT_DOB,
    smsConsent: false,
  });
  await t.mutation(api.documents.signDocument, {
    kioskToken,
    memberId,
    templateId,
    todayLocalDate: TODAY,
    signerName: "Walk In",
    signatureData: SIG,
  });

  const before = await asOwner.query(api.documents.listSignedDocuments, { memberId });
  expect(before[0].signerDobUnverified).toBe(true);

  // The owner confirms the date a week later. The MEMBER is now checked — the
  // SIGNATURE was still taken on an unchecked date, and this record is
  // evidence of what was known then, not now.
  await asOwner.mutation(api.members.confirmDob, { memberId });
  expect((await t.run(async (ctx) => ctx.db.get(memberId)))?.dobUnverified).toBeUndefined();

  const after = await asOwner.query(api.documents.listSignedDocuments, { memberId });
  expect(after[0].signerDobUnverified).toBe(true);
});

test("a signature on an owner-entered date carries no mark", async () => {
  const t = convexTest(schema, modules);
  const { asOwner, kioskToken } = await seedGym(t);
  const templateId = await seedWaiver(asOwner, false);

  const memberId = await asOwner.mutation(api.members.add, {
    name: "Owner Typed",
    plan: "BJJ",
    status: "active",
    dob: ADULT_DOB,
  });
  await t.mutation(api.documents.signDocument, {
    kioskToken,
    memberId,
    templateId,
    todayLocalDate: TODAY,
    signerName: "Owner Typed",
    signatureData: SIG,
  });

  // Guards the test above against passing vacuously: if every signature were
  // marked, "marked" would carry no information.
  const signed = await asOwner.query(api.documents.listSignedDocuments, { memberId });
  expect(signed[0].signerDobUnverified).toBeUndefined();
});
