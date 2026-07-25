import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { fetchAction, fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getConvexToken } from "@/lib/convex-auth";
import { PLAN_LABEL } from "@/lib/plans";

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center text-center px-6"
      style={{ backgroundColor: "#0D0D0D" }}
    >
      {children}
    </div>
  );
}

export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string; token?: string }>;
}) {
  const { session_id, token: recoveryToken } = await searchParams;

  if (!session_id && !recoveryToken) {
    return (
      <CenteredMessage>
        <p style={{ color: "#AAAAAA" }}>No order found.</p>
        <a href="/recover" className="text-sm underline mt-4 inline-block" style={{ color: "#888888" }}>
          Already paid? Recover your purchase
        </a>
        <a href="/pricing" className="text-sm underline mt-2 inline-block" style={{ color: "#888888" }}>
          Back to pricing
        </a>
      </CenteredMessage>
    );
  }

  const user = await currentUser();
  if (!user) {
    const redirectUrl = session_id
      ? `/welcome?session_id=${session_id}`
      : `/welcome?token=${recoveryToken}`;
    redirect(`/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`);
  }

  const convexToken = await getConvexToken();
  try {
    if (session_id) {
      await fetchAction(api.subscriptions.claimGymBySessionId, { sessionId: session_id }, { token: convexToken });
    } else {
      await fetchAction(api.subscriptions.claimGymByRecoveryToken, { token: recoveryToken! }, { token: convexToken });
    }
  } catch (err) {
    console.error("claim failed:", err);
    return (
      <CenteredMessage>
        <p className="text-sm" style={{ color: "#FF6B6B" }}>
          {session_id
            ? "We couldn't confirm your payment. If you were charged, contact us and we'll sort it out."
            : "This recovery link is invalid or has expired."}
        </p>
        <a
          href={session_id ? "/pricing" : "/recover"}
          className="text-sm underline mt-4 inline-block"
          style={{ color: "#888888" }}
        >
          {session_id ? "Back to pricing" : "Request a new link"}
        </a>
      </CenteredMessage>
    );
  }

  // Plan is already active in Convex by this point — claimGymBySessionId
  // just wrote it synchronously from Stripe-verified data (see
  // convex/subscriptions.ts). Show a real confirmation instead of silently
  // redirecting, so the buyer sees their payment actually went through.
  const subscription = await fetchQuery(api.subscriptions.getSubscription, {}, { token: convexToken });
  const planLabel = subscription.plan ? (PLAN_LABEL[subscription.plan] ?? subscription.plan) : null;

  return (
    <CenteredMessage>
      <p className="text-2xl font-bold mb-2" style={{ color: "#FFFFFF" }}>
        {planLabel ? `You're on ${planLabel}` : "You're all set"}
      </p>
      <p className="text-sm mb-6" style={{ color: "#888888" }}>
        Your account is ready to go.
      </p>
      <a
        href="/dashboard"
        className="rounded-lg font-semibold px-6 py-3 text-sm"
        style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
      >
        Go to dashboard
      </a>
    </CenteredMessage>
  );
}
