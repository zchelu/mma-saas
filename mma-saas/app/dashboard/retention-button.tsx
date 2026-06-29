"use client";
import { useRef, useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";

export default function RetentionButton() {
  const trigger = useMutation(api.sendRetentionTexts.triggerRetentionTexts);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  async function handleClick() {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      await trigger();
      setToast(true);
      toastTimer.current = setTimeout(() => setToast(false), 3000);
    } catch {
      setError("Failed — check Convex logs");
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }

  return (
    <div className="relative inline-block">
      <button
        onClick={handleClick}
        disabled={loading}
        className="rounded-lg text-sm font-semibold px-4 py-2 transition-colors disabled:opacity-50"
        style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
        onMouseEnter={e => { if (!loading) e.currentTarget.style.backgroundColor = "#B91C1C"; }}
        onMouseLeave={e => { e.currentTarget.style.backgroundColor = "#E02020"; }}
      >
        {loading ? "Sending…" : "Send Retention Texts"}
      </button>

      {toast && (
        <div
          className="absolute top-10 right-0 text-sm px-3 py-2 rounded-lg whitespace-nowrap z-10"
          style={{ backgroundColor: "#1A2A1A", border: "1px solid #4ADE80", color: "#4ADE80" }}
        >
          Texts queued
        </div>
      )}

      {error && (
        <div
          className="absolute top-10 right-0 text-sm px-3 py-2 rounded-lg whitespace-nowrap z-10"
          style={{ backgroundColor: "#2A0A0A", border: "1px solid #F87171", color: "#F87171" }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
