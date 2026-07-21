import { NextRequest, NextResponse } from "next/server";
import { fetchAction } from "convex/nextjs";
import { api } from "@/convex/_generated/api";

// Stripe's dashboard endpoint stays pointed at this Vercel route (by
// decision — see project CLAUDE.md), but signature verification and event
// processing now live in one place, convex/stripeWebhookAction.ts, shared
// with the Convex-native shadow endpoint (convex/http.ts). This route is
// just a forwarder: it no longer holds the Stripe secret or calls Convex
// mutations directly — upsertSubscription/upsertUnclaimedSubscription/
// updatePlanStatusByCustomer are internalMutation now, unreachable from
// here or anywhere else outside a trusted Convex function.
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  const result = await fetchAction(api.stripeWebhookAction.verifyAndProcess, {
    signature,
    payload: rawBody,
  });

  if (!result.success) {
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });
  }

  return NextResponse.json({ received: true });
}
