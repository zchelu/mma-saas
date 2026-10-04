"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIsHydrated } from "./use-hydrated";

// The app's ONE dropdown. Replaces every native <select> in app/.
//
// WHY THIS EXISTS. A native <select> renders as whatever the OS says: on iOS a
// full-screen sheet, on Android a small dialog, on Windows Chrome a flat white
// list that ignores the dark UI entirely and looks like a different product.
// The option list is the one part of a <select> CSS cannot reach - `.input`
// styles the closed control and nothing else - so "dark everywhere" was never
// achievable by styling. This renders the list ourselves, so the same panel
// appears on a phone at the front desk, an iPad kiosk and a laptop on a call.
//
// PORTALLED, DELIBERATELY. Selects live inside modals and drawers that set
// their own stacking and overflow (member-modal, member-billing-drawer). An
// anchored popover would be clipped by those or trapped under them, and the
// fix is different in each one. A portalled centered panel has no relationship
// to its parent's layout, so it behaves identically everywhere and there is no
// position maths to get wrong on a device that cannot be tested from here.
//
// ANIMATION IS CSS, NOT STATE. The enter animation is a keyframe in
// globals.css that runs on mount; only the exit needs React to know, and that
// flips from an event handler. Nothing here sets state from an effect - the
// shape this codebase avoids (see use-hydrated.ts).
//
// NOT A DROP-IN FOR NATIVE `required`. A button cannot be constraint-validated,
// so a form that relied on `<select required>` must check the value in its own
// submit handler. app/invoices/invoice-modal.tsx already does.

export type SelectOption = {
  value: string;
  label: string;
  // Second line under the label - a price, a status note. Keeps the label
  // short enough to read at a glance on a phone.
  hint?: string;
  disabled?: boolean;
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  // Heading at the top of the panel ("Membership plan"). Matches the field's
  // own label so the sheet says what is being chosen once it covers the form.
  title?: string;
  // Trigger text when nothing is selected yet.
  placeholder?: string;
  disabled?: boolean;
  // Width utilities and the like, applied to the trigger - `w-36`, `flex-1`.
  className?: string;
  ariaLabel?: string;
};

const EXIT_MS = 130;

const GUTTER = 8; // minimum distance from any viewport edge
const GAP = 6; // distance between trigger and panel
const MIN_PANEL_H = 192;

type Placement =
  | null // centered sheet — the current behaviour
  | {
      left: number;
      top?: number;
      bottom?: number;
      width: number;
      maxHeight: number;
      transformOrigin: "top left" | "bottom left";
    };

// Below 640px this always returns null: the phone gets the centered sheet,
// unconditionally. Above it, anchors under (or, out of room, above) the
// trigger - see the fix-2 spec this shipped from for the exact numbers.
function computePlacement(rect: DOMRect): Placement {
  if (window.innerWidth < 640) return null;

  const width = Math.min(Math.max(rect.width, 224), 352);
  const left = Math.min(Math.max(rect.left, GUTTER), window.innerWidth - width - GUTTER);
  const below = window.innerHeight - rect.bottom - GAP - GUTTER;
  const above = rect.top - GAP - GUTTER;

  if (below >= MIN_PANEL_H) {
    return {
      left,
      top: rect.bottom + GAP,
      width,
      maxHeight: Math.min(0.7 * window.innerHeight, 544, below),
      transformOrigin: "top left",
    };
  }
  if (above >= MIN_PANEL_H) {
    return {
      left,
      bottom: window.innerHeight - rect.top + GAP,
      width,
      maxHeight: Math.min(0.7 * window.innerHeight, 544, above),
      transformOrigin: "bottom left",
    };
  }
  return null;
}

export default function SelectField({
  value,
  onChange,
  options,
  title,
  placeholder = "Select…",
  disabled = false,
  className = "",
  ariaLabel,
}: Props) {
  const hydrated = useIsHydrated();
  const listId = useId();
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const [activeIndex, setActiveIndex] = useState(0);
  const [placement, setPlacement] = useState<Placement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selected = options.find((o) => o.value === value) ?? null;
  const isOpen = phase !== "closed";

  const close = useCallback(() => {
    setPhase((p) => (p === "open" ? "closing" : p));
    if (exitTimer.current) clearTimeout(exitTimer.current);
    exitTimer.current = setTimeout(() => {
      setPhase("closed");
      // Focus goes back where it came from, or the next Tab starts at the top
      // of the document - on the kiosk that means the front desk loses their
      // place in the form.
      triggerRef.current?.focus();
    }, EXIT_MS);
  }, []);

  function open() {
    if (disabled || options.length === 0) return;
    if (exitTimer.current) clearTimeout(exitTimer.current);
    const i = options.findIndex((o) => o.value === value);
    setActiveIndex(i >= 0 ? i : 0);
    // Measured here, in the click handler, not in an effect - see the
    // component-level comment on why nothing here sets state from one.
    setPlacement(triggerRef.current ? computePlacement(triggerRef.current.getBoundingClientRect()) : null);
    setPhase("open");
  }

  function pick(option: SelectOption) {
    if (option.disabled) return;
    // Fire before closing: the caller may unmount this control as a result
    // (a plan change re-renders the drawer), and a setState afterwards on an
    // unmounted tree is the warning that follows.
    if (option.value !== value) onChange(option.value);
    close();
  }

  // Key handling and the body scroll lock. One effect, no state written from
  // it - everything here is either a listener or a DOM side effect.
  useEffect(() => {
    if (phase !== "open") return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "Tab") {
        // Nowhere to tab to - the panel is the whole interaction. Letting
        // focus escape leaves an open panel behind the page.
        event.preventDefault();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((current) => {
          let next = current;
          // Skip disabled rows rather than landing on one and doing nothing.
          for (let i = 0; i < options.length; i += 1) {
            next = (next + step + options.length) % options.length;
            if (!options[next]?.disabled) return next;
          }
          return current;
        });
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const option = options[activeIndex];
        if (option) pick(option);
      }
    }

    // An anchored panel drifts from its trigger the moment anything scrolls
    // or the window resizes. Closing is deliberate over repositioning - it is
    // one line, it cannot drift, and a dropdown vanishing when the page
    // behind it scrolls is normal behaviour.
    function onReposition(event: Event) {
      // A scroll INSIDE the panel's own option list is not drift.
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      close();
    }

    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onReposition);
    // Capture phase: the Billing drawer scrolls in its own container, not on
    // window, and only capture sees that.
    document.addEventListener("scroll", onReposition, { capture: true, passive: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onReposition);
      document.removeEventListener("scroll", onReposition, { capture: true });
      document.body.style.overflow = previousOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, activeIndex, options, close]);

  // Bring the selected row into view when the panel opens. A gym with 30 plans
  // otherwise opens at the top with the current one somewhere below the fold.
  useEffect(() => {
    if (phase !== "open") return;
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: "center" });
  }, [phase]);

  useEffect(() => {
    return () => {
      if (exitTimer.current) clearTimeout(exitTimer.current);
    };
  }, []);

  const triggerLabel = selected ? selected.label : placeholder;

  // Same panel either way - same radius, blur, checkmarks, hints, animation.
  // Only placement and the backdrop change.
  const anchored = placement !== null;

  const panel = (
    <div
      className={`select-sheet-backdrop fixed inset-0 ${anchored ? "" : "flex items-center justify-center p-6"}`}
      data-closing={phase === "closing"}
      style={
        anchored
          ? { zIndex: 100 } // transparent, no blur - exists only to catch the click-outside
          : { zIndex: 100, backgroundColor: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }
      }
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        className={`select-sheet-panel overflow-hidden ${anchored ? "" : "w-full"}`}
        data-closing={phase === "closing"}
        style={
          anchored
            ? {
                position: "fixed",
                left: placement.left,
                top: placement.top,
                bottom: placement.bottom,
                width: placement.width,
                maxHeight: placement.maxHeight,
                transformOrigin: placement.transformOrigin,
                borderRadius: 26,
                backgroundColor: "rgba(60,60,60,0.96)",
                backdropFilter: "blur(24px) saturate(180%)",
                border: "1px solid rgba(255,255,255,0.08)",
                boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
                display: "flex",
                flexDirection: "column",
              }
            : {
                maxWidth: "22rem",
                maxHeight: "min(70vh, 34rem)",
                borderRadius: 26,
                backgroundColor: "rgba(60,60,60,0.96)",
                backdropFilter: "blur(24px) saturate(180%)",
                border: "1px solid rgba(255,255,255,0.08)",
                boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
                display: "flex",
                flexDirection: "column",
              }
        }
      >
        {title && (
          <p className="px-6 pt-5 pb-2 text-lg shrink-0" style={{ color: "#A5A5A5", fontWeight: 400 }}>
            {title}
          </p>
        )}
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel ?? title}
          className="overflow-y-auto overscroll-contain pb-2"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <div
                key={option.value}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled}
                data-active={index === activeIndex}
                onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                onClick={() => pick(option)}
                className="flex items-start gap-3 px-6 py-3 select-none"
                style={{
                  color: option.disabled ? "#7A7A7A" : "#FFFFFF",
                  backgroundColor:
                    index === activeIndex && !option.disabled ? "rgba(255,255,255,0.08)" : "transparent",
                  cursor: option.disabled ? "default" : "pointer",
                }}
              >
                {/* Fixed-width column so every label starts on the same line
                    whether or not it is the selected one - the checkmark must
                    not shift the list sideways as the selection moves. */}
                <span className="shrink-0 text-lg" style={{ width: "1.25rem", color: "#FFFFFF" }}>
                  {isSelected ? "✓" : ""}
                </span>
                <span className="min-w-0">
                  <span className="block text-lg leading-tight">{option.label}</span>
                  {option.hint && (
                    <span className="block text-sm mt-0.5" style={{ color: "#A5A5A5" }}>
                      {option.hint}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => (isOpen ? close() : open())}
        className={`input flex items-center justify-between gap-2 text-left disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      >
        <span className="truncate" style={{ color: selected ? "#FFFFFF" : "#555555" }}>
          {triggerLabel}
        </span>
        {/* The stacked chevrons a native control shows on iOS - the affordance
            people already read as "this opens a list". */}
        <svg
          width="12"
          height="16"
          viewBox="0 0 12 16"
          fill="none"
          aria-hidden="true"
          className="shrink-0"
          style={{ color: "#8A8A8A" }}
        >
          <path d="M3 6.5L6 3.5L9 6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3 9.5L6 12.5L9 9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {/* Before hydration there is no document to portal into, and the trigger
          above does nothing anyway - same reasoning as the kiosk's submit gate. */}
      {hydrated && isOpen && createPortal(panel, document.body)}
    </>
  );
}
