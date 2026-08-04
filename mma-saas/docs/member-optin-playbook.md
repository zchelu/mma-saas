# Member Opt-In Playbook — how to actually get gym members to consent

**Written 2026-08-03.** Campaign `CM16da80…` approved 8/3, so every path below now produces
a real text. Companion to `docs/design-waiver-consent.md`.

---

## The one thing every high-performing SMS program has in common

Retail, restaurants, airlines, banks — they all converge on the same rule, and none of them
frame it as a compliance rule:

> **Ask at a moment the customer already has their phone in their hand and already feels
> good about you.**

That's why the ask lives at checkout, on the thank-you page, on the receipt, on the table
tent. Not in an email. Not on a form someone has to go find.

KombatDesk currently violates this on its only live path. `/consent/[gymSlug]` is a link the
owner has to remember to send, that arrives at a random moment, and that asks the member to
type their name and phone number on a phone keyboard — then silently fails if the number
they typed doesn't match the roster. It is the highest-friction, lowest-emotion, most
failure-prone ask in the system, and right now it is the *only* one.

Everything below is about moving the ask to moments the gym already owns.

Context worth holding: **89% of US consumers had signed up for texts from at least one
business in 2026, up from 66% in 2021.** Willingness is not the constraint. Friction and
timing are. What motivates sign-up: discounts 56%, delivery/order updates 50%, **appointment
reminders 42%** — that last one is the closest analogue to what KombatDesk actually sends,
and it means the honest pitch works without a bribe.

---

## The list, in build order

Ranked by opt-in gained per hour of build. Effort is rough dev time.

### 🥇 1. Kiosk prompt after check-in — *the ceiling-raiser*
**Effort: S–M · Impact: highest · Status: designed, not built**

Covered in `design-waiver-consent.md` §11. Short version of why it beats everything else:

- **The kiosk already knows who they are.** They tapped their name or scanned a card, so
  `memberId` is in hand. Consent lands 100% matched — the entire consent-gap problem class
  (`listPendingConsent`, `applyPendingConsent`, the red dashboard panel) never arises.
- **It reaches exactly the addressable set.** At-risk detection needs attendance history, so
  a member who never checks in can't trigger a winback no matter how consented they are.
  Kiosk coverage isn't a subset of the roster — it's the whole servable population.
- **It retries for free.** A link blast is one shot that decays inside a week. The kiosk asks
  again Thursday.

Rules, both learned expensively: fires **after** the check-in commits (gating entry on
consent is forced consent in a worse form than the one that cost two rejections — and it
damages the attendance data that *is* the product); and it's an **in-kiosk component using
the known `memberId`**, never a redirect to `/consent/[gymSlug]` (a redirect re-asks for a
phone the kiosk already has, reintroduces the match gap, and parks one member's PII on a
shared tablet for the next person in line). Ask at most once per 7 days, cap at 3, then stop
forever. A prompt on every visit becomes nagware and the owner will ask you to kill it —
which costs you the channel entirely.

### 🥈 2. Text-to-join keyword + QR — *the evidence upgrade*
**Effort: S · Impact: high · Status: not designed**

Signage on the door, the mat wall, and the front desk: **"Text MAT to (719) 504-5926."**
Plus a QR code that opens the pre-filled message.

Three reasons this is the most underrated item on the list:

1. **It fixes the documented weakness in the whole consent system.** `convex/consent.ts`
   says it out loud: *"nothing here proves the submitter owns the phone number they typed,
   only that someone submitted this exact name+phone for this gym."* A member texting from
   their own handset proves ownership definitionally. Twilio's `From` is E.164 and verified.
   No typos, no mismatches, no gap panel.
2. **It extends a code path that already works.** Inbound is wired and verified end to end
   (7/30): `twilioWebhookAction.ts` already does keyword matching, `claimMessageSid` already
   gives replay protection, `setSmsOptOutByPhone` already matches members on normalized
   digits from `From`. A `JOIN` keyword is a sibling of code that is already in production.
3. **It's the only path that needs nothing from the gym owner.** Every other channel depends
   on the owner sending a link, running the kiosk, or remembering to ask. Signage works at
   6am when nobody's at the desk.

Do **not** reuse `START`/`YES` for this. Those clear a prior `smsOptedOut` and deliberately
do *not* grant consent — that separation is load-bearing and documented in three places.
`JOIN` is a new keyword that sets `smsConsentConfirmed` + a new `smsConsentSource`, and
writes a `consentSubmissions` row carrying the inbound `MessageSid` as evidence.

Keyword choice: 4–12 characters, no symbols, autocorrect-tested on real handsets. `MAT`,
`ROLL` or `TRAIN` beat `JOIN` for a BJJ gym — memorable and on-brand. Per-gym keywords don't
scale on one shared number; use one global keyword and resolve the gym from the member's
number, falling back to a reply that asks which gym.

### 🥉 3. Two-tap links everywhere you currently send the consent URL
**Effort: XS · Impact: high · Status: not built — cheapest win on this list**

This is the retail standard and it is roughly a day of work.

Instead of sending `kombatdesk.com/consent/demo` and making someone type their details,
send an `sms:` deep link:

```
sms:+17195045926?&body=MAT
```

One tap opens their Messages app with the text pre-filled. Second tap sends. **Zero typing,
zero typos, zero phone-match gap** — and it inherits all the evidence strength of #2 because
it *is* #2, just triggered from a link instead of signage.

Where it goes: a big "Just text us instead" button at the top of `/consent/[gymSlug]`
(keep the form beneath it for desktop and for anyone who prefers it), the QR poster, the
owner's copy-paste outreach text in `OwnerLinks`, and the welcome email.

### 4. Waiver-embedded consent — *day-one coverage*
**Effort: L · Impact: high but delayed · Status: designed, `docs/design-waiver-consent.md`*

Gets you ~100% of *new* members and 0% of existing ones on day one. For a gym that just
migrated 180 people, that's a month-six asset, not a launch asset. Build it after #1–#3.

Worth knowing: the industry guidance is explicit that **a phone number on a paper waiver
with no messaging language is not consent.** That's precisely the gap this closes, and it's
a clean line in a sales conversation.

### 5. Make the staff ask a ritual, not a hope
**Effort: XS (it's an ops asset, not code) · Impact: medium-high**

The verbal channel is already declared to the carrier and the script is already approved by
Twilio's reviewer. It converts better than any screen because a human is asking. The only
failure mode is that nobody does it.

Fix it with two things, neither of which is software: a **printed script card** for the front
desk (the approved wording from `claude/a2p-verbal-script-resubmission.md`, verbatim), and a
line in the onboarding wizard telling the owner this is step one of getting value. Ship the
card as a PDF in the welcome email.

### 6. Move the ask to the high-emotion moments
**Effort: S–M · Impact: medium · Status: not designed**

Post-check-in is good. These are better, because SMS opt-in tracks how the person feels
about you at the instant you ask:

- **After a belt promotion.** The single highest-emotion moment in BJJ. The `ranks` table
  already exists. *"Text ROLL to get your promotion photo"* is a real hook, not a pretext.
- **After the first class.** Highest goodwill, lowest habit — exactly the member most likely
  to quietly vanish, which is the member this product exists to save.
- **On the thank-you screen after joining**, not in a follow-up email nobody opens.

### 7. Rewrite the ask so it sells the member something
**Effort: XS · Impact: medium · Status: copy only**

`/consent/[gymSlug]` currently leads with **"Opt in to text updates."** Nobody has ever
wanted an update. The page states the mechanism and sells nothing.

The product's value to the *gym* is retention. Its value to the *member* is **accountability**
— the thing people join a gym for and then fail at alone. That is a real benefit and it's
worth naming:

> **Don't let your training slip.**
> If you go quiet for a couple of weeks, we'll send you a nudge. That's it — no spam, no
> sales pitch. Most people who quit didn't decide to quit; they just stopped showing up and
> nobody noticed.

Then the legal checkbox beneath, unchanged and byte-identical.

⚠️ **The `getConsentText()` string itself must not be touched.** It's frozen onto every
evidence row, byte-identical across every site listed in
`convex/sendRetentionTexts.ts`'s `getAtRiskMembers`, and now quoted inside an **approved** CTA
field. Edit the surrounding page copy only. Anything inside the checkbox label forces a
`CONSENT_VERSION` bump and desyncs the campaign record.

### 8. Instrument it, or none of the above is measurable
**Effort: S · Impact: compounding**

`getConsentStats` returns total / matched / unmatched submissions. There is **no
denominator** — no percentage, no per-channel breakdown. `members.smsConsentSource` exists
precisely so this is answerable and nothing reads it.

Build one number on the dashboard:

> **Opt-in coverage: 62% of active members** — 41 kiosk · 12 text-in · 8 waiver · 5 staff

You can't improve what you don't measure. And this is also the number that renews the
subscription in month two: *"your coverage went from 0 to 62%, and here's what it saved."*

### 9. Double opt-in confirmation — *do it, but not casually*
**Effort: S · Impact: evidence quality, not volume · ⚠️ campaign change**

Every source calls this best practice, and for text-to-join it's near-standard: they text
`MAT`, you reply with the full disclosure and *"Reply YES to confirm"*, they reply `YES`.
That pair is close to unimpeachable evidence.

Two real costs before you commit:

- It's a **new outbound message type** the campaign doesn't declare. This exact line was
  deliberately cut from the 7/30 Message Flow draft — *"you don't send one; declaring a
  confirmation message you never send is a false statement to the carrier."* Sending one now
  is the mirror image of that problem.
- It interacts with **"Up to 5 automated msgs/month"**, which is byte-identical across five
  sites and inside the approved CTA. A confirmation message has to fit inside that ceiling
  or the ceiling changes — and changing it means a `CONSENT_VERSION` bump plus all five
  sites plus the campaign.

Batch it into the single campaign edit below. Don't ship it standalone.

---

## The compliance gate — one edit, not five

Items #2, #3, #4 and #9 all collect or send in ways the approved CTA field doesn't describe.
**Do not make four separate campaign edits.** The campaign took four submissions and ~$60 to
approve; editing it risks re-vetting.

The sequence:

1. Build #1 (kiosk) and #2/#3 (text-to-join + two-tap). Demo them on the demo gym — that
   needs no campaign change.
2. Before the **first live gym's real members** use any of them, ask Manish on ticket
   #28460668 for a pre-review. He did the verbal script for free and it went through. On an
   approved campaign a free pre-review is the cheapest insurance available.
3. Then **one** CTA rewrite declaring every surface at once, phrased generically — *"hosted
   consent pages and SMS keyword opt-in operated by KombatDesk on each gym's behalf"* —
   rather than an enumerated path list, so the next surface needs no further edit.
4. Hard constraint: the CTA field is at **2,039 of 2,048 characters**. Nine characters of
   headroom. Nothing can be appended; the whole field gets recompressed. The generic phrasing
   is the only version that fits.

---

## What not to do

- **Don't gate anything on consent.** Not check-in, not the waiver signature, not class
  booking, not the incentive. Twilio rejected this product once for a `required` attribute on
  a checkbox. A physical or functional gate is the same offence, larger.
- **Don't over-incentivize.** Discounts are the #1 stated motivator (56%), and a free class
  or a gear-draw entry is fine — consent isn't a condition of purchase, and the disclosure
  already says so. But incentivized opt-ins carry higher STOP and complaint rates, and every
  gym on the platform currently shares **one 10DLC number**. A complaint spike at one gym is
  a risk to the asset every other gym depends on. Prefer a free class over cash, and never
  frame the incentive as something they lose by declining.
- **Don't assume an imported roster consented.** `adminImportBatch` deliberately never sets
  `smsConsentConfirmed`, and that is correct. A phone number in a CSV is not consent — the
  industry guidance names "lists from booking systems where members never agreed" as
  explicitly invalid.
- **Don't touch `STOP_KEYWORDS` / `START_KEYWORDS`** to make room for `JOIN`. They render
  verbatim into the consent checkbox. Add to `*_KEYWORDS_HANDLED` instead.
- **Don't send the consent link and call it done.** It's one shot with no retry and a silent
  failure mode. It should become the *fallback*, not the primary.

---

## Recommended order

| # | Item | Effort | Gate |
|---|---|---|---|
| 1 | Two-tap `sms:` links on the existing consent page + owner links | XS | none |
| 2 | Copy rewrite of `/consent/[gymSlug]` (outside the checkbox) | XS | none |
| 3 | Front-desk script card (PDF, welcome email) | XS | none |
| 4 | Kiosk post-check-in prompt | S–M | none to demo |
| 5 | `JOIN` keyword + QR signage | S | ⬇ |
| 6 | Coverage % + per-source breakdown on dashboard | S | none |
| 7 | **One CTA rewrite, after a free pre-review from Manish** | — | unlocks 5, 8, 9 |
| 8 | Waiver-embedded consent | L | ⬆ |
| 9 | Double opt-in confirmation | S | ⬆ |

Items 1–3 are under a day combined, need no campaign change, and address the single
highest-friction path in the product. Start there.

**And the standing caveat from every other doc in this project still applies:** none of this
produces a customer. There are zero gyms on the platform. Opt-in coverage is a problem you
have *after* someone signs — the referral list is still the work, and this playbook is what
you run on day one of gym #1, not instead of finding them.
