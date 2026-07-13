// lib/twilio.ts
import twilio from "twilio";

// Server-only. Never import this file from a "use client" component.
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;

if (!accountSid || !authToken || !fromNumber) {
  throw new Error(
    "Missing Twilio env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER"
  );
}

const client = twilio(accountSid, authToken);

export async function sendTestSms(to: string, body: string) {
  const message = await client.messages.create({
    to,        // e.g. "+15551234567" — your own cell for testing
    from: fromNumber,
    body,
  });

  return { sid: message.sid, status: message.status };
}
