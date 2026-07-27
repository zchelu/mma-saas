"use node";

import { Resend } from "resend";
import { internalAction, ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REPORT_WINDOW_DAYS = 30;
// Caps the at-risk list in the email body — a founding gym's whole roster
// going quiet at once shouldn't produce an unreadable wall of names.
const MAX_AT_RISK_LISTED = 20;

// Mirrors app/dashboard/winback-panel.tsx's formatting exactly: daysToReturn
// is stored unrounded on purpose, round only for display, and under a full
// day reads as "same day" rather than "0 days" (which would read as a bug,
// not the best possible outcome).
function formatDaysToReturn(days: number): string {
  if (days < 1) return "same day";
  const rounded = Math.round(days);
  return `${rounded} day${rounded === 1 ? "" : "s"}`;
}

// Failure is logged, not thrown — one gym's bad email address or a Resend
// outage must not take down the rest of the fan-out, same reasoning as
// stripeWebhookAction.ts's sendTrialConfirmationEmail.
async function sendReportForGym(ctx: ActionCtx, gymId: Id<"gyms">, gymName: string, email: string) {
  try {
    const now = Date.now();
    const startMs = now - REPORT_WINDOW_DAYS * MS_PER_DAY;

    const report = await ctx.runQuery(internal.winbackReport.getWinbackRecoveriesInternal, {
      gymId,
      startMs,
      endMs: now,
    });
    const atRisk = await ctx.runQuery(internal.sendRetentionTexts.getAtRiskMembers, { gymId });

    const recoveryLines =
      report.count > 0
        ? report.recoveries.map((r) => `- ${r.name} (back ${formatDaysToReturn(r.daysToReturn)} after text ${r.attemptsUsed})`)
        : ["Nobody yet — no members came back after a winback text in this period."];

    const atRiskLines =
      atRisk.length > 0
        ? atRisk.slice(0, MAX_AT_RISK_LISTED).map((m) => `- ${m.name}`)
        : ["Nobody currently at risk."];
    const atRiskOverflow =
      atRisk.length > MAX_AT_RISK_LISTED ? [`...and ${atRisk.length - MAX_AT_RISK_LISTED} more`] : [];

    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: "KombatDesk <reports@kombatdesk.com>",
      to: email,
      subject: `Your KombatDesk winback report — ${gymName}`,
      text: [
        `${report.count} member${report.count === 1 ? "" : "s"} came back after a winback text in the last ${REPORT_WINDOW_DAYS} days:`,
        ``,
        ...recoveryLines,
        ``,
        `Currently at risk (${atRisk.length}):`,
        ...atRiskLines,
        ...atRiskOverflow,
      ].join("\n"),
    });
  } catch (err) {
    console.error(`Winback report email failed for gym ${gymId}:`, err);
  }
}

// Cron entry point — fans out to every actively-subscribed, texting-eligible
// gym individually, same shape as sendRetentionTexts.ts:sendRetentionTextsSMS,
// so one gym's failure (bad email, Resend hiccup) never blends into or blocks
// another gym's report.
export const sendMonthlyWinbackReports = internalAction({
  args: {},
  handler: async (ctx) => {
    const textableGyms = await ctx.runQuery(internal.subscriptions.listTextableGyms);
    for (const gym of textableGyms) {
      if (!gym.email) {
        console.log(`Gym ${gym._id} has no owner email on file — skipping monthly winback report`);
        continue;
      }
      await sendReportForGym(ctx, gym._id, gym.name ?? "your gym", gym.email);
    }
  },
});
