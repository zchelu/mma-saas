import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily(
  "mark inactive members",
  { hourUTC: 8, minuteUTC: 0 },
  internal.members.markInactiveMembers,
);

// 10am MST (UTC-7) / 9am MDT (UTC-6) — fires ~10am in winter, 9am in summer
crons.daily(
  "send retention texts",
  { hourUTC: 17, minuteUTC: 0 },
  internal.sendRetentionTexts.sendRetentionTextsSMS,
);

export default crons;
