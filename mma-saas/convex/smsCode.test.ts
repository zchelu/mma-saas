/// <reference types="vite/client" />
// Covers convex/gyms.ts's smsCode generation and validation — the short
// per-gym code carried in the body of an inbound SMS keyword opt-in.
//
// This code is READ OFF A PRINTED POSTER AND TYPED INTO A PHONE, and a typo
// that happens to land on another gym's live code resolves silently to the
// WRONG GYM — recording consent for a gym the person never contacted. That is
// the worst failure this system can produce, and the Luhn check character is
// the thing standing in front of it, so its substitution coverage is tested
// exhaustively rather than sampled.
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { generateUniqueSmsCode, isValidSmsCode } from "./gyms";

const modules = import.meta.glob("./**/*.ts");

// Must match convex/gyms.ts. Duplicated deliberately: if someone changes the
// alphabet there, these tests should fail rather than silently retune
// themselves to the new value and keep passing.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

// Known-good fixtures, computed against the Luhn mod 30 definition and pinned
// as literals so the algorithm can't be quietly redefined.
//
// A TEST THAT CANNOT FAIL. The first version of this line read:
//
//   const KNOWN_GOOD = ["2222", "3334", "ABCD"].filter(isValidSmsCode);
//
// which pins nothing. The filter discards every fixture the validator already
// rejects, so the loop below only ever sees codes that pass, and the suite
// reports green no matter what the algorithm does. Two of those three guesses
// were in fact wrong ("3334" and "ABCD"); the test never said so. A validator
// rewritten to `return true` would also have passed.
//
// Pin fixtures as bare literals. If a fixture is wrong, the test must say so
// on the first run — that is the entire job. Never derive the expected values
// from the code under test, and never filter a fixture list through it.
//
// If a change makes these fail, that change reissues every code in every
// deployment and invalidates anything already printed. That is the signal.
const KNOWN_GOOD = ["2222", "333V", "ABCH"];

// Same random parts with a deliberately wrong check character.
const KNOWN_BAD = ["2223", "333W", "ABCJ"];

test("generated codes are the right shape and drawn from the restricted alphabet", async () => {
  const t = convexTest(schema, modules);

  const codes = await t.run(async (ctx) => {
    const results: string[] = [];
    for (let i = 0; i < 200; i++) {
      results.push(await generateUniqueSmsCode(ctx));
    }
    return results;
  });

  for (const code of codes) {
    expect(code).toHaveLength(4);
    // 0/O/1/I/L/U are excluded because they collide as glyphs on a poster (and
    // U is what makes most four-letter profanity constructible).
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
    for (const char of code) {
      expect(ALPHABET).toContain(char);
    }
  }
});

test("generated codes are distinct when each one is persisted", async () => {
  const t = convexTest(schema, modules);

  // EACH CODE IS WRITTEN TO A gyms ROW BEFORE THE NEXT IS DRAWN, and that is
  // the entire point of the test rather than incidental setup.
  //
  // generateUniqueSmsCode enforces uniqueness by checking a candidate against
  // the by_sms_code INDEX, which only sees codes already persisted. Generating
  // 200 codes without inserting them tests nothing about that mechanism — it
  // is 200 draws from 27,000 with replacement, and the birthday bound puts the
  // expected number of collisions at 200^2/(2*27,000) ~= 0.74, so P(at least
  // one) ~= 52%. The first version of this test did exactly that and therefore
  // FAILED ROUGHLY HALF THE TIME; it went green twice by luck before the flake
  // surfaced.
  //
  // A flaky test is the same failure as a test that cannot fail, one bit
  // rotated: both report a result uncorrelated with the property they claim to
  // check. Persisting makes the index do its job and the assertion becomes a
  // real statement about the generator.
  const codes = await t.run(async (ctx) => {
    const results: string[] = [];
    for (let i = 0; i < 200; i++) {
      const smsCode = await generateUniqueSmsCode(ctx);
      await ctx.db.insert("gyms", {
        clerkUserId: `user_${Math.random().toString(36).slice(2)}`,
        smsCode,
      });
      results.push(smsCode);
    }
    return results;
  });

  expect(new Set(codes).size).toBe(codes.length);
});

test("every generated code passes its own validator", async () => {
  const t = convexTest(schema, modules);

  const codes = await t.run(async (ctx) => {
    const results: string[] = [];
    for (let i = 0; i < 200; i++) {
      results.push(await generateUniqueSmsCode(ctx));
    }
    return results;
  });

  for (const code of codes) {
    expect(isValidSmsCode(code)).toBe(true);
  }
});

test("EVERY single-character substitution fails validation", async () => {
  const t = convexTest(schema, modules);

  const codes = await t.run(async (ctx) => {
    const results: string[] = [];
    for (let i = 0; i < 25; i++) {
      results.push(await generateUniqueSmsCode(ctx));
    }
    return results;
  });

  // Exhaustive, not sampled: 25 codes x 4 positions x 29 wrong characters =
  // 2,900 substitutions, every one of which must be rejected. This is the
  // property the whole check-digit decision rests on — Luhn mod 30's doubling
  // map is injective (d < 15 -> even residues, d >= 15 -> odd), so any one
  // wrong character must change the sum.
  let checked = 0;
  for (const code of codes) {
    for (let position = 0; position < code.length; position++) {
      for (const replacement of ALPHABET) {
        if (replacement === code[position]) continue;
        const mutated = code.slice(0, position) + replacement + code.slice(position + 1);
        expect(isValidSmsCode(mutated)).toBe(false);
        checked++;
      }
    }
  }
  expect(checked).toBe(25 * 4 * 29);
});

test("pinned known-good codes validate and known-bad ones do not", () => {
  // Guards against the validator degenerating into something that accepts
  // everything — which would pass every other test in this file.
  for (const code of KNOWN_GOOD) {
    expect(isValidSmsCode(code)).toBe(true);
  }
  for (const code of KNOWN_BAD) {
    expect(isValidSmsCode(code)).toBe(false);
  }
});

test("malformed codes are rejected before they can reach the index", () => {
  // Wrong length — a 3- or 5-character body token is not a code.
  expect(isValidSmsCode("")).toBe(false);
  expect(isValidSmsCode("ABC")).toBe(false);
  expect(isValidSmsCode("ABCDE")).toBe(false);

  // Characters outside the alphabet, including the six excluded precisely
  // because a member reading a poster confuses them for something else.
  expect(isValidSmsCode("O0IL")).toBe(false);
  expect(isValidSmsCode("AB-D")).toBe(false);
  expect(isValidSmsCode("ab cd".slice(0, 4))).toBe(false);

  // Lowercase must not validate: twilioWebhookAction.ts uppercases the whole
  // message body before matching, so anything reaching the resolver is already
  // uppercase, and accepting lowercase here would mean the validator and the
  // caller disagree about what a code is.
  expect(isValidSmsCode("abcd")).toBe(false);
});

test("a code is never reassigned once set", async () => {
  const t = convexTest(schema, modules);

  // The never-reassign rule is the one that cannot be undone in the field: a
  // stale slug breaks a link that can be resent, a stale smsCode breaks a
  // poster on a wall. Asserted against the persisted row, not the generator.
  const { gymId, original } = await t.run(async (ctx) => {
    const smsCode = await generateUniqueSmsCode(ctx);
    const gymId = await ctx.db.insert("gyms", {
      clerkUserId: `user_${Math.random().toString(36).slice(2)}`,
      smsCode,
    });
    return { gymId, original: smsCode };
  });

  const { regenerated, stored } = await t.run(async (ctx) => {
    const gym = await ctx.db.get(gymId);
    // Mirrors onboarding.ts: an existing code short-circuits generation.
    const next = gym?.smsCode ? undefined : await generateUniqueSmsCode(ctx);
    // CONVEX-TEST SERIALIZES undefined TO null ACROSS t.run. Returning `next`
    // directly and asserting toBeUndefined() fails with "expected null to be
    // undefined" — a harness artifact, not a bug in the rule being tested.
    // Collapse to a boolean inside the callback so the assertion is about the
    // never-reassign rule rather than about how convex-test marshals values.
    // Applies to any t.run that can return undefined, not just this one.
    return { regenerated: next !== undefined, stored: gym?.smsCode };
  });

  expect(regenerated).toBe(false);
  expect(stored).toBe(original);
  expect(original).toHaveLength(4);
  expect(isValidSmsCode(original)).toBe(true);
});

test("generateUniqueSmsCode avoids a code already taken by another gym", async () => {
  const t = convexTest(schema, modules);

  const { taken, fresh } = await t.run(async (ctx) => {
    const taken = await generateUniqueSmsCode(ctx);
    await ctx.db.insert("gyms", {
      clerkUserId: `user_${Math.random().toString(36).slice(2)}`,
      smsCode: taken,
    });
    const fresh: string[] = [];
    for (let i = 0; i < 50; i++) {
      fresh.push(await generateUniqueSmsCode(ctx));
    }
    return { taken, fresh };
  });

  // Uniqueness is global by construction, not per-gym: an inbound Twilio
  // webhook carries no other scoping signal, so two gyms sharing a code would
  // make the resolver ambiguous with no way to break the tie.
  expect(fresh).not.toContain(taken);
});
