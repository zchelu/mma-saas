// Pure unit tests for the waiver rules that carry legal weight — placeholder
// substitution (what a member actually signed) and minor detection (whether a
// guardian signature was required at all). No Convex, no DOM.
//
// The date cases are the point of this file. This deployment runs in UTC and
// a Colorado gym signs people up in the evening, when UTC is already tomorrow
// (lib/localDate.ts, four separate incidents). Every date here is therefore
// asserted as a calendar date, never a Date object, and the birthday-boundary
// tests exist so a "simplification" back to `new Date(dob)` fails loudly.
import { describe, expect, test } from "vitest";
import {
  ageOnDate,
  BLANK,
  daysBetweenCalendarDates,
  buildPlaceholderValues,
  formatCalendarDate,
  isMinorOnDate,
  isValidSignatureData,
  MAX_SIGNATURE_DATA_LENGTH,
  parseCalendarDate,
  placeholdersUsed,
  reconcileSigningDate,
  resolvePlaceholders,
  shiftCalendarDate,
} from "./documents";

describe("parseCalendarDate", () => {
  test("accepts a real date", () => {
    expect(parseCalendarDate("2011-03-04")).toEqual({ year: 2011, month: 3, day: 4 });
  });

  test("rejects malformed, empty and undefined input", () => {
    for (const bad of [undefined, "", "  ", "2011-3-4", "03/04/2011", "not a date"]) {
      expect(parseCalendarDate(bad)).toBeNull();
    }
  });

  test("rejects impossible days, including Feb 29 on a non-leap year", () => {
    expect(parseCalendarDate("2011-02-29")).toBeNull();
    expect(parseCalendarDate("2012-02-29")).toEqual({ year: 2012, month: 2, day: 29 });
    // 1900 is divisible by 4 but not a leap year; 2000 is.
    expect(parseCalendarDate("1900-02-29")).toBeNull();
    expect(parseCalendarDate("2000-02-29")).toEqual({ year: 2000, month: 2, day: 29 });
    expect(parseCalendarDate("2011-04-31")).toBeNull();
    expect(parseCalendarDate("2011-13-01")).toBeNull();
  });

  test("rejects absurd years rather than computing a confident wrong age", () => {
    expect(parseCalendarDate("0202-03-04")).toBeNull();
    expect(parseCalendarDate("9999-01-01")).toBeNull();
  });
});

describe("formatCalendarDate", () => {
  test("formats without ever constructing a Date", () => {
    expect(formatCalendarDate("2011-03-04")).toBe("March 4, 2011");
    expect(formatCalendarDate("2026-12-31")).toBe("December 31, 2026");
    expect(formatCalendarDate("2026-01-01")).toBe("January 1, 2026");
  });

  // The regression this guards: `new Date("2011-03-04")` is UTC midnight, so
  // in Denver (UTC-7) toLocaleDateString reports March 3 — a member's date of
  // birth printed one day early onto a signed liability waiver.
  test("does not shift the day backwards the way UTC parsing would", () => {
    expect(formatCalendarDate("2011-03-01")).toBe("March 1, 2011");
    expect(formatCalendarDate("2011-01-01")).toBe("January 1, 2011");
  });

  test("returns null rather than 'Invalid Date' for junk", () => {
    expect(formatCalendarDate("nope")).toBeNull();
    expect(formatCalendarDate(undefined)).toBeNull();
  });
});

describe("ageOnDate", () => {
  test("counts whole years", () => {
    expect(ageOnDate("2000-06-15", "2026-08-11")).toBe(26);
  });

  test("the day before the birthday is still the younger age", () => {
    expect(ageOnDate("2008-08-12", "2026-08-11")).toBe(17);
  });

  test("the birthday itself is the older age", () => {
    expect(ageOnDate("2008-08-11", "2026-08-11")).toBe(18);
  });

  test("the day after the birthday is the older age", () => {
    expect(ageOnDate("2008-08-10", "2026-08-11")).toBe(18);
  });

  test("month boundary, not just day", () => {
    expect(ageOnDate("2008-09-01", "2026-08-31")).toBe(17);
    expect(ageOnDate("2008-08-31", "2026-09-01")).toBe(18);
  });

  test("null for unparseable or future dates of birth", () => {
    expect(ageOnDate(undefined, "2026-08-11")).toBeNull();
    expect(ageOnDate("2011-03-04", undefined)).toBeNull();
    expect(ageOnDate("junk", "2026-08-11")).toBeNull();
    expect(ageOnDate("2027-01-01", "2026-08-11")).toBeNull();
  });
});

describe("isMinorOnDate", () => {
  test("under the threshold is a minor", () => {
    expect(isMinorOnDate("2012-01-01", "2026-08-11", 18)).toBe(true);
  });

  test("exactly the threshold is not a minor", () => {
    expect(isMinorOnDate("2008-08-11", "2026-08-11", 18)).toBe(false);
  });

  test("one day short of the threshold is still a minor", () => {
    expect(isMinorOnDate("2008-08-12", "2026-08-11", 18)).toBe(true);
  });

  test("honours a gym-specific threshold", () => {
    // Same member, same day: a minor at a gym that sets 21, an adult at 16.
    expect(isMinorOnDate("2008-08-12", "2026-08-11", 21)).toBe(true);
    expect(isMinorOnDate("2008-08-12", "2026-08-11", 16)).toBe(false);
  });

  // The reason this returns a tri-state. A missing date of birth must never
  // read as "adult" — convex/documents.ts:signDocument refuses to sign on null
  // and the UI asks for the date instead.
  test("unknown date of birth is null, NOT false", () => {
    expect(isMinorOnDate(undefined, "2026-08-11", 18)).toBeNull();
    expect(isMinorOnDate("", "2026-08-11", 18)).toBeNull();
    expect(isMinorOnDate("garbage", "2026-08-11", 18)).toBeNull();
  });
});

describe("resolvePlaceholders", () => {
  const values = {
    member_name: "Maya Ortiz",
    member_dob: "March 4, 2011",
    member_address: "1200 N Nevada Ave, Colorado Springs, CO",
    gym_name: "Front Range BJJ",
    today: "August 11, 2026",
  };

  test("substitutes every supported placeholder", () => {
    expect(
      resolvePlaceholders(
        "{{member_name}} ({{member_dob}}) of {{member_address}} at {{gym_name}} on {{today}}.",
        values
      )
    ).toBe(
      "Maya Ortiz (March 4, 2011) of 1200 N Nevada Ave, Colorado Springs, CO at Front Range BJJ on August 11, 2026."
    );
  });

  test("substitutes every occurrence, not just the first", () => {
    expect(resolvePlaceholders("{{member_name}} / {{member_name}}", values)).toBe(
      "Maya Ortiz / Maya Ortiz"
    );
  });

  test("tolerates internal whitespace and mixed case", () => {
    expect(resolvePlaceholders("{{ member_name }} {{Member_Name}}", values)).toBe(
      "Maya Ortiz Maya Ortiz"
    );
  });

  test("missing values render as a ruled blank, not an empty string", () => {
    expect(
      resolvePlaceholders("Address: {{member_address}}", { ...values, member_address: undefined })
    ).toBe(`Address: ${BLANK}`);
    expect(
      resolvePlaceholders("Address: {{member_address}}", { ...values, member_address: "   " })
    ).toBe(`Address: ${BLANK}`);
  });

  // An owner who typos a placeholder has to be able to see it. Deleting it
  // would remove text from a legal document with no signal.
  test("leaves an unknown placeholder verbatim", () => {
    expect(resolvePlaceholders("Hi {{membername}} and {{member_name}}", values)).toBe(
      "Hi {{membername}} and Maya Ortiz"
    );
  });

  test("leaves ordinary prose containing braces alone", () => {
    expect(resolvePlaceholders("Use { and } freely, and {{}} too.", values)).toBe(
      "Use { and } freely, and {{}} too."
    );
  });
});

describe("placeholdersUsed", () => {
  test("reports the known placeholders a template references, deduped", () => {
    expect(
      placeholdersUsed("{{member_name}} {{member_name}} {{today}} {{nope}}")
    ).toEqual(["member_name", "today"]);
  });

  test("returns them in reference order, not order of appearance", () => {
    expect(placeholdersUsed("{{today}} then {{member_name}}")).toEqual([
      "member_name",
      "today",
    ]);
  });

  test("empty for a template with no placeholders", () => {
    expect(placeholdersUsed("Plain waiver text.")).toEqual([]);
  });
});

describe("buildPlaceholderValues", () => {
  test("formats the date of birth and today, and passes the rest through", () => {
    expect(
      buildPlaceholderValues({
        memberName: "Maya Ortiz",
        memberDob: "2011-03-04",
        memberAddress: "1200 N Nevada Ave",
        gymName: "Front Range BJJ",
        todayLocalDate: "2026-08-11",
      })
    ).toEqual({
      member_name: "Maya Ortiz",
      member_dob: "March 4, 2011",
      member_address: "1200 N Nevada Ave",
      gym_name: "Front Range BJJ",
      today: "August 11, 2026",
    });
  });

  test("an absent date of birth becomes undefined, which renders as a blank", () => {
    const values = buildPlaceholderValues({
      memberName: "Maya Ortiz",
      todayLocalDate: "2026-08-11",
    });
    expect(values.member_dob).toBeUndefined();
    expect(resolvePlaceholders("DOB: {{member_dob}}", values)).toBe(`DOB: ${BLANK}`);
  });
});

describe("isValidSignatureData", () => {
  const ok = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

  test("accepts a PNG data URL", () => {
    expect(isValidSignatureData(ok)).toBe(true);
  });

  test("rejects non-PNG data URLs, including script-bearing SVG", () => {
    expect(isValidSignatureData("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe(false);
    expect(isValidSignatureData("data:image/jpeg;base64,/9j/4AAQ")).toBe(false);
  });

  test("rejects a bare URL, empty body and non-base64 body", () => {
    expect(isValidSignatureData("https://example.com/sig.png")).toBe(false);
    expect(isValidSignatureData("data:image/png;base64,")).toBe(false);
    expect(isValidSignatureData("data:image/png;base64,not base64!")).toBe(false);
  });

  test("rejects anything over the size ceiling", () => {
    const huge = "data:image/png;base64," + "A".repeat(MAX_SIGNATURE_DATA_LENGTH);
    expect(isValidSignatureData(huge)).toBe(false);
  });
});

describe("daysBetweenCalendarDates", () => {
  test("same day is zero", () => {
    expect(daysBetweenCalendarDates("2026-08-11", "2026-08-11")).toBe(0);
  });

  test("counts forwards and backwards", () => {
    expect(daysBetweenCalendarDates("2026-08-11", "2026-08-12")).toBe(1);
    expect(daysBetweenCalendarDates("2026-08-12", "2026-08-11")).toBe(-1);
  });

  test("crosses month, year and leap-day boundaries", () => {
    expect(daysBetweenCalendarDates("2026-08-31", "2026-09-01")).toBe(1);
    expect(daysBetweenCalendarDates("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetweenCalendarDates("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysBetweenCalendarDates("2027-02-28", "2027-03-01")).toBe(1);
  });

  // The case this function exists for: a Denver tablet at 7pm reports a date
  // one behind the deployment's UTC date, and that must read as plausible.
  test("a one-day timezone disagreement is exactly one day", () => {
    expect(daysBetweenCalendarDates("2026-08-11", "2026-08-12")).toBe(1);
  });

  test("null for unparseable input", () => {
    expect(daysBetweenCalendarDates(undefined, "2026-08-11")).toBeNull();
    expect(daysBetweenCalendarDates("2026-08-11", "junk")).toBeNull();
  });
});

// The rule that decides whether a child may sign their own liability waiver
// alone. Every case below is a real device/server disagreement, not a
// hypothetical: a Colorado tablet after 6pm reports yesterday's date relative
// to this UTC deployment, and a tampered or dead-battery tablet can report
// anything at all.
describe("reconcileSigningDate", () => {
  const DOB_TURNS_18_ON_AUG_12 = "2008-08-12";

  test("device and server agree: device date is used", () => {
    const r = reconcileSigningDate("2026-08-11", "2026-08-11", "2000-01-01");
    expect(r.today).toBe("2026-08-11");
    expect(r.age).toBe(26);
  });

  // The everyday case. Denver at 7pm on the 10th; UTC is already the 11th.
  test("device one day BEHIND the server is a timezone — device date is frozen", () => {
    const r = reconcileSigningDate("2026-08-10", "2026-08-11", "2000-06-15");
    expect(r.today).toBe("2026-08-10");
  });

  // THE ATTACK. Real local date is the 11th, the member turns 18 on the 12th,
  // and someone winds the iPad forward a day to skip the guardian.
  test("winding the device forward a day does NOT age a minor into an adult", () => {
    const r = reconcileSigningDate("2026-08-12", "2026-08-11", DOB_TURNS_18_ON_AUG_12);
    expect(r.age).toBe(17);
  });

  // The everyday UTC trap, and the reason the device date is one of the
  // candidates rather than a tiebreak. Denver at 7pm on the 10th; UTC is
  // already the 11th; the member turns 18 on the 11th. Server-only would read
  // 18 and let them sign alone while they are still 17 in the building.
  test("a member who turns 18 tomorrow LOCALLY is still a minor when UTC has rolled over", () => {
    const r = reconcileSigningDate("2026-08-10", "2026-08-11", "2008-08-11");
    expect(r.age).toBe(17);
  });

  // The residual, asserted so it is a known quantity rather than a surprise:
  // when the device is discarded as implausible, the server's UTC date can be
  // one day ahead of the gym's real local date, and a member whose threshold
  // birthday is that day reads as an adult. Discarding an untrustworthy clock
  // is still the right call — this locks in what it costs.
  test("KNOWN RESIDUAL: with the device discarded, a UTC-rollover birthday reads as adult", () => {
    const r = reconcileSigningDate("1999-01-01", "2026-08-11", "2008-08-11");
    expect(r.today).toBe("2026-08-11");
    expect(r.age).toBe(18);
  });

  test("a genuinely adult signer is not blocked by the younger-age rule", () => {
    const r = reconcileSigningDate("2026-08-12", "2026-08-11", "2000-03-04");
    expect(r.age).toBe(26);
  });

  // Dead battery, RTC default, or a crafted payload: outside ±1 day the
  // device is ignored entirely — for the frozen date as well as the age.
  test("an implausible device date is discarded for BOTH the date and the age", () => {
    const r = reconcileSigningDate("2020-01-01", "2026-08-11", "2010-01-01");
    expect(r.today).toBe("2026-08-11");
    expect(r.age).toBe(16);
  });

  test("a device far in the future is discarded too", () => {
    const r = reconcileSigningDate("2099-01-01", "2026-08-11", "2010-01-01");
    expect(r.today).toBe("2026-08-11");
    expect(r.age).toBe(16);
  });

  // A signer whose date of birth we don't have must come back as unknown, not
  // as an adult — convex/documents.ts refuses to sign on null.
  test("unknown date of birth yields a null age, never a number", () => {
    expect(reconcileSigningDate("2026-08-11", "2026-08-11", undefined).age).toBeNull();
    expect(reconcileSigningDate("2026-08-11", "2026-08-11", "garbage").age).toBeNull();
  });

  test("an unparseable device date falls back to the server without throwing", () => {
    const r = reconcileSigningDate("not-a-date", "2026-08-11", "2000-01-01");
    expect(r.today).toBe("2026-08-11");
    expect(r.age).toBe(26);
  });
});

describe("shiftCalendarDate", () => {
  test("moves forwards and backwards", () => {
    expect(shiftCalendarDate("2026-08-11", 1)).toBe("2026-08-12");
    expect(shiftCalendarDate("2026-08-11", -1)).toBe("2026-08-10");
    expect(shiftCalendarDate("2026-08-11", 0)).toBe("2026-08-11");
  });

  test("crosses month, year and leap boundaries", () => {
    expect(shiftCalendarDate("2026-08-31", 1)).toBe("2026-09-01");
    expect(shiftCalendarDate("2026-09-01", -1)).toBe("2026-08-31");
    expect(shiftCalendarDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftCalendarDate("2027-01-01", -1)).toBe("2026-12-31");
    expect(shiftCalendarDate("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftCalendarDate("2027-02-28", 1)).toBe("2027-03-01");
  });

  // The seeder back-dates demo signatures by up to ~7 weeks.
  test("a 46-day back-shift lands where daysBetweenCalendarDates agrees", () => {
    const shifted = shiftCalendarDate("2026-08-11", -46);
    expect(shifted).toBe("2026-06-26");
    expect(daysBetweenCalendarDates(shifted, "2026-08-11")).toBe(46);
  });

  test("round-trips against daysBetweenCalendarDates across a leap year", () => {
    for (const delta of [-400, -60, -1, 0, 1, 60, 400]) {
      const shifted = shiftCalendarDate("2028-03-01", delta);
      expect(daysBetweenCalendarDates("2028-03-01", shifted)).toBe(delta);
    }
  });

  test("null for junk input or a non-integer shift", () => {
    expect(shiftCalendarDate("nope", 1)).toBeNull();
    expect(shiftCalendarDate(undefined, 1)).toBeNull();
    expect(shiftCalendarDate("2026-08-11", 1.5)).toBeNull();
  });
});
