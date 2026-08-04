# SMS keyword opt-in — design and implementation

**Built 2026-08-04, branch `env-boundary-verify`, commit `c0021fb` (11 files, +956/−26).
Dev only; not deployed to production.** Everything below was read from disk, not recalled.

Related: `docs/sms-campaign-constraints.md` (the compliance rules this obeys),
`docs/design-waiver-consent.md` (the sibling capture path, designed but unbuilt),
`docs/member-optin-playbook.md` (why this was built first).

---

## 1. What it does, in one paragraph

A gym member texts an opt-in keyword — optionally followed by their gym's short code —
to +1 719 504 5926. The webhook resolves which gym they mean, records a consent-evidence
row carrying the carrier's own `MessageSid`, and stamps the matched roster member as
consented. No app, no form, no typing a phone number. A QR code or an `sms:` link makes it
two taps.

## 2. Why this path and not another

`convex/consent.ts` states the web form's weakness out loud, in a comment that predates
this work:

> *"nothing here proves the submitter owns the phone number they typed, only that someone
> submitted this exact name+phone for this gym."*

An inbound text closes that. Twilio's `From` is carrier-attested E.164, and the `MessageSid`
is the carrier's own record that this handset sent this message — independently checkable in
Twilio's logs years later, without trusting anything in our database. It is the strongest
consent evidence the product can hold.

It also removes the consent gap by construction on the paths where a gym identifier is
supplied: there is no typed phone number to mistype, so there is nothing to fail to match.

---

## 3. The four decisions

### D1 — Which gym? *(the problem with no analogue elsewhere)*

`/consent/[gymSlug]` reads the gym from the URL. An inbound text has only a phone number,
arriving at **one shared Twilio number serving every gym**.

`members.setSmsOptOutByPhone` sidesteps this by patching every member row with that phone
across all gyms — correct for STOP, because an opt-out should apply everywhere. **This must
never do that.** Granting consent to every gym a number appears in fabricates consent for
gyms the person never contacted, which is the worst failure this system can produce.

**Resolved strongest-evidence-first, in `resolveGym`:**

| Order | Path | Nature |
|---|---|---|
| 1 | `smsCode` — validated *before* the index lookup | Explicit. They told us. |
| 2 | `slug`, lowercased | Explicit. Free to embed in a QR or `sms:` link where nobody types it. |
| 3 | Unique cross-gym roster match | **Inferred.** We guessed from a phone number. |

Zero or two-plus roster matches resolves nothing. And critically:

```js
    return null;   // token present, resolved to nothing — NO fallthrough
```

> A token that is present but resolves to nothing does **not** fall through to the roster
> match. If someone was given a specific gym identifier and it doesn't resolve, that's a
> signal something is wrong, not an invitation to guess. Falling through would attach a
> visiting member to their *home* gym instead of the gym whose poster they actually read —
> silently, with `gymResolvedBy` recording `roster_match` as though nothing had been typed.

`gymResolvedBy` is persisted on every row, because *"they told us"* and *"we inferred it"*
are different evidentiary claims and a dispute needs to know which one happened.

**The smsCode itself.** Slugs are name-derived and up to 40 characters — `colorado-springs-bjj`
is not a poster. So gyms carry a 4-character code: **3 random + 1 Luhn mod 30 check
character**, from a 30-character alphabet (`2-9`, `A-Z` less `0 O 1 I L U`).

- The dropped glyphs are the ones that collide in print. Dropping `U` does more work than
  the blocklist does — `FUCK`, `CUNT`, `SLUT`, `ANUS` all need it.
- An 18-entry blocklist screens the **final** 4-character string and retries the whole
  generation, because the computed character can complete a word the random part didn't.
- The check character exists because a single-character typo that lands on another gym's
  live code doesn't fail — it resolves, confidently, to the wrong gym. Luhn mod 30 catches
  every single-character substitution: the doubling map sends `d < 15` to the even residues
  and `d ≥ 15` to the odd ones, all thirty distinct, so any wrong character must move the
  sum. Proven exhaustively in the tests over 2,900 mutations, not sampled.
- Adjacent transpositions are the known residual.

### D2 — Someone who previously texted STOP

A trap with no obvious surface. `JOIN` is not a registered opt-out-reversal keyword — only
`START` is — so a suppressed number that texts in **stays suppressed at the carrier layer**.
Worse, Twilio blocks every outbound message to it with error 21610, so a confirmation reply
explaining the problem also can't be delivered. Verified in Twilio's own error log on
2026-08-02 at 21:59 and 22:08 UTC, when the old STOP reply failed this exact way.

**Resolution:** record the consent (it's real), never touch `smsOptedOut` (only a registered
START may clear it), and surface the state to the gym owner — the only channel that reaches
this person.

```js
    const suppressed = matched?.smsOptedOut === true;
```

Both gates pass independently. Someone can be **consented and suppressed** simultaneously,
and that is the correct state, not a contradiction.

### D3 — What the evidence row snapshots

`consentSubmissions.consentText` exists to prove what a specific person saw. A keyword
opt-in sees a **printed poster**, and printed signage is a consent surface you cannot
version-control — a wording change doesn't change the walls, it only means the repo and the
poster disagree.

So the poster text is deliberately **minimal**, and the confirmation reply — the surface we
control remotely — carries anything that may need to change. Two constants, a separate
version namespace from `CONSENT_VERSION`:

```js
export const KEYWORD_CONSENT_VERSION_SIGNAGE_ONLY     = "keyword-1";
export const KEYWORD_CONSENT_VERSION_WITH_CONFIRMATION = "keyword-2";
```

Which one is stamped is decided **per row at write time**, by whether the reply actually
went out — never assumed. Snapshotting a confirmation the member never received would be
precisely the plausible-but-false evidence this table exists to prevent.

Consequence, accepted deliberately: keyword rows live in a different version namespace, so
`submitConsent`'s dedupe doesn't see them. Someone who texts in *and* later fills the web
form gets two rows — two surfaces, two disclosures, two real TCPA events. **Any opt-in
coverage metric must therefore count distinct members, never rows.** And nothing may
numerically compare or sort `consentVersion` — `parseInt("keyword-1")` is `NaN`, every
comparison against it is silently false, and that reads as "never consented."

### D4 — Does the confirmation reply go out?

**No. Dark by default.** It is a new outbound message type the approved A2P campaign does
not declare. Twilio's own 7/30 Message Flow draft had this exact line cut, because
*declaring a message you don't send is a false statement to the carrier*; sending one never
declared is that inverted.

Delivery mechanism doesn't rescue it — a TwiML `<Message>` in the webhook response is still
a message the member receives and still sets an expectation against the declared frequency.

Two gates plus a skip:

```js
const CONFIRMATION_REPLY_ALLOWED_SLUGS = new Set(["demo"]);

const willConfirm =
  args.confirmationEnabled &&                          // env flag
  !!gym.slug &&
  CONFIRMATION_REPLY_ALLOWED_SLUGS.has(gym.slug) &&    // per-gym allowlist
  !suppressed;                                          // 21610 would reject it anyway
```

> Adding a slug to that set is a **carrier-facing change, not a code change.**

---

## 4. Implementation

| File | What it holds |
|---|---|
| `convex/keywordConsent.ts` | New. Resolver + `recordKeywordConsent` internal mutation. |
| `convex/keywordConsent.test.ts` | New. The DoD cases plus keyword-shape assertions. |
| `lib/smsKeywords.ts` | `OPT_IN_KEYWORD` / `OPT_IN_KEYWORDS_HANDLED` — a **third category**. |
| `lib/consentText.ts` | The two versioned constants and two text functions. |
| `convex/gyms.ts` | `generateUniqueSmsCode`, `isValidSmsCode`. |
| `convex/twilioWebhookAction.ts` | The branch, above the final `return`. |
| `convex/consent.ts` | One-line fix (below). |
| `convex/schema.ts` | (commit `6dc4209`) `keyword` source, `messageSid`, `gymResolvedBy`, `gyms.smsCode` + index. |

### The keyword is a third category

```js
export const OPT_IN_KEYWORD = "OPTINPENDING";        // placeholder
export const OPT_IN_KEYWORDS_HANDLED = [OPT_IN_KEYWORD];
```

Not a fourth START keyword. `START`/`YES`/`UNSTOP` clear `smsOptedOut` and deliberately do
**not** grant consent; that separation is load-bearing and documented in three places. The
advertised `STOP_KEYWORDS`/`START_KEYWORDS` arrays are untouched — they render verbatim into
the consent checkbox, are frozen at `CONSENT_VERSION 3`, and that wording is now quoted
inside an **approved** carrier record.

### Rules mirrored from `submitConsent`, verbatim

- Gym resolved server-side; the client never supplies a `gymId`.
- Idempotent per gym + phone + **version**. A double-text is not a second TCPA event; a text
  under different wording is.
- Member matched on normalized digits. **Never creates a member. Never un-archives. No
  archived filter** — `submitConsent` has none either, and consistency on this table beats
  cleverness.
- `smsOptedOut` **never touched**.
- The evidence row is written whether or not a member matched, so the owner's existing
  consent-gap panel picks it up for free once that person is added to the roster.
- Duplicate and fresh writes return the identical shape — the caller cannot distinguish
  them, same reasoning as the webhook's byte-identical replay response.

### Two deliberate divergences

```js
    submittedName: KEYWORD_SUBMITTED_NAME,   // "(opted in by text)"
    submittedPhone: args.fromPhone,          // VERBATIM Twilio From, not normalized
```

`submittedName` is **not** filled from the roster on a match, even though the name is right
there. `submittedName` means *what the person submitted*; the roster is *what we already
believed*. Copying one into the other destroys the distinction on the one table whose
purpose is recording what actually happened. It also contains no keyword — the keyword can
change, and these rows are forever.

`ip`/`userAgent` are deliberately **absent**. An inbound webhook has neither, and the
evidence rules require they be derived server-side rather than accepted from a caller — so
the honest value is undefined, not Twilio's own IP dressed up as the member's.

### Two small hardenings

```js
        .withIndex("by_sms_code", (q) => q.eq("smsCode", token))
        .first();                            // .first(), never .unique()
```

`.unique()` throws on a duplicate; a throw in this call chain becomes a 500 that **Twilio
retries forever**, turning a data problem into an infinite redelivery loop.

And no new rate-limit bucket: the `twilioInbound` bucket the action already consumes is
keyed on `params.From`, so it *is* the per-phone bucket (30 per 15 min). A second one on the
same key would halve the real ceiling for nothing.

### The one-line fix that came along

`consent.ts:applyPendingConsent` stamped `smsConsentSource: "member_self_serve"`
unconditionally. It now stamps `submission.source`. Without it, keyword-origin consent
applied later would be mislabelled on the member row — the exact field that exists so a
carrier question is answerable from the member row alone.

---

## 5. Verification

**134 tests across 10 files.** The guard tests were mutation-tested: the resolver was
deliberately broken to confirm they fail, and only they failed — targeted, not blunt.

**Against the deployed dev function**, which in-memory tests can't reach (codegen, the
internal API path, the real indexes):

| Case | Result |
|---|---|
| Bare keyword, phone on no roster | `unresolved`, nothing written |
| `5RRJ` — one character off a real code | `unresolved`, nothing written — the check character works against the live index |
| `5RRK` — real code | `recorded` |
| Same text again, different `MessageSid` | `recorded`, still **exactly one row**, retaining the **first** SID |

The persisted row carried `consentVersion "keyword-1"`, `gymResolvedBy "sms_code"`,
`source "keyword"`, `submittedName "(opted in by text)"`, `submittedPhone "+17195550101"`
verbatim with `normalizedPhone "7195550101"` beside it, empty `ip`/`userAgent`, no `memberId`,
and `consentText` carrying `Up to 5 automated msgs/month.` byte-identically.

---

## 6. Not live — three conditions before production

1. **Twilio console check** — Advanced Opt-Out on `MG3df4bb11fd47a0f0b562ba9605aacd9d` may
   intercept the chosen keyword at the carrier layer, in which case the webhook never sees it.
2. **Clean working tree** — `npx convex deploy` reads the working directory, not a commit.
3. **Keyword swap** — `OPTINPENDING` is a placeholder. The test suite asserts the 4–12
   character, letters-only, no-collision-with-STOP/START/HELP shape as literals, so a bad
   replacement fails the suite.

Then: swap → re-run the gate clean → **one** `npx convex deploy` → prod migration → handset
test with the final keyword.

**Step 4, queued:** the two-tap `sms:` button at the top of `/consent/[gymSlug]` (the
existing form stays, and its submit control stays live at all times — forced consent is what
cost two carrier rejections), the third `LinkCard`, and the D2 owner-facing warning for
members who texted in but are suppressed.
