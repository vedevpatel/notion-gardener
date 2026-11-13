import { describe, expect, it } from "vitest";
import type { Finding, PageRecord } from "./detectors.js";
import { renderMarkdown, scoreWorkspace } from "./report.js";

function finding(kind: Finding["kind"], id = "p1"): Finding {
  const page: PageRecord = {
    id,
    title: `Page ${id}`,
    url: `https://notion.so/${id}`,
    parentType: "workspace",
    lastEditedTime: new Date("2026-11-01T00:00:00Z"),
    createdTime: new Date("2026-10-01T00:00:00Z"),
    archived: false,
    hasChildren: true,
  };
  return { kind, page, detail: "some detail" };
}

describe("scoreWorkspace", () => {
  it("weights dead links and hollow pages below stale and duplicate", () => {
    expect(scoreWorkspace([finding("dead_link")])).toBe(99);
    expect(scoreWorkspace([finding("hollow")])).toBe(99);
    expect(scoreWorkspace([finding("orphan")])).toBe(98);
    expect(scoreWorkspace([finding("empty_database")])).toBe(98);
    expect(scoreWorkspace([finding("duplicate")])).toBe(98);
    expect(scoreWorkspace([finding("stale")])).toBe(99);
  });

  it("caps the new categories so one messy corner can't tank the score", () => {
    const many = (kind: Finding["kind"]) =>
      Array.from({ length: 30 }, (_, i) => finding(kind, `p${i}`));
    expect(scoreWorkspace(many("dead_link"))).toBe(90);
    expect(scoreWorkspace(many("hollow"))).toBe(95);
    expect(scoreWorkspace(many("orphan"))).toBe(80);
    expect(scoreWorkspace(many("empty_database"))).toBe(90);
  });
});

describe("renderMarkdown", () => {
  it("renders a section per finding kind, including the new detectors", () => {
    const findings = [
      finding("orphan", "o"),
      finding("dead_link", "l"),
      finding("empty_database", "db"),
      finding("hollow", "h"),
    ];
    const md = renderMarkdown(
      findings.map((f) => f.page),
      findings,
      80,
      90
    );
    expect(md).toContain("## Orphaned pages");
    expect(md).toContain("## Dead links");
    expect(md).toContain("## Empty databases");
    expect(md).toContain("## Hollow pages");
  });
});
