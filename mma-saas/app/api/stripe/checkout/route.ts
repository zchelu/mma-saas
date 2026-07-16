import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { currentUser } from "@clerk/nextjs/server";

export async function POST(request: NextRequest) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const { priceId } = await request.json() as { priceId: string };

  const allowedPriceIds = [
    process.env.STRIPE_STARTER_PRICE_ID,
    process.env.STRIPE_PRO_PRICE_ID,
    process.env.STRIPE_ELITE_PRICE_ID,
  ];
  if (!allowedPriceIds.includes(priceId)) {
    return NextResponse.json(
      { error: "That plan isn't available right now. Please refresh and try again." },
      { status: 400 }
    );
  }

  const origin = new URL(request.url).origin;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/dashboard?upgraded=true`,
      cancel_url: `${origin}/pricing`,
      customer_email: user.emailAddresses[0]?.emailAddress,
      billing_address_collection: "required",
      automatic_tax: { enabled: true },
      subscription_data: {
        metadata: { clerkUserId: user.id },
      },
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout session creation failed:", err);
    return NextResponse.json(
      { error: "Something went wrong — please try again or contact us." },
      { status: 500 }
    );
  }
}
