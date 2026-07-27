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
