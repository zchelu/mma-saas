# Design — Waiver-Embedded SMS Consent (E-Signature)

**Status:** design only, awaiting Zain's approval. No implementation code exists and none
should be written from this document until it is approved.
**Written:** 2026-08-03
**Lane:** new `app/waiver/*`, new `convex/waivers.ts`, new `lib/waiverText.ts`, additive
edits to `convex/schema.ts` and `convex/rateLimit.ts`, one copy edit in
`app/dashboard/owner-links.tsx`.

---

## 0. Corrections to the handoff — read this first

The handoff that commissioned this design was written 2026-07-28 and five of its factual
claims no longer match the repo or the compliance record. Each one changes a design
decision.

| Handoff says | Disk / record says | Consequence |
|---|---|---|
| `CONSENT_VERSION` is `"2"` | `lib/consentText.ts:58` → `"3"` (v3 added the "Up to 5 automated msgs/month" ceiling) | The consent island must render `getConsentText()` at v3. Any hardcoded v2 wording would create a sixth site contradicting the five that must stay byte-identical. |
| Read `docs/handoff-member-archival.md` | **File does not exist.** `docs/` holds only `belt-tracking-system.md`, `handoff-ipad-demo-prep.md`, `handoff-onboarding-auth-first.md`, `handoff.md` | The archival contract lives in the comment block above `members.ts:archiveMember` (lines 173–206) and in `convex/archiveMember.test.ts`. Both were read; the "do not break" rules are honoured in §4 below. |
| `smsConsentSource` union needs one additive change | **Two** union changes are needed. `consentSubmissions.source` is `v.literal("member_self_serve")` (schema.ts:206) — a literal, not a union. It must be *widened* to a union. | Two schema edits, and the widening is the one that will surprise a reviewer skimming the diff. |
| — | The campaign's declared Message Flow (CTA field) names exactly **two** channels: the hosted page at `/consent/[gym-slug]`, and verbal/in-person | `/waiver/[gym-slug]` is a third URL collecting consent. See §9 open question 1 — the answer changed once the campaign was approved, and not in the direction you'd expect. |
| — | The CTA field is **2,039 characters against a 2,048 limit** after the 7/31 rewrite | Nine characters of headroom. Declaring the waiver channel cannot be an append — the whole field has to be recompressed, exactly as it was on 7/31. Budget that as real work, not a copy-paste. |

**A2P campaign status — the one claim that was false on 7/28 and is now true.**
Campaign `CM16da80dcc588e7a5cb0bb68130e0ca0e` is **approved** as of 2026-08-03, after four
submissions and roughly $60. Outbound sends leave without error 30034, and **texts have been
confirmed received on a real handset** — the full chain is proven end to end, in both
directions. Nothing about SMS delivery is assumed any more.

One more, load-bearing: **the checkbox pattern in `app/consent/[gymSlug]/ConsentForm.tsx`
must not be copied into this feature.** That component intercepts an unchecked submit and
stops it dead, on both the JS and no-JS paths, because on that page an unchecked box means
"do not enrol me" and there is nothing else to do. Here an unchecked box means "sign my
waiver, don't text me" — the submit must go all the way through. The interceptor is the
single most dangerous piece of prior art in this lane.

---

## 1. What this feature is

A public, unauthenticated, per-gym page at `/waiver/[gymSlug]` where a new member signs
the gym's liability waiver on their own phone, with an **optional** SMS-consent block
embedded in the same screen. Signing produces one row of waiver evidence; ticking the
optional box additionally produces one row of consent evidence in the existing
`consentSubmissions` table, indistinguishable in shape from a `/consent` submission except
for its `source`.

Third of three capture paths, all sharing one evidence model:

| Path | Status | Serves |
|---|---|---|
| `/consent/[gymSlug]` | Live, Twilio-reviewed 2026-07-29 | Remote members, link/QR outreach |
| Kiosk prompt at check-in | Designed, not built | Backfilling imported rosters |
| `/waiver/[gymSlug]` | **This design** | New members, day-one paperwork |

The sales argument, stated plainly because it is the reason to build it: Mindbody's Terms
§3.7 makes the gym owner represent and warrant they hold consent evidence they do not
actually possess. This collects it for them, per member, timestamped, IP-stamped, and
wording-snapshotted.

---

## 2. Schema

Two new tables, two widened validators. All additive; no existing row becomes invalid.

### 2.1 `waiverVersions`

```ts
waiverVersions: defineTable({
  gymId: v.id("gyms"),
  // Monotonic per gym, 1-based. Displayed to the member ("Waiver v3").
  version: v.number(),
  // The gym's own waiver text, verbatim, plain text. Never mutated after insert.
  bodyText: v.string(),
  // SHA-256 hex of bodyText. Denormalised onto every signature row so a signature
  // can prove what it signed without trusting this row to be unchanged.
  contentHash: v.string(),
  publishedAt: v.number(),
  publishedByClerkUserId: v.string(),
})
  .index("by_gym", ["gymId"])
  .index("by_gym_version", ["gymId", "version"]),
```

Deliberately **not** on this table: `consentVersion`. Coupling a gym's waiver version to
`CONSENT_VERSION` would force a new waiver version for every gym on every consent-wording
bump — three bumps have already happened in twelve days. The consent version belongs on
the per-signature and per-submission rows, where it already lives.

### 2.2 `waiverSignatures`

```ts
waiverSignatures: defineTable({
  gymId: v.id("gyms"),
  // Nullable, matched by normalized phone at signing time, exactly like
  // consentSubmissions.memberId. Never creates a member. Backfilled later by
  // waivers.applyPendingWaiverMatches — see §6.
  memberId: v.optional(v.id("members")),

  waiverVersionId: v.id("waiverVersions"),
  waiverVersion: v.number(),      // denormalised, so a list view needs no join
  waiverContentHash: v.string(),  // denormalised, tamper-evidence — see §3

  // Identity as typed by the signer. submittedName is the form field;
  // signedName is what they typed into the signature box. Stored separately
  // and never normalised against each other — a mismatch is evidence too.
  submittedName: v.string(),
  submittedEmail: v.optional(v.string()),
  submittedPhone: v.string(),
  normalizedPhone: v.string(),
  signedName: v.string(),

  // Verbatim intent-to-sign sentence displayed above the affirmation checkbox,
  // plus its version. Same reasoning as consentSubmissions.consentText: the
  // record must prove what this specific person saw.
  affirmationText: v.string(),
  affirmationVersion: v.string(),

  signedAt: v.number(),

  // Whether the optional SMS box was ticked at signing. Kept even when false —
  // "this person signed and declined texts" is an affirmative record worth
  // holding, and it is what makes the unchecked path auditable.
  smsConsentGiven: v.boolean(),
  consentSubmissionId: v.optional(v.id("consentSubmissions")),

  ip: v.optional(v.string()),
  userAgent: v.optional(v.string()),
})
  .index("by_gym", ["gymId"])
  .index("by_gym_phone", ["gymId", "normalizedPhone"])
  .index("by_member", ["memberId"]),
```

### 2.3 Widened validators

```ts
// members.smsConsentSource — add one literal
smsConsentSource: v.optional(
  v.union(
    v.literal("member_self_serve"),
    v.literal("owner_attestation"),
    v.literal("member_modal"),
    v.literal("waiver")            // NEW
  )
),

// consentSubmissions.source — literal widened to a union
source: v.union(
  v.literal("member_self_serve"),
  v.literal("waiver")              // NEW
),
```

Write the second one as a union even though it holds two members today: the kiosk path is
the next literal, and a union that already exists is a one-line change while a literal is
a schema migration argument every time.

Both are safe widenings — every existing row still validates. Both require a deliberate
`npx convex deploy` from disk before the frontend ships (repo rule: `build` is bare
`next build`; pushing to master deploys the frontend only).

---

## 3. Hash + version table, not per-signature snapshot — and why

**Decision: store the waiver body once per version, and a SHA-256 content hash on every
signature.** The consent island text keeps its existing per-row verbatim snapshot on
`consentSubmissions.consentText`, unchanged.

Two different strategies in one feature, each fitted to its evidence:

**Why the waiver body is hashed, not snapshotted.** A gym waiver is 1–4 KB of legal prose
and it is *per gym* — unlike `CONSENT_TEXT`, it cannot be reconstructed from a shared
constant. A 180-member gym signing once each stores ~180 copies of the same kilobytes.
That is affordable as storage and expensive as bandwidth: every owner-side list query in
this codebase is a `.collect()` over an index (see `consent.ts:getConsentStats`,
`members.ts:getUnconfirmedImportedMembers`), so a signature-list view would pull the full
waiver body once per row on every render. The hash costs 64 bytes.

**Why that does not weaken the evidence.** The version row is append-only — no mutation
patches `bodyText`, and editing publishes a new version rather than mutating the current
one (§5.1). The per-signature hash is the second leg: if a `waiverVersions` row were ever
altered by hand in the Convex dashboard, every signature pointing at it would stop
matching and the tamper would be *detectable*. A per-row snapshot gives you no such
property — a snapshot proves nothing about tampering with the snapshot. Hash-plus-immutable-
version is the standard construction here; per-row copies are the weaker one dressed as the
stronger.

**Cost accepted, explicitly.** A snapshot survives the accidental deletion of its source
row and a hash does not. Mitigation is the same rule the members table already lives under:
**no delete path on `waiverVersions` in v1**, and none should be added without resolving
this first. Same paragraph, same reasoning, as `members.ts:archiveMember`'s "do not
reintroduce a delete path here."

**Why consent text stays snapshotted.** It is ~450 bytes, shared across all gyms, and it is
the string a carrier will ask about. It already works, it already passed review, and
changing its storage in this lane would be scope creep touching a compliance-critical table.

---

## 4. The signing page

Route `app/waiver/[gymSlug]/` — `page.tsx` (Server Component), `WaiverForm.tsx` (Client
Component), `actions.ts` (Server Action), `not-found.tsx`. Same shape as
`app/consent/[gymSlug]/`.

### 4.1 Layout, top to bottom

Single mobile-width column, `max-w-md`, matching the consent page's existing dark
treatment.

1. Gym name header, `Sign your waiver` eyebrow in `#E02020`
2. Status banner slot (invalid / rate-limited / stale / error)
3. Identity fields — full name, email, phone. All `required`.
4. Scrollable waiver panel, fixed max height, with a version stamp beneath it:
   `Waiver v{n} · updated {Month Year}`
5. **The consent island** — see §4.2
6. Typed-signature field, italic serif, label `Type your full name to sign`
7. Intent affirmation checkbox — `required`
8. `Sign waiver` button. Never `Sign and subscribe`, never `Sign and opt in`.
9. Footer: the existing `ConsentDisclosure` block, plus one added line —
   `KombatDesk is the software {gymName} uses to manage its membership. KombatDesk is not
   a party to this waiver.`

The ordering matters and is not cosmetic. The **required** affirmation checkbox (7) and the
**optional** consent checkbox (5) are separated by the signature field (6). A compliance
reviewer screenshotting this page must never see the two checkboxes adjacent — that
adjacency is what reads as "you must tick both to sign."

### 4.2 The consent island

Visually distinct: tinted background (`#1A1A1A`), accent left border, its own padding, set
apart from the surrounding form.

- **Header label:** `Optional — text message updates`
- **Checkbox label:** exactly `getConsentText(gym.name)` from `lib/consentText.ts`,
  unedited, imported not retyped. This is the whole point of the island — the wording a
  waiver signer agrees to is byte-identical to the wording a `/consent` submitter agrees to,
  so one `consentSubmissions` schema serves both and one `CONSENT_VERSION` describes both.
- **Exit line, beneath the checkbox, plain words, never small print:**
  `You can sign the waiver without checking this box. Checking it is not required to train
  here, to sign this waiver, or to buy anything.`

The visual separation *is* the compliance argument. A reviewer looking at one screenshot
should be able to see, without reading, that consent is not entangled with the signature.

### 4.3 The unchecked-consent path — the constraint that shapes everything

Twilio rejected this product on 2026-07-28 for forced consent. The actual cause was a
`required` attribute on the checkbox, not a `disabled` button — both fail, and the fix
landed on 7/29 with full clearance. That must not be reintroduced here in a new form.

Concretely, on the consent checkbox in `WaiverForm.tsx`:

- No `required` attribute.
- Unchecked by default. No `defaultChecked`, no server-supplied initial state.
- The `Sign waiver` button is live at all times.
- **No client-side interceptor.** `ConsentForm.tsx`'s `handleSubmit` guard exists to stop
  an unchecked submit; here an unchecked submit is a *correct, complete* submit. Copying
  that handler would silently break the feature's central requirement.
- The only gate is server-side and it gates one thing: whether a `consentSubmissions` row
  is written. The `waiverSignatures` row is written either way.

`WaiverForm.tsx` is therefore a Client Component only for signature-field UX (mirroring the
typed name into the italic preview, enabling nothing). If that turns out not to be needed,
it should be a Server Component with a plain `<form action={...}>` — fewer moving parts on
a page whose correctness is legal.

The `action` prop stays bound unconditionally so the no-JS path posts to a real target.
Without it React emits a `<form>` with no action, and a no-JS submit GETs the current URL
with the member's name and phone in the query string. That exact bug is documented in
`ConsentForm.tsx` and must not be re-earned.

### 4.4 Success states — two of them, both honest

`?status=ok&sms=1` → "Waiver signed. {gym} can now text you about your membership."
`?status=ok&sms=0` → "Waiver signed. **You have not been signed up for text messages.**"

Two distinct success screens, not one generic thank-you. The second is what makes the
unchecked path visibly complete rather than ambiguous, and it is the screenshot that
answers a reviewer asking "what happens if they don't tick?"

Note this is a deliberate, narrow departure from `submitConsent`'s no-oracle rule. It
reveals what the submitter themselves just chose — not whether they matched a member.
Member-match status stays invisible on both branches.

Other statuses: `invalid`, `rate_limited`, `stale_version`
("This waiver was updated while you had it open. Please read it again and re-sign."),
`error`.

### 4.5 What `archiveMember` must not do

Signed waivers are permanent. `archiveMember` patches exactly two fields today
(`archived`, `archivedAt`) and must continue to touch nothing else — no cascade into
`waiverSignatures`, no delete path in v1. Owner-side lists show an archived member's
signature with an "archived" marker rather than hiding it, for the same reason
`setSmsOptOutByPhone` deliberately does not filter archived rows: the evidence outlives the
roster entry. Add a case to `convex/archiveMember.test.ts` asserting a signature row
survives archival untouched.

---

## 5. Functions, with auth models

All new code in `convex/waivers.ts`.

### 5.1 Owner-side (authenticated)

**`publishWaiverVersion({ bodyText })`** — mutation.
`requireGym` + `requireWriteAccess` (a lapsed gym can read its waiver, not republish it —
same posture as every other write in this codebase). `assertMaxLength(bodyText, 20000)`.
Computes SHA-256; **if the hash equals the current version's hash, returns the existing
version and writes nothing** — an owner hitting Save without editing must not create v4,
v5, v6 and orphan the version stamp members are reading. Otherwise inserts
`version = current + 1`. Never patches an existing version row.

**`getCurrentWaiver({})`** — query. `tryGetReadableGym` (renders in a client component via
`useQuery`; `requireGym` there throws a plain Error that production redacts to "Server
Error" and, with no error boundary, takes the page down — this is the `getConsentStats`
lesson, see `consent.ts:134`). Returns the current version or null.

**`listWaiverVersions({})`** — query, `requireGym`. Version history for the owner.

**`listSignatures({})`** — query, `requireGym`. Signature rows with name, phone, signed
date, version, whether a member is linked, whether that member is archived, and whether SMS
consent was given. Gym-scoped by index, never by client-supplied id.

**`listUnsignedMembers({})`** — query, `tryGetReadableGym`. Active, non-archived members
with a phone and no `waiverSignatures` row matching their normalized phone. This is the
number a gym owner actually wants: "who on my roster has never signed."

**`applyPendingWaiverMatches({})`** — mutation, `requireGym` + `requireWriteAccess`.
Backfills `memberId` on signature rows whose normalized phone now matches a roster member.
Mirrors `consent.ts:applyPendingConsent` line for line, including the "count only what
actually changed" honesty rule.

### 5.2 Public (unauthenticated)

**`getPublicWaiver({ gymSlug })`** — query. Returns
`{ gymName, waiverVersionId, version, bodyText, publishedAt }` and **nothing else** —
specifically never `gymId`. `gyms.getBySlug` already sets this precedent by returning only
`{ name }` to an unauthenticated caller. Returns null when the gym has no published waiver;
the page then `notFound()`s rather than rendering an empty signable document.

**`submitWaiverSignature({ gymSlug, name, email, phone, typedSignature, waiverVersionId, smsConsent, ip, userAgent })`**
— mutation. Called only from `app/waiver/[gymSlug]/actions.ts`, a Server Action that derives
`ip` via `clientIpFromHeaders(await headers())` and `userAgent` from the header. **Never
client-supplied**, or the evidence is self-reported.

Handler order, each step load-bearing:

1. `assertMaxLength` — name 200, email 200, phone 30, typedSignature 200.
   `assertEmailFormat(email)`. Reject empty name / phone / typedSignature.
2. Resolve the gym from `gymSlug` via `by_slug`. Client never supplies a `gymId`, so this
   cannot be pointed at another gym's roster by guessing an id.
3. `normalizePhoneDigits(phone)`; `ipKey = ip || "unknown"`.
4. **Rate limit**, two new buckets in `rateLimit.ts:BUCKETS`, checked independently and
   sized off the consent pair's rationale:
   `waiverPhone: { limit: 3, windowMs: 15 * 60 * 1000 }` (keyed `ip:normalizedPhone`) and
   `waiverIp: { limit: 75, windowMs: 15 * 60 * 1000 }` (keyed `ip` — above a real class
   size, so a front-desk QR behind one NAT'd IP doesn't throttle a whole intake night).
   **Separate buckets, not reused from consent** — a member who signs a waiver must not
   burn the budget that lets them later use the opt-in page. Neither goes into
   `PUBLICLY_CALLABLE_BUCKETS`; nothing calls these through `checkRateLimitAction`.
   Either tripping returns `{ status: "rate_limited" }`.
5. **Version freshness.** Load `waiverVersionId`; reject if it does not belong to this gym,
   or is not the gym's current version → `{ status: "stale_version" }`. An owner
   republishing while a member has the page open must not produce a signature against text
   the member can no longer see.
6. **Idempotency**, keyed `gymId + normalizedPhone + waiverVersionId`. A double-tap or
   refresh is not a second signing event. A *new waiver version* is, correctly, a new one.
   - **The changed-mind case, designed not discovered:** if a signature already exists for
     that triple with `smsConsentGiven: false` and this submission has `smsConsent: true`,
     do **not** insert a second signature row — but **do** run step 8, and patch the
     existing row's `smsConsentGiven` and `consentSubmissionId`. Silently swallowing that
     consent would be the same class of bug as the consent gap in
     `consent.ts:listPendingConsent`: the member sees success, nothing happens, nobody finds
     out until the first winback run.
   - The reverse (previously true, now false) writes nothing and returns ok. Un-consenting
     is a STOP keyword's job, not a web form's.
7. **Member match.** Full-roster `.collect()` by `by_gym`, find on
   `normalizePhoneDigits(m.phone)`. Same known linear-scan limit `submitConsent` carries and
   the same non-fix: a stored normalized-phone index on members is the real answer at scale
   and is out of scope here. **Never creates a member. Never un-archives one.**
8. **If `smsConsent` is true**, and only then:
   - Reuse the existing consent idempotency rule — skip if a `consentSubmissions` row
     already exists for `gymId + normalizedPhone + CONSENT_VERSION`, so someone who already
     opted in at `/consent` does not get a duplicate TCPA event.
   - Otherwise insert `consentSubmissions` with `source: "waiver"`,
     `consentText: getConsentText(gym.name)`, `consentVersion: CONSENT_VERSION`, plus
     `ip`/`userAgent`.
   - Patch a matched member: `smsConsentConfirmed: true`, `smsConsentConfirmedAt: now`,
     `smsConsentSource: "waiver"`.
   - **Never touch `smsOptedOut`.** A web form does not prove phone ownership; only an
     inbound START/YES clears an opt-out. Both gates pass independently — verbatim the rule
     in `submitConsent`.
9. Insert the `waiverSignatures` row.
10. Return `{ status: "ok", smsConsentRecorded: smsConsent }` — identical whether or not a
    member matched.

---

## 6. Reconciliation — mostly free

Because a ticked box writes an ordinary `consentSubmissions` row, **the entire existing
consent-gap machinery covers waiver-sourced consent with no new code**:
`getConsentStats` and `listPendingConsent` filter on `memberId`, not on `source`, and
`applyPendingConsent` already backfills `memberId` and stamps the member. A waiver signed by
someone not yet on the roster shows up in the red gap panel on the dashboard automatically.

Two consequences to handle:

1. **A copy edit is now required, not optional.** `app/dashboard/owner-links.tsx:236-240` reads
   *"These people filled in your opt-in page…"*. Once waiver consent flows into the same
   panel that sentence is false for some rows. Change to *"These people opted in — through
   your opt-in page or your waiver — but the phone number they gave didn't match anyone on
   your roster at the time."*
2. `applyPendingConsent` stamps `smsConsentSource: "member_self_serve"` unconditionally
   (`consent.ts:270`). A waiver-sourced consent applied later would be mislabelled on the
   member row. Fix: read `submission.source` and stamp that. One line, and it is exactly the
   field that exists so a carrier question is answerable from the member row alone.

The waiver→member join is the only genuinely new reconciliation, and that is
`applyPendingWaiverMatches` (§5.1).

---

## 7. Owner-side surface

Three additions, in build order:

1. **Waiver editor**, `/dashboard` or a `/settings` section: a textarea holding the current
   `bodyText`, a Save that calls `publishWaiverVersion`, and a version history list. Copy
   under the box: *"Members see this exactly as written. Saving publishes a new version —
   everyone who already signed keeps the version they signed."*
2. **A third `LinkCard` in `OwnerLinks`** — `Member waiver` → `{origin}/waiver/{slug}`, with
   the same missing-slug fallback the other two carry. Blurb: *"New members sign this on
   their phone at the front desk."*
3. **Signed / unsigned views.** A signed list from `listSignatures`, an unsigned list from
   `listUnsignedMembers`, and a waiver status line on the member profile
   (`app/members/member-modal.tsx`): *Waiver: signed v3 on 14 Jun 2026* or *Waiver: not
   signed*.

Fast-follow worth naming now: an **"Add as member"** button on an unmatched signature row,
which creates the member with name/email/phone pre-filled from the signature and then runs
the match. That is the honest answer to "why doesn't signing create the member" — the public
endpoint must never insert roster rows (anyone with the URL could inject members), but the
owner clicking once is a different trust boundary entirely.

---

## 8. v1 non-goals — stated so they are choices, not gaps

- PDF upload or parsing. Owner pastes plain text.
- Drawn signatures. Typed name + intent affirmation satisfies ESIGN/UETA; drawn is v2.
- Gym countersignature.
- Multiple waiver types (adult vs kids vs trial class vs competition).
- Expiry and re-signing cadence. A signature is valid until the waiver version changes;
  nothing prompts a re-sign.
- Emailing the member a copy of what they signed. Wanted, not v1 — and note Resend is
  already in the stack, so this is small.
- Owner-side PDF export of a signature. Wanted for the "hand this to your insurer" story.
- No delete path anywhere in this feature.

### ⚠️ Minors and guardian signatures — the one that must be said out loud

**BJJ gyms are full of under-18 students. Kids' programs are frequently the largest and most
profitable class on the schedule. V1 has no guardian flow, and a minor cannot form a binding
contract.** This is not a polish gap; it is a legally required flow that does not exist.

Three consequences, all binding:

1. The affirmation text carries `I am 18 or older and signing on my own behalf.` — so the
   record shows what was asserted rather than being silent about age.
2. **Guardian signature is the first fast-follow.** Not "eventually." The shape is a second
   identity block (guardian name, relationship, guardian's own typed signature) on a
   `waiverSignatures` row with `signerIsGuardian: true` and the minor's details in the
   subject fields — additive to the schema above, which is part of why the schema is shaped
   this way.
3. **Sales demos must say so.** "Adult members today, guardian signing for kids is next" is
   a fine thing to say and a bad thing to be caught not having said. It costs nothing on a
   call and it is the kind of thing an owner remembers you volunteered.

---

## 9. Open questions — Zain's calls, not mine

**1. Does the A2P campaign need updating before a real gym uses this? (Ship-gating.)**
The campaign's Message Flow declares two channels and names the URL
`https://www.kombatdesk.com/consent/[gym-slug]` explicitly. `/waiver/[gym-slug]` collects
consent at a URL the carrier record does not mention. `claude/a2p-campaign-resolution.md`
already recorded the lesson: *the console record is a separate surface from the app and the
legal pages*, and the near-miss there was a field that had never been updated.

**The approval on 2026-08-03 makes this question harder, not easier.** The instinct is that
being out of review opens the safe editing window — the same reasoning
`a2p-console-findings.md` applied to Advanced Opt-Out ("the safe window is now, between
reviews, not during one"). That reasoning does not transfer. Advanced Opt-Out was a
messaging-service setting; this is the campaign record itself, and the campaign is now an
**approved** asset that took four submissions and ~$60 to obtain. Editing the CTA on an
approved campaign risks re-vetting: another fee, and a window where a campaign that
currently works might not.

Recommendation: **do not touch the campaign to declare a channel that does not exist yet.**
There is nothing to declare today — neither the kiosk prompt nor the waiver is built, and
no member has consented through either. Declare a channel as part of shipping it, not in
advance of it. Concretely:

1. Build the surface (kiosk first — see the note at the end of §11).
2. Before the *first live gym* uses it to collect consent, do **one** CTA rewrite declaring
   every surface then in existence, described generically ("hosted consent pages operated by
   KombatDesk on each gym's behalf") rather than as an enumerated path list — so the next
   surface needs no further edit. That generic phrasing is also the only way to fit
   anything into 9 characters of headroom without a third full recompression.
3. Ask Manish on ticket #28460668 first, as with the verbal script. He pre-reviewed that one
   for free and it went through; a pre-review costs nothing and is the cheapest insurance
   available on an approved campaign.

Until that edit lands, both surfaces can be built, demoed and shown to prospects on the demo
gym. Neither may collect consent for a live paying gym's real members.

**2. Sender-of-record, now with a second edge.** `lib/consentText.ts` already carries the
open lawyer question. The waiver adds one: the waiver is a contract between member and gym,
and we are injecting a KombatDesk-authored block inside it. The proposed footer line
("KombatDesk is not a party to this waiver") is my mitigation, not legal advice. Ask the
lawyer both together — they are one conversation.

**3. Whose document is it?** The owner pastes waiver text we then display and store. The ToS
should carry a representation that they hold the right to use it and that KombatDesk neither
authored nor reviewed it — the same shape as the existing consent attestation. Termly
regeneration, probably one clause.

**4. Should the phone match fall back to email?** Recommendation: **no** in v1. Phone is the
SMS identity; an email-matched member with a non-matching phone still cannot be texted, so
the match would create a link that looks like coverage and isn't. Flagging it because the
email field is being captured and someone will ask.

**5. Retention.** Privacy §10 commits to retaining opt-out records after a member is removed.
It says nothing about signed waivers, which are now permanent records containing name, email,
phone, IP and browser. Probably one Termly clause; worth checking rather than assuming §2/§4
already covers it.

**6. Where does the editor live?** `/dashboard` is getting crowded — it now carries stats,
at-risk, winback, owner links, the consent gap panel and the automatic-message editor. A
`/settings` route may be the honest answer, but that is a bigger change than this lane and
I have not assumed it.

---

## 10. Test plan

- **Unit** (`convex/waivers.test.ts`, following `archiveMember.test.ts`'s shape):
  unchecked consent writes a signature and no `consentSubmissions` row · checked writes both
  and patches the matched member · a prior `smsOptedOut: true` survives a checked submission
  untouched · idempotent re-submit writes nothing · the false→true changed-mind case patches
  rather than duplicating · stale `waiverVersionId` rejects · a `waiverVersionId` from
  another gym rejects · unmatched phone still writes a signature with `memberId` unset ·
  `publishWaiverVersion` with identical text does not bump the version.
- **Archival** (`archiveMember.test.ts`): archiving a member leaves their signature row
  byte-identical.
- **Manual, no-JS:** load `/waiver/demo` with JavaScript disabled, submit with the consent
  box unticked, confirm a signature row exists and no `consentSubmissions` row does.
- **Compliance screenshot set** (keep these — they are the artefact a reviewer asks for):
  full page unticked · full page ticked · both success screens.
- **Demo-gym zero-phone constraint is LIFTED.** It was written as "until the campaign is
  approved" (`claude/a2p-campaign-resolution.md`) and the campaign was approved 2026-08-03,
  so it expires by its own terms — the rule existed because the send gate is data, not code,
  and an unregistered number was the risk. Still use the reserved `(719) 555-01xx` range for
  throwaway test rows and delete them after: that hygiene rule was never about registration.
- **Handset delivery is confirmed** (2026-08-03) — texts arrive on a real phone, so both the
  inbound (verified 7/30) and outbound legs are proven. The demo can end on a phone buzzing,
  which is the close in `claude/referral-outreach-kit.md`.

---

## 11. Build order, if approved

1. Schema (both tables, both widened unions) + `npx convex codegen` + a deliberate
   `npx convex deploy`. Nothing else works until the generated types exist.
2. `lib/waiverText.ts` — `SIGNATURE_AFFIRMATION`, `SIGNATURE_AFFIRMATION_VERSION`, the
   island header and exit line. One module, versioned like `consentText.ts`, so the strings
   the page renders and the strings frozen onto evidence rows cannot drift.
3. `convex/waivers.ts` — public query + submit mutation first; owner-side after.
4. `app/waiver/[gymSlug]/` — page, form, action, not-found.
5. Owner surface: editor, `LinkCard`, signed/unsigned lists, member-profile line.
6. The two `owner-links.tsx` / `applyPendingConsent` fixes from §6.
7. Tests, then the screenshot set.

Steps 1–4 are the demoable unit. Everything after is real but not required to show a gym
owner a member signing a waiver on a phone.

**Priority honesty — and the approval raises the bar here, it does not lower it.**
`claude/ship-checklist-2026-08-03.md` §6 says stop building and call the referral list. That
was right while outbound was blocked; it is *more* right now. The single hard blocker on
delivering value to gym #1 is gone, the demo can end on a phone actually buzzing, and the
opportunity cost of a week spent on e-signature plumbing just went up sharply.

This feature is a strong *sales argument* that can be made on a call today — "your current
software makes you warrant consent evidence you don't have; ours collects it at signup" —
without a single line of it being built. Build it when a prospect's objection is
specifically consent coverage, or when a signed gym needs day-one coverage for new joins.

**And build the kiosk consent prompt before this one.** It is the higher-leverage capture
path by a wide margin, for a structural reason: the kiosk already knows which member is
standing there (they tapped their name or scanned a card), so `memberId` is in hand and
consent is 100% matched at capture — the entire consent-gap problem class that forced
`listPendingConsent` / `applyPendingConsent` / the dashboard gap panel into existence simply
does not arise on that path. It also reaches exactly the population the product can serve:
at-risk detection needs attendance history, so a member who never checks in can never
trigger a winback no matter how consented they are. Kiosk coverage is not a subset of the
roster, it is the whole addressable set. And it retries for free — a link blast is one shot
that decays inside a week; the kiosk asks again on Thursday.

Two constraints on that prompt, both learned the expensive way: it fires **after** the
check-in commits, never as a gate (gating entry on consent is forced consent in a worse form
than the one that cost two rejections, and it damages the attendance data that is the actual
product), and it is an **in-kiosk component using the known `memberId`**, not a redirect to
`/consent/[gymSlug]` — a redirect re-asks for a phone the kiosk already has, reintroduces
the match gap, and leaves one member's PII on a shared tablet for the next person in line.
Ask at most once every 7 days, cap at 3 asks, then stop forever.

---

## 12. Repo rules that apply to whoever implements this

- Working dir `C:\Users\zainc\mma-saas\mma-saas` (nested, not the git root above it).
- Concurrent sessions are real and have collided. Before touching anything: `git status`,
  `git log origin/master..master --oneline`, check for `.claude/worktrees/`. Re-read
  `schema.ts` fresh from disk immediately before editing it. **Targeted additive edits,
  never a full-file write** — `schema.ts` is the single most contended file in this repo.
- Convex prod deploys are manual and read from **disk**, not from a commit.
- Never run `npx convex env list` (dumps secrets into the transcript). Use
  `npx convex env get VAR_NAME --prod`.
- PowerShell: no `<placeholders>` in paste-able commands; CRLF has silently broken
  string-match edits twice — verify edits actually applied.

---

**Nothing in this document has been implemented. No schema was edited, no code written, no
deploy run. Approve, amend, or reject §2, §3, §4.3 and §9.1 in particular — those four carry
the decisions that are expensive to reverse.**
