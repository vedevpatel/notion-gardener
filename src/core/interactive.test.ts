import { describe, expect, it } from "vitest";
import type { Finding, PageRecord } from "./detectors.js";
import { buildWalkthroughItems, walkthroughPlan, type FixChoice } from "./interactive.js";

function page(overrides: Partial<PageRecord>): PageRecord {
  return {
    id: Math.random().toString(36).slice(2),
    title: "A page",
    url: "https://notion.so/x",
    parentType: "workspace",
    lastEditedTime: new Date("2026-11-01T00:00:00Z"),
    createdTime: new Date("2026-10-01T00:00:00Z"),
    archived: false,
    hasChildren: false,
    ...overrides,
  };
}

function finding(kind: Finding["kind"], p: PageRecord, detail: string): Finding {
  return { kind, page: p, detail };
}

describe("buildWalkthroughItems", () => {
  it("pairs each planned page with the reasons it was flagged", () => {
    const p = page({ title: "" });
    const findings = [
      finding("untitled", p, "Page has no title"),
      finding("empty", p, "Page has no content and no subpages"),
    ];
    const items = buildWalkthroughItems([p], findings);
    expect(items).toHaveLength(1);
    expect(items[0].page.id).toBe(p.id);
    expect(items[0].issues).toEqual([
      "Page has no title",
      "Page has no content and no subpages",
    ]);
  });

  it("excludes findings for pages not in the plan", () => {
    const inPlan = page({});
    const notInPlan = page({});
    const findings = [finding("duplicate", notInPlan, "dup")];
    const items = buildWalkthroughItems([inPlan], findings);
    expect(items[0].issues).toEqual([]);
  });
});

/** A chooser that plays back scripted answers, like a mocked prompt layer. */
function scripted(answers: FixChoice[]) {
  const seen: number[] = [];
  const choose = async (_item: unknown, index: number, _total: number): Promise<FixChoice> => {
    seen.push(index);
    return answers[index] ?? "skip";
  };
  return { choose, seen };
}

describe("walkthroughPlan", () => {
  it("archives and skips exactly what the chooser decides", async () => {
    const a = page({ title: "a" });
    const b = page({ title: "b" });
    const c = page({ title: "c" });
    const items = buildWalkthroughItems([a, b, c], []);
    const { choose } = scripted(["archive", "skip", "archive"]);
    const result = await walkthroughPlan(items, choose);
    expect(result.completed).toBe(true);
    expect(result.archive.map((p) => p.id)).toEqual([a.id, c.id]);
    expect(result.skipped.map((p) => p.id)).toEqual([b.id]);
  });

  it("stops on quit and reports the walkthrough as incomplete", async () => {
    const pages = [page({}), page({}), page({})];
    const items = buildWalkthroughItems(pages, []);
    const { choose, seen } = scripted(["archive", "quit", "archive"]);
    const result = await walkthroughPlan(items, choose);
    expect(result.completed).toBe(false);
    expect(result.archive.map((p) => p.id)).toEqual([pages[0].id]);
    expect(result.skipped).toEqual([]);
    // the third page was never presented
    expect(seen).toEqual([0, 1]);
  });

  it("handles an empty plan without calling the chooser", async () => {
    const { choose, seen } = scripted([]);
    const result = await walkthroughPlan([], choose);
    expect(result.completed).toBe(true);
    expect(result.archive).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("passes index and total so the prompt can show progress", async () => {
    const items = buildWalkthroughItems([page({}), page({})], []);
    const calls: [number, number][] = [];
    await walkthroughPlan(items, async (_item, index, total) => {
      calls.push([index, total]);
      return "skip";
    });
    expect(calls).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });
});
