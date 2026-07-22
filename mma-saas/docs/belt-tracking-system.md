# Belt tracking system

How KombatDesk models rank/belt data across disciplines, and why it's shaped the way it is. Covers the `ranks`/`promotionCriteria` tables (`convex/schema.ts`), the `validateRank` helper (`convex/beltTaxonomy.ts`), and the taxonomy data both are built on (`migration-assets/beltTaxonomy.json`).

## Schema

**`ranks`** — one row per `(memberId, discipline)`. A cross-training member (e.g. BJJ + Muay Thai) holds multiple rows, one per discipline. This is the source of truth for current belt/stripes going forward.

**`promotionCriteria`** — one row per `(gymId, discipline, belt)`, where `belt` is the rank being **promoted into** — i.e. the requirements to reach that belt from whatever precedes it in the discipline's taxonomy order (see `migration-assets/defaultPromotionCriteria.json` for draft default values). `requiredSessions`/`requiredDaysAtRank` are both optional — a gym can set either, both, or neither per belt.

**`members.beltRank` / `members.beltPromotionDate`** — legacy fields, left in place as a **display snapshot** populated only by the CSV import path (`scripts/import-members.js` / `members:adminImportBatch`). They're deliberately not the source of truth once a `ranks` row exists for that member/discipline — UI reading current rank should prefer `ranks`, falling back to these only for members imported before `ranks` existed and not yet backfilled.

## `validateRank`

```ts
validateRank(discipline: string, belt: string, stripes?: number): RankValidationResult
```

Single source of truth for "is this `(discipline, belt, stripes)` combo real," checked against `migration-assets/beltTaxonomy.json`. Called from both `adminImportBatch` (CSV import) and, eventually, a manual gym-owner-triggered promotion mutation — so a promotion a gym owner makes by hand can't produce a rank the CSV importer would have rejected, and vice versa.

Returns a discriminated union (`{ valid: true, canonicalBelt }` or `{ valid: false, reason }`) rather than throwing — see "flag, don't crash" below.

## Key design decisions

### Discipline: closed union. Belt: free string, validated at write-time.

`disciplineValidator` (`convex/beltTaxonomy.ts`) is a `v.union` of five `v.literal()`s, exported once and imported by both `schema.ts` (`ranks`/`promotionCriteria`) and `members.ts` (`adminImportBatch`). The discipline set is small, stable, and shared everywhere it's used, so a closed union buys compile-time typo protection and a single place to change it.

`belt` is just `v.string()` in the schema — not a union of the ~26 canonical belts across all five disciplines. Two reasons: that list is far larger and less stable than the discipline list (a gym could reasonably need a custom belt tier someday), and belt values arrive from messy real-world CSV exports that need fuzzy alias matching ("Purpel", "PB", "Purple Belt" -> `purple`) before they're even comparable — that's a runtime concern (`validateRank`, `normalizeBelt`), not something a schema-level enum can express. Enforcing it at write-time via `validateRank` gets the same safety without hardcoding a belt list in three places.

### Canonical belt vs. display label

Every rank in `beltTaxonomy.json` has a `canonical` key (e.g. `grey_white`, `no_rank`, `purple`) plus a list of human-entered `aliases` that all fuzzy-match down to it. Canonical keys are what gets stored and compared everywhere (`ranks.currentBelt`, `promotionCriteria.belt`, the lookup key into `beltTaxonomy.json` itself) — they never change spelling or spacing, so equality checks stay reliable no matter how a gym typed the original input.

Display labels (e.g. `"Grey/White"`) are a presentation-only derivation (`canonicalLabel()` in `scripts/import-members.js`) — built from the canonical key, never stored, never used for comparison. Keeping the two separate means storage/lookup logic never has to worry about capitalization or slash-vs-dash formatting choices made purely for UI readability.

### Flag, don't crash

`normalizeBelt` and `normalizeStripes` (`scripts/import-members.js`) and `validateRank` (`convex/beltTaxonomy.ts`) all share the same contract: return a result describing whether the value was recognized/valid, never throw on bad input. `adminImportBatch` follows the same posture one level up — a bad discipline/belt/stripe combo produces a `rankWarning` on an otherwise-successful member insert rather than failing the row.

This matters because the input is inherently messy (real gym exports have typos, missing columns, inconsistent formats) and a Convex mutation batch is all-or-nothing — if a single bad rank value threw, one typo'd belt in a 200-row CSV would roll back the entire import. Flagging instead of crashing means the name/email/plan/membership data — which is almost always fine — still imports, while only the rank portion is set aside for a human to look at.
