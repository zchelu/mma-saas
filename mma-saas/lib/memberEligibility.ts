// Single source of truth for "can this member receive a retention text",
// factored out after that rule existed in two copies —
// convex/sendRetentionTexts.ts:getAtRiskMembers (the real send gate) and
// app/members/page.tsx:textState (the Texts column) — which is exactly how
// the two drift and start disagreeing on screen. convex/members.ts:
// getTextableCount is the third call site.
//
// Deliberately excludes two gates that DO live in getAtRiskMembers:
//   - the 7-day cadence gate (lastRetentionTextAt)
//   - the 3-attempt cap (winbackAttempts)
// Both are transient — a member is "recently texted" for a week and then
// isn't — so a roster-level count or badge built on top of them would
// flicker between page loads and read as a permanent state when it's a
// temporary one. getAtRiskMembers layers those on top of this predicate
// itself; only the durable part moves here.
export type TextEligibilityFields = {
  archived?: boolean;
  status: "active" | "inactive";
  phone?: string;
  smsConsentConfirmed?: boolean;
  smsOptedOut?: boolean;
};

export function isTextEligibleMember(member: TextEligibilityFields): boolean {
  return (
    !member.archived &&
    member.status === "active" &&
    !!member.phone &&
    member.smsConsentConfirmed === true &&
    !member.smsOptedOut
  );
}
