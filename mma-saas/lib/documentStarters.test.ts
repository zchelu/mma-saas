// The starter library is text a real gym may put in front of a real member,
// so the properties below are rules, not style: a starter that prints a raw
// {{token}}, names a state, or can be saved with a blank still in it is a
// defect in a legal record. See the header of lib/documentStarters.ts.
import { describe, expect, test } from "vitest";
import {
  buildPlaceholderValues,
  PLACEHOLDER_KEYS,
  placeholdersUsed,
  resolvePlaceholders,
} from "./documents";
import {
  blankExample,
  fillBlanks,
  findStarter,
  firstBlankRange,
  STARTER_DOCUMENTS,
  STARTER_NOTICE,
  STARTER_WAIVER,
  unfilledBlanks,
} from "./documentStarters";

// Mirrors convex/documents.ts. Duplicated on purpose: importing the Convex
// module here would drag the generated server into a pure test.
const MAX_TEMPLATE_CONTENT = 50_000;
const MAX_TEMPLATE_TITLE = 200;

const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut",
  "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
  "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan",
  "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada",
  "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina",
  "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island",
  "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont",
  "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
];

describe("the library as a whole", () => {
  test("keys and titles are unique", () => {
    const keys = STARTER_DOCUMENTS.map((s) => s.key);
    const titles = STARTER_DOCUMENTS.map((s) => s.title.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(titles).size).toBe(titles.length);
  });

  test("exactly one starter is the waiver, and it gates the door with a guardian rule", () => {
    const waivers = STARTER_DOCUMENTS.filter((s) => s.isWaiver);
    expect(waivers).toHaveLength(1);
    expect(waivers[0]).toBe(STARTER_WAIVER);
    expect(STARTER_WAIVER.requiredAtSignup).toBe(true);
    expect(STARTER_WAIVER.requiresGuardianForMinors).toBe(true);
  });

  test("nothing but the waiver blocks check-in by default", () => {
    // A pre-ticked "required" box on a photo release stops paying members at
    // the door — the failure convex/documents.ts:isRequired exists to prevent.
    for (const s of STARTER_DOCUMENTS.filter((d) => !d.isWaiver)) {
      expect(s.requiredAtSignup, s.key).toBe(false);
    }
  });

  test("findStarter resolves every key and nothing else", () => {
    for (const s of STARTER_DOCUMENTS) expect(findStarter(s.key)).toBe(s);
    expect(findStarter("nope")).toBeUndefined();
  });

  test("the notice says what it has to", () => {
    expect(STARTER_NOTICE).toMatch(/not legal advice/i);
    expect(STARTER_NOTICE).toMatch(/attorney/i);
  });
});

describe.each(STARTER_DOCUMENTS.map((s) => [s.key, s] as const))("%s", (_key, starter) => {
  test("fits the limits createTemplate enforces", () => {
    expect(starter.title.trim().length).toBeGreaterThan(0);
    expect(starter.title.length).toBeLessThanOrEqual(MAX_TEMPLATE_TITLE);
    expect(starter.content.trim().length).toBeGreaterThan(500);
    expect(starter.content.length).toBeLessThanOrEqual(MAX_TEMPLATE_CONTENT);
  });

  test("every {{token}} is a placeholder the resolver knows", () => {
    const tokens = [...starter.content.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) =>
      m[1].toLowerCase()
    );
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) expect(PLACEHOLDER_KEYS as readonly string[]).toContain(t);
  });

  test("resolves with no token left behind", () => {
    const rendered = resolvePlaceholders(
      starter.content,
      buildPlaceholderValues({
        memberName: "Sam Example",
        memberDob: "1990-05-06",
        gymName: "Example Academy",
        todayLocalDate: "2026-10-03",
      })
    );
    expect(rendered).not.toContain("{{");
    expect(rendered).not.toContain("}}");
    expect(rendered).toContain("Sam Example");
    expect(rendered).toContain("Example Academy");
    expect(rendered).toContain("October 3, 2026");
  });

  test("does not ask for an address, which would lengthen the signup form", () => {
    expect(placeholdersUsed(starter.content)).not.toContain("member_address");
  });

  test("names no state and carries no demo marker", () => {
    for (const state of US_STATES) {
      expect(starter.content, state).not.toMatch(new RegExp(`\\b${state}\\b`));
    }
    expect(starter.content).not.toMatch(/DEMO DOCUMENT|NOT A VALID LEGAL AGREEMENT/);
  });

  test("is not hard-wrapped mid-paragraph", () => {
    // pre-wrap rendering on a portrait tablet turns 80-column wraps into
    // ragged half-lines. Any long line must end a sentence or a list item.
    for (const line of starter.content.split("\n")) {
      if (line.length > 90) expect(line.trimEnd(), line).toMatch(/[.:)]$/);
    }
  });

  test("comes with something for the owner to check", () => {
    expect(starter.reviewNotes.length).toBeGreaterThan(0);
    expect(starter.summary.length).toBeGreaterThan(0);
  });
});

describe("blanks", () => {
  test("only the membership agreement has them, and it has three", () => {
    for (const s of STARTER_DOCUMENTS) {
      const blanks = unfilledBlanks(s.content);
      if (s.key === "membership_agreement") expect(blanks).toHaveLength(3);
      else expect(blanks, s.key).toEqual([]);
    }
  });

  test("unfilledBlanks returns labels in order, once each", () => {
    expect(unfilledBlanks("a [FILL IN: one] b [FILL IN:  two ] c [FILL IN: one]")).toEqual([
      "one",
      "two",
    ]);
    expect(unfilledBlanks("no blanks, just [brackets] and {{member_name}}")).toEqual([]);
  });

  test("firstBlankRange points at the whole token", () => {
    const text = "Cancel by [FILL IN: how]. Then [FILL IN: when].";
    const range = firstBlankRange(text)!;
    expect(text.slice(range.start, range.end)).toBe("[FILL IN: how]");
    expect(firstBlankRange("nothing here")).toBeNull();
    // Stateless: a second call must not resume from the previous match.
    expect(firstBlankRange(text)).toEqual(range);
  });

  test("fillBlanks fills by label and leaves an unanswered blank visible", () => {
    const text = "Cancel by [FILL IN: how]. Effective [FILL IN: when].";
    const partly = fillBlanks(text, { how: "email", when: "  " });
    expect(partly).toBe("Cancel by email. Effective [FILL IN: when].");
    expect(unfilledBlanks(partly)).toEqual(["when"]);
  });

  test("every blank in the library suggests an example, and the examples fill it", () => {
    // convex/seedDemoGym.ts fills the demo gym's documents from these, and
    // throws if one is missing — so a blank added without an example breaks
    // here first, not on a production seed.
    for (const s of STARTER_DOCUMENTS) {
      const labels = unfilledBlanks(s.content);
      const values: Record<string, string> = {};
      for (const label of labels) {
        const example = blankExample(label);
        expect(example, label).not.toBeNull();
        values[label] = example!;
      }
      const filled = fillBlanks(s.content, values);
      expect(unfilledBlanks(filled)).toEqual([]);
      expect(filled).not.toContain("[FILL IN");
    }
    expect(blankExample("no example here")).toBeNull();
    expect(blankExample("label - e.g. ")).toBeNull();
  });

  test("the membership agreement can be filled completely", () => {
    const starter = findStarter("membership_agreement")!;
    const values = Object.fromEntries(
      unfilledBlanks(starter.content).map((label) => [label, "I may do the thing."])
    );
    expect(unfilledBlanks(fillBlanks(starter.content, values))).toEqual([]);
  });
});
