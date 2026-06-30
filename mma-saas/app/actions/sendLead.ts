"use server";

import { Resend } from "resend";

export async function sendLead(name: string, contact: string, challenge?: string): Promise<{ success: boolean; error?: string }> {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const contactLabel = contact.includes("@") ? "Email" : "Phone";
  const timestamp = new Date().toLocaleString("en-US", {
    timeZone: "America/Denver",
    dateStyle: "full",
    timeStyle: "short",
  });
  const lines = [
    `New lead from KombatDesk signup form`,
    ``,
    `Name: ${name}`,
    `${contactLabel}: ${contact}`,
    challenge ? `Biggest challenge: ${challenge}` : null,
    ``,
    `Submitted: ${timestamp} (MST)`,
  ].filter(Boolean).join("\n");

  try {
    await resend.emails.send({
      from: "KombatDesk <leads@kombatdesk.com>",
      to: "kombatdesk@outlook.com",
      subject: `New KombatDesk Lead: ${name}`,
      text: lines,
    });
    return { success: true };
  } catch {
    return { success: false, error: "Failed to send email" };
  }
}
