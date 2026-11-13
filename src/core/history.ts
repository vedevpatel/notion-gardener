import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, FindingKind } from "./detectors.js";

/**
 * One recorded scan. Appended to .gardener-history.jsonl (one JSON object
 * per line) in the directory the CLI runs from, so the score becomes a
 * trend instead of a one-off number. The file is local state - gitignore it.
 */
export interface HistoryEntry {
  timestamp: string; // ISO 8601
  score: number;
  pagesScanned: number;
  counts: Record<FindingKind, number>;
}

export const HISTORY_FILENAME = ".gardener-history.jsonl";

const KINDS: FindingKind[] = ["untitled", "empty", "stale", "duplicate"];

export function historyPath(dir: string = process.cwd()): string {
  return join(dir, HISTORY_FILENAME);
}

export function countByKind(findings: Finding[]): Record<FindingKind, number> {
  const counts = { untitled: 0, empty: 0, stale: 0, duplicate: 0 } as Record<FindingKind, number>;
  for (const f of findings) counts[f.kind]++;
  return counts;
}

export function makeEntry(
  pagesScanned: number,
  findings: Finding[],
  score: number,
  now: Date = new Date()
): HistoryEntry {
  return {
    timestamp: now.toISOString(),
    score,
    pagesScanned,
    counts: countByKind(findings),
  };
}

export function appendHistory(entry: HistoryEntry, dir: string = process.cwd()): void {
  appendFileSync(historyPath(dir), JSON.stringify(entry) + "\n", "utf8");
}

/** Reads the history file, skipping malformed lines rather than failing the scan. */
export function readHistory(dir: string = process.cwd()): HistoryEntry[] {
  const path = historyPath(dir);
  if (!existsSync(path)) return [];
  const entries: HistoryEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<HistoryEntry>;
      if (
        typeof parsed.timestamp === "string" &&
        typeof parsed.score === "number" &&
        typeof parsed.pagesScanned === "number" &&
        parsed.counts !== undefined &&
        KINDS.every((k) => typeof parsed.counts?.[k] === "number")
      ) {
        entries.push(parsed as HistoryEntry);
      }
    } catch {
      // skip the line
    }
  }
  return entries;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/**
 * One-line trend for the report header, e.g. "67 -> 94 (+27 since Nov 12)".
 * Compares the latest entry against the one before it; null on the first scan.
 */
export function formatTrend(entries: HistoryEntry[]): string | null {
  if (entries.length < 2) return null;
  const prev = entries[entries.length - 2];
  const curr = entries[entries.length - 1];
  const delta = curr.score - prev.score;
  const change = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "no change";
  return `${prev.score} -> ${curr.score} (${change} since ${formatShortDate(prev.timestamp)})`;
}
