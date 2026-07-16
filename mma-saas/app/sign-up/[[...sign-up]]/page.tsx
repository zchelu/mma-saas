import { SignUp } from '@clerk/nextjs'

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string }>;
}) {
  const { redirect_url } = await searchParams;
  const isSafeRedirect = !!redirect_url && redirect_url.startsWith("/") && !redirect_url.startsWith("//");

  return (
    <div className="min-h-screen flex items-center justify-center">
      <SignUp fallbackRedirectUrl={isSafeRedirect ? redirect_url : "/dashboard"} />
    </div>
  )
}
