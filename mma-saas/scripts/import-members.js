#!/usr/bin/env node
// One-time-per-gym CSV member importer for KombatDesk.
// Run manually from the command line — not user-facing, no UI.
//
// Usage:
//   node scripts/import-members.js <path-to-csv> --gym-id=<convexGymId> [--commit] [--prod]
//
// Without --commit this is a dry run: nothing is written to Convex, you just
// get a summary printed here plus a <csv>.flagged.csv file listing rows that
// need a look before you commit.
//
// Find the gym's Convex _id in the Convex dashboard (Data tab -> gyms table,
// or Logs while the owner is signed in) before running this.
//
// Safe to re-run: rows are matched against existing members by email and
// skipped if already imported. Rows with no email can't be deduped this way
// — the dry-run summary tells you how many of those exist.
//
// Auto-detects PushPress / Zen Planner / Kicksite / Gymdesk exports by header
// shape (see PLATFORM_PROFILES below) and picks the right column map + belt
// taxonomy automatically. See migration-assets/export-instructions.md for how
// gym owners generate these exports, and migration-assets/beltTaxonomy.json
// for the canonical rank list this script normalizes against.
//
// For any other platform, edit FALLBACK_COLUMN_MAP below to match its export.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { parse } = require("csv-parse/sync");

const beltTaxonomy = require(path.join(__dirname, "..", "migration-assets", "beltTaxonomy.json"));

// ---------------------------------------------------------------------------
// EDIT THIS for a gym exporting from something other than PushPress/Zen
// Planner/Kicksite/Gymdesk (those four are auto-detected below). Map your
// students table's field names to the exact column header the export uses —
// open the CSV once and copy the header text exactly (case-sensitive). Use
// either "name" for a single full-name column, or "firstName"/"lastName" for
// a split one. "program" feeds both the belt-taxonomy lookup (BJJ/Muay
// Thai/Wrestling/MMA/BJJ Kids) and the member's plan field.
// ---------------------------------------------------------------------------
const FALLBACK_COLUMN_MAP = {
  name: "Full Name",
  email: "Email Address",
  phone: "Phone",
  program: "Program",
  belt: "Current Rank",
  join_date: "Join Date",
  promotion_date: "Last Promoted",
  status: "Status",
  // None of the four auto-detected platforms (PushPress/Zen Planner/
  // Kicksite/Gymdesk) export a stripe-count column — see
  // migration-assets/fixtures/*.csv. This only matters for a different
  // platform whose export has one; point it at the exact header text. A
  // missing/unmapped column is treated as "no stripe data", not an error.
  stripes: "Stripes",
};
// ---------------------------------------------------------------------------

// Real header shapes captured from each platform's export (see
// migration-assets/fixtures/*.csv). `match` requires every listed header to
// be present so an unrelated CSV that happens to share one column name
// doesn't misfire.
//
// None of these four platforms export a stripe-count column today, so no
// columnMap below has a `stripes` entry — normalizeStripes() treats that as
// no data, not an error.
const PLATFORM_PROFILES = [
  {
    name: "PushPress",
    headers: ["First Name", "Last Name", "Email", "Phone", "Discipline", "Belt Rank", "Join Date", "Status"],
    columnMap: {
      firstName: "First Name",
      lastName: "Last Name",
      email: "Email",
      phone: "Phone",
      program: "Discipline",
      belt: "Belt Rank",
      join_date: "Join Date",
      status: "Status",
    },
  },
  {
    name: "Zen Planner",
    headers: ["Full Name", "Email Address", "Cell Phone", "Program", "Rank", "Enrollment Date", "Member Status"],
    columnMap: {
      name: "Full Name",
      email: "Email Address",
      phone: "Cell Phone",
      program: "Program",
      belt: "Rank",
      join_date: "Enrollment Date",
      status: "Member Status",
    },
  },
  {
    name: "Kicksite",
    headers: ["Student Name", "Email", "Phone Number", "Program", "Current Belt", "Start Date", "Active"],
    columnMap: {
      name: "Student Name",
      email: "Email",
      phone: "Phone Number",
      program: "Program",
      belt: "Current Belt",
      join_date: "Start Date",
      status: "Active",
    },
  },
  {
    name: "Gymdesk",
    headers: ["Name", "Email", "Mobile", "Membership Type", "Current Rank", "Date Joined", "Status"],
    columnMap: {
      name: "Name",
      email: "Email",
      phone: "Mobile",
      program: "Membership Type",
      belt: "Current Rank",
      join_date: "Date Joined",
      status: "Status",
    },
  },
];

function detectPlatform(headers) {
  const headerSet = new Set(headers);
  for (const profile of PLATFORM_PROFILES) {
    if (profile.headers.every((h) => headerSet.has(h))) return profile;
  }
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BATCH_SIZE = 25;
// Invoke the Convex CLI's JS entrypoint directly with node, instead of
// "npx convex ...": execFileSync("npx", ...) throws ENOENT on Windows
// (CreateProcess can't resolve the .cmd extension without a shell), naming
// npx.cmd directly throws EINVAL instead (.cmd files need cmd.exe to launch
// them, not a direct process spawn), and shell: true is a JSON-injection/
// quoting risk — cmd.exe's argument re-joining silently strips the double
// quotes the JSON payload below relies on. Spawning node on a real .js file
// with a plain argv array sidesteps all of it, on every platform.
const CONVEX_BIN = path.join(__dirname, "..", "node_modules", "convex", "bin", "main.js");

function parseArgs() {
  const args = process.argv.slice(2);
  const csvPath = args.find((a) => !a.startsWith("--"));
  const gymIdArg = args.find((a) => a.startsWith("--gym-id="));
  const gymId = gymIdArg && gymIdArg.split("=")[1];
  const commit = args.includes("--commit");
  const prod = args.includes("--prod");
  if (!csvPath || !gymId) {
    console.error("Usage: node scripts/import-members.js <csv-path> --gym-id=<convexGymId> [--commit] [--prod]");
    process.exit(1);
  }
  return { csvPath, gymId, commit, prod };
}

// Accepts YYYY-MM-DD / YYYY/MM/DD (year-first) and MM/DD/YYYY / MM-DD-YYYY
// (US year-last — PushPress/Zen Planner/Kicksite/Gymdesk are all US
// platforms, and real exports mix both forms even within one column).
// Anything else comes back unparsed rather than guessed at, since a wrong
// DD/MM-vs-MM/DD guess would corrupt the date silently.
function normalizeDate(raw) {
  if (!raw || !raw.trim()) return { value: undefined, ok: true };
  const s = raw.trim();

  let m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (m) {
    const [, yyyy, mm, dd] = m;
    return finalizeDate(yyyy, mm, dd, s);
  }

  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return finalizeDate(yyyy, mm, dd, s);
  }

  return { value: undefined, ok: false, raw: s };
}

function finalizeDate(yyyy, mm, dd, raw) {
  const month = mm.padStart(2, "0");
  const day = dd.padStart(2, "0");
  if (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31) {
    return { value: `${yyyy}-${month}-${day}`, ok: true };
  }
  return { value: undefined, ok: false, raw };
}

// Discipline detection from a free-text program/membership-type column
// ("Adult BJJ Unlimited", "Kids BJJ", "Muay Thai Unlimited", "Wrestling
// Club", "MMA Unlimited", ...) into a migration-assets/beltTaxonomy.json key.
// Order matters: check "kids" before the bare "bjj" fallback.
function detectDiscipline(programRaw) {
  const p = (programRaw || "").toLowerCase();
  if (p.includes("bjj") && p.includes("kid")) return "bjj_kids";
  if (p.includes("muay")) return "muay_thai";
  if (p.includes("wrestl")) return "wrestling";
  if (p.includes("mma")) return "mma";
  if (p.includes("bjj")) return "bjj_adult";
  return undefined;
}

function isNoRankDiscipline(discipline) {
  return discipline === "muay_thai" || discipline === "wrestling" || discipline === "mma";
}

const aliasMapCache = new Map();

// Builds a lowercased alias -> canonical-value lookup for one discipline
// (or, if the discipline is unknown, across every discipline in the
// taxonomy — belt names collide across disciplines, e.g. "white" means
// something different for BJJ vs a Muay Thai armband system, so this is
// a best-effort fallback only used when we have no program/discipline
// column to disambiguate with).
function getAliasMap(discipline) {
  const cacheKey = discipline || "__all__";
  if (aliasMapCache.has(cacheKey)) return aliasMapCache.get(cacheKey);

  const map = new Map();
  const categoryKeys = discipline
    ? [discipline]
    : Object.keys(beltTaxonomy).filter((k) => !k.startsWith("_"));
  for (const key of categoryKeys) {
    const category = beltTaxonomy[key];
    if (!category) continue;
    for (const rank of category.ranks) {
      map.set(rank.canonical.toLowerCase(), rank.canonical);
      for (const alias of rank.aliases) {
        map.set(alias.toLowerCase(), rank.canonical);
      }
    }
  }
  aliasMapCache.set(cacheKey, map);
  return map;
}

// "grey_white" -> "Grey/White", "no_rank" -> "No Rank", "white" -> "White"
function canonicalLabel(value) {
  if (value === "no_rank") return "No Rank";
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("/");
}

function normalizeBelt(raw, discipline) {
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    if (isNoRankDiscipline(discipline)) return { value: "No Rank", canonical: "no_rank", recognized: true };
    if (discipline === "bjj_adult" || discipline === "bjj_kids") {
      return { value: undefined, canonical: undefined, recognized: false, reason: "blank belt rank for a belt-based discipline" };
    }
    return { value: undefined, canonical: undefined, recognized: true };
  }

  const key = trimmed.toLowerCase();
  const aliasMap = getAliasMap(discipline);
  if (aliasMap.has(key)) {
    const canonical = aliasMap.get(key);
    return { value: canonicalLabel(canonical), canonical, recognized: true };
  }

  // Retry with a trailing/leading "belt" stripped ("blue belt" already
  // matches via aliases, but this catches odd spacing/punctuation variants).
  const stripped = key.replace(/\bbelt\b/g, "").replace(/\s+/g, " ").trim();
  if (stripped && aliasMap.has(stripped)) {
    const canonical = aliasMap.get(stripped);
    return { value: canonicalLabel(canonical), canonical, recognized: true };
  }

  return { value: trimmed, canonical: undefined, recognized: false, reason: `unrecognized belt "${trimmed}"` };
}

// Parses a raw stripe-count column into an integer and validates it against
// the matched belt's valid range in beltTaxonomy.json — same
// flag-don't-crash contract as normalizeBelt(). Needs the belt's canonical
// key (normalizeBelt's `canonical` field above), not its display label, to
// look up the right rank's stripes array. No range to check against if the
// discipline/belt wasn't recognized, so a parsed number is accepted as-is
// rather than guessed at.
function normalizeStripes(raw, discipline, canonicalBelt) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return { value: undefined, recognized: true };

  const n = Number(trimmed);
  if (!Number.isInteger(n)) {
    return { value: undefined, recognized: false, reason: `unparseable stripe count "${trimmed}"` };
  }

  const category = discipline ? beltTaxonomy[discipline] : undefined;
  const rank = category && canonicalBelt
    ? category.ranks.find((r) => r.canonical === canonicalBelt)
    : undefined;

  if (rank && !rank.stripes.includes(n)) {
    const validValues = rank.stripes.length ? rank.stripes.join(", ") : "none";
    return {
      value: n,
      recognized: false,
      reason: `${n} stripe(s) not valid for ${discipline} ${canonicalBelt} (valid: ${validValues})`,
    };
  }

  return { value: n, recognized: true };
}

function normalizeStatus(raw) {
  const s = (raw || "").trim().toLowerCase();
  if (["active", "yes", "y", "true", "1"].includes(s)) return { value: "active", recognized: true };
  if (["inactive", "no", "n", "false", "0"].includes(s)) return { value: "inactive", recognized: true };
  return { value: "active", recognized: false };
}

function get(row, columnMap, field) {
  const header = columnMap[field];
  if (!header) return undefined;
  return row[header];
}

function resolveName(row, columnMap) {
  const single = (get(row, columnMap, "name") || "").trim();
  if (single) return single;
  const first = (get(row, columnMap, "firstName") || "").trim();
  const last = (get(row, columnMap, "lastName") || "").trim();
  return [first, last].filter(Boolean).join(" ").trim();
}

function processRows(rawRows, columnMap) {
  const clean = [];
  const flagged = []; // imported anyway, but worth a look
  const skipped = []; // never sent to Convex
  const seenEmails = new Set();
  let phoneCount = 0;
  let noEmailCount = 0;

  rawRows.forEach((row, i) => {
    const rowNum = i + 2; // +1 for 0-index, +1 for the header line
    const name = resolveName(row, columnMap);
    if (!name) {
      skipped.push({ rowNum, reason: "missing name", raw: row });
      return;
    }

    const emailRaw = (get(row, columnMap, "email") || "").trim();
    const email = emailRaw || undefined;
    const flags = [];

    if (email && !EMAIL_RE.test(email)) {
      flags.push(`malformed email "${email}"`);
    }
    if (email && seenEmails.has(email.toLowerCase())) {
      skipped.push({ rowNum, reason: `duplicate email within this CSV ("${email}")`, raw: row });
      return;
    }
    if (email) seenEmails.add(email.toLowerCase());
    else noEmailCount++;

    const phone = (get(row, columnMap, "phone") || "").trim() || undefined;
    if (phone) phoneCount++;

    const programRaw = (get(row, columnMap, "program") || "").trim() || undefined;
    const discipline = detectDiscipline(programRaw);

    const belt = normalizeBelt(get(row, columnMap, "belt"), discipline);
    if (!belt.recognized) flags.push(belt.reason);

    const stripes = normalizeStripes(get(row, columnMap, "stripes"), discipline, belt.canonical);
    if (!stripes.recognized) flags.push(stripes.reason);

    const joinDate = normalizeDate(get(row, columnMap, "join_date"));
    if (!joinDate.ok) flags.push(`unparseable join date "${joinDate.raw}"`);

    const promotionDate = normalizeDate(get(row, columnMap, "promotion_date"));
    if (!promotionDate.ok) flags.push(`unparseable promotion date "${promotionDate.raw}"`);

    const status = normalizeStatus(get(row, columnMap, "status"));
    if (!status.recognized) flags.push(`unrecognized status "${(get(row, columnMap, "status") || "").trim()}" — defaulted to active`);

    clean.push({
      name,
      email,
      phone,
      beltRank: belt.value,
      discipline,
      stripes: stripes.value,
      joinDate: joinDate.value,
      beltPromotionDate: promotionDate.value,
      plan: programRaw,
      status: status.value,
    });
    if (flags.length) flagged.push({ rowNum, reasons: flags, raw: row });
  });

  return { clean, flagged, skipped, phoneCount, noEmailCount };
}

function csvField(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function writeFlaggedCsv(csvPath, flagged, skipped) {
  if (!flagged.length && !skipped.length) return null;
  const outPath = csvPath.replace(/\.csv$/i, "") + ".flagged.csv";
  const lines = ["row,type,reason,raw_json"];
  for (const s of skipped) {
    lines.push([s.rowNum, "skipped", csvField(s.reason), csvField(JSON.stringify(s.raw))].join(","));
  }
  for (const f of flagged) {
    lines.push([f.rowNum, "flagged", csvField(f.reasons.join("; ")), csvField(JSON.stringify(f.raw))].join(","));
  }
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  return outPath;
}

function printSummary({ clean, flagged, skipped, phoneCount, noEmailCount }, flaggedPath, platformName) {
  console.log(`\nDetected platform: ${platformName || "unknown (using FALLBACK_COLUMN_MAP — edit it at the top of this script if the columns look wrong below)"}`);
  console.log(`\nParsed ${clean.length + skipped.length} data row(s).\n`);
  console.log(`  will import cleanly : ${clean.length - flagged.length}`);
  console.log(`  flagged for review  : ${flagged.length}${flaggedPath ? ` (see ${flaggedPath})` : ""}`);
  console.log(`  skipped entirely    : ${skipped.length}${flaggedPath ? ` (see ${flaggedPath})` : ""}`);
  if (phoneCount) {
    console.log(`\n${phoneCount} row(s) have a phone number. SMS consent is NOT assumed from`);
    console.log(`migrated data — these members import without retention texting enabled`);
    console.log(`until you edit + re-save each one in the dashboard to confirm consent.`);
  }
  if (noEmailCount) {
    console.log(`\n${noEmailCount} row(s) have no email — duplicate protection can't catch these`);
    console.log(`on a re-run. Rows with an email are always safe to re-import.`);
  }
}

function runBatch(gymId, rows, prod) {
  const args = [
    CONVEX_BIN,
    "run",
    "members:adminImportBatch",
    JSON.stringify({ gymId, rows }),
    ...(prod ? ["--prod"] : []),
  ];
  try {
    const out = execFileSync(process.execPath, args, { encoding: "utf8", cwd: path.join(__dirname, "..") });
    console.log(out.trim());
    return true;
  } catch (e) {
    console.error(`\nBatch failed — nothing in this batch was written (a Convex mutation call is all-or-nothing).`);
    console.error(e.stdout || "");
    console.error(e.stderr || e.message);
    return false;
  }
}

function main() {
  const { csvPath, gymId, commit, prod } = parseArgs();
  const raw = fs.readFileSync(csvPath, "utf8");
  const rawRows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  const headers = rawRows.length ? Object.keys(rawRows[0]) : [];

  const platform = detectPlatform(headers);
  const columnMap = platform ? platform.columnMap : FALLBACK_COLUMN_MAP;

  const result = processRows(rawRows, columnMap);
  const flaggedPath = writeFlaggedCsv(csvPath, result.flagged, result.skipped);
  printSummary(result, flaggedPath, platform && platform.name);

  if (!commit) {
    console.log(`\nDry run only — nothing was written. Re-run with --commit to import.`);
    return;
  }

  console.log(`\nImporting ${result.clean.length} member(s) into gym ${gymId}${prod ? " (PRODUCTION)" : " (dev)"}...`);
  for (let i = 0; i < result.clean.length; i += BATCH_SIZE) {
    const batch = result.clean.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`\nBatch ${batchNum} (${batch.length} rows):`);
    const ok = runBatch(gymId, batch, prod);
    if (!ok) {
      console.error(`\nStopped after batch ${batchNum}. Earlier batches are already committed and safe to`);
      console.error(`leave as-is. Fix the issue above, then re-run this script — already-imported`);
      console.error(`members (matched by email) will be skipped automatically.`);
      process.exit(1);
    }
  }
  console.log(`\nDone. Re-running this script is safe — members already matched by email are skipped as duplicates.`);
}

main();
