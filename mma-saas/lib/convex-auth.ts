import { auth } from "@clerk/nextjs/server";

// Server-side Convex auth token for an already-Clerk-authenticated request
// (Server Component / Route Handler). Logs when minting fails so a bad
// "convex" JWT template or a Clerk hiccup shows up in logs instead of
// silently degrading into Convex's "no identity" branch (which looks
// identical to a legitimate signed-out/no-subscription state to callers).
export async function getConvexToken(): Promise<string | undefined> {
  const { getToken } = await auth();
  const token = await getToken({ template: "convex" });
  if (!token) {
    console.error(
      "getConvexToken: Clerk returned no token for the \"convex\" JWT template on an authenticated request " +
        "— Convex calls will see this as unauthenticated. Check the template exists and CLERK_JWT_ISSUER_DOMAIN."
    );
  }
  return token ?? undefined;
}
