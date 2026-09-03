import { describe, it, expect } from "vitest";
import {
  parseDollarsToCents,
  formatCents,
  formatPlanPrice,
  MAX_PLAN_AMOUNT_CENTS,
  MIN_PLAN_AMOUNT_CENTS,
} from "./money";

// This suite is the reason lib/money.ts exists as a separate file. The app
// carries two money representations one table apart — `invoices.amount` is
// dollars-as-float, everything this feature adds is integer cents — and the
// failure when they are confused is a 100x charge against a member's card that
// looks completely normal in the UI. These lock the conversion.

describe("parseDollarsToCents", () => {
  it("parses whole dollars", () => {
    expect(parseDollarsToCents("150")).toEqual({ ok: true, cents: 15000 });
  });

  it("parses two decimal places", () => {
    expect(parseDollarsToCents("149.99")).toEqual({ ok: true, cents: 14999 });
  });

  // The one that would silently undercharge by 10x. "89.5" is eighty-nine
  // dollars fifty, not eighty-nine dollars five cents, and a naive
  // Number(fraction) reads it as the second.
  it("reads a single decimal digit as tenths, not hundredths", () => {
    expect(parseDollarsToCents("89.5")).toEqual({ ok: true, cents: 8950 });
  });

  // The float cases named in the header comment. 19.99 * 100 is
  // 1998.9999999999998 and 1.005 * 100 is 100.49999999999999 — both are
  // rescued by Math.round only by luck, and this file does not rely on luck.
  it("is exact on the values float multiplication gets wrong", () => {
    expect(parseDollarsToCents("19.99")).toEqual({ ok: true, cents: 1999 });
    expect(parseDollarsToCents("1.005")).toMatchObject({ ok: false });
    expect(parseDollarsToCents("10.05")).toEqual({ ok: true, cents: 1005 });
    expect(parseDollarsToCents("0.70")).toMatchObject({ ok: false }); // below the $1 floor
    expect(parseDollarsToCents("70.07")).toEqual({ ok: true, cents: 7007 });
  });

  it("accepts what people actually type", () => {
    expect(parseDollarsToCents("$150")).toEqual({ ok: true, cents: 15000 });
    expect(parseDollarsToCents(" 150.00 ")).toEqual({ ok: true, cents: 15000 });
    expect(parseDollarsToCents("1,250.50")).toEqual({ ok: true, cents: 125050 });
  });

  it("rejects more than two decimal places rather than rounding them", () => {
    // Rounding here would mean the owner typed one price and Stripe charged
    // another, with nothing on screen to show it happened.
    expect(parseDollarsToCents("149.999")).toMatchObject({ ok: false });
  });

  it("rejects negatives, zero, blanks and words", () => {
    for (const bad of ["", "   ", "-50", "0", "0.00", "abc", "1e3", "150-", "$", ".", ".99"]) {
      expect(parseDollarsToCents(bad), `expected ${JSON.stringify(bad)} to be rejected`).toMatchObject({
        ok: false,
      });
    }
  });

  it("holds the floor and the ceiling", () => {
    expect(parseDollarsToCents("0.99")).toMatchObject({ ok: false });
    expect(parseDollarsToCents("1.00")).toEqual({ ok: true, cents: MIN_PLAN_AMOUNT_CENTS });
    expect(parseDollarsToCents("10000.00")).toEqual({ ok: true, cents: MAX_PLAN_AMOUNT_CENTS });
    expect(parseDollarsToCents("10000.01")).toMatchObject({ ok: false });
  });

  it("survives an absurd paste without producing a number", () => {
    expect(parseDollarsToCents("999999999999999999999")).toMatchObject({ ok: false });
  });

  it("never returns a fractional cent", () => {
    for (const input of ["1.00", "3.33", "89.5", "149.99", "1,250.50", "10000"]) {
      const parsed = parseDollarsToCents(input);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(Number.isInteger(parsed.cents)).toBe(true);
    }
  });
});

describe("formatCents", () => {
  it("round-trips everything the parser accepts", () => {
    for (const input of ["1.00", "89.5", "149.99", "150", "1,250.50", "10000"]) {
      const parsed = parseDollarsToCents(input);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const reparsed = parseDollarsToCents(formatCents(parsed.cents));
      expect(reparsed).toEqual({ ok: true, cents: parsed.cents });
    }
  });

  it("pads the cents so 8950 is not $89.5", () => {
    expect(formatCents(8950)).toBe("$89.50");
    expect(formatCents(8905)).toBe("$89.05");
    expect(formatCents(100)).toBe("$1.00");
    expect(formatCents(0)).toBe("$0.00");
  });

  it("groups thousands", () => {
    expect(formatCents(125050)).toBe("$1,250.50");
    expect(formatCents(1000000)).toBe("$10,000.00");
  });
});

describe("formatPlanPrice", () => {
  it("spells the interval", () => {
    expect(formatPlanPrice(15000, "month")).toBe("$150.00/mo");
    expect(formatPlanPrice(150000, "year")).toBe("$1,500.00/yr");
  });
});
