import { describe, expect, it } from "vitest";
import type { PageRecord } from "./detectors.js";
import {
  comparisonToJson,
  diffDuplicates,
  digestWords,
  makeDigest,
  renderComparisonMarkdown,
  type ContentDigest,
} from "./duplicates.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-12T00:00:00Z");

function page(overrides: Partial<PageRecord>): PageRecord {
  return {
    id: Math.random().toString(36).slice(2),
    title: "Meeting notes",
    url: "https://notion.so/x",
    parentType: "workspace",
    lastEditedTime: new Date(NOW.getTime() - DAY),
    createdTime: new Date(NOW.getTime() - 30 * DAY),
    archived: false,
    hasChildren: true,
    ...overrides,
  };
}

function digest(text: string, blockTypes: Record<string, number> = { paragraph: 1 }): ContentDigest {
  return makeDigest(text, blockTypes);
}

describe("digestWords", () => {
  it("lowercases, splits on punctuation, and drops short and stop words", () => {
    expect([...digestWords("The Plan: ship it!")].sort()).toEqual(["plan", "ship"]);
  });
});

describe("diffDuplicates", () => {
  it("groups pages by normalized title, newest edit first", () => {
    const old = page({ id: "old", title: "meeting  notes", lastEditedTime: new Date(NOW.getTime() - 100 * DAY) });
    const fresh = page({ id: "fresh", title: "Meeting Notes", lastEditedTime: new Date(NOW.getTime() - 2 * DAY) });
    const solo = page({ id: "solo", title: "Unique title" });
    const untitledA = page({ id: "u1", title: "" });
    const untitledB = page({ id: "u2", title: "  " });
    const archived = page({ id: "ar", title: "Meeting notes", archived: true });
    const digests = new Map<string, ContentDigest>([
      ["old", digest("agenda budget hiring")],
      ["fresh", digest("agenda budget hiring")],
    ]);
    const diffs = diffDuplicates([old, fresh, solo, untitledA, untitledB, archived], digests);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].title).toBe("Meeting Notes");
    expect(diffs[0].pages.map((p) => p.page.id)).toEqual(["fresh", "old"]);
  });

  it("suggests keeping the newest copy when contents are near-identical", () => {
    const a = page({ id: "a", lastEditedTime: new Date("2026-11-10T00:00:00Z") });
    const b = page({ id: "b", lastEditedTime: new Date("2026-03-02T00:00:00Z") });
    const text = "agenda budget hiring roadmap launch retro planning";
    const diffs = diffDuplicates([a, b], new Map([["a", digest(text)], ["b", digest(text)]]));
    expect(diffs[0].suggestion).toBe("keep_newest");
    expect(diffs[0].suggestionText).toContain("2026-11-10");
    expect(diffs[0].suggestionText).toContain("archive the older");
  });

  it("says review when both copies carry unique content, naming the unique words", () => {
    const a = page({ id: "a", lastEditedTime: new Date("2026-11-10T00:00:00Z") });
    const b = page({ id: "b", lastEditedTime: new Date("2026-03-02T00:00:00Z") });
    const diffs = diffDuplicates(
      [a, b],
      new Map([
        ["a", digest("shared agenda kubernetes migration runbook")],
        ["b", digest("shared agenda fundraising valuation pitch")],
      ])
    );
    expect(diffs[0].suggestion).toBe("review");
    expect(diffs[0].suggestionText).toContain("unique content");
    const aOnly = diffs[0].pages.find((p) => p.page.id === "a")!.uniqueWords;
    const bOnly = diffs[0].pages.find((p) => p.page.id === "b")!.uniqueWords;
    expect(aOnly).toContain("kubernetes");
    expect(aOnly).not.toContain("shared");
    expect(bOnly).toContain("fundraising");
    expect(diffs[0].differences.some((d) => d.includes("kubernetes"))).toBe(true);
  });

  it("suggests keeping the copy with content when the other is empty", () => {
    const full = page({ id: "full", lastEditedTime: new Date("2026-01-05T00:00:00Z") });
    const empty = page({ id: "empty", lastEditedTime: new Date("2026-11-01T00:00:00Z") });
    const diffs = diffDuplicates(
      [full, empty],
      new Map([
        ["full", digest("real content lives here", { paragraph: 3, to_do: 2 })],
        ["empty", digest("", {})],
      ])
    );
    expect(diffs[0].suggestion).toBe("keep_contentful");
    // the empty copy is newer, but content beats recency
    expect(diffs[0].suggestionText).toContain("2026-01-05");
  });

  it("says review when a copy's content was not read", () => {
    const a = page({ id: "a" });
    const b = page({ id: "b" });
    const diffs = diffDuplicates([a, b], new Map([["a", digest("some content")]]));
    expect(diffs[0].suggestion).toBe("review");
    expect(diffs[0].suggestionText).toContain("Could not read");
  });

  it("reports how the copies differ: dates, length, block mix", () => {
    const a = page({ id: "a", lastEditedTime: new Date("2026-11-10T00:00:00Z") });
    const b = page({ id: "b", lastEditedTime: new Date("2026-03-02T00:00:00Z") });
    const diffs = diffDuplicates(
      [a, b],
      new Map([
        ["a", digest("shared words only", { paragraph: 5, to_do: 1 })],
        ["b", digest("shared words", { paragraph: 1 })],
      ])
    );
    expect(diffs[0].differences.some((d) => d.includes("2026-11-10") && d.includes("2026-03-02"))).toBe(true);
    expect(diffs[0].differences.some((d) => d.includes("chars"))).toBe(true);
    const md = renderComparisonMarkdown(diffs[0]).join("\n");
    expect(md).toContain("5 paragraph, 1 to do");
    expect(md).toContain("Suggestion:");
  });

  it("caps unique words shown and serializes for the json report", () => {
    const a = page({ id: "a", lastEditedTime: new Date("2026-11-10T00:00:00Z") });
    const b = page({ id: "b", lastEditedTime: new Date("2026-03-02T00:00:00Z") });
    const many = Array.from({ length: 20 }, (_, i) => `uniqueterm${i}`).join(" ");
    const diffs = diffDuplicates(
      [a, b],
      new Map([["a", digest(`shared ${many}`)], ["b", digest("shared pitchdeck")]])
    );
    expect(diffs[0].pages[0].uniqueWords.length).toBeLessThanOrEqual(5);
    const json = comparisonToJson(diffs[0]) as {
      title: string;
      suggestion: string;
      copies: { id: string; charCount: number | null; uniqueWords: string[] }[];
    };
    expect(json.title).toBe("Meeting notes");
    expect(json.suggestion).toBe("review");
    expect(json.copies.map((c) => c.id)).toEqual(["a", "b"]);
    expect(json.copies[0].charCount).toBeGreaterThan(0);
  });
});
