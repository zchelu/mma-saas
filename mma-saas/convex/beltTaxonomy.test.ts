// Regression test for a silent-skip bug: validateRank() matched belt input
// only against each rank's raw `canonical` key (e.g. "no_rank", "grey_white"),
// never against migration-assets/beltTaxonomy.json's `aliases` list the way
// scripts/import-members.js's normalizeBelt() does. Real member data stores
// belts as their human-readable display label ("No Rank", "Grey/White"), not
// the canonical key — so validateRank rejected perfectly valid ranks with no
// error, just a quiet rankWarning in adminImportBatch's per-row result and no
// `ranks` row written. Nothing threw, nothing failed loudly; rows just
// silently ended up without rank data.
//
// This is test-only, in a new file — beltTaxonomy.ts itself is intentionally
// NOT modified here (Terminal 1 is fixing it live). Expect the "No Rank" /
// slash-belt cases below to fail until that fix lands; that's the point —
// once fixed, this file goes green and stays as the tripwire if this class of
// bug (a 6th discipline, a new compound belt format, etc.) ever comes back.
import { describe, expect, it } from "vitest";
import { validateRank } from "./beltTaxonomy";

describe("validateRank - no-rank disciplines accept their display label", () => {
  it.each(["muay_thai", "wrestling", "mma"])(
    "%s accepts \"No Rank\"",
    (discipline) => {
      const result = validateRank(discipline, "No Rank");
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.canonicalBelt).toBe("no_rank");
      }
    }
  );
});

describe("validateRank - compound BJJ kids belts with slashes", () => {
  it('bjj_kids accepts "Grey/White"', () => {
    const result = validateRank("bjj_kids", "Grey/White");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.canonicalBelt).toBe("grey_white");
    }
  });

  it('bjj_kids accepts "Yellow/Black"', () => {
    const result = validateRank("bjj_kids", "Yellow/Black");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.canonicalBelt).toBe("yellow_black");
    }
  });
});

describe("validateRank - still correctly rejects a genuinely invalid belt", () => {
  it('bjj_adult rejects "Rainbow Belt" (not in the taxonomy at all)', () => {
    const result = validateRank("bjj_adult", "Rainbow Belt");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/not a recognized bjj_adult belt/);
    }
  });
});
