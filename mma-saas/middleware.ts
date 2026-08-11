import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/pricing',
  '/checkout',
  '/welcome(.*)',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/signup(.*)',
  '/checkin(.*)',
  // The front-desk tablet's other half — new-member signup and waiver
  // signing. Unauthenticated for the same reason /checkin is: the device at
  // the door has no Clerk session. Every function behind it takes an explicit
  // gymId and re-derives the rest server-side (convex/documents.ts).
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
