"use client";

import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexReactClient, ConvexProvider } from "convex/react";
import { useAuth } from "@clerk/nextjs";
import { usePathname } from "next/navigation";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

const PUBLIC_PATHS = ["/", "/signup", "/sign-in", "/sign-up", "/thank-you"];

export function ConvexClientProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));

  if (isPublic) {
    return <ConvexProvider client={convex}>{children}</ConvexProvider>;
  }

  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}
