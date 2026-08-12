// Pure, dependency-free helpers behind Documents & Waivers. No Convex, no
// React, no browser APIs — so both convex/documents.ts (V8 isolate) and the
// signing UI can import them, and lib/documents.test.ts can exercise the
// rules that actually carry legal weight without standing anything up.
//
// THE TWO RULES THIS FILE EXISTS TO ENFORCE
//
// 1. A signed document is FROZEN. Placeholders are resolved once, at signing
//    time, and convex/documents.ts stores the output in
//    signedDocuments.renderedContent. Nothing ever re-renders a signed record
//    from its template — an owner fixing a typo in the waiver next month must
//    not retroactively change what a member put their name to.
//
// 2. CALENDAR DATES ARE THE CLIENT'S, NEVER THE SERVER'S. See lib/localDate.ts
//    for the four times this deployment's UTC clock has already produced an
//    off-by-one day. Two things here depend on "what day is it": the {{today}}
//    placeholder, and whether the signer is a minor. Both take the date as a
//    "YYYY-MM-DD" string argument. Nothing in this file calls `new Date()`
//    with no argument, reads Date.now(), or uses toISOString() on a calendar
//    date, and nothing added to it may either.

/** A calendar date with no time and no timezone, "YYYY-MM-DD". */
export type CalendarDate = string;

// Every function here takes `string | null | undefined` rather than just
// `string | undefined`, and returns null for anything it can't parse. That is
// deliberate: these compose — shiftCalendarDate's output feeds
// daysBetweenCalendarDates, formatCalendarDate's feeds a placeholder — and
// half of them return null while the other half refused to accept it, so every
// composition needed a `?? undefined` that existed only to satisfy the
// compiler. `vitest` doesn't typecheck, so the first place that showed up was
// a red `tsc --noEmit` after a green suite. Null in, null out, all the way
// through.

const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type DateParts = { year: number; month: number; day: number };

/**
 * Parse "YYYY-MM-DD" into parts, or null if it isn't a real calendar date.
 *
 * Deliberately does NOT go through `new Date(str)`. `new Date("2011-03-04")`
 * parses as UTC midnight, so every downstream getMonth()/getDate() in a
 * negative-offset timezone reports the PREVIOUS day — which for a date of
 * birth silently moves a child's birthday and, on exactly the wrong day,
 * flips whether a guardian signature is required. Parsed by hand instead.
 */
export function parseCalendarDate(value: string | null | undefined): DateParts | null {
  if (!value) return null;
  const m = CALENDAR_DATE_RE.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  // Guards a fat-fingered "0202-03-04" or a paste of a far-future date, both
  // of which would otherwise produce a confident, absurd age.
  if (year < 1900 || year > 2200) return null;
  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * "2011-03-04" -> "March 4, 2011". Formatted from the parsed parts, never via
 * Date#toLocaleDateString, for the timezone reason in parseCalendarDate.
 * Returns null for anything that isn't a real calendar date, so callers
 * decide what a blank looks like rather than getting "Invalid Date" printed
 * into a legal document.
 */
export function formatCalendarDate(value: string | null | undefined): string | null {
  const parts = parseCalendarDate(value);
  if (!parts) return null;
  return `${MONTH_NAMES[parts.month - 1]} ${parts.day}, ${parts.year}`;
}

/**
 * Whole years old on `onDate`. Null when either date is unparseable, or when
 * the date of birth is in the future.
 *
 * Both arguments are calendar dates, compared as parts. A subtraction of two
 * Date objects would reintroduce the timezone problem and, worse, would be
 * wrong across a DST boundary by an hour that rounds a birthday the wrong way.
 */
export function ageOnDate(
  dob: string | null | undefined,
  onDate: string | null | undefined
): number | null {
  const b = parseCalendarDate(dob);
  const t = parseCalendarDate(onDate);
  if (!b || !t) return null;
  let age = t.year - b.year;
  if (t.month < b.month || (t.month === b.month && t.day < b.day)) age -= 1;
  if (age < 0) return null;
  return age;
}

/**
 * Is this signer a minor on `onDate`, given the gym's threshold?
 *
 * Returns null — NOT false — when the date of birth is missing or malformed.
 * "We don't know how old this person is" and "this person is an adult" are
 * different answers, and collapsing them is exactly how a 9-year-old with a
 * blank DOB field ends up signing their own liability waiver.
 * convex/documents.ts:signDocument refuses to sign on null rather than
 * guessing; the UI asks for the date of birth instead.
 */
export function isMinorOnDate(
  dob: string | null | undefined,
  onDate: string | null | undefined,
  minorAgeThreshold: number
): boolean | null {
  const age = ageOnDate(dob, onDate);
  if (age === null) return null;
  return age < minorAgeThreshold;
}

export const DEFAULT_MINOR_AGE_THRESHOLD = 18;

/**
 * Whole days from `from` to `to`, negative if `to` is earlier. Null if either
 * isn't a real calendar date.
 *
 * Exists for one job: deciding whether a signing device's self-reported
 * "today" is plausible, by comparing it to the server's own UTC date. See
 * convex/documents.ts:signDocument.
 *
 * Counted from a day number rather than by subtracting two Date objects,
 * because the latter is wrong by an hour across a DST boundary and that hour
 * is enough to round a day the wrong way. The epoch here is arbitrary and
 * never leaves this function — it exists only so two calendar dates can be
 * subtracted.
 */
export function daysBetweenCalendarDates(
  from: string | null | undefined,
  to: string | null | undefined
): number | null {
  const a = parseCalendarDate(from);
  const b = parseCalendarDate(to);
  if (!a || !b) return null;
  return dayNumber(b) - dayNumber(a);
}

/**
 * `date` shifted by `days` (negative goes backwards), as "YYYY-MM-DD". Null if
 * the input isn't a real calendar date or the result falls outside the
 * supported range.
 *
 * Counting, not Date arithmetic — adding 86400000ms to a Date lands on the
 * wrong day across a DST boundary, which is the whole reason this module
 * refuses to touch Date at all.
 *
 * Exists for convex/seedDemoGym.ts, which back-dates demo signatures: a seeded
 * waiver frozen with today's date but stamped signedAt six weeks ago shows an
 * owner two contradictory dates on the same screen.
 */
export function shiftCalendarDate(date: string | null | undefined, days: number): string | null {
  const parts = parseCalendarDate(date);
  if (!parts || !Number.isInteger(days)) return null;
  return dateFromDayNumber(dayNumber(parts) + days);
}

// Inverse of dayNumber. Walks years then months rather than dividing, for the
// same reason dayNumber counts: no epoch maths, no leap-year special cases
// beyond the one table.
function dateFromDayNumber(n: number): string | null {
  if (n < 1) return null;
  let remaining = n;
  let year = 1900;
  for (;;) {
    const inYear = isLeapYear(year) ? 366 : 365;
    if (remaining <= inYear) break;
    remaining -= inYear;
    year++;
    if (year > 2200) return null;
  }
  let month = 1;
  for (;;) {
    const inMonth = daysInMonth(year, month);
    if (remaining <= inMonth) break;
    remaining -= inMonth;
    month++;
    if (month > 12) return null;
  }
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(remaining)}`;
}

// Days since 1900-01-01, by counting. No Date, no timezone, no DST.
function dayNumber(d: DateParts): number {
  let days = 0;
  for (let y = 1900; y < d.year; y++) days += isLeapYear(y) ? 366 : 365;
  for (let m = 1; m < d.month; m++) days += daysInMonth(d.year, m);
  return days + d.day;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Reconcile the signing device's self-reported calendar date against the
 * deployment's own UTC date, and answer both questions that depend on "what
 * day is it": which date to freeze into the document, and how old the signer
 * is.
 *
 * Pure, and takes the server date as an ARGUMENT rather than reading a clock,
 * so the rule that decides whether a child may sign alone is testable without
 * standing anything up. convex/documents.ts passes its own UTC date in, and
 * both the query that renders the guardian pad and the mutation that demands a
 * guardian signature call this — if they used different rules, a tablet with a
 * wrong clock could show a screen with no guardian field and hit a mutation
 * that insists on one.
 *
 * PLAUSIBILITY WINDOW. Local dates worldwide sit within one calendar day of
 * UTC (offsets run UTC-12 to UTC+14), so a disagreement of ±1 day is a
 * timezone and the device is trusted; anything larger is a wrong clock or a
 * crafted payload, and the device is ignored.
 *
 * AGE TAKES THE YOUNGER ANSWER inside that window. Accepting the device date
 * outright is exploitable in one specific, serious way: every US timezone is
 * behind UTC, so a real tablet can only report a date at or before the
 * server's — a device claiming to be a day AHEAD is never a timezone. On the
 * eve of a member's threshold birthday, winding the iPad forward one day made
 * them an adult and let a 17-year-old sign their own liability waiver alone.
 * After 6pm Mountain, when UTC is already tomorrow, that slack was two days
 * against the gym's real calendar.
 *
 * The cost is narrow and deliberate: at a UTC+ offset, exactly on a signer's
 * threshold birthday, this asks for a guardian signature that wasn't strictly
 * required. Every gym this product sells to today is in the US, where that
 * case cannot arise — and "asked for a guardian we didn't need" is the error
 * worth having.
 *
 * `today` deliberately does NOT take the younger answer: the document should
 * carry the date the person in the room would say it is, falling back to the
 * server only when the device is clearly wrong.
 */
export function reconcileSigningDate(
  deviceDate: string,
  serverUtcDate: string,
  dob: string | undefined
): { today: string; age: number | null } {
  const drift = daysBetweenCalendarDates(deviceDate, serverUtcDate);
  const devicePlausible = drift !== null && Math.abs(drift) <= 1;

  const candidates = devicePlausible ? [deviceDate, serverUtcDate] : [serverUtcDate];
  const ages = candidates
    .map((d) => ageOnDate(dob, d))
    .filter((a): a is number => a !== null);

  return {
    today: devicePlausible ? deviceDate : serverUtcDate,
    age: ages.length > 0 ? Math.min(...ages) : null,
  };
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

/**
 * The complete supported set, in the order the settings screen lists them.
 * This array IS the reference shown to the gym owner — adding a placeholder
 * means adding it here and to PlaceholderValues, and the UI updates itself.
 */
export const PLACEHOLDER_KEYS = [
  "member_name",
  "member_dob",
  "member_address",
  "gym_name",
  "today",
] as const;

export type PlaceholderKey = (typeof PLACEHOLDER_KEYS)[number];

export const PLACEHOLDER_DESCRIPTIONS: Record<PlaceholderKey, string> = {
  member_name: "The member's full name",
  member_dob: "The member's date of birth, e.g. March 4, 2011",
  member_address: "The member's address",
  gym_name: "Your gym's name",
  today: "The date the document is signed",
};

export type PlaceholderValues = Record<PlaceholderKey, string | undefined>;

/**
 * What a placeholder with no value renders as. A ruled blank, the way the
 * paper form this replaces would look — not an empty string, which silently
 * closes a gap the reader would otherwise notice ("Address: " reads as a
 * rendering bug; "Address: __________" reads as a blank someone left).
 */
export const BLANK = "__________";

// Tolerates internal whitespace ({{ member_name }}) because an owner pasting
// from Word will produce it, and case because {{Member_Name}} is the obvious
// thing to type. Anchored to word characters only, so a stray "{{" in prose
// isn't consumed.
const PLACEHOLDER_RE = /\{\{\s*(\w+)\s*\}\}/g;

const KNOWN = new Set<string>(PLACEHOLDER_KEYS);

/**
 * Substitute every known placeholder. An UNKNOWN one is left verbatim, on
 * purpose: an owner who typed {{membername}} needs to see it survive into the
 * preview so they can fix it. Silently deleting it would remove text from a
 * legal document with no signal that anything happened.
 */
export function resolvePlaceholders(
  content: string,
  values: PlaceholderValues
): string {
  return content.replace(PLACEHOLDER_RE, (whole, rawKey: string) => {
    const key = rawKey.toLowerCase();
    if (!KNOWN.has(key)) return whole;
    const value = values[key as PlaceholderKey];
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed.length > 0 ? trimmed : BLANK;
  });
}

/**
 * Which known placeholders a template actually uses — drives the "this
 * template asks for an address and you haven't got one" hint on the settings
 * screen. Order follows PLACEHOLDER_KEYS, not order of appearance, so the
 * list is stable as the owner edits.
 */
export function placeholdersUsed(content: string): PlaceholderKey[] {
  const found = new Set<string>();
  for (const m of content.matchAll(PLACEHOLDER_RE)) {
    found.add(m[1].toLowerCase());
  }
  return PLACEHOLDER_KEYS.filter((k) => found.has(k));
}

/**
 * Build the substitution map for one signing event.
 *
 * `todayLocalDate` is supplied by the signing device — see the header comment.
 * It is NOT optional and there is deliberately no server-side default: a
 * default here is precisely the bug lib/localDate.ts documents four times.
 */
export function buildPlaceholderValues(input: {
  memberName: string;
  memberDob?: string;
  memberAddress?: string;
  gymName?: string;
  todayLocalDate: CalendarDate;
}): PlaceholderValues {
  return {
    member_name: input.memberName,
    member_dob: formatCalendarDate(input.memberDob) ?? undefined,
    member_address: input.memberAddress,
    gym_name: input.gymName,
    today: formatCalendarDate(input.todayLocalDate) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Signature payloads
// ---------------------------------------------------------------------------

/**
 * base64 PNG data URL, as produced by app/components/signature-pad.tsx.
 *
 * Convex documents are capped at 1 MB and a signed record can carry TWO
 * signatures plus the full rendered waiver text, so the pad exports at a
 * fixed logical size rather than at device pixel ratio (an iPad Pro at DPR 2
 * would otherwise quadruple this). 300_000 base64 characters is ~220 KB of
 * PNG — far above anything the pad actually produces (~10-25 KB), and far
 * below the point where two of them plus the document text threaten the
 * document limit.
 */
export const MAX_SIGNATURE_DATA_LENGTH = 300_000;

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/**
 * Shape check only — this proves the string is a PNG data URL of a sane size,
 * not that it depicts a signature. It exists so a malformed or hostile payload
 * fails at the mutation boundary instead of becoming an <img src> that renders
 * nothing on the one screen an owner would show a lawyer. PNG only, so no
 * data:image/svg+xml (which is script-bearing) can reach an <img> tag.
 */
export function isValidSignatureData(value: string): boolean {
  if (!value.startsWith(PNG_DATA_URL_PREFIX)) return false;
  const body = value.slice(PNG_DATA_URL_PREFIX.length);
  if (body.length === 0 || value.length > MAX_SIGNATURE_DATA_LENGTH) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(body);
}
