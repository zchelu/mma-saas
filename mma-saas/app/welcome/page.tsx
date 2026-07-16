import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { fetchAction } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { getConvexToken } from "@/lib/convex-auth";

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
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id } = await searchParams;

  if (!session_id) {
    return (
      <CenteredMessage>
        <p style={{ color: "#AAAAAA" }}>No order found.</p>
        <a href="/pricing" className="text-sm underline mt-4 inline-block" style={{ color: "#888888" }}>
          Back to pricing
        </a>
      </CenteredMessage>
    );
  }

  const user = await currentUser();
  if (!user) {
    const redirectUrl = `/welcome?session_id=${session_id}`;
    redirect(`/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`);
  }

  const token = await getConvexToken();
  try {
    await fetchAction(api.subscriptions.claimGymBySessionId, { sessionId: session_id }, { token });
  } catch (err) {
    console.error("claimGymBySessionId failed:", err);
    return (
      <CenteredMessage>
        <p className="text-sm" style={{ color: "#FF6B6B" }}>
          We couldn&apos;t confirm your payment. If you were charged, contact us and we&apos;ll sort it out.
        </p>
        <a href="/pricing" className="text-sm underline mt-4 inline-block" style={{ color: "#888888" }}>
          Back to pricing
        </a>
      </CenteredMessage>
    );
  }

  redirect("/dashboard?upgraded=true");
}
