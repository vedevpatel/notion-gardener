import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Finding } from "./detectors.js";
import {
  appendHistory,
  countByKind,
  formatShortDate,
  formatTrend,
  historyPath,
  makeEntry,
  readHistory,
  HISTORY_FILENAME,
  type HistoryEntry,
} from "./history.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gardener-history-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function finding(kind: Finding["kind"]): Finding {
  return {
    kind,
    page: {
      id: Math.random().toString(36).slice(2),
      title: "t",
      url: "https://notion.so/x",
      parentType: "workspace",
      lastEditedTime: new Date(),
      createdTime: new Date(),
      archived: false,
      hasChildren: true,
    },
    detail: "d",
  };
}

function entry(score: number, timestamp: string): HistoryEntry {
  return {
    timestamp,
    score,
    pagesScanned: 10,
    counts: { untitled: 1, empty: 2, stale: 3, duplicate: 4 },
  };
}

describe("countByKind", () => {
  it("counts every kind, defaulting missing kinds to zero", () => {
    const counts = countByKind([finding("stale"), finding("stale"), finding("untitled")]);
    expect(counts).toEqual({ untitled: 1, empty: 0, stale: 2, duplicate: 0 });
  });
});

describe("appendHistory + readHistory", () => {
  it("round-trips entries as JSONL", () => {
    const a = entry(67, "2026-11-01T12:00:00");
    const b = entry(94, "2026-11-12T12:00:00");
    appendHistory(a, dir);
    appendHistory(b, dir);
    expect(readHistory(dir)).toEqual([a, b]);
    const lines = readFileSync(historyPath(dir), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("returns an empty list when no history file exists", () => {
    expect(readHistory(dir)).toEqual([]);
  });

  it("skips malformed lines instead of failing", () => {
    writeFileSync(
      historyPath(dir),
      [
        "not json at all",
        JSON.stringify(entry(67, "2026-11-01T12:00:00")),
        JSON.stringify({ score: "94", timestamp: 123 }), // wrong types
        "",
        JSON.stringify(entry(94, "2026-11-12T12:00:00")),
      ].join("\n"),
      "utf8"
    );
    const entries = readHistory(dir);
    expect(entries.map((e) => e.score)).toEqual([67, 94]);
  });
});

describe("makeEntry", () => {
  it("captures score, page count, per-kind counts, and a timestamp", () => {
    const now = new Date("2026-11-12T20:00:00Z");
    const e = makeEntry(14, [finding("empty"), finding("stale")], 92, now);
    expect(e.timestamp).toBe(now.toISOString());
    expect(e.score).toBe(92);
    expect(e.pagesScanned).toBe(14);
    expect(e.counts).toEqual({ untitled: 0, empty: 1, stale: 1, duplicate: 0 });
  });
});

describe("formatTrend", () => {
  it("returns null with fewer than two entries", () => {
    expect(formatTrend([])).toBeNull();
    expect(formatTrend([entry(67, "2026-11-12T12:00:00")])).toBeNull();
  });

  it("shows an improvement", () => {
    const trend = formatTrend([
      entry(67, "2026-11-01T12:00:00"),
      entry(94, "2026-11-12T12:00:00"),
    ]);
    expect(trend).toBe("67 -> 94 (+27 since Nov 1)");
  });

  it("shows a regression", () => {
    const trend = formatTrend([
      entry(94, "2026-11-01T12:00:00"),
      entry(80, "2026-11-12T12:00:00"),
    ]);
    expect(trend).toBe("94 -> 80 (-14 since Nov 1)");
  });

  it("shows no change", () => {
    const trend = formatTrend([
      entry(90, "2026-11-01T12:00:00"),
      entry(90, "2026-11-12T12:00:00"),
    ]);
    expect(trend).toBe("90 -> 90 (no change since Nov 1)");
  });

  it("compares only the two most recent entries", () => {
    const trend = formatTrend([
      entry(50, "2026-10-01T12:00:00"),
      entry(67, "2026-11-01T12:00:00"),
      entry(70, "2026-11-12T12:00:00"),
    ]);
    expect(trend).toBe("67 -> 70 (+3 since Nov 1)");
  });
});

describe("formatShortDate", () => {
  it("formats an ISO timestamp as a short local date", () => {
    expect(formatShortDate("2026-11-12T12:00:00")).toBe("Nov 12");
  });
});

describe("HISTORY_FILENAME", () => {
  it("is the documented local-state filename", () => {
    expect(HISTORY_FILENAME).toBe(".gardener-history.jsonl");
  });
});
