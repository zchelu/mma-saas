// Money parsing for gym-defined membership plans (spec §2, stage 3).
//
// WHY THIS IS ITS OWN FILE, AND WHY IT HAS TESTS.
//
// `invoices.amount` holds DOLLARS AS A FLOAT — confirmed at
// app/invoices/invoice-modal.tsx:68, `type="number" step="0.01"` written
// through `Number(amount)`. Every field added by this feature is INTEGER CENTS
// carrying a `Cents` suffix. The two now live inches apart in one app, and the
// failure when they are confused is a silent 100x error against a real
// member's card. So the conversion exists in exactly one place, and that place
// is covered by the suite rather than by care.
//
// NEVER `Math.round(Number(input) * 100)`. Float multiplication is the reason:
//
//   19.99 * 100 === 1998.9999999999998
//   1.005 * 100 === 100.49999999999999
//
// Math.round rescues both of those by luck. A money path needs a rule, not
// luck, so this parses the decimal STRING and no float ever touches a cent
// value.
//
// Pure, dependency-free and importable from both runtimes on purpose: the
// browser form validates with it before submitting, and the Convex action
// validates with it again before creating a Stripe Price. Client validation is
// a courtesy; the server call is the one that counts, and both must agree
// character for character or an owner gets a form that accepts input the server
// then rejects.

// $10,000.00. Not a business rule — a typo guard. The largest real martial arts
// membership is a few hundred dollars a month, so anything past this is a
// misplaced decimal or a paste accident, and a Stripe Price is a real object
// that a member could then be subscribed to.
export const MAX_PLAN_AMOUNT_CENTS = 1_000_000;

// $1.00. Stripe's own minimum charge is 50c USD; a dues plan below a dollar is
// a mistake in every real case.
export const MIN_PLAN_AMOUNT_CENTS = 100;

export type ParsedAmount =
  | { ok: true; cents: number }
  | { ok: false; error: string };

// Accepts what a person actually types into a price field: "150", "150.00",
// "$150", "1,250.50", " 89.5 ". Rejects everything else rather than guessing —
// a money field is the wrong place to be lenient about input nobody intended.
const AMOUNT_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

export function parseDollarsToCents(input: string): ParsedAmount {
  if (typeof input !== "string") return { ok: false, error: "Enter a price." };

  // Strip only presentation: surrounding space, a leading dollar sign, and
  // thousands separators. Nothing here changes the VALUE, which is the test for
  // whether a character is safe to remove.
  const cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (!cleaned) return { ok: false, error: "Enter a price." };

  const match = AMOUNT_PATTERN.exec(cleaned);
  if (!match) {
    return {
      ok: false,
      error: "Enter a price like 150 or 149.99 — numbers and up to two decimals.",
    };
  }

  const [, whole, fraction = ""] = match;

  // The whole point of the file: both halves are parsed as INTEGERS out of the
  // string, then combined with integer arithmetic. `fraction.padEnd(2, "0")` is
  // what makes "89.5" mean 8950 rather than 8905 — a single-digit decimal is
  // tenths, not hundredths, and reading it as hundredths would undercharge by
  // 10x without ever looking wrong.
  const wholeCents = Number(whole) * 100;
  const fractionCents = fraction ? Number(fraction.padEnd(2, "0")) : 0;
  const cents = wholeCents + fractionCents;

  // Number("999999999999999999999") is Infinity long before this, and
  // Number.isSafeInteger catches it along with every other way the arithmetic
  // above could stop being exact.
  if (!Number.isSafeInteger(cents)) {
    return { ok: false, error: "That price is too large." };
  }
  if (cents < MIN_PLAN_AMOUNT_CENTS) {
    return { ok: false, error: "Plans have to be at least $1.00." };
  }
  if (cents > MAX_PLAN_AMOUNT_CENTS) {
    return { ok: false, error: "That looks like a typo — plans cap at $10,000." };
  }

  return { ok: true, cents };
}

// The inverse, for display. Integer division and remainder, so this is exact for
// every value parseDollarsToCents can produce.
export function formatCents(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  const formatted = `$${dollars.toLocaleString("en-US")}.${String(remainder).padStart(2, "0")}`;
  return negative ? `-${formatted}` : formatted;
}

// "$150.00/mo". Used on the owner's plan list and, later, anywhere a member is
// told what they are agreeing to — which is why the interval is spelled rather
// than abbreviated to a bare "/m".
export function formatPlanPrice(cents: number, interval: "month" | "year"): string {
  return `${formatCents(cents)}/${interval === "month" ? "mo" : "yr"}`;
}
