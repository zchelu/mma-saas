"use client";
import { ConvexError } from "convex/values";

// Convex mutations that reject a write on purpose (e.g. requireWriteAccess's
// billing gate) throw ConvexError specifically so the message survives
// production's redaction of plain Error messages to a generic "Server
// Error" - see convex/gyms.ts. Anything else (network blip, real bug) is a
// developer error and prod won't tell us more than that.
export function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ConvexError && typeof err.data === "string") {
    return err.data;
  }
  return fallback;
}

export function ErrorToast({ message }: { message: string }) {
  return (
    <div
      className="text-sm px-3 py-2 rounded-lg"
      style={{ backgroundColor: "#2A0A0A", border: "1px solid #F87171", color: "#F87171" }}
    >
      {message}
    </div>
  );
}
