"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { clientIpFromHeaders } from "@/lib/rate-limit";

// Plain Server Action bound directly to <form action={...}> — Next 16
// progressively enhances this into a client-side submit when JS is
// available, but a real form POST (no JS) hits the same function and gets
// the same redirect-based result, so the no-JS path needs no separate
// Route Handler. Result is communicated via a ?status= redirect rather than
// useActionState, since that hook requires a client component and this page
// is deliberately a server component with no client JS dependency.
export async function submitConsentAction(formData: FormData) {
  const gymSlug = String(formData.get("gymSlug") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const consented = formData.get("consent") === "yes";

  // No /consent index page exists — this branch is only reachable if the
  // hidden gymSlug field is missing from the POST, which shouldn't happen in
  // normal use (page.tsx always sets it). Sends to the marketing homepage
  // rather than a route that doesn't exist.
  if (!gymSlug) redirect("/");
  if (!name || !phone || !consented) {
    redirect(`/consent/${gymSlug}?status=invalid`);
  }

  const h = await headers();
  const ip = clientIpFromHeaders(h);
  const userAgent = h.get("user-agent") ?? undefined;

  let status: string;
  try {
    const result = await fetchMutation(api.consent.submitConsent, {
      gymSlug,
      name,
      phone,
      ip,
      userAgent,
    });
    status = result.status;
  } catch (error) {
    // No alerting on this yet — deliberately not wiring to Resend or any
    // shared notification helper here, since another session is mid-flight
    // on one and this lane shouldn't couple to it.
    // TODO: route this to that shared alert path once it exists, so a
    // broken consent page during a gym's setup doesn't silently produce an
    // empty Day-14 number.
    console.error(`[consent] submitConsent failed for gymSlug=${gymSlug}:`, error);
    status = "error";
  }

  redirect(`/consent/${gymSlug}?status=${status}`);
}
