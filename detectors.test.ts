import { describe, expect, it } from "vitest";
import { affectedPages, detectFindings, normalizeTitle, type PageRecord } from "./detectors.js";

const NOW = new Date("2026-11-12T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function page(overrides: Partial<PageRecord>): PageRecord {
  return {
    id: Math.random().toString(36).slice(2),
    title: "A page",
    url: "https://notion.so/x",
    parentType: "workspace",
    lastEditedTime: new Date(NOW.getTime() - DAY),
    createdTime: new Date(NOW.getTime() - 30 * DAY),
    archived: false,
    hasChildren: true,
    ...overrides,
  };
}

describe("detectFindings", () => {
  it("flags untitled pages", () => {
    const findings = detectFindings([page({ title: "   " })], { now: NOW });
    expect(findings.some((f) => f.kind === "untitled")).toBe(true);
  });

  it("flags empty pages", () => {
    const findings = detectFindings([page({ hasChildren: false })], { now: NOW });
    expect(findings.some((f) => f.kind === "empty")).toBe(true);
  });

  it("flags pages older than the stale window", () => {
    const old = page({ lastEditedTime: new Date(NOW.getTime() - 120 * DAY) });
    const fresh = page({ lastEditedTime: new Date(NOW.getTime() - 10 * DAY) });
    const findings = detectFindings([old, fresh], { now: NOW, staleDays: 90 });
    const stale = findings.filter((f) => f.kind === "stale");
    expect(stale).toHaveLength(1);
    expect(stale[0].page.id).toBe(old.id);
  });

  it("respects a custom stale window", () => {
    const p = page({ lastEditedTime: new Date(NOW.getTime() - 20 * DAY) });
    const findings = detectFindings([p], { now: NOW, staleDays: 14 });
    expect(findings.some((f) => f.kind === "stale")).toBe(true);
  });

  it("groups duplicate titles case- and whitespace-insensitively", () => {
    const a = page({ title: "Meeting Notes" });
    const b = page({ title: "meeting   notes" });
    const c = page({ title: "Other" });
    const findings = detectFindings([a, b, c], { now: NOW });
    const dupes = findings.filter((f) => f.kind === "duplicate");
    expect(dupes).toHaveLength(2);
    expect(dupes[0].detail).toContain("2 times");
  });

  it("ignores archived pages entirely", () => {
    const p = page({ title: "", archived: true, hasChildren: false });
    expect(detectFindings([p], { now: NOW })).toHaveLength(0);
  });

  it("returns nothing for a clean workspace", () => {
    expect(detectFindings([page({})], { now: NOW })).toHaveLength(0);
  });
});

describe("affectedPages", () => {
  it("deduplicates pages across findings", () => {
    const p = page({ title: "", hasChildren: false });
    const findings = detectFindings([p], { now: NOW });
    expect(findings.length).toBeGreaterThan(1);
    expect(affectedPages(findings)).toHaveLength(1);
  });
});

describe("normalizeTitle", () => {
  it("collapses whitespace and case", () => {
    expect(normalizeTitle("  Weekly   Sync ")).toBe("weekly sync");
  });
});
