import { NextResponse } from "next/server";
import { sendTestSms } from "@/lib/twilio";

export async function GET() {
  const result = await sendTestSms(
    "+17192298105", // Zain's cell
    "KombatDesk test: this is a working SMS pipe 🥋"
  );
  return NextResponse.json(result);
}
