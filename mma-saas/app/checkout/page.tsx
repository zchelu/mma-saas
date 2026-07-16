"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

const GENERIC_ERROR = "Something went wrong — please try again or contact us.";

export default function CheckoutPage() {
  return (
    <Suspense fallback={null}>
      <CheckoutPageInner />
    </Suspense>
  );
}

function CheckoutPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const priceId = searchParams.get("priceId");
  const { isLoaded, isSignedIn } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const fired = useRef(false);

  useEffect(() => {
    if (!isLoaded || !priceId || fired.current) return;
    fired.current = true;

    if (!isSignedIn) {
      const redirectUrl = `/checkout?priceId=${encodeURIComponent(priceId)}`;
      router.replace(`/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`);
      return;
    }

    (async () => {
      try {
        const res = await fetch("/api/stripe/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priceId }),
        });
        const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;

        if (!res.ok || !data?.url) {
          setError(data?.error ?? GENERIC_ERROR);
          return;
        }

        window.location.href = data.url;
      } catch {
        setError(GENERIC_ERROR);
      }
    })();
  }, [isLoaded, isSignedIn, priceId, router]);

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center text-center px-6"
      style={{ backgroundColor: "#0D0D0D" }}
    >
      {!priceId ? (
        <p style={{ color: "#AAAAAA" }}>No plan selected.</p>
      ) : error ? (
        <p className="text-sm" style={{ color: "#FF6B6B" }}>{error}</p>
      ) : (
        <>
          <span className="inline-block w-6 h-6 rounded-full border-2 animate-spin" style={{ borderColor: "#E02020", borderTopColor: "transparent" }} />
          <p className="mt-4 text-sm" style={{ color: "#888888" }}>Taking you to checkout…</p>
        </>
      )}
      {(!priceId || error) && (
        <a href="/pricing" className="text-sm underline mt-4 inline-block" style={{ color: "#888888" }}>
          Back to pricing
        </a>
      )}
    </div>
  );
}
