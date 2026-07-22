import { readFileSync } from "fs";
import { join } from "path";

// The source documents in content/ carry their own embedded <style> blocks
// (Termly's export uses `!important` dark text colors; the hand-built docs
// hardcode #0D0D0D body text) meant for a light background. This site is
// dark-themed, so those colors render as unreadable dark-on-dark — strip
// them and let app/globals.css's .legal-content rules style the markup
// instead.
export function readLegalContent(filename: string): string {
  const raw = readFileSync(join(process.cwd(), "content", filename), "utf-8");
  return raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
}
