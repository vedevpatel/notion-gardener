import type { Finding, FindingKind, PageRecord } from "./detectors.js";
import {
  comparisonToJson,
  renderComparisonMarkdown,
  type DuplicateComparison,
} from "./duplicates.js";

/**
 * Hygiene score, 0-100. Penalties are weighted by how much each kind of
 * rot hurts findability, and capped per category so one messy corner
 * can't tank an otherwise healthy workspace:
 *   untitled: 5 each, capped at 25
 *   empty:    3 each, capped at 20
 *   stale:    1 each, capped at 30
 *   duplicate: 2 each, capped at 25
 *   orphan:   2 each, capped at 20
 *   dead_link: 1 each, capped at 10
 *   empty_database: 2 each, capped at 10
 *   hollow:   1 each, capped at 5
 * Dead links and hollow pages dent the score less than stale/duplicate:
 * they're pointers to rot, not rot themselves.
 */
export function scoreWorkspace(findings: Finding[]): number {
  const weights: Record<FindingKind, { each: number; cap: number }> = {
    untitled: { each: 5, cap: 25 },
    empty: { each: 3, cap: 20 },
    stale: { each: 1, cap: 30 },
    duplicate: { each: 2, cap: 25 },
    orphan: { each: 2, cap: 20 },
    dead_link: { each: 1, cap: 10 },
    empty_database: { each: 2, cap: 10 },
    hollow: { each: 1, cap: 5 },
  };
  let penalty = 0;
  for (const kind of Object.keys(weights) as FindingKind[]) {
    const count = findings.filter((f) => f.kind === kind).length;
    const { each, cap } = weights[kind];
    penalty += Math.min(count * each, cap);
  }
  return Math.max(0, 100 - penalty);
}

const KIND_HEADINGS: Record<FindingKind, string> = {
  untitled: "Untitled pages",
  empty: "Empty pages",
  stale: "Stale pages",
  duplicate: "Duplicate titles",
  orphan: "Orphaned pages",
  dead_link: "Dead links",
  empty_database: "Empty databases",
  hollow: "Hollow pages",
};

const LIST_LIMIT = 25;

export function renderMarkdown(
  pages: PageRecord[],
  findings: Finding[],
  score: number,
  staleDays: number,
  trend?: string | null,
  duplicateDiffs?: DuplicateComparison[]
): string {
  const active = pages.filter((p) => !p.archived);
  const lines: string[] = [];
  lines.push(`# Notion workspace audit`);
  lines.push("");
  lines.push(`- Pages scanned: ${active.length} active, ${pages.length - active.length} archived`);
  lines.push(`- Hygiene score: **${score}/100**`);
  if (trend) lines.push(`- Trend: ${trend}`);
  lines.push(`- Findings: ${findings.length}`);
  lines.push("");

  for (const kind of Object.keys(KIND_HEADINGS) as FindingKind[]) {
    const group = findings.filter((f) => f.kind === kind);
    if (group.length === 0) continue;
    const heading =
      kind === "stale" ? `${KIND_HEADINGS[kind]} (>${staleDays} days)` : KIND_HEADINGS[kind];
    lines.push(`## ${heading} — ${group.length}`);
    lines.push("");
    if (kind === "duplicate" && duplicateDiffs && duplicateDiffs.length > 0) {
      // With diffs available, the section is grouped per title: what
      // differs between the copies and a concrete suggestion, instead of
      // a flat list that leaves the whole call to the reader.
      for (const c of duplicateDiffs) lines.push(...renderComparisonMarkdown(c));
      continue;
    }
    for (const f of group.slice(0, LIST_LIMIT)) {
      const label = f.page.title.trim() || "(untitled)";
      lines.push(`- [${label}](${f.page.url}) — ${f.detail}`);
    }
    if (group.length > LIST_LIMIT) {
      lines.push(`- …and ${group.length - LIST_LIMIT} more`);
    }
    lines.push("");
  }

  if (findings.length === 0) {
    lines.push("No findings. This workspace is clean.");
    lines.push("");
  }

  return lines.join("\n");
}

export function renderJson(
  pages: PageRecord[],
  findings: Finding[],
  score: number,
  duplicateDiffs?: DuplicateComparison[]
): string {
  return JSON.stringify(
    {
      pagesScanned: pages.filter((p) => !p.archived).length,
      score,
      duplicates: (duplicateDiffs ?? []).map(comparisonToJson),
      findings: findings.map((f) => ({
        kind: f.kind,
        detail: f.detail,
        page: {
          id: f.page.id,
          title: f.page.title,
          url: f.page.url,
          lastEditedTime: f.page.lastEditedTime.toISOString(),
        },
      })),
    },
    null,
    2
  );
}
