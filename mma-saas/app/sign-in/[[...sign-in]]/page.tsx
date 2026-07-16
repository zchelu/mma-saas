import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="flex flex-col justify-center items-center min-h-screen gap-4" style={{ backgroundColor: "#0D0D0D" }}>
      <SignIn fallbackRedirectUrl="/dashboard" />
      <a href="/recover" className="text-sm underline" style={{ color: "#888888" }}>
        Already paid but never finished setting up? Recover your purchase
      </a>
    </div>
  );
}
