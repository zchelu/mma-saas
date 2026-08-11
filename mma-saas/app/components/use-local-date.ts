"use client";
import { useSyncExternalStore } from "react";
import { localDateString } from "@/lib/localDate";

// The running device's calendar date, safe to read during render.
//
// lib/localDate.ts says to compute a calendar date on the client and send it,
// never derive one on the server — this deployment runs in UTC and a Colorado
// gym after 6pm is already tomorrow there. Doing that inside a component is
// awkward: calling localDateString() during render returns the SERVER's date
// during SSR, which is both wrong and a hydration mismatch.
//
// The obvious fix — useState(null) plus an effect that sets it — is the
// react-hooks/set-state-in-effect anti-pattern the check-in kiosk already has
// a long comment about avoiding. useSyncExternalStore is the sanctioned shape
// for exactly this: `null` on the server, the real local date on the client,
// with React handling the handoff.
//
// getSnapshot returns a NEW string each call, which is fine — React compares
// with Object.is and two equal date strings are the same value, so this
// doesn't loop. It also means the value is stable for the whole session: a
// tablet left running past midnight keeps yesterday's date until something
// re-renders it from scratch. That is the same behaviour a set-once state
// would have, and the kiosk is reset between members anyway.
const subscribe = () => () => {};
const getServerSnapshot = () => null;

export function useLocalDate(): string | null {
  return useSyncExternalStore(subscribe, () => localDateString(), getServerSnapshot);
}
