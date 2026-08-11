"use client";
import { useSyncExternalStore } from "react";

// Has React taken over the page yet?
//
// THIS EXISTS BECAUSE OF A REAL, REPRODUCED KIOSK BUG. Before hydration a
// <form> is plain HTML: tapping its submit button performs a native GET
// submission instead of running React's onSubmit, so `e.preventDefault()`
// never happens. None of the kiosk's inputs carry a `name`, so the browser
// rebuilt the URL with an EMPTY query string — turning
// `/kiosk/signup?gym=<id>` into `/kiosk/signup?` and dropping the gym id, at
// which point the page correctly but uselessly reported "Kiosk not
// configured". Observed on an iPad over wifi, where the hydration window is
// long enough to tap into; unreproducible on desktop localhost, where it
// isn't.
//
// Gate a submit control on this and a pre-hydration tap can't fire the native
// path at all. Pair it with a hidden input carrying the parameter, so that if
// a native submit ever does happen the URL survives it — belt and braces,
// because the failure mode is a member standing at the door with a form that
// just erased itself.
//
// useSyncExternalStore rather than useState+useEffect for the same reason
// use-local-date.ts uses it: the effect version is the
// react-hooks/set-state-in-effect shape this codebase avoids.
const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

export function useIsHydrated(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
