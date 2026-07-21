import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

const http = httpRouter();

http.route({
  path: "/stripe/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      return new Response(JSON.stringify({ error: "Missing stripe-signature header" }), { status: 400 });
    }

    const payload = await request.text();
    const result = await ctx.runAction(api.stripeWebhookAction.verifyAndProcess, {
      signature,
      payload,
    });

    if (!result.success) {
      return new Response(JSON.stringify({ error: "Invalid webhook signature" }), { status: 400 });
    }
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }),
});

// Twilio inbound-SMS webhook (STOP/START opt-out handling). Lives here rather
// than as a Next.js API route so the HMAC signature verification and the
// internal-only member mutation it guards stay in the same trust boundary —
// see convex/twilioWebhookAction.ts for why.
http.route({
  path: "/twilio/inbound",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signature = request.headers.get("x-twilio-signature");
    if (!signature) {
      return new Response("Missing signature", { status: 400 });
    }

    const rawBody = await request.text();
    const params = Object.fromEntries(new URLSearchParams(rawBody));
    const url = new URL(request.url);
    const webhookUrl = `${url.origin}${url.pathname}`;

    // Signature verification (below) already proves this came from Twilio,
    // but a compromised/misconfigured sender replaying the same request
    // shouldn't be able to hammer this in a tight loop — bounded per sender
    // number, generous enough for a real opt-out/opt-in burst.
    const allowed = await ctx.runMutation(internal.rateLimit.checkRateLimit, {
      bucket: "twilioInbound",
      identifier: params.From ?? "unknown",
    });
    if (!allowed) {
      return new Response("Too many requests", { status: 429 });
    }

    try {
      const result = await ctx.runAction(internal.twilioWebhookAction.verifyAndProcess, {
        url: webhookUrl,
        params,
        signature,
      });
      const twiml = result.replyMessage
        ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${result.replyMessage}</Message></Response>`
        : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
      return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
    } catch {
      return new Response("Invalid signature", { status: 403 });
    }
  }),
});

export default http;
