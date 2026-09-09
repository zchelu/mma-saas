import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily(
  "mark inactive members",
  { hourUTC: 8, minuteUTC: 0 },
  internal.members.markInactiveMembers,
);

// 17:00 UTC. That is 10am MST (UTC-7) in winter and 11am MDT (UTC-6) in
// summer - later in summer, not earlier. This comment previously read "9am in
// summer", which is off by two hours and in the wrong direction; the 2026-08-26
// production audit observed the run firing at 11:00, and 11am Mountain is the
// number quoted to gym owners on calls.
crons.daily(
  "send retention texts",
  { hourUTC: 17, minuteUTC: 0 },
  internal.sendRetentionTexts.sendRetentionTextsSMS,
);

// Trailing-30-day summary, not a calendar-month report — see
// winbackReportEmail.ts. Runs on the 1st so every gym gets it on a
// predictable date regardless of when they onboarded.
crons.monthly(
  "send monthly winback reports",
  { day: 1, hourUTC: 17, minuteUTC: 0 },
  internal.winbackReportEmail.sendMonthlyWinbackReports,
);

export default crons;
