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

    if (result.status === "invalid_signature") {
      return new Response(JSON.stringify({ error: "Invalid webhook signature" }), { status: 400 });
    }

    // 500, not 400 — processing hit a transient failure (typically the Stripe
    // re-fetch) and the dedupe claim has been released, so Stripe should
    // redeliver. Stripe retries any non-2xx, so a 400 would also get retried,
    // but it would record an outage as a rejected signature.
    if (result.status === "retry") {
      return new Response(JSON.stringify({ error: "Temporarily unable to process" }), { status: 500 });
    }

    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }),
});

// Stripe CONNECT webhook — Accounts v2 event notifications for the platform's
// connected accounts, a different stream from /stripe/webhook above and
// deliberately not folded into it (spec §1).
//
// Different signing secret (STRIPE_CONNECT_WEBHOOK_SECRET), different dedupe
// table (stripeConnectWebhookEvents), different failure consequences. The
// platform stream provisions gyms that have already paid; this one is the only
// thing that ever learns a connected account went live, because embedded
// components never redirect and so produce no arrival event.
//
// REGISTER THIS URL AS AN EVENT DESTINATION AT "YOUR ACCOUNT" SCOPE — NOT
// "Connected accounts". Accounts v2 events for accounts that belong directly to
// the platform are delivered to the platform's own destinations; the v1 routing
// does not apply, and a Connect-scoped endpoint receives NOTHING AT ALL. Read
// verbatim from the Stripe dashboard, 2026-08-18. See the header of
// convex/connectWebhookAction.ts for the rest of the v1/v2 differences.
//
// URL: <deployment>.convex.site/stripe/connect-webhook
http.route({
  path: "/stripe/connect-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      return new Response(JSON.stringify({ error: "Missing stripe-signature header" }), {
        status: 400,
      });
    }

    const payload = await request.text();
    const result = await ctx.runAction(api.connectWebhookAction.verifyAndProcess, {
      signature,
      payload,
    });

    if (result.status === "invalid_signature") {
      return new Response(JSON.stringify({ error: "Invalid webhook signature" }), { status: 400 });
    }

    // 500, not 400 — processing hit a transient failure and the dedupe claim has
    // been released, so Stripe should redeliver. Stripe retries any non-2xx, so
    // a 400 would also get retried, but it would record an outage as a rejected
    // signature and send whoever is debugging to rotate a healthy secret.
    if (result.status === "retry") {
      return new Response(JSON.stringify({ error: "Temporarily unable to process" }), {
        status: 500,
      });
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

    // Everything from here to the runAction below is read-only parsing. The
    // rate limiter used to sit in this gap and write a rateLimits row keyed on
    // params.From — an attacker-controlled field on an unauthenticated
    // endpoint, read before anything had proven the request came from Twilio.
    // Burning a real member's bucket that way got their genuine STOP rejected
    // with a 429 right here, before the signature was ever checked. It now
    // runs inside verifyAndProcess, after validation; see the comment there.
    const rawBody = await request.text();
    const params = Object.fromEntries(new URLSearchParams(rawBody));
    const url = new URL(request.url);
    const webhookUrl = `${url.origin}${url.pathname}`;

    try {
      const result = await ctx.runAction(internal.twilioWebhookAction.verifyAndProcess, {
        url: webhookUrl,
        params,
        signature,
      });

      // Empty body: a forged request gets a deliberate rejection and nothing
      // to learn from. 403 rather than 401 — there is no credential to
      // re-present, and Twilio does not retry 4xx.
      if (result.status === "invalid_signature") {
        return new Response(null, { status: 403 });
      }

      // Distinct from the 403 above on purpose: this point is only reachable
      // with a valid Twilio signature, so 429 tells a real sender to back off
      // rather than implying their credentials were rejected.
      if (result.status === "rate_limited") {
        return new Response("Too many requests", { status: 429 });
      }

      // MUST escape. The reply body was previously interpolated raw, and the
      // HELP text contains a bare "&" ("Msg & data rates may apply") — not
      // well-formed XML. Twilio rejected the whole document with 12200
      // ("The entity name must immediately follow the '&' in the entity
      // reference") and delivered nothing, verified in Twilio's error log
      // 2026-08-02 at 21:45 and 21:53 UTC. The member still got a HELP reply
      // because Twilio's own messaging-service Advanced Opt-Out answer is
      // configured with the identical wording, so the failure was invisible
      // from the handset and our route still returned 200. STOP and START
      // survived only by luck of containing no XML metacharacters.
      //
      // Escaping here rather than sanitising the copy is deliberate: the HELP
      // sentence is part of the five-site disclosure set that carriers
      // cross-check (see sendRetentionTexts.ts:39-51), so it must stay
      // byte-identical to lib/consentText.ts, terms.html §23 and
      // privacy-policy.html §9. Fix the encoder, never the disclosure.
      const escapeXml = (s: string) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

      const twiml = result.replyMessage
        ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(result.replyMessage)}</Message></Response>`
        : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
      return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
    } catch (err) {
      // Genuinely unexpected only — an invalid signature is a returned variant
      // now, not a throw. This used to answer 403 for anything, which meant a
      // missing TWILIO_AUTH_TOKEN or a Convex fault was reported to Twilio as a
      // forged request: no retry, no log, and a real member's STOP dropped on
      // the floor looking like an attack. 500 gets it retried and logged.
      console.error("Twilio inbound webhook failed:", err);
      return new Response(null, { status: 500 });
    }
  }),
});

export default http;
