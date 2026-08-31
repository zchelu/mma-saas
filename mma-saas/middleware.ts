import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/pricing',
  '/checkout',
  '/welcome(.*)',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/signup(.*)',
  // The lead form's confirmation page. It is the LAST STEP OF /signup above,
  // and leaving it out of this list meant every prospect who submitted the form
  // was redirected to accounts.kombatdesk.com/sign-in and asked to log in to an
  // account they do not have. The lead email still sent (the server action
  // completes before the route change), so the failure was invisible from the
  // inbox. Reproduced against production 2026-08-31. A page that a signed-out
  // visitor is ROUTED TO must be public, not merely the page that routes to it.
  '/thank-you',
  '/checkin(.*)',
  // The front-desk tablet's other half — new-member signup and waiver
  // signing. Unauthenticated for the same reason /checkin is: the device at
  // the door has no Clerk session. Every function behind it takes the gym's
  // rotatable kiosk token, never a gymId, and re-derives the rest server-side
  // (convex/gyms.ts:tryGetKioskGym, convex/documents.ts).
  '/kiosk(.*)',
  '/consent(.*)',
  '/recover(.*)',
  '/terms(.*)',
  '/privacy(.*)',
  '/cookies(.*)',
  '/demo/sms-consent(.*)',
  '/api/stripe/webhook',
  '/api/stripe/checkout',
  '/api/recover',
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
