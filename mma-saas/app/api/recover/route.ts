import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { Resend } from "resend";
import { fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";

const GENERIC_RESPONSE = {
  message: "If that email has a purchase on file, we've sent a link to finish setting up your account.",
};
const TOKEN_TTL_MS = 30 * 60 * 1000;

export async function POST(request: NextRequest) {
  const { email } = (await request.json()) as { email?: string };
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

  try {
    const customers = await stripe.customers.list({ email, limit: 1 });
    const customer = customers.data[0];

    if (customer) {
      const subscriptions = await stripe.subscriptions.list({ customer: customer.id, limit: 1 });
      if (subscriptions.data.length > 0) {
        const token = randomBytes(32).toString("hex");
        await fetchMutation(api.subscriptions.createRecoveryToken, {
          token,
          stripeCustomerId: customer.id,
          expiresAt: Date.now() + TOKEN_TTL_MS,
        });

        const origin = new URL(request.url).origin;
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: "KombatDesk <billing@kombatdesk.com>",
          to: email,
          subject: "Finish setting up your KombatDesk account",
          text: [
            `We found a payment on file for this email but no account linked to it yet.`,
            ``,
            `Finish setting up your account here (link expires in 30 minutes):`,
            `${origin}/welcome?token=${token}`,
            ``,
            `If you didn't request this, you can ignore this email.`,
          ].join("\n"),
        });
      }
    }
  } catch (err) {
    console.error("Recovery email request failed:", err);
    // Fall through to the generic response either way — never reveal via
    // response shape/timing whether an email has a purchase on file.
  }

  return NextResponse.json(GENERIC_RESPONSE);
}
