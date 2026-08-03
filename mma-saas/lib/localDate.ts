// THE LOCAL-DATE RULE. Read this before writing any date-to-string code.
//
// This deployment runs in UTC. A Colorado gym is UTC-6 or UTC-7, so from 5pm
// or 6pm local until midnight, UTC is ALREADY THE NEXT DAY. Any date derived
// with toISOString() during those hours is off by one — and those are exactly
// the hours a martial arts gym is full.
//
// This mistake has been made FOUR times in this codebase:
//
//   1. app/classes/[id]/page.tsx — a Monday 6:00 PM session logged itself
//      under Tuesday, silently corrupting Session History. Because
//      getByClassAndDate keys on the date string, the real day always came
//      back empty, so a coach could log the same session twice and see no
//      "Logged" markers. Caught 2026-07-29 with the field reading 07/30 at
//      9pm Mountain.
//   2. app/dashboard/winback-panel.tsx — carries its own warning comment.
//   3. The check-in kiosk (2026-08-02) — would have filed evening check-ins
//      under the following day and shown the wrong day's classes.
//   4. attendance.getSessionDates (2026-08-02) — same, one level up.
//
// Every one of those sites already had a comment warning against it. The
// comments did not work. This function exists so there is one implementation
// to reach for instead of a rule to remember.
//
// RULES:
//   - NEVER use `toISOString().slice(0, 10)` to get a calendar date.
//   - A calendar date is always the USER'S local date. Compute it on the
//     client and send it; the server cannot know it. There is no timezone
//     field on gyms, deliberately — the device is physically in the gym, so
//     its clock is the gym's clock.
//   - Server-side code that needs to bucket by day must receive the date
//     string as an argument (see attendance.logAttendance's `date` and
//     checkIns.localDate), never derive one.

/**
 * The calendar date in the RUNNING DEVICE'S timezone, as "YYYY-MM-DD".
 *
 * Uses the local getters, not the UTC ones. Call this in a client component
 * or an effect — never during SSR, where "local" is the server's UTC and the
 * result will both be wrong and cause a hydration mismatch against the
 * browser's value.
 */
export function localDateString(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Lowercase three-letter weekday prefix in the running device's timezone —
 * "sun", "mon", "tue", "wed", "thu", "fri", "sat".
 *
 * Used to match against the free-text `dayOfWeek` an owner typed on a class,
 * which may be "Monday", "Mon", "Mon/Wed" or "Monday & Thursday". A prefix
 * test handles all of those without parsing. Same timezone rule applies:
 * after 6pm Mountain the UTC weekday is already tomorrow's.
 */
export function localDayPrefix(d: Date = new Date()): string {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d.getDay()];
}
