import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { fetchQuery } from "convex/nextjs";
import Stripe from "stripe";
import { api } from "@/convex/_generated/api";
import { getConvexToken } from "@/lib/convex-auth";
import AppHeader from "../components/app-header";
import ManageSubscriptionButton from "./manage-subscription-button";

// FOUNDING (COMPED) TRIAL — see convex/schema.ts:foundingTrialEndsAt.
//
// This page's whole vocabulary assumes a Stripe customer: invoice history, a
// cancellation date, a Manage Subscription button that opens the Stripe portal.
// A founding gym has none of those, so without this block the owner of the
// first gym opens /billing and reads "Status: trialing" over an empty invoice
// list and no controls — which looks exactly like something has gone wrong with
// their account. It has not; there is simply nothing in Stripe to show.
function FoundingTrialCard({ endsAt, ended }: { endsAt: number; ended: boolean }) {
  const endsOn = new Date(endsAt).toLocaleDateString();
  return (
    <div
      className="mb-10 flex flex-col gap-3 rounded-lg px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
      style={
        ended
          ? { border: "1px solid #E02020", backgroundColor: "#1A0E0E" }
          : { border: "1px solid #333333", backgroundColor: "#1A1A1A" }
      }
    >
      <div className="flex flex-col gap-1 text-sm">
        <span style={{ color: "#FFFFFF", fontWeight: 600 }}>
          {ended ? `Free founding trial ended ${endsOn}` : `Free founding trial through ${endsOn}`}
        </span>
        <span style={{ color: "#888888" }}>
          {ended
            ? "No card was ever collected, so nothing was charged. Choose a plan to start making changes again — your data is untouched."
            : "No card on file. Nothing will be charged when this date passes — we'll ask you to choose a plan instead."}
        </span>
      </div>
      <Link
        href="/pricing"
        className="shrink-0 rounded-lg font-semibold px-6 py-3 text-sm text-center"
        style={
          ended
            ? { backgroundColor: "#E02020", color: "#FFFFFF" }
            : { backgroundColor: "#1A1A1A", color: "#CCCCCC", border: "1px solid #333333" }
        }
      >
        {ended ? "Choose a plan" : "See plans"}
      </Link>
    </div>
  );
}

function statusColor(status: string | null) {
  if (status === "active") return "#4ADE80";
  if (status === "trialing") return "#3B82F6";
  if (status === "past_due") return "#F87171";
  return "#888888";
}

export default async function BillingPage() {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const token = await getConvexToken();
  const subscription = await fetchQuery(api.subscriptions.getSubscription, {}, { token });

  // Read, don't construct — `new Stripe(undefined!)` throws synchronously, and
  // in a Server Component that means the whole billing page 500s rather than
  // degrading. Same class of bug as app/api/stripe/checkout/route.ts:39, which
  // was fixed while this one was missed.
  //
  // A missing key must NOT take the page down: plan, status and the Manage
  // Subscription button all come from Convex and stay useful. Only the
  // Stripe-sourced parts (invoice history, cancellation date) are unavailable,
  // so those degrade to an honest notice. No alert is raised here — this is a
  // read-only page, and app/api/stripe/portal/route.ts alerts on the same
  // condition when the customer actually tries to do something.
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

  if (!stripeSecretKey) {
    console.error("Billing page: STRIPE_SECRET_KEY is missing — invoice history unavailable");
  }

  // Wrapped: a Stripe outage or a revoked key would otherwise crash a page the
  // customer opened specifically to cancel. Failing to a notice keeps the
  // Manage Subscription path reachable, which is the one FAQ #4 promises.
  let invoices: Stripe.Invoice[] = [];
  let cancelAt: number | null = null;
  let stripeUnavailable = !stripeSecretKey;

  if (stripe) {
    try {
      if (subscription.stripeCustomerId) {
        invoices = (
          await stripe.invoices.list({ customer: subscription.stripeCustomerId, limit: 12 })
        ).data;
      }
      if (subscription.stripeSubscriptionId) {
        cancelAt = (await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId)).cancel_at;
      }
    } catch (err) {
      console.error("Billing page: Stripe read failed — showing page without invoice history:", err);
      stripeUnavailable = true;
    }
  }

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: "#0D0D0D" }}>
      <AppHeader />
      <main className="max-w-3xl mx-auto px-8 py-16">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-3xl" style={{ color: "#FFFFFF", fontWeight: 500 }}>
            Billing
          </h1>
          {subscription.stripeCustomerId && <ManageSubscriptionButton />}
        </div>
        <p className="mb-10" style={{ color: "#888888" }}>
          Plan: <span style={{ color: "#FFFFFF", textTransform: "capitalize" }}>{subscription.plan ?? "None"}</span>
          {" · "}
          Status:{" "}
          <span style={{ color: statusColor(subscription.planStatus), textTransform: "capitalize" }}>
            {subscription.planStatus ?? "—"}
          </span>
        </p>

        {/* typeof === "number", not !== null — see the matching guard in
            app/dashboard/page.tsx for the stale-deployment case this survives. */}
        {typeof subscription.foundingTrialEndsAt === "number" &&
          !subscription.stripeCustomerId && (
            <FoundingTrialCard
              endsAt={subscription.foundingTrialEndsAt}
              ended={subscription.foundingTrialEnded}
            />
          )}

        {cancelAt && (
          <div
            className="mb-10 rounded-lg px-4 py-3 text-sm"
            style={{ border: "1px solid #E02020", backgroundColor: "#1A0E0E", color: "#F87171" }}
          >
            Your subscription is canceled and will end on{" "}
            {new Date(cancelAt * 1000).toLocaleDateString()}. You&apos;ll keep access until then.
          </div>
        )}

        <h2 className="text-sm uppercase tracking-widest mb-4" style={{ color: "#888888" }}>
          Invoice history
        </h2>

        {stripeUnavailable ? (
          <p style={{ color: "#888888" }}>
            Invoice history is temporarily unavailable. Your subscription is unaffected —
            use Manage Subscription above, or email kombatdesk@outlook.com and I&apos;ll sort it.
          </p>
        ) : invoices.length === 0 ? (
          <p style={{ color: "#555555" }}>No invoices yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {invoices.map((inv) => (
              <a
                key={inv.id}
                href={inv.hosted_invoice_url ?? "#"}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between px-4 py-3 rounded-lg"
                style={{ border: "1px solid #2A2A2A", color: "#CCCCCC" }}
              >
                <span>{new Date(inv.created * 1000).toLocaleDateString()}</span>
                <span>${(inv.amount_paid / 100).toFixed(2)}</span>
                <span style={{ color: inv.status === "paid" ? "#4ADE80" : "#F87171", textTransform: "capitalize" }}>
                  {inv.status}
                </span>
              </a>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
