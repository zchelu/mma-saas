import { SignUpGate } from "./signup-gate";

const VALID_PLANS = new Set(["academy", "fightteam", "blackbelt"]);

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string; plan?: string }>;
}) {
  const { redirect_url, plan } = await searchParams;
  const isSafeRedirect = !!redirect_url && redirect_url.startsWith("/") && !redirect_url.startsWith("//");

  // redirect_url (used by /welcome's recovery/claim links) always wins when
  // present. Otherwise, a plan query param from a pricing CTA carries
  // through to onboarding; SignUpGate's own default ("/onboarding") covers
  // the case where neither is set.
  const resolvedRedirect = isSafeRedirect
    ? redirect_url
    : plan && VALID_PLANS.has(plan)
      ? `/onboarding?plan=${plan}`
      : undefined;

  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ backgroundColor: "#0D0D0D" }}>
      <SignUpGate redirectUrl={resolvedRedirect} />
    </div>
  )
}
