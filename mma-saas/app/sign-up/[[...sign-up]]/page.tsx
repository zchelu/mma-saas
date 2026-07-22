import { SignUpGate } from "./signup-gate";

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string }>;
}) {
  const { redirect_url } = await searchParams;
  const isSafeRedirect = !!redirect_url && redirect_url.startsWith("/") && !redirect_url.startsWith("//");

  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ backgroundColor: "#0D0D0D" }}>
      <SignUpGate redirectUrl={isSafeRedirect ? redirect_url : undefined} />
    </div>
  )
}
