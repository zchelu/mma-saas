import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

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
    const result = await ctx.runAction(internal.stripeWebhookAction.verifyAndProcess, {
      signature,
      payload,
    });

    if (!result.success) {
      return new Response(JSON.stringify({ error: "Invalid webhook signature" }), { status: 400 });
    }
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }),
});

export default http;
