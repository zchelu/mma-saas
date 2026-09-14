# Handoff — 2026-09-11 (evening) — production config, key rotation fallout, live Connect

**Companion to** `handoff-2026-09-11.md`, which covers the sandbox dues flow going
green. This one covers what happened **after** that: production configuration, the
live Stripe platform, and the fallout from the 2026-09-09 key rotation.

**Evidence standard.** Everything in §1–§3 was read directly off the Stripe and
Convex dashboards in a browser during this session. Items marked *(reported)* came
from the owner's terminal and were not independently verified. The repo was read only
for file listings and mtimes — no code was reviewed.

---

## 1. What changed in production today

| Change | Detail |
|---|---|
| **Prod Convex deployed** | `npx convex deploy` added `stripeDuesWebhookEvents.by_event_id` and `.by_processed_at`. Prod genuinely was behind. *(reported)* |
| **Code pushed** | `365a66f..a205515`, 51 objects, `master`. Convex deployed BEFORE push — correct order. *(reported)* |
| **Prod live secret key** | Overwritten in Convex `limitless-raven-596` and Vercel Production. *(reported)* |
| **Platform profile acknowledgements** | Refunds-and-chargebacks liability, and ongoing seller compliance — both **Completed September 11, 2026**. |
| **New live webhook endpoint** | `connect-account-status-prod`, `ed_61VNzrHiy3ud2T5VS16V2GSYGrSQkpaRWcmzeH59s8Mq` |
| **`STRIPE_CONNECT_WEBHOOK_SECRET`** | Added to prod Convex, **proven working** (see §2). |

### `connect-account-status-prod` — full config

```
URL             https://limitless-raven-596.convex.site/stripe/connect-webhook
Scope           Your account          (NOT Connected accounts)
Payload style   Thin                  (NOT Snapshot)
API version     Unversioned           (normal for thin events)
Events          v2.core.account.closed
                v2.core.account.updated
                v2.core.account[configuration.merchant].capability_status_updated
```

Mirrors sandbox `connect-account-status` exactly, changing only the host. **Scope and
payload style are the two fields that fail silently in different ways if wrong** —
this is the Accounts v2 stream, and v2 account events are thin by design.

---

## 2. Verified working

Ping on the new prod endpoint:

```
v2.core.event_destination.ping     200 OK     Sep 11, 2026, 3:26:32 PM MDT
evt_65VNzvEefyEOCAfrdXB16V2GSYGrSQkpaRWcmzeH59sVS4
Response: { "received": true }
```

A 200 with `received: true` is not merely "the endpoint resolves." It means prod
Convex **verified the Stripe signature** against the newly pasted secret and the
handler accepted the event. Signing secret, routing and endpoint config are all
correct.

**Consequence:** a real gym's Connect status will now update in production. Before
today it could not — prod had no Connect webhook endpoint and no secret, so a gym
who finished Stripe verification would have seen "Setup incomplete" forever.

---

## 3. Findings that correct earlier documents

### 3.1 The rotated key — `handoff-2026-09-11.md` §3.1 is wrong on one point

That doc says the `StripePermissionError` came from "an already-rotated dead key."
It did not. The live API log shows **403 permission denied**, not **401 invalid API
key**. A dead key returns 401. `sk_live_…eOPf7T` is valid and current; a live key
simply cannot reach a test-mode connected account, which is what those six calls
were doing.

Live API keys page, read directly:

- **Exactly one** live secret key exists: `sk_live_…Pf7T`, **created Sep 8** (local
  MDT = Sep 9 UTC, i.e. our rotation), **last used Sep 11**.
- `sk_live_…UaEdUu` — the key behind the Aug 18 checkout — **no longer appears**.
  Rolled keys are removed from the list. Anywhere still holding `…EdUu` is holding a
  dead value.

The six 403s ran 2:04–2:20 PM and stopped one minute before the dev `sk_test_` swap
at 2:21:55 PM. Already fixed; dev-only.

### 3.2 Live platform onboarding was NOT complete — but the hard part already was

Stripe's **Platform setup** page on live showed all six elections already recorded and
all six **correct** (variant 7):

| Detail | Selection | Property |
|---|---|---|
| Business model | Accounts collect directly, direct charges | — |
| Negative balance liability | Stripe is responsible for losses | `losses_collector: stripe` |
| Monetization | Stripe collects processing fees directly from sellers | `fees_collector: account` |
| Dashboard | Embedded components | **`dashboard: none`** |
| Onboarding | Stripe-hosted **or embedded** | — |

The one-way door (`dashboard: none`) was already through, correctly. Only the two
acknowledgements were outstanding, and they are now done.

**Note the Onboarding row: "Stripe-hosted or embedded."** Hosted onboarding is an
approved path on the live platform config. The Account Link fix (§4.4) is in-bounds,
not a workaround.

### 3.3 `fees_collector` discrepancy — UNRESOLVED, worth ten minutes

Live platform default reads `defaults.responsibilities.fees_collector: **account**`.

But `connect-platform-profile-answers.md` asserts the equivalence
`v1 fees.payer: "account"` ≡ `v2 fees_collector: "stripe"`, and `handoff-2026-09-07.md`
states accounts are created with `fees_collector: "stripe"`.

Those do not line up. Per-account config overrides the platform default, so nothing is
broken today — but one of those two descriptions is wrong, and "who pays the processing
fee" is not a field to be guessing about when a gym asks. Read `ensureConnectedAccount`
and settle it.

### 3.4 "Onboarding incomplete" banner — unexplained

Platform profile still shows **"Onboarding incomplete"** with a **non-functional
"View onboarding" button** (reproduced twice — it redirects to `/connect`). This
persists *after* both acknowledgements completed, and Platform setup shows every
election recorded. Nothing was found that the owner still has to fill in.

Treated as Stripe-side dashboard state. See §4.6.

---

## 4. TO DO — next fresh session

Ordered. The first is a verification that may already be fine; the rest are real work.

### 4.1 Confirm the Vercel build went green

`a205515` was pushed to `master`, which **is** the production deploy. Check the Vercel
deployment for that commit.

**The trap to look for first if it failed:** a stale committed `convex/_generated/api.d.ts`.
`npx tsc --noEmit` passes locally because it reads the file `convex dev` regenerated on
disk, while Vercel builds against the committed one. Four deploys went red for six hours
on 2026-08-11 exactly this way. `npm run check:convex` is the check that catches it —
see `typecheck-blind-spot-api-d-ts.md`.

### 4.2 Reconcile the `whimsical-jubilee` split

The only pre-existing **live** webhook endpoint is:

```
whimsical-jubilee  →  https://www.kombatdesk.com/api/stripe/webhook
                      Your account · 5 events · 0% error
```

That is the **Next.js route on Vercel** (`app/api/stripe/webhook/route.ts`).

Its dev counterpart, `platform-subscriptions-dev`, points at
`polished-peacock-100.convex.site/stripe/webhook` — **Convex**.

**Dev and prod run the platform webhook through entirely different code paths.**
Whatever is tested in dev is not what production executes. This also explains why prod
Convex carries a `STRIPE_WEBHOOK_SECRET` that nothing delivers to — live platform
traffic goes to Vercel, which needs its own copy.

Decide which path is canonical and make both environments match, or — at minimum —
write the split down so the next person debugging a platform-subscription event does
not spend an afternoon reading the wrong file.

### 4.3 Ping sandbox `connect-account-status`

It sits at a **100% error rate** — 6 deliveries this week, 6 failed. `handoff-2026-09-11.md`
§5 calls it "unverified since the key fix"; it is not unverified, it is *failing*, and
nothing has been delivered since the `sk_test_` swap to prove otherwise.

One **Ping** from that endpoint's page answers it, exactly as it did for the prod
endpoint in §2. Do not report it as working until a delivery shows 200.

### 4.4 The Account Link onboarding fix — highest-value code remaining

Until this ships, **a founding gym cannot reach charges-enabled.** The embedded
onboarding component hangs for them, and unlike Zain they have no Stripe dashboard to
fall back on. Everything else that has been built is downstream of a gym getting
through that screen.

The fix is known and verified (see the corrected
`connect-onboarding-stall-2026-09-03.md`): generate an Account Link and redirect,
instead of mounting the embedded onboarding component. Partial revert of stage C, for
the onboarding step only.

### 4.5 The SMS consent bug — before any real member is texted

From `handoff-2026-09-11.md` §7.3: a member saved with **TEXTS: On** and counted under
"Can be texted" although the SMS-consent checkbox was never ticked — moments after the
same form had *rejected* a save for exactly that reason.

**Concrete lead**, from `app/members/member-modal.tsx`:

```js
const smsConsentConfirmed = trimmedPhone === "" ? false : true;
```

That derives consent purely from whether a phone is present. The checkbox never feeds
it — it only gates whether submit proceeds, via
`needsConsent = trimmedPhone !== "" && !alreadyConfirmedForThisPhone`. So once
`member.smsConsentConfirmed` is true for a phone, later saves re-stamp `true` without
ever showing the box.

This is the only defect on the board that can cost money in damages rather than churn.
TCPA. Reproduce it before shipping.

### 4.6 Open a Stripe support ticket about the banner

Has lead time you do not control, so file it early. Ask precisely:

> "Platform profile shows 'Onboarding incomplete' with a non-functional 'View
> onboarding' button, but Platform setup shows all elections recorded and both
> acknowledgements completed 2026-09-11. What remains, and **does this block creating
> live connected accounts?**"

That last clause is the only part that matters operationally.

**The empirical test, independent of Stripe's answer:** create one live connected
account. If it succeeds, live Connect works and the banner is cosmetic. That is the
real definition of "enabled" — not what the settings page says.

---

## 5. Environment reference

| Thing | Value |
|---|---|
| Repo | `C:\dev\kombatdesk\mma-saas` (git root `C:\dev\kombatdesk`, PowerShell — never `&&`) |
| Convex dev | `polished-peacock-100` · `STRIPE_SECRET_KEY` = **sk_test_** as of 2026-09-11 14:21 |
| Convex prod | `limitless-raven-596` |
| Stripe platform (live) | `acct_1TssVBQztS1N9xLG` |
| Stripe sandbox | `acct_1TssVXQwB6kCcMIg` |
| Test gym (sandbox) | `acct_1U5vUlQwB6H9L3jJ` — Enabled, KYC cleared 2026-09-11 |
| Live secret key | one only, `sk_live_…Pf7T`, created Sep 8 |

### Webhook endpoints, all environments

| Env | Name | URL | Scope | Payload |
|---|---|---|---|---|
| live | `whimsical-jubilee` | `www.kombatdesk.com/api/stripe/webhook` | Your account | — |
| live | `connect-account-status-prod` | `limitless-raven-596.convex.site/stripe/connect-webhook` | Your account | Thin |
| sandbox | `platform-subscriptions-dev` | `polished-peacock-100.convex.site/stripe/webhook` | Your account | Snapshot |
| sandbox | `connect-account-status` | `polished-peacock-100.convex.site/stripe/connect-webhook` | Your account | Thin |
| sandbox | `connect-dues-dev` | `polished-peacock-100.convex.site/stripe/dues-webhook` | **Connected accounts** | Snapshot |

**No live dues endpoint exists**, and none is needed yet — member billing cannot run in
production until live Connect is confirmed. When it is, it needs its own endpoint at
**Connected accounts** scope with **Snapshot** payload and its own
`STRIPE_CONNECT_DUES_WEBHOOK_SECRET` in prod Convex.

---

## 6. Dashboard gotchas worth not rediscovering

- **`dashboard.stripe.com/logs` redirects to the sandbox in test mode.** The browser's
  default account context is the sandbox. Checking "production" by typing the bare URL
  lands you in test mode looking at a clean log that means nothing. Always use the
  explicit `/acct_1TssVBQztS1N9xLG/...` path.
- **`/logs` also redirects to `/workbench/logs/api`.**
- **The API-requests view carries sticky filters.** It opened pre-filtered to POST and
  DELETE plus two more, hiding every 403. Click **Clear filters** before concluding
  anything from that page.
- **An empty error log is not proof of health when there is no traffic.** Prod's last
  real business call was the Aug 18 checkout session.
- **The endpoint Overview performance chart lags.** Use the **Event deliveries** tab.
- **Stripe's dashboard will not hydrate in an unfocused browser tab** — the shell
  loads, `<main>` stays empty. Not a network or auth problem.

---

## 7. Still not done, and it is not code

Zero gyms have been called. That has been true in every handoff since 2026-09-07.

What changed today is the pitch, not just the plumbing: dues collection works end to
end in sandbox, a real invoice cleared, and production can now observe a gym going
live. Live Connect remains the gate on taking a real dollar, and it has underwriting
lead time — which is exactly the argument for filling that wait with conversations
rather than more building.

Primal Fit Fusion (Jacob's father) is still the warmest lead and is still unconverted.
The demo video, cheat sheet and referral kit already exist.
