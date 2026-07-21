import { NextRequest } from "next/server";

// Generous for this app's small JSON bodies (an email, a price id) — catches
// a garbage/oversized payload before it's even parsed, not a real usage cap.
const MAX_BODY_BYTES = 10_000;

// Returns null on a missing/oversized/malformed body instead of throwing, so
// every call site can respond with a clean 400 rather than an unhandled
// exception turning into a 500 with a stack trace.
export async function readJsonBody<T>(request: NextRequest): Promise<T | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) return null;

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  if (!text) return null;

  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
