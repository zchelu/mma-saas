"use client";

import { useState } from "react";
import Link from "next/link";
import { SignUp } from "@clerk/nextjs";

export function SignUpGate({ redirectUrl }: { redirectUrl?: string }) {
  const [agreed, setAgreed] = useState(false);
  const [revealed, setRevealed] = useState(false);

  if (revealed) {
    return <SignUp fallbackRedirectUrl={redirectUrl ?? "/dashboard"} />;
  }

  return (
    <div
      className="w-full max-w-[400px] rounded-xl p-8"
      style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333" }}
    >
      <h1 className="text-xl font-bold mb-2" style={{ color: "#FFFFFF" }}>
        Create your account
      </h1>
      <p className="text-sm mb-6" style={{ color: "#888888" }}>
        Confirm you agree to our legal terms before continuing.
      </p>

      <label className="flex items-start gap-3 mb-6 cursor-pointer">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5 w-4 h-4 shrink-0"
        />
        <span className="text-sm leading-relaxed" style={{ color: "#CCCCCC" }}>
          I agree to the{" "}
          <Link
            href="/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="underline transition-colors hover:text-white"
            style={{ color: "#E02020" }}
          >
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="underline transition-colors hover:text-white"
            style={{ color: "#E02020" }}
          >
            Privacy Policy
          </Link>
          .
        </span>
      </label>

      <button
        type="button"
        disabled={!agreed}
        onClick={() => setRevealed(true)}
        className="w-full rounded-lg px-4 py-3 text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
      >
        Continue
      </button>
    </div>
  );
}
