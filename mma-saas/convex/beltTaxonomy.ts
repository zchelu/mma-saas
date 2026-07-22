import { v, type Infer } from "convex/values";
import taxonomy from "../migration-assets/beltTaxonomy.json";

type TaxonomyRank = {
  canonical: string;
  order: number;
  stripes: number[];
  aliases: string[];
};

type TaxonomyCategory = {
  label: string;
  notes: string;
  ranks: TaxonomyRank[];
};

const categories = taxonomy as unknown as Record<string, TaxonomyCategory>;

// Single source of truth for the closed set of disciplines — schema.ts
// (ranks/promotionCriteria) and members.ts (adminImportBatch) import this
// instead of each hardcoding the same five v.literal()s.
export const disciplineValidator = v.union(
  v.literal("bjj_adult"),
  v.literal("bjj_kids"),
  v.literal("muay_thai"),
  v.literal("wrestling"),
  v.literal("mma"),
);
export type Discipline = Infer<typeof disciplineValidator>;

export type RankValidationResult =
  | { valid: true; canonicalBelt: string }
  | { valid: false; reason: string };

// Single source of truth for "is this (discipline, belt, stripes) combo
// real" per migration-assets/beltTaxonomy.json — called by both
// adminImportBatch and (eventually) a manual-promotion mutation, so a
// gym-owner-triggered promotion can't write a rank the CSV importer would
// have rejected, and vice versa. Returns rather than throws, same as
// scripts/import-members.js's normalizeBelt(), so a caller can decide
// whether a bad rank should block a write entirely or just skip the rank
// portion while the rest proceeds.
export function validateRank(
  discipline: string,
  belt: string,
  stripes?: number
): RankValidationResult {
  const category = categories[discipline];
  if (!category) {
    return { valid: false, reason: `Unknown discipline "${discipline}"` };
  }

  // members.beltRank is always stored in canonicalLabel()'s display format
  // ("No Rank", "Grey/White"), never the raw canonical key ("no_rank",
  // "grey_white") — normalize spaces/slashes/dashes back to underscores
  // before comparing, or every compound-key belt (anything but a single
  // word) would falsely fail to match its own canonical entry.
  const normalized = belt.trim().toLowerCase().replace(/[\s/-]+/g, "_");
  const rank = category.ranks.find((r) => r.canonical.toLowerCase() === normalized);
  if (!rank) {
    return { valid: false, reason: `"${belt}" is not a recognized ${discipline} belt` };
  }

  if (stripes !== undefined) {
    if (!Number.isInteger(stripes) || !rank.stripes.includes(stripes)) {
      const validValues = rank.stripes.length ? rank.stripes.join(", ") : "none";
      return {
        valid: false,
        reason: `${stripes} stripe(s) is not valid for ${discipline} ${rank.canonical} (valid: ${validValues})`,
      };
    }
  }

  return { valid: true, canonicalBelt: rank.canonical };
}
