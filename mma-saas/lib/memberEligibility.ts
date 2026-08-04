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
//
// MAX_WINBACK_ATTEMPTS and isWinbackDormant sit at the bottom of this file,
// but note the distinction: they are *available* here, not applied by the
// predicate. Exhausting the attempt cap is the one part of the cap that is
// durable enough to show (a member stays dormant until they check in again),
// so it gets its own display-layer state; the 7-day cadence gate stays out of
// the UI entirely.
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

// Winback attempts a member gets per cold streak before going dormant. Paired
// with the 7-day cadence gate in convex/sendRetentionTexts.ts, that's ~three
// weeks of outreach.
//
// It lives HERE rather than in convex/sendRetentionTexts.ts (which re-exports
// it, so that module's existing importers are unaffected) purely so client
// components can read it: app/components/text-state-pill.tsx needs it to
// render the "Dormant" state, and a "use client" component must not import a
// Convex module.
//
// Note what did NOT move: this constant is available to the predicate above,
// but is deliberately not applied by it. isTextEligibleMember stays the
// durable half only — see the header comment. Dormancy is computed on top of
// the predicate at the display layer, and the send gate in
// sendRetentionTexts.ts:getAtRiskMembers layers it on there.
export const MAX_WINBACK_ATTEMPTS = 3;

// True when a member is still perfectly reachable but has used up this cold
// streak's whole winback sequence — "we've stopped reaching out, it's a phone
// call from you now" (convex/members.ts:getDormantMembers).
//
// Strictly narrower than isTextEligibleMember: a dormant member IS text-
// eligible, which is why the "Can be texted" count and the dashboard tile
// deliberately still include them. Cleared by members.ts:checkIn along with
// winbackAttempts, so a member who comes back and lapses again is no longer
// dormant.
export function isWinbackDormant(member: { winbackAttempts?: number }): boolean {
  return (member.winbackAttempts ?? 0) >= MAX_WINBACK_ATTEMPTS;
}
