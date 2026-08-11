"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// Finger-signature pad. No library, on purpose — the whole component is one
// canvas and a point buffer, and a dependency here would be a third-party
// script sitting inside a legal signing flow.
//
// THIS IS DEMOED LIVE ON AN iPAD. Everything below that looks fussy is there
// because iOS Safari breaks it otherwise:
//
//   - `touchAction: "none"` on the canvas. Without it, a finger drag scrolls
//     the page (or triggers pull-to-refresh) instead of drawing, and a
//     double-tap zooms the whole kiosk. This is the single most important
//     line in the file.
//   - Pointer events, not touch events. React attaches touchmove passively,
//     so `preventDefault()` inside onTouchMove is ignored — the classic "it
//     draws on desktop and scrolls on the tablet" bug. Pointer events also
//     unify finger, Apple Pencil and mouse into one code path.
//   - setPointerCapture, so a stroke that leaves the canvas edge still ends
//     properly instead of leaving the pad stuck in drawing state.
//   - `isPrimary` only, which drops the second contact point of a palm rest
//     or an accidental pinch.
//   - The backing store is scaled by devicePixelRatio so strokes aren't
//     blurry on a Retina display, but the EXPORT is redrawn at a fixed
//     logical size (see toPngDataUrl) — a DPR-3 iPad Pro would otherwise
//     produce a PNG nine times the area, and two of those plus the waiver
//     text have to fit inside one Convex document.
//
// Strokes are kept as points rather than baked straight into the canvas so a
// resize (rotating the iPad mid-signature) can redraw rather than erase.

type Point = { x: number; y: number };
type Stroke = Point[];

// Logical drawing surface. The canvas is styled to fill its container and the
// backing store follows the real pixel size, but strokes are recorded in these
// coordinates so the export is device-independent.
const EXPORT_WIDTH = 600;
const EXPORT_HEIGHT = 200;

const INK = "#111111";
const EXPORT_LINE_WIDTH = 2.5;

type Props = {
  /** Shown above the pad, e.g. "Member signature" or "Parent / guardian signature". */
  label: string;
  /** Disabled pads still render, greyed, so the layout doesn't jump when they enable. */
  disabled?: boolean;
  /**
   * Fires with a base64 PNG data URL on Accept, and with null on Clear — so
   * the parent's "accepted" state is derived from this one callback and can't
   * drift from what's on screen.
   */
  onChange: (dataUrl: string | null) => void;
};

export default function SignaturePad({ label, disabled = false, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const activeRef = useRef<Stroke | null>(null);
  const [hasInk, setHasInk] = useState(false);
  const [accepted, setAccepted] = useState(false);

  // Redraws everything from the point buffer at the canvas's current size.
  // Called on every resize/orientation change, which is why the buffer exists.
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Strokes are stored in EXPORT_WIDTH x EXPORT_HEIGHT space; map that onto
    // however big the element actually is.
    ctx.setTransform(
      canvas.width / EXPORT_WIDTH,
      0,
      0,
      canvas.height / EXPORT_HEIGHT,
      0,
      0
    );
    paintStrokes(ctx, strokesRef.current);
  }, []);

  useEffect(() => {
    redraw();
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => redraw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [redraw]);

  function toLogical(e: React.PointerEvent<HTMLCanvasElement>): Point {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * EXPORT_WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * EXPORT_HEIGHT,
    };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled || accepted || !e.isPrimary) return;
    // Belt and braces with touchAction: none — stops iOS from also treating
    // this as the start of a scroll gesture or a text selection.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const point = toLogical(e);
    // Seeded with the same point twice so a single tap (a dot on an "i", or a
    // very short signature) still paints — a one-point path draws nothing.
    activeRef.current = [point, point];
    strokesRef.current = [...strokesRef.current, activeRef.current];
    setHasInk(true);
    redraw();
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    // Read into a local before the toLogical() call below. TypeScript keeps
    // narrowing on `activeRef.current` across a function call, but only
    // because of a known unsoundness — a local makes the guard actually mean
    // what it looks like it means.
    const stroke = activeRef.current;
    if (!stroke || !e.isPrimary) return;
    e.preventDefault();
    stroke.push(toLogical(e));
    redraw();
  }

  function endStroke(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!activeRef.current) return;
    activeRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  function handleClear() {
    strokesRef.current = [];
    activeRef.current = null;
    setHasInk(false);
    setAccepted(false);
    redraw();
    onChange(null);
  }

  function handleAccept() {
    const dataUrl = toPngDataUrl(strokesRef.current);
    if (!dataUrl) return;
    setAccepted(true);
    onChange(dataUrl);
  }

  const framed = disabled ? "#1A1A1A" : "#FFFFFF";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-semibold uppercase tracking-widest" style={{ color: "#888888" }}>
          {label}
        </p>
        {accepted && (
          <span className="text-sm font-semibold" style={{ color: "#4ADE80" }}>
            ✓ Signed
          </span>
        )}
      </div>

      <div
        className="relative rounded-2xl overflow-hidden"
        style={{
          backgroundColor: framed,
          border: `1px solid ${accepted ? "#4ADE80" : "#333333"}`,
          opacity: disabled ? 0.4 : 1,
        }}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={endStroke}
          // Long-press on iOS otherwise raises the callout menu mid-signature.
          onContextMenu={(e) => e.preventDefault()}
          className="block w-full"
          style={{
            height: 200,
            // THE LINE THAT MAKES THIS WORK WITH A FINGER. See the header.
            touchAction: "none",
            WebkitUserSelect: "none",
            userSelect: "none",
            cursor: disabled || accepted ? "default" : "crosshair",
          }}
          aria-label={label}
        />
        {/* Signature rule, drawn in the DOM rather than onto the canvas so it
            never ends up baked into the exported PNG. */}
        <div
          className="absolute left-8 right-8 pointer-events-none"
          style={{ bottom: 44, borderBottom: "1px solid #CCCCCC" }}
        />
        {!hasInk && !disabled && (
          <p
            className="absolute inset-x-0 pointer-events-none text-center text-base"
            style={{ bottom: 16, color: "#999999" }}
          >
            Sign above with your finger
          </p>
        )}
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={handleClear}
          disabled={disabled || !hasInk}
          className="rounded-xl px-6 py-4 text-base font-semibold transition-all active:scale-95 disabled:opacity-40"
          style={{ backgroundColor: "#222222", border: "1px solid #333333", color: "#FFFFFF" }}
        >
          Clear
        </button>
        <button
          type="button"
          onClick={handleAccept}
          disabled={disabled || !hasInk || accepted}
          className="flex-1 rounded-xl px-6 py-4 text-base font-bold transition-all active:scale-95 disabled:opacity-40"
          style={{ backgroundColor: accepted ? "#166534" : "#E02020", color: "#FFFFFF" }}
        >
          {accepted ? "Signature accepted" : "Accept signature"}
        </button>
      </div>
    </div>
  );
}

function paintStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[]) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
  ctx.lineWidth = EXPORT_LINE_WIDTH;
  for (const stroke of strokes) {
    if (stroke.length === 0) continue;
    ctx.beginPath();
    ctx.moveTo(stroke[0].x, stroke[0].y);
    for (let i = 1; i < stroke.length; i++) {
      ctx.lineTo(stroke[i].x, stroke[i].y);
    }
    ctx.stroke();
  }
}

/**
 * Render the point buffer to a PNG data URL at a FIXED logical size.
 *
 * Deliberately not `canvasRef.current.toDataURL()`. That canvas's backing
 * store is devicePixelRatio-scaled, so the same signature exports at 600x200
 * from a laptop and 1800x600 from an iPad Pro — a nine-fold difference in a
 * value that gets stored twice (member + guardian) inside a Convex document
 * capped at 1 MB. Redrawing onto an offscreen canvas makes the payload a
 * property of the signature, not of whichever tablet happened to be at the
 * door. Transparent background, so the PNG sits on whatever the viewing
 * surface is.
 */
function toPngDataUrl(strokes: Stroke[]): string | null {
  if (strokes.length === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = EXPORT_WIDTH;
  canvas.height = EXPORT_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  paintStrokes(ctx, strokes);
  return canvas.toDataURL("image/png");
}
