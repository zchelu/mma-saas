"use client";
import { useSyncExternalStore } from "react";

// The running page's origin, safe to read during render.
//
// Hardcoding a base URL is how a link ends up pointing at the wrong
// environment, so these URLs have to come from window.location — but reading it
// through `typeof window === "undefined" ? "" : window.location.origin` is a
// server/client branch, which is the FIRST bullet in React's hydration-mismatch
// error message and exactly what it produced: the server rendered
// `/consent/<slug>` and the client rendered `http://host/consent/<slug>`, so
// React threw and regenerated the subtree on every dashboard load.
//
// Same shape as use-hydrated.ts, use-local-date.ts and use-detected-timezone.ts,
// and for the same reason. `""` on the server AND during hydration, the real
// origin immediately after — React drives the handoff instead of discovering a
// disagreement.
//
// Consumers must tolerate `""` for that first paint. Every current caller
// interpolates it as a prefix, so the value is a valid relative URL in the
// meantime rather than a broken one.
const subscribe = () => () => {};
const getServerSnapshot = () => "";
const getSnapshot = () => window.location.origin;

export function useOrigin(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
