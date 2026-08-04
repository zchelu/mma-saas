import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { ConvexClientProvider } from "./convex-provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// metadataBase is what makes the relative OG/Twitter image paths below resolve
// to absolute URLs. Without it Next emits a relative og:image, which iMessage,
// WhatsApp and LinkedIn all silently refuse to render — and the link preview is
// the first thing a gym owner sees when the site gets texted to them.
//
// The favicon and Apple touch icon are NOT declared here: app/favicon.ico and
// app/apple-icon.png are file-based conventions that Next wires up on its own.
// Declaring them twice ships duplicate <link> tags.
export const metadata: Metadata = {
  metadataBase: new URL("https://www.kombatdesk.com"),
  title: "KombatDesk",
  description:
    "KombatDesk spots members going cold and texts them back through your door. Built for MMA and BJJ gyms.",
  openGraph: {
    title: "Members don't quit your gym. They just stop showing up.",
    description:
      "KombatDesk spots members going cold and texts them back through your door.",
    url: "/",
    siteName: "KombatDesk",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "KombatDesk" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Members don't quit your gym. They just stop showing up.",
    description:
      "KombatDesk spots members going cold and texts them back through your door.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">
          <ConvexClientProvider>{children}</ConvexClientProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
