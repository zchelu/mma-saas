import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { fetchQuery, fetchMutation, fetchAction } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getConvexToken } from "@/lib/convex-auth";
import { planHasTexting } from "@/lib/plans";
import { alertStrandedCheckout } from "@/lib/alerts";
import AppHeader from "../components/app-header";
import StatsGrid from "./stats";
import RetentionButton from "./retention-button";
import AtRiskPanel from "./at-risk";
import SettlingGate from "./settling-gate";
import WinbackPanel from "./winback-panel";
import OwnerLinks from "./owner-links";
import ConnectBilling from "./connect-billing";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; session_id?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const { checkout, session_id: sessionId } = await searchParams;
  const token = await getConvexToken();

  // First authenticated page a new sign-up ever reaches — provisions this
  // owner's gyms row if one doesn't exist yet. No-op for existing owners.
  // clerkUserId is identity-derived inside the mutation from this token, not
  // passed as an argument — see convex/subscriptions.ts.
  await fetchMutation(
    api.subscriptions.getOrCreateGym,
    { defaultName: user.firstName ? `${user.firstName}'s Gym` : undefined },
    { token }
  );

  let subscription = await fetchQuery(api.subscriptions.getSubscription, {}, { token });

  // WEBHOOK-INDEPENDENT PROVISIONING. Everything below this block decides what
  // to show based on planStatus, and until 2026-08-20 the ONLY thing that ever
  // wrote planStatus on the auth-first path was the customer.subscription.created
  // webhook. When a delivery failed signature verification that night, a gym
  // owner who had already paid got SettlingGate for 8 seconds, then /pricing,
  // then the wizard again — forever, with no error emitted anywhere. The guest
  // path had been immune the whole time because /welcome re-verifies the session
  // against Stripe itself; this is that same mechanism, finally on this path too.
  //
  // Gated on an inactive plan, not just on the params: claimGymBySessionId shares
  // the rate-limited "auth" bucket with claimGymByRecoveryToken, so calling it on
  // every dashboard load would spend a real customer's allowance on nothing. Once
  // it succeeds, stripeCustomerId is set, and the /onboarding redirect below stops
  // firing even if a refresh drops the query params.
  //
  // Deliberately NOT fatal. A buyer who has just been charged must never see an
  // error page, so a failure here falls through to SettlingGate's stranded state
  // (which tells them the truth and gives them /recover) rather than throwing.
  if (
    checkout === "success" &&
    sessionId &&
    (!subscription.planStatus || subscription.planStatus === "inactive")
  ) {
    try {
      await fetchAction(api.subscriptions.claimGymBySessionId, { sessionId }, { token });
      subscription = await fetchQuery(api.subscriptions.getSubscription, {}, { token });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `Auth-first checkout claim failed for session ${sessionId} (user ${user.id}) — falling through to the stranded state:`,
        err
      );
      // A rate-limit rejection is the same person refreshing, not a new
      // failure. Alerting on it would let one stranded customer fill the
      // inbox, and an alert channel that cries wolf stops being read — the
      // same reasoning as the duplicate-email suppression in
      // lib/alerts.ts:alertMissingTrialConfirmation.
      if (!detail.includes("Too many attempts")) {
        await alertStrandedCheckout({ clerkUserId: user.id, sessionId, detail });
      }
    }
  }

  // Auth-first signup: onboarding runs before any checkout, so a gym that
  // hasn't finished it yet has no stripeCustomerId either. A gym that DOES
  // have a stripeCustomerId already got here via the old guest-checkout/
  // recovery fallback (onboardingCompleted is undefined for those, and
  // that's fine — they never needed the wizard) so it's excluded here to
  // avoid forcing already-paying accounts through onboarding retroactively.
  // checkout=success is also excluded: that means Stripe just redirected
  // back from a real completed Checkout, so both fields are EXPECTED to
  // still be unset for a beat (they're only written by the webhook) — same
  // race SettlingGate's awaitingCheckout exists to wait out below. Without
  // this, every auth-first purchase bounced straight back to /onboarding
  // before SettlingGate ever got a chance to render, forcing a redundant
  // second checkout.
  if (!subscription.onboardingCompleted && !subscription.stripeCustomerId && checkout !== "success") {
    redirect("/onboarding");
  }

  // Mirrors requireGym's read-access gate (convex/gyms.ts): only "inactive"/
  // no plan at all is blocked here. canceled/past_due gyms keep a read-only
  // grace period and should reach the real dashboard, not bounce to
  // /pricing — SettlingGate used to gate on active/trialing only, which
  // meant a canceled or past_due gym got stuck "finalizing" for 8s and then
  // got hard-redirected to /pricing despite requireGym allowing it through.
  // A checkout may still be settling too (claimGymBySessionId / webhook
  // write racing this request) — SettlingGate itself handles that case,
  // waiting on the reactive query before deciding there's genuinely no plan.
  if (!subscription.planStatus || subscription.planStatus === "inactive") {
    // checkout=success (set by the auth-first success_url — see
    // app/api/stripe/checkout/route.ts) means stripeCustomerId is NOT known
    // yet by design: unlike the old /welcome path, nothing synchronously
    // claimed the subscription before landing here, so SettlingGate must
    // wait out the webhook instead of bouncing on "no stripeCustomerId yet".
    return <SettlingGate awaitingCheckout={checkout === "success"} />;
  }

  // Members moved out of the onboarding wizard (now gym info + SMS consent
  // only) — this is where that first roster entry actually happens instead,
  // via the existing /members add-member UI.
  const memberCount = await fetchQuery(api.members.getActiveCount, {}, { token });

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
      <AppHeader />
      <main className="max-w-5xl mx-auto px-8 py-16">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-3xl" style={{ color: "#FFFFFF", fontWeight: 500 }}>
            Welcome back, {user.firstName ?? "Coach"}
          </h1>
          {/* Mirrors triggerRetentionTexts' server-side gate: billing status
              (active/trialing) plus planHasTexting to hide the button for a
              legacy "starter" gym, which never had texting under the old
              pricing and shouldn't gain it just because the tier split was
              replaced with a billing-status-only check. */}
          {(subscription.planStatus === "active" || subscription.planStatus === "trialing") &&
            planHasTexting(subscription.plan ?? undefined) && <RetentionButton />}
        </div>
        <p className="mb-12" style={{ color: "#888888" }}>Here&apos;s your gym at a glance.</p>
        {memberCount === 0 && (
          <Link
            href="/members"
            className="flex items-center justify-between rounded-lg px-6 py-4 mb-12"
            style={{ border: "1px solid #E02020", backgroundColor: "#1A1A1A" }}
          >
            <span style={{ color: "#FFFFFF" }}>Add your first members to start tracking attendance</span>
            <span style={{ color: "#E02020" }}>Add members →</span>
          </Link>
        )}
        <StatsGrid />
        <AtRiskPanel />
        <WinbackPanel gymId={subscription.gymId} gymCreatedAt={subscription.createdAt} />
        <OwnerLinks slug={subscription.slug} />
        <ConnectBilling />
      </main>
    </div>
  );
}
