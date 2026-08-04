"use client";
import { isTextEligibleMember, isWinbackDormant, TextEligibilityFields } from "../../lib/memberEligibility";

// The one implementation of "what is this member's texting state, and what
// badge does that look like". Rendered by the Members table's Texts column
// (app/members/page.tsx) and the dashboard's At Risk panel
// (app/dashboard/at-risk.tsx). It lives here rather than in either page for
// the same reason lib/memberEligibility.ts exists: two copies of this logic on
// two screens is precisely how they drift and start disagreeing on screen.
//
// "on" is delegated entirely to lib/memberEligibility.ts's isTextEligibleMember
// — the same predicate convex/sendRetentionTexts.ts:getAtRiskMembers (the real
// send gate) and members.ts:getTextableCount (the dashboard tile) use, so this
// pill, the dashboard, and the actual send audience can't drift apart the way
// they used to. Deliberately NOT convex/members.ts:getAtRiskMembers, which is a
// different, wider "who has gone quiet" list that includes people with no
// number and people who have opted out.
//
// The not-eligible sub-cases below are diagnostic labeling only, not a second
// copy of the eligibility rule — every one of those branches is already
// excluded by isTextEligibleMember; this just decides which single reason to
// surface when more than one gate fails. Order matters. smsOptedOut is checked
// before smsConsentConfirmed because an opt-out is the member's own most recent
// instruction and outranks any consent record we hold; showing "needs opt-in"
// for someone who texted STOP would invite an owner to go chase them, which is
// exactly the behaviour TCPA penalises. Absence of a phone number wins over
// both simply because there is nothing to act on. A non-"active" status is
// checked last — it isn't something this pill asks the owner to act on (that's
// the adjacent Status column), it's just the least specific reason.
//
// "dormant" is the one state that is NOT a failed eligibility gate: the member
// is fully reachable and still opted in, they have just used up this cold
// streak's whole automatic sequence. It therefore ranks below eligibility and
// above "on" — an eligible member with no attempts left is dormant, not on.
//
// The gate that is still NOT reflected here is the 7-day spacing rule. It is
// genuinely transient (a member is "recently texted" for a week, then isn't)
// and rendering it as a roster attribute would make the badge flicker between
// page loads and read as a permanent state when it is a temporary one.
// Dormancy is different: it persists until the member actually comes back,
// which members.ts:checkIn is the only thing that changes.
export type TextState = "on" | "dormant" | "opted_out" | "needs_optin" | "no_number" | "inactive";

export type TextStateFields = TextEligibilityFields & { winbackAttempts?: number };

export function textState(m: TextStateFields): TextState {
  if (isTextEligibleMember(m)) return isWinbackDormant(m) ? "dormant" : "on";
  if (!m.phone) return "no_number";
  if (m.smsOptedOut) return "opted_out";
  if (!m.smsConsentConfirmed) return "needs_optin";
  return "inactive";
}

const TEXT_STATE_STYLE: Record<Exclude<TextState, "no_number">, { label: string; bg: string; fg: string }> = {
  // Same green/amber pairs already used by the status pill and
  // ConsentAttestationPanel, so "amber = there is something for you to do here"
  // means the same thing everywhere.
  on: { label: "On", bg: "#0A2A14", fg: "#4ADE80" },
  // Amber, not grey: this is the one state on the list that asks the owner to
  // personally do something, which is the whole reason it's worth surfacing.
  dormant: { label: "Dormant", bg: "#1A1400", fg: "#FBBF24" },
  needs_optin: { label: "Needs opt-in", bg: "#1A1400", fg: "#FBBF24" },
  opted_out: { label: "Opted out", bg: "#1A1A1A", fg: "#888888" },
  inactive: { label: "Inactive", bg: "#1A1A1A", fg: "#888888" },
};

const TEXT_STATE_TITLE: Record<Exclude<TextState, "no_number">, string> = {
  on: "Number on file, consent recorded, not opted out.",
  dormant:
    "All three winback texts have been sent. They're still opted in, but the automatic sequence has stopped until they come back — this one's a phone call.",
  needs_optin:
    "You have a number but no recorded consent, so they will not be texted. Send them your opt-in link.",
  opted_out:
    "This member replied STOP. Only they can undo it, by texting START from their own phone.",
  inactive: "Consent is on file, but this member's status isn't Active, so they won't be texted.",
};

export function TextStatePill({ state }: { state: TextState }) {
  // No pill for "no number" — a roster where most members have no phone yet
  // would otherwise be a wall of badges saying nothing actionable. It still
  // carries the pill's exact box metrics (text-xs + the same padding) minus the
  // background: inheriting the 16px base size instead made the dash the tallest
  // thing in an At Risk row and left the list visibly ragged, 48px rows against
  // 44px ones, on precisely the screen that's meant to be scanned at a glance.
  if (state === "no_number")
    return (
      <span
        className="inline-block px-2.5 py-0.5 text-xs font-semibold"
        style={{ color: "#555555" }}
      >
        —
      </span>
    );
  const s = TEXT_STATE_STYLE[state];
  return (
    <span
      className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap"
      style={{ backgroundColor: s.bg, color: s.fg }}
      title={TEXT_STATE_TITLE[state]}
    >
      {s.label}
    </span>
  );
}
