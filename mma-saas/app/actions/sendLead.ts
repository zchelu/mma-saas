"use server";

import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendLead(name: string, phone: string): Promise<{ success: boolean; error?: string }> {
  try {
    await resend.emails.send({
      from: "KombatDesk <onboarding@resend.dev>",
      to: "kombatdesk@outlook.com",
      subject: "New KombatDesk Lead",
      text: `New lead from KombatDesk:\n\nName: ${name}\nPhone: ${phone}`,
    });
    return { success: true };
  } catch {
    return { success: false, error: "Failed to send email" };
  }
}
