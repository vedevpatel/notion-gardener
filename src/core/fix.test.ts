import { describe, expect, it } from "vitest";
import type { Finding, PageRecord } from "./detectors.js";
import { compileMatcher } from "./config.js";
import { planArchives } from "./fix.js";

function pageFor(id: string): PageRecord {
  return {
    id,
    title: `Page ${id}`,
    url: `https://notion.so/${id}`,
    parentType: "page_id",
    lastEditedTime: new Date(),
    createdTime: new Date(),
    archived: false,
    hasChildren: true,
  };
}

function finding(kind: Finding["kind"], id: string): Finding {
  return { kind, page: pageFor(id), detail: "d" };
}

describe("planArchives", () => {
  it("plans untitled, empty and orphan pages", () => {
    const plan = planArchives(
      [finding("untitled", "u"), finding("empty", "e"), finding("orphan", "o")],
      { includeStale: false }
    );
    expect(plan.map((p) => p.id).sort()).toEqual(["e", "o", "u"]);
  });

  it("includes stale pages only when asked", () => {
    const findings = [finding("stale", "s")];
    expect(planArchives(findings, { includeStale: false })).toHaveLength(0);
    expect(planArchives(findings, { includeStale: true }).map((p) => p.id)).toEqual(["s"]);
  });

  it("never plans duplicates, dead links, hollow pages or empty databases", () => {
    const findings = [
      finding("duplicate", "d"),
      finding("dead_link", "l"),
      finding("hollow", "h"),
      finding("empty_database", "db"),
    ];
    expect(planArchives(findings, { includeStale: true })).toHaveLength(0);
  });

  it("deduplicates a page flagged for several reasons", () => {
    const plan = planArchives([finding("untitled", "x"), finding("orphan", "x")], {
      includeStale: false,
    });
    expect(plan).toHaveLength(1);
  });

  it("refuses protected pages even when a finding points at them", () => {
    const findings = [
      finding("untitled", "keep-me"),
      finding("orphan", "keep-me"),
      finding("empty", "other"),
    ];
    const plan = planArchives(findings, {
      includeStale: true,
      isProtected: compileMatcher(["keep-me"]),
    });
    expect(plan.map((p) => p.id)).toEqual(["other"]);
  });

  it("protects by title pattern too, and an empty protect list changes nothing", () => {
    const findings = [finding("empty", "x"), finding("empty", "y")];
    expect(
      planArchives(findings, { includeStale: false, isProtected: compileMatcher(["page y"]) }).map(
        (p) => p.id
      )
    ).toEqual(["x"]);
    expect(
      planArchives(findings, { includeStale: false, isProtected: compileMatcher([]) })
    ).toHaveLength(2);
  });
});
