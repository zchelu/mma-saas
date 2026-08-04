/// <reference types="vite/client" />
// Covers convex/keywordConsent.ts — the text-to-join opt-in path.
//
// Every case here is one of step 3's definition-of-done bullets, tested as
// backend behaviour with no handset involved. The handset only proves that
// Twilio reaches the webhook; everything below is what happens after, and it
// is where mistakes are free.
//
// TWO TRAPS ALREADY PAID FOR IN THIS FILE'S SIBLING (convex/smsCode.test.ts),
// repeated here because they generalise:
//   - A fixture list filtered through the code under test cannot fail. Pin
//     literals.
//   - convex-test serializes undefined to null across t.run. Collapse to a
//     boolean inside the callback rather than asserting on the raw value.
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { OPT_IN_KEYWORD } from "../lib/smsKeywords";
import {
  KEYWORD_CONSENT_VERSION_SIGNAGE_ONLY,
  KEYWORD_CONSENT_VERSION_WITH_CONFIRMATION,
} from "../lib/consentText";

const modules = import.meta.glob("./**/*.ts");

// Reserved (719) 555-01xx range, per the repo's test-phone convention. Twilio
// delivers From in E.164, so that is what these are.
const PHONE_E164 = "+17195550101";
const PHONE_OTHER = "+17195550102";

// Pinned literal, not derived from convex/gyms.ts. A code whose check
// character is wrong must be rejected by the resolver, and computing it here
// from the same helper the resolver uses would test nothing.
const GYM_CODE = "2222";
const GYM_CODE_BAD_CHECK = "2223";

async function seedGym(
  t: ReturnType<typeof convexTest>,
  opts: { slug?: string; name?: string; smsCode?: string } = {}
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("gyms", {
      clerkUserId: `user_${Math.random().toString(36).slice(2)}`,
      name: opts.name ?? "Test BJJ",
      slug: opts.slug ?? "test-bjj",
      smsCode: opts.smsCode ?? GYM_CODE,
    })
  );
}

async function seedMember(
  t: ReturnType<typeof convexTest>,
  gymId: Id<"gyms">,
  opts: { phone?: string; smsOptedOut?: boolean; archived?: boolean } = {}
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("members", {
      name: "Avery Simmons",
      plan: "BJJ Monthly",
      status: "active",
      gymId,
      // Stored as free-typed text, unlike Twilio's E.164 From — the match runs
      // on normalized digits precisely because these two never look alike.
      phone: "(719) 555-0101",
      ...(opts.phone ? { phone: opts.phone } : {}),
      ...(opts.smsOptedOut !== undefined ? { smsOptedOut: opts.smsOptedOut } : {}),
      ...(opts.archived !== undefined ? { archived: opts.archived } : {}),
    })
  );
}

function record(
  t: ReturnType<typeof convexTest>,
  body: string,
  opts: { from?: string; messageSid?: string; confirmationEnabled?: boolean } = {}
) {
  return t.mutation(internal.keywordConsent.recordKeywordConsent, {
    fromPhone: opts.from ?? PHONE_E164,
    body,
    messageSid: opts.messageSid ?? "SM00000000000000000000000000000001",
    confirmationEnabled: opts.confirmationEnabled ?? false,
  });
}

const submissions = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("consentSubmissions").collect());

test("the opt-in keyword is shaped legally for a printed poster", () => {
  // Asserted as literals so a bad FINAL value fails the suite too — this is
  // the one test that still means something once the placeholder is replaced.
  // Rules from docs/sms-campaign-constraints.md: 4-12 characters, no symbols.
  expect(OPT_IN_KEYWORD.length).toBeGreaterThanOrEqual(4);
  expect(OPT_IN_KEYWORD.length).toBeLessThanOrEqual(12);
  expect(OPT_IN_KEYWORD).toMatch(/^[A-Z]+$/);

  // Must never collide with a STOP or START keyword. Those clear or set
  // carrier suppression and deliberately do not grant consent; this grants
  // consent and deliberately does not touch suppression.
  expect(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"])
    .not.toContain(OPT_IN_KEYWORD);
  expect(["START", "YES", "UNSTOP"]).not.toContain(OPT_IN_KEYWORD);
  expect(["HELP", "INFO"]).not.toContain(OPT_IN_KEYWORD);
});

test("DoD: texting the keyword writes exactly one row, source keyword, messageSid populated, member stamped", async () => {
  const t = convexTest(schema, modules);
  const gymId = await seedGym(t);
  const memberId = await seedMember(t, gymId);

  const result = await record(t, `${OPT_IN_KEYWORD} ${GYM_CODE}`, {
    messageSid: "SM11111111111111111111111111111111",
  });
  expect(result.status).toBe("recorded");

  const rows = await submissions(t);
  expect(rows).toHaveLength(1);
  expect(rows[0].source).toBe("keyword");
  expect(rows[0].messageSid).toBe("SM11111111111111111111111111111111");
  expect(rows[0].memberId).toBe(memberId);
  expect(rows[0].gymResolvedBy).toBe("sms_code");
  expect(rows[0].consentVersion).toBe(KEYWORD_CONSENT_VERSION_SIGNAGE_ONLY);

  // submittedPhone is Twilio's From VERBATIM — the raw carrier E.164 is the
  // evidence. normalizedPhone is the lookup key and is derived from it.
  expect(rows[0].submittedPhone).toBe(PHONE_E164);
  expect(rows[0].normalizedPhone).toBe("7195550101");

  // Never filled from the roster even though the member matched and their
  // real name was available.
  expect(rows[0].submittedName).toBe("(opted in by text)");
  expect(rows[0].submittedName).not.toBe("Avery Simmons");

  // An inbound webhook has neither, and they must never be synthesized.
  expect(rows[0].ip).toBeUndefined();
  expect(rows[0].userAgent).toBeUndefined();

  const member = await t.run(async (ctx) => ctx.db.get(memberId));
  expect(member!.smsConsentConfirmed).toBe(true);
  expect(member!.smsConsentSource).toBe("keyword");
  expect(member!.smsConsentConfirmedAt).toBeGreaterThan(0);
});

test("DoD: texting it twice writes one row", async () => {
  const t = convexTest(schema, modules);
  const gymId = await seedGym(t);
  await seedMember(t, gymId);

  await record(t, `${OPT_IN_KEYWORD} ${GYM_CODE}`, { messageSid: "SM1" });
  const second = await record(t, `${OPT_IN_KEYWORD} ${GYM_CODE}`, { messageSid: "SM2" });

  // A double-text is not a second TCPA event. The second call still reports
  // "recorded" — a duplicate must be indistinguishable from a first delivery
  // to the caller, same reasoning as the replay path in twilioWebhookAction.
  expect(second.status).toBe("recorded");
  expect(await submissions(t)).toHaveLength(1);
});

test("DoD: texting from a number that previously sent STOP does not clear smsOptedOut", async () => {
  const t = convexTest(schema, modules);
  const gymId = await seedGym(t);
  const memberId = await seedMember(t, gymId, { smsOptedOut: true });

  const result = await record(t, `${OPT_IN_KEYWORD} ${GYM_CODE}`);
  expect(result.status).toBe("recorded");
  expect(result.status === "recorded" && result.suppressed).toBe(true);

  const member = await t.run(async (ctx) => ctx.db.get(memberId));

  // Both gates pass INDEPENDENTLY. They really did consent, so that is
  // recorded; only a registered START keyword lifts carrier suppression, and
  // this is not one. Consented AND suppressed is a real state, and it is the
  // state the owner dashboard has to surface.
  expect(member!.smsOptedOut).toBe(true);
  expect(member!.smsConsentConfirmed).toBe(true);

  // The evidence row is still written — the consent was real.
  expect(await submissions(t)).toHaveLength(1);
});

test("DoD: a bare keyword with no gym token and no unique roster match writes nothing", async () => {
  const t = convexTest(schema, modules);

  // Two gyms, both with a member on the same phone number. This is the case
  // that breaks a bare-keyword fallback first — not gym #6, but gym #2 sharing
  // one member who trains at both.
  const gymA = await seedGym(t, { slug: "gym-a", smsCode: GYM_CODE });
  const gymB = await seedGym(t, { slug: "gym-b", smsCode: "333V" });
  await seedMember(t, gymA);
  await seedMember(t, gymB);

  const result = await record(t, OPT_IN_KEYWORD);
  expect(result.status).toBe("unresolved");
  expect(await submissions(t)).toHaveLength(0);

  // And nothing was stamped on either member — the failure is total, not
  // partial. Granting consent to every gym a number appears in is the worst
  // failure this system can produce.
  const members = await t.run(async (ctx) => ctx.db.query("members").collect());
  for (const m of members) {
    expect(m.smsConsentConfirmed).toBeUndefined();
  }
});

test("a bare keyword with no roster match at all writes nothing", async () => {
  const t = convexTest(schema, modules);
  await seedGym(t);

  const result = await record(t, OPT_IN_KEYWORD, { from: PHONE_OTHER });
  expect(result.status).toBe("unresolved");
  expect(await submissions(t)).toHaveLength(0);
});

test("a bare keyword with exactly one roster match resolves and records roster_match", async () => {
  const t = convexTest(schema, modules);
  const gymId = await seedGym(t);
  await seedMember(t, gymId);

  const result = await record(t, OPT_IN_KEYWORD);
  expect(result.status).toBe("recorded");

  const rows = await submissions(t);
  expect(rows).toHaveLength(1);
  // "We inferred it" — a materially weaker evidentiary claim than "they told
  // us", and the row has to say which.
  expect(rows[0].gymResolvedBy).toBe("roster_match");
});

test("a code with a bad check character resolves nothing and never reaches the index", async () => {
  const t = convexTest(schema, modules);
  const gymId = await seedGym(t, { smsCode: GYM_CODE });
  await seedMember(t, gymId);

  // The typo case the check character exists for. Critically this must NOT
  // fall through to the roster match: the sender told us a specific gym and
  // that identifier did not resolve, which is a signal something is wrong, not
  // an invitation to guess.
  const result = await record(t, `${OPT_IN_KEYWORD} ${GYM_CODE_BAD_CHECK}`);
  expect(result.status).toBe("unresolved");
  expect(await submissions(t)).toHaveLength(0);
});

test("a valid but unknown code resolves nothing rather than falling through", async () => {
  const t = convexTest(schema, modules);
  const gymId = await seedGym(t, { smsCode: GYM_CODE });
  await seedMember(t, gymId);

  // "333V" is a structurally valid code belonging to no gym here. Same rule:
  // a token was given and did not resolve, so nothing is guessed.
  const result = await record(t, `${OPT_IN_KEYWORD} 333V`);
  expect(result.status).toBe("unresolved");
  expect(await submissions(t)).toHaveLength(0);
});

test("the gym slug resolves, and is matched case-insensitively", async () => {
  const t = convexTest(schema, modules);
  const gymId = await seedGym(t, { slug: "colorado-springs-bjj" });
  await seedMember(t, gymId);

  // The body arrives uppercased from twilioWebhookAction; slugs are lowercase.
  // Forgetting to lowercase makes every slug-carrying text unresolvable.
  const result = await record(t, `${OPT_IN_KEYWORD} COLORADO-SPRINGS-BJJ`);
  expect(result.status).toBe("recorded");

  const rows = await submissions(t);
  expect(rows).toHaveLength(1);
  expect(rows[0].gymResolvedBy).toBe("slug");
});

test("consent is recorded with no member match and left for the gap panel", async () => {
  const t = convexTest(schema, modules);
  await seedGym(t, { smsCode: GYM_CODE });

  const result = await record(t, `${OPT_IN_KEYWORD} ${GYM_CODE}`, { from: PHONE_OTHER });
  expect(result.status).toBe("recorded");

  const rows = await submissions(t);
  expect(rows).toHaveLength(1);
  // memberId unset is what consent.ts:listPendingConsent filters on — the
  // owner's existing consent-gap panel picks this up for free, because it
  // filters on memberId and not on source.
  expect(rows[0].memberId).toBeUndefined();
  expect(rows[0].source).toBe("keyword");
});

test("an archived member is matched, mirroring submitConsent's lack of a filter", async () => {
  const t = convexTest(schema, modules);
  const gymId = await seedGym(t);
  const memberId = await seedMember(t, gymId, { archived: true });

  const result = await record(t, `${OPT_IN_KEYWORD} ${GYM_CODE}`);
  expect(result.status).toBe("recorded");

  const rows = await submissions(t);
  expect(rows[0].memberId).toBe(memberId);
});

test("never creates a member", async () => {
  const t = convexTest(schema, modules);
  await seedGym(t, { smsCode: GYM_CODE });

  await record(t, `${OPT_IN_KEYWORD} ${GYM_CODE}`, { from: PHONE_OTHER });

  const members = await t.run(async (ctx) => ctx.db.query("members").collect());
  expect(members).toHaveLength(0);
});

test("consent is never granted to a second gym the sender did not contact", async () => {
  const t = convexTest(schema, modules);
  const gymA = await seedGym(t, { slug: "gym-a", smsCode: GYM_CODE });
  const gymB = await seedGym(t, { slug: "gym-b", smsCode: "333V" });
  const memberA = await seedMember(t, gymA);
  const memberB = await seedMember(t, gymB);

  // Texts gym A's code specifically. Unlike setSmsOptOutByPhone — which
  // patches every member sharing the phone across all gyms, correctly, because
  // an opt-out should apply everywhere — this must touch gym A only.
  await record(t, `${OPT_IN_KEYWORD} ${GYM_CODE}`);

  const a = await t.run(async (ctx) => ctx.db.get(memberA));
  const b = await t.run(async (ctx) => ctx.db.get(memberB));
  expect(a!.smsConsentConfirmed).toBe(true);
  expect(b!.smsConsentConfirmed).toBeUndefined();

  const rows = await submissions(t);
  expect(rows).toHaveLength(1);
  expect(rows[0].gymId).toBe(gymA);
  expect(rows[0].gymId).not.toBe(gymB);
});

test("the confirmation reply is off by default and stamps the signage-only version", async () => {
  const t = convexTest(schema, modules);
  const gymId = await seedGym(t, { slug: "demo", name: "Demo Gym" });
  await seedMember(t, gymId);

  const result = await record(t, `${OPT_IN_KEYWORD} ${GYM_CODE}`);
  expect(result.status === "recorded" && result.confirmationText).toBeNull();

  const rows = await submissions(t);
  expect(rows[0].consentVersion).toBe(KEYWORD_CONSENT_VERSION_SIGNAGE_ONLY);
  // The row must not claim the member saw a confirmation that was never sent.
  expect(rows[0].consentText).not.toContain("you're opted in");
});

test("the confirmation reply requires BOTH the flag and the gym allowlist", async () => {
  const t = convexTest(schema, modules);
  const notAllowed = await seedGym(t, { slug: "real-gym", name: "Real Gym" });
  await seedMember(t, notAllowed);

  // Flag on, gym not on the allowlist: still silent. The allowlist is what
  // keeps an undeclared message type away from a real gym's members before
  // the batched CTA rewrite lands.
  const result = await record(t, `${OPT_IN_KEYWORD} ${GYM_CODE}`, {
    confirmationEnabled: true,
  });
  expect(result.status === "recorded" && result.confirmationText).toBeNull();

  const rows = await submissions(t);
  expect(rows[0].consentVersion).toBe(KEYWORD_CONSENT_VERSION_SIGNAGE_ONLY);
});

test("with flag and allowlist both passing, the confirmation is sent and snapshotted", async () => {
  const t = convexTest(schema, modules);
  const gymId = await seedGym(t, { slug: "demo", name: "Demo Gym" });
  await seedMember(t, gymId);

  const result = await record(t, `${OPT_IN_KEYWORD} ${GYM_CODE}`, {
    confirmationEnabled: true,
  });
  expect(result.status === "recorded" && result.confirmationText).toBeTruthy();

  const rows = await submissions(t);
  expect(rows[0].consentVersion).toBe(KEYWORD_CONSENT_VERSION_WITH_CONFIRMATION);
  // The evidence row snapshots what was actually delivered — signage AND the
  // confirmation, because both were seen.
  expect(rows[0].consentText).toContain("Demo Gym");
  expect(rows[0].consentText).toContain("you're opted in");
});

test("a suppressed member never gets a confirmation, even with flag and allowlist passing", async () => {
  const t = convexTest(schema, modules);
  const gymId = await seedGym(t, { slug: "demo", name: "Demo Gym" });
  await seedMember(t, gymId, { smsOptedOut: true });

  // Twilio blocks every outbound message to a suppressed number with 21610, so
  // "sending" this only mints a guaranteed error-log entry the member never
  // sees — and snapshotting it would record a disclosure they never received.
  const result = await record(t, `${OPT_IN_KEYWORD} ${GYM_CODE}`, {
    confirmationEnabled: true,
  });
  expect(result.status === "recorded" && result.confirmationText).toBeNull();

  const rows = await submissions(t);
  expect(rows[0].consentVersion).toBe(KEYWORD_CONSENT_VERSION_SIGNAGE_ONLY);
});

test("the frequency disclosure appears byte-identically in the snapshotted text", async () => {
  const t = convexTest(schema, modules);
  const gymId = await seedGym(t);
  await seedMember(t, gymId);

  await record(t, `${OPT_IN_KEYWORD} ${GYM_CODE}`);
  const rows = await submissions(t);

  // Pinned as a literal, not imported. Carriers cross-check this sentence
  // across the opt-in disclosure, the HELP reply, and both linked legal
  // documents; signage is a new site carrying it. If this assertion has to
  // change, five other files and a Twilio console field change with it.
  expect(rows[0].consentText).toContain("Up to 5 automated msgs/month.");
  expect(rows[0].consentText).toContain("Consent is not a condition of membership");
});
