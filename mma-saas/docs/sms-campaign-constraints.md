# SMS campaign constraints — the compliance facts that gate code

**Status as of 2026-08-04. This file exists because it is the primary source for anything
that touches SMS consent or messaging, and an implementing session cannot read the
claude.ai project.**

AGENTS.md says durable context lives in the claude.ai project. That still holds for
narrative and handoff context. It does **not** hold for constraints that gate code — those
have to be readable from the repo, or an implementer either guesses or repeats a brief back
without a primary source. That happened on 2026-08-04.

---

## Campaign state

| | |
|---|---|
| Campaign | `CM16da80dcc588e7a5cb0bb68130e0ca0e` — **APPROVED** |
| Brand | `BN847fa0ca2fddf18a0ee28ee953328ea1` |
| Messaging service | `MG3df4bb11fd47a0f0b562ba9605aacd9d` |
| Sender | `+1 719 504 5926` |
| Cost to date | ~$60 across four submissions |
| Outbound | ✅ Clears error 30034. **Texts confirmed received on a real handset.** |
| Inbound | ✅ Verified end to end 2026-07-30 — signature check, `claimMessageSid` replay protection, rate limit, and a real STOP landing `smsOptedOut: true` in production |
| Advanced Opt-Out | **ENABLED** since 2026-07-30 |
| Registered opt-out keywords | cancel, quit, stop, optout, unsubscribe, stopall, revoke, end |

---

## The standing prohibition: do not edit the campaign

It took four submissions to approve. Editing the campaign record risks re-vetting — a fee,
and a window in which something that currently works might not.

**The CTA field ("How do end-users consent to receive messages?") declares exactly two
channels:** the hosted page at `https://www.kombatdesk.com/consent/[gym-slug]`, and
verbal/in-person consent taken by gym staff.

Any *new* consent surface — the `JOIN`/`ROLL` keyword, the kiosk check-in prompt, the
waiver-embedded block — collects at a URL or through a channel that field does not describe.
That is a discrepancy a reviewer can catch.

**Rules that follow:**

1. Building and demoing a new surface **on the demo gym** needs no campaign change.
2. Before the **first live gym's real members** use one, the CTA field must declare it.
3. Do that as **one batched rewrite** covering every surface then in existence, phrased
   generically ("hosted consent pages and SMS keyword opt-in operated by KombatDesk on each
   gym's behalf") rather than as an enumerated path list — so the next surface needs no
   further edit.
4. Ask Manish on ticket #28460668 for a **free pre-review first**. He pre-reviewed the
   verbal script at no cost and it went through.
5. **Hard limit: the CTA field is at 2,039 of 2,048 characters.** Nine characters of
   headroom. Nothing can be appended — the whole field gets recompressed, which is what
   consumed 2026-07-31.

---

## New outbound message types are a campaign change

A confirmation auto-reply on keyword opt-in is a message type the campaign does not declare.

This is not hypothetical caution. Twilio's own template for the 7/30 Message Flow draft
contained *"You'll receive a quick confirmation text shortly"* and it was **deliberately
cut**, because the product did not send one — *declaring a message flow you don't operate is
a false statement to the carrier.* Sending one that was never declared is the same problem
inverted.

It also interacts with the frequency ceiling below.

**Therefore:** build a confirmation reply behind a flag, exercise it on the demo gym only,
and do not enable it for a real gym until the batched CTA rewrite lands.

Note the delivery mechanism does not change this. A TwiML `<Message>` in the webhook
response (`convex/http.ts`) is still a message the member receives and still sets an
expectation against the declared frequency. It is not "not a send" in any sense a carrier
cares about.

---

## The five byte-identical sites

**"Up to 5 automated msgs/month."** must be byte-identical across all five, because carriers
cross-check the opt-in disclosure against the HELP reply and both linked legal documents:

1. `lib/consentText.ts`
2. `convex/twilioWebhookAction.ts` (the `HELP_REPLY_MIRRORS_TWILIO_CONSOLE` constant)
3. `content/terms.html` §23 Program Description
4. `content/terms.html` §23 Message Frequency
5. `content/privacy-policy.html` §9 Frequency

A **sixth** copy now lives in the Twilio console (Advanced Opt-Out HELP message on
`MG3df4bb11fd47a0f0b562ba9605aacd9d`) and must move with them. The console is a separate
surface from the repo — auditing the five files proves nothing about what a reviewer sees.

The number is 5, not 4: a check-in clears `winbackAttempts` **and** `lastRetentionTextAt`
(`members.ts:checkIn`), rearming a member within the same month. The real bound is the 7-day
per-member spacing in `sendRetentionTexts.ts`, which allows `floor(30/7)+1 = 5` sends in a
30- or 31-day month.

---

## Keyword rules

- **Never widen `STOP_KEYWORDS` / `START_KEYWORDS`** in `lib/smsKeywords.ts`. They render
  verbatim into the consent checkbox, are frozen at `CONSENT_VERSION 3`, and that text is
  now quoted inside the approved CTA field. Add to the `*_KEYWORDS_HANDLED` lists instead.
- **A new opt-in keyword must not reuse `START` or `YES`.** Those clear `smsOptedOut` and
  deliberately do **not** grant consent. The separation is load-bearing and documented in
  three places.
- **Check the Twilio console before locking any new keyword.** Advanced Opt-Out can
  intercept configured keywords at the carrier layer, in which case the webhook never sees
  the message. Messaging Service → Opt-Out Management is the authority, not the code.
- Keyword shape: 4–12 characters, no symbols, autocorrect-tested on a real handset.

---

## Consent evidence rules — apply to every capture surface

From `convex/consent.ts:submitConsent`, which passed carrier review:

- Snapshot the **verbatim text displayed**, plus a version. The record proves what a specific
  person saw. Never snapshot text that was not actually shown.
- Derive `ip` / `userAgent` **server-side**. Never accept them as client args.
- Resolve the gym **server-side**. Never accept a client-supplied `gymId`.
- Match members by `normalizePhoneDigits`. **Never create a member.** No match means an
  evidence row with `memberId` unset.
- **Never touch `smsOptedOut`.** A web form or a keyword does not undo a STOP; only an
  inbound registered START keyword does. Both gates pass independently.
- Idempotent per gym + phone + version. Same person, same wording, twice is not two TCPA
  events. Different wording **is**.
- Return an identical response whether or not a member matched — no roster oracle.

`consentSubmissions` is **append-only**. There is no delete path anywhere in the consent
system, deliberately. A wrong row cannot be taken back, which is why a preview deployment
must never point at production Convex.

---

## Forced consent — the pattern that cost two rejections

A submit control that is inert until the consent box is ticked is classified by carriers as
forced consent and fails review on its own. The actual cause on 2026-07-28 was a `required`
attribute on the checkbox, not a `disabled` button — **both fail.**

Required on every consent surface: the box is unchecked by default, the submit control is
live at all times, and an unchecked submit is accepted without enrolling anyone.

Gating a *physical* action on consent — check-in at the kiosk, signing a waiver, booking a
class — is the same offence in a larger form. Never do it.

---

## Known open items

- **Registered Help Message mismatch.** The campaign registers Twilio's default
  (`"Reply STOP to unsubscribe. Msg&Data Rates May Apply."`), which carries no frequency
  disclosure, while the messaging service returns the KombatDesk version that does. What
  sends is better than what is registered, so it errs safe. Fold into the batched CTA edit —
  do not touch the campaign for this alone.
- **Sender-of-record is not legally reviewed.** `lib/consentText.ts` carries the note.
  Carrier approval is not legal approval, and the CTA field now puts a position on that
  question in writing on a compliance record.
