import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily(
  "mark inactive members",
  { hourUTC: 8, minuteUTC: 0 },
  internal.members.markInactiveMembers,
);

export default crons;
