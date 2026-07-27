"use client";
import { useRef, useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";

const MAX_MESSAGE_LENGTH = 480; // mirrors convex/sendRetentionTexts.ts's MAX_MESSAGE_LENGTH
const DEFAULT_MESSAGE = "Hey {name}, we missed you at the gym! Come back this week and keep that momentum going.";

export default function RetentionButton() {
  const trigger = useMutation(api.sendRetentionTexts.triggerRetentionTexts);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
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

  async function handleSend() {
    if (inFlight.current || !message.trim()) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      await trigger({ message: message.trim() });
      setToast(true);
      setOpen(false);
      toastTimer.current = setTimeout(() => setToast(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed — check Convex logs");
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg text-sm font-semibold px-4 py-2 transition-colors"
        style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#B91C1C"; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "#E02020"; }}
      >
        Send Retention Texts
      </button>

      {open && (
        <div
          className="absolute top-10 right-0 z-20 w-80 rounded-lg p-4"
          style={{ backgroundColor: "#1A1A1A", border: "1px solid #333333" }}
        >
          <p className="text-xs mb-2" style={{ color: "#888888" }}>
            Sent to at-risk members who&apos;ve opted in to texts and aren&apos;t already
            mid-winback. Use{" "}
            <code style={{ color: "#CCCCCC" }}>{"{name}"}</code> for their first name — &quot;Reply STOP to opt
            out.&quot; is always added automatically.
          </p>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, MAX_MESSAGE_LENGTH))}
            rows={4}
            className="w-full rounded-lg p-2 text-sm mb-1 resize-none"
            style={{ backgroundColor: "#0D0D0D", border: "1px solid #333333", color: "#FFFFFF" }}
            placeholder="Type your message…"
          />
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs" style={{ color: "#666666" }}>
              {message.length}/{MAX_MESSAGE_LENGTH}
            </span>
          </div>
          {error && (
            <p className="text-xs mb-2" style={{ color: "#F87171" }}>
              {error}
            </p>
          )}
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setOpen(false)}
              className="rounded-lg text-sm px-3 py-1.5"
              style={{ color: "#CCCCCC" }}
            >
              Cancel
            </button>
            <button
              onClick={handleSend}
              disabled={loading || !message.trim()}
              className="rounded-lg text-sm font-semibold px-3 py-1.5 disabled:opacity-50"
              style={{ backgroundColor: "#E02020", color: "#FFFFFF" }}
            >
              {loading ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div
          className="absolute top-10 right-0 text-sm px-3 py-2 rounded-lg whitespace-nowrap z-10"
          style={{ backgroundColor: "#1A2A1A", border: "1px solid #4ADE80", color: "#4ADE80" }}
        >
          Send started — only eligible members will actually be texted
        </div>
      )}

      {error && !open && (
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
