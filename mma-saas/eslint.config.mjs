import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Convex codegen output — rewritten by `npx convex dev` / `convex deploy`.
    // Anything flagged here is unfixable by hand because the next codegen run
    // overwrites the edit. Was emitting 4 "unused eslint-disable directive"
    // warnings that no one could ever action.
    "convex/_generated/**",
    // Vendored agent skill packs. Not application source, not bundled by Next,
    // not ours to fix: these are third-party skill bundles that ship their own
    // .cjs scripts and minified vendor assets (gsap.min.js alone accounts for
    // hundreds of findings). They were producing 83 of the repo's 85 lint
    // errors and 380+ warnings, which made `npm run lint` unreadable — two real
    // errors in app/dashboard/connect-billing.tsx sat undetected in that noise
    // until 2026-08-18. A gate nobody can read is not a gate.
    ".agents/**",
  ]),
  {
    // Standalone Node scripts, run directly with `node scripts/x.js` and never
    // bundled by Next. CommonJS require() is correct in them; the TS rule
    // banning it exists for the app's ESM sources, not here. Was producing 12
    // of the repo's 16 lint errors.
    files: ["scripts/**/*.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
