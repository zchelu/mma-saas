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
- On a shared working tree, `git add <file>` followed by a bare `git commit`
  **IS** `git add -A` — the commit takes the whole index, including anything
  another session staged. Always commit with an explicit pathspec
  (`git commit --only <path>`). Verified the hard way on 2026-08-04, when a
  doc commit captured two files mid-refactor and produced a commit that could
  not build from a fresh clone.
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
- **A check that cannot fail is guessing with extra steps.** If a check's
  all-clear output can print when the thing it looks for is present, it is not
  a check — it is a ritual. Three instances in one session, which is why this
  is written down broadly rather than as a testing rule:
  - a fixture list filtered through the code under test (`.filter(isValid…)`)
    silently drops every wrong fixture and reports green — pin literals; see
    `KNOWN_GOOD` in `convex/smsCode.test.ts`;
  - a suite that passes first try has not yet been shown to fail — break the
    thing on purpose, confirm the *right* tests go red, revert;
  - `grep … ; echo "(none = clean)"` prints the all-clear unconditionally,
    including on the run where grep found three matches.
  The fix is always the same: make the failure path produce different output
  from the success path, then read the output rather than the summary.
- **A check chained ahead of the action it guards is not a gate.** `git status
  && git commit` prints the answer and commits anyway — the output arrives
  where nothing can act on it. Run the check as its own command, read it, then
  act. This is how the `git add -A` mechanism in §1 got past a verification
  step that was looking straight at it.

## 3. Dates are local, never UTC

`toISOString().slice(0, 10)` is banned for calendar dates. This deployment runs
in UTC; a Colorado gym after 6pm is already tomorrow in UTC, and that is when
gyms are full. Use `lib/localDate.ts`. Server code receives a date string as an
argument and never derives one. **This mistake has been made four times.**

## 4. SMS is compliance surface, not copy

- The sentence *"Up to 5 automated msgs/month."* must stay byte-identical across
  **every site listed in `convex/sendRetentionTexts.ts:getAtRiskMembers`**, which includes
  the Twilio console copy. Carriers cross-check them. No count here on purpose —
  that list is the count, and a number in prose rots the moment a site is added.
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

`npx convex codegen` is **not filesystem-only, and it is also not a deploy.**
Both halves have been guessed wrong in this repo, in both directions:

- It contacts the configured deployment. Its output reads `Downloading current
  deployment state… Uploading functions to Convex…`, so check
  `CONVEX_DEPLOYMENT` before running it — it is not a local no-op.
- That upload does **not** make new functions callable. Verified 2026-08-03: a
  freshly written `internalMutation` was still missing after codegen, and
  `npx convex run` answered `Could not find function … Did you forget to run
  npx convex dev?`. The "Uploading functions" line means type analysis, not
  deployment.

To actually push to dev, use `npx convex dev --once`. Prod stays with
`npx convex deploy`, which is interactive — propose it, don't run it.

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

## 8. Preview and production are separate stacks

Since 2026-08-04, Vercel **Preview** points at Convex dev
(`polished-peacock-100`) and the Clerk **Development** instance. Vercel
**Production** points at Convex prod (`limitless-raven-596`) and Clerk
Production. They pair one-to-one, and values never cross the pair boundary.

| Scope | Convex | Clerk | Stripe | Twilio | Resend |
|---|---|---|---|---|---|
| Production | `limitless-raven-596` | Production | live | live | live |
| Preview | `polished-peacock-100` | Development | none | none | none |

- **Never add a Stripe, Twilio or Resend credential to Vercel Preview or to the
  dev Convex deployment.** A preview that can charge burns a founding slot
  permanently; one that can text sends from an unregistered number; one that can
  email pages a real inbox from a branch. Their *absence* is the control, and
  each degrades to a documented no-op rather than an error.
- **`consentSubmissions` is why this matters most.** It is the TCPA evidence
  table — append-only by design, with no delete path anywhere in the consent
  system. A branch pointed at prod Convex can write a fabricated consent row
  into real evidence, and there is no way to take it back. Never repoint a
  preview at prod "just to test something".
- `NEXT_PUBLIC_*` is read at **build** time, so omitting one fails the preview
  build outright instead of failing safe. Those two get real Preview values;
  server-side secrets are safely absent instead.
- Your production login will **not** work on a preview — dev Clerk has no users.
  That is the boundary working, not a bug.
- Runbook: `claude/preview-prod-separation-runbook.md`.

## 9. Priorities

Revenue and customer-facing work first. Infrastructure only when it unblocks a
sale. Nothing is "done" until it is demoable on the live site. Push back on
scope creep — including your own.
