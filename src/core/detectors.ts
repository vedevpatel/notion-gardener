export interface PageRecord {
  id: string;
  title: string;
  url: string;
  parentType: string;
  lastEditedTime: Date;
  createdTime: Date;
  archived: boolean;
  hasChildren: boolean;
}

export type FindingKind = "untitled" | "empty" | "stale" | "duplicate";

export interface Finding {
  kind: FindingKind;
  page: PageRecord;
  detail: string;
}

export const DEFAULT_STALE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface DetectOptions {
  staleDays?: number;
  now?: Date;
}

/**
 * Pure detection pass over a set of pages. Archived pages are ignored:
 * they're already out of the way and flagging them is noise.
 */
export function detectFindings(pages: PageRecord[], opts: DetectOptions = {}): Finding[] {
  const now = opts.now ?? new Date();
  const staleMs = (opts.staleDays ?? DEFAULT_STALE_DAYS) * DAY_MS;
  const findings: Finding[] = [];
  const active = pages.filter((p) => !p.archived);

  for (const page of active) {
    if (!page.title.trim()) {
      findings.push({ kind: "untitled", page, detail: "Page has no title" });
    }
    if (!page.hasChildren) {
      findings.push({ kind: "empty", page, detail: "Page has no content and no subpages" });
    }
    const ageMs = now.getTime() - page.lastEditedTime.getTime();
    if (ageMs > staleMs) {
      const days = Math.floor(ageMs / DAY_MS);
      findings.push({ kind: "stale", page, detail: `Last edited ${days} days ago` });
    }
  }

  const byTitle = new Map<string, PageRecord[]>();
  for (const page of active) {
    const key = normalizeTitle(page.title);
    if (!key) continue;
    const group = byTitle.get(key) ?? [];
    group.push(page);
    byTitle.set(key, group);
  }
  for (const [title, group] of byTitle) {
    if (group.length < 2) continue;
    for (const page of group) {
      findings.push({
        kind: "duplicate",
        page,
        detail: `"${title}" appears ${group.length} times in the workspace`,
      });
    }
  }

  return findings;
}

/** The pages a finding set points at, deduplicated. */
export function affectedPages(findings: Finding[]): PageRecord[] {
  const seen = new Map<string, PageRecord>();
  for (const f of findings) {
    if (!seen.has(f.page.id)) seen.set(f.page.id, f.page);
  }
  return [...seen.values()];
}
