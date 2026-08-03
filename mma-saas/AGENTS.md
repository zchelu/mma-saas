<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# KombatDesk — working rules

KombatDesk LLC. Solo founder (Zain), Colorado Springs. Pre-revenue, selling the
first 5 gyms. Next.js App Router · Convex · Clerk · Stripe · Twilio · Resend ·
Vercel · Tailwind v4 · TypeScript.

Durable context lives in the **claude.ai project**, not in this repo. Start with
the newest `claude/handoff-*.md` there.

## 1. Who runs git and deploys

**RESOLVED 2026-08-03. Agents may run git and deploys, under per-step
authorization.** This supersedes the /pricing lane's Rule 10 ("no git, no
build, no Convex CLI, no deploy from an agent"). That rule is retired — do not
reinstate it without replacing this section.

How it works:

- Propose each stage / commit / push / deploy as its own step, with the
  **explicit file list** and the commit message written out. Run it only after
  Zain approves that specific step.
- **Never `git add -A` or `git commit -a`.** Explicit paths only. That is how
  `app/globals.css` ended up inside an unrelated commit on 8/2.
- **Never `git commit` without `-m`.** It opens an editor an agent can't drive.
- `npx convex deploy` is interactive. Propose it; let Zain run it.
- If the plan changed while you were mid-flight, **stop and re-read it**. On
  8/3 a superseded file list was executed as agreed, which put an inconsistent
  `api.d.ts` commit permanently in master — see
  `claude/typecheck-blind-spot-api-d-ts.md`.

Why this rather than the stricter rule: the stricter rule is what caused
`convex/demoSmsMember.ts`, `convex/refreshDemoGym.ts` and both demo scripts to
run in production from 7/31 to 8/3 with no copy in git. The agent that deployed
them was not permitted to commit them. **Code reaching production without
passing through version control is the worse failure**, and Convex deploys from
the working directory, so the two cannot be separated in practice.

## 2. Never guess when you can look

This project has a documented record: **whoever went and looked was right;
whoever reasoned from a plausible model was wrong.** Real examples — a
"read-only" Twilio field that was editable, a blocker inferred from code that
the running system disproved, a handoff written without reading the newer
handoff beside it, an SMS reply returning HTTP 200 for days while delivering
nothing.

- Read the primary source: the running system, the error log, the raw file.
- When a doc and the system disagree, **the system wins** — then fix the doc.
- Say "I haven't checked that" instead of filling the gap.
- A verifier handed your *interpretation* cannot falsify it. Hand over the
  source and the question.

## 3. Dates are local, never UTC

`toISOString().slice(0, 10)` is banned for calendar dates. This deployment runs
in UTC; a Colorado gym after 6pm is already tomorrow in UTC, and that is when
gyms are full. Use `lib/localDate.ts`. Server code receives a date string as an
argument and never derives one. **This mistake has been made four times.**

## 4. SMS is compliance surface, not copy

- The sentence *"Up to 5 automated msgs/month."* must stay byte-identical across
  **five** sites — see `convex/sendRetentionTexts.ts:39-51` for the list and the
  `CONSENT_VERSION` rules. Carriers cross-check them. A sixth copy now lives in
  the Twilio console (Advanced Opt-Out HELP message on
  `MG3df4bb11fd47a0f0b562ba9605aacd9d`) and must move with them.
- Never widen `STOP_KEYWORDS` / `START_KEYWORDS`; add to the `_HANDLED` lists.
  The advertised arrays render verbatim into consent copy and are frozen at
  `CONSENT_VERSION 3`.
- The opt-out footer is appended server-side on every send path. No owner-facing
  field may be able to remove it.
- Twilio answers STOP and HELP at the carrier layer. Our webhook deliberately
  replies to neither — see `convex/twilioWebhookAction.ts`.

## 5. Deploy order: Convex before Vercel

App code frequently reads Convex fields and queries that must exist first. Ship
Convex, confirm, then push. Getting this backwards on 2026-08-02 would have
routed every paying gym into the setup wizard, because `!undefined === true`.

## 6. Money and consent

- **Never complete a Stripe checkout to test.** Creating a Checkout Session is
  free and does not redeem the founding coupon; completing one burns a founding
  slot permanently. Coupons are immutable — changing the cap means a new coupon
  then an env repoint, in that order.
- **Never sell through guest checkout.** Account first. See
  `claude/guest-checkout-dead-gym-trap.md`.
- Consent acquisition is the product's single point of failure: a gym that
  cannot collect member consent can never send a text. Three separate bugs have
  reached that dead end by different routes. Treat anything touching
  `/consent/[gymSlug]`, slugs, or roster phone matching as load-bearing.

## 7. Stripe clients: read, don't construct

`new Stripe(process.env.STRIPE_SECRET_KEY!)` throws **synchronously**. Above a
try/catch it yields a raw 500 with no alert — a silent outage. Read the key into
a variable, branch on it, construct the client afterwards.

## 8. Priorities

Revenue and customer-facing work first. Infrastructure only when it unblocks a
sale. Nothing is "done" until it is demoable on the live site. Push back on
scope creep — including your own.
