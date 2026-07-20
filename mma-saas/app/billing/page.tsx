import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import Stripe from "stripe";
import { api } from "@/convex/_generated/api";
import { getConvexToken } from "@/lib/convex-auth";
import AppHeader from "../components/app-header";
import ManageSubscriptionButton from "./manage-subscription-button";

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
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

  const invoices = subscription.stripeCustomerId
    ? (
        await stripe.invoices.list({
          customer: subscription.stripeCustomerId,
          limit: 12,
        })
      ).data
    : [];

  const cancelAt = subscription.stripeSubscriptionId
    ? (await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId)).cancel_at
    : null;

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

        {cancelAt && (
          <div
            className="mb-10 rounded-lg px-4 py-3 text-sm"
            style={{ border: "1px solid #E02020", backgroundColor: "#1A0E0E", color: "#F87171" }}
          >
            Your subscription is canceled and will end on{" "}
            {new Date(cancelAt * 1000).toLocaleDateString()}. You'll keep access until then.
          </div>
        )}

        <h2 className="text-sm uppercase tracking-widest mb-4" style={{ color: "#888888" }}>
          Invoice history
        </h2>

        {invoices.length === 0 ? (
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
