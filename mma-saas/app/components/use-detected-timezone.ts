"use client";
import { useSyncExternalStore } from "react";

// The browser's IANA timezone, safe to read during render.
//
// Resolving Intl.DateTimeFormat().resolvedOptions().timeZone inline would run
// once on the server — where this deployment is UTC — and again in the browser,
// which is both a hydration mismatch and the wrong answer. See spec §3.
//
// Same shape as use-hydrated.ts and use-local-date.ts, and for the same reason:
// the useState(null) + effect version is the react-hooks/set-state-in-effect
// anti-pattern this codebase avoids. `null` on the server, the real zone on the
// client, React handles the handoff.
//
// getSnapshot returns the same string on every call for a given device, so
// Object.is holds and this does not loop. A user who changes their OS timezone
// mid-session keeps the old value until something re-renders from scratch —
// acceptable, and identical to what a set-once state would do.
const subscribe = () => () => {};
const getServerSnapshot = () => null;

function getSnapshot(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function useDetectedTimezone(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
