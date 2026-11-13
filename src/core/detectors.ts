export interface PageRecord {
  id: string;
  title: string;
  url: string;
  parentType: string;
  /** Id of the containing page/block/database, when there is one. */
  parentId?: string | null;
  lastEditedTime: Date;
  createdTime: Date;
  archived: boolean;
  hasChildren: boolean;
}

/** A Notion database, as far as the audit cares about it. */
export interface DatabaseRecord {
  id: string;
  title: string;
  url: string;
  lastEditedTime: Date;
  archived: boolean;
  /** True when querying the first row came back empty. */
  empty: boolean;
}

export type FindingKind =
  | "untitled"
  | "empty"
  | "stale"
  | "duplicate"
  | "orphan"
  | "dead_link"
  | "empty_database"
  | "hollow";

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

/**
 * Inbound content links per page: how many distinct other active pages
 * link to or mention it. Parent-child containment (the sidebar tree) is
 * deliberately not a link - a page only reachable through the tree is
 * exactly the rot the orphan detector is after. Self-links don't count.
 */
export function inboundLinkCounts(
  pages: PageRecord[],
  outbound: ReadonlyMap<string, ReadonlySet<string>>
): Map<string, number> {
  const active = new Set(pages.filter((p) => !p.archived).map((p) => p.id));
  const inbound = new Map<string, number>();
  for (const [source, targets] of outbound) {
    if (!active.has(source)) continue;
    for (const target of targets) {
      if (target === source || !active.has(target)) continue;
      inbound.set(target, (inbound.get(target) ?? 0) + 1);
    }
  }
  return inbound;
}

/**
 * Orphaned pages: nothing in the workspace links to or mentions them.
 * Workspace roots and database rows are exempt - people reach those
 * directly through the sidebar or the database view. What remains is
 * pages whose only reachability is being a child in the tree, which is
 * containment, not a link.
 */
export function detectOrphans(
  pages: PageRecord[],
  inbound: ReadonlyMap<string, number>
): Finding[] {
  const findings: Finding[] = [];
  for (const page of pages) {
    if (page.archived) continue;
    if (page.parentType === "workspace" || page.parentType === "database_id") continue;
    if ((inbound.get(page.id) ?? 0) > 0) continue;
    findings.push({ kind: "orphan", page, detail: "Nothing links to or mentions this page" });
  }
  return findings;
}

/**
 * Hollow pages: no block content, but an active comment thread. The
 * content died and the discussion stayed behind. These are flags for a
 * human (the comments are worth reading first), so fix never archives
 * them.
 */
export function detectHollowPages(
  pages: PageRecord[],
  commentCounts: ReadonlyMap<string, number>
): Finding[] {
  const findings: Finding[] = [];
  for (const page of pages) {
    if (page.archived || page.hasChildren) continue;
    const comments = commentCounts.get(page.id) ?? 0;
    if (comments <= 0) continue;
    findings.push({
      kind: "hollow",
      page,
      detail: `No content, but ${comments} comment${comments === 1 ? "" : "s"} on it`,
    });
  }
  return findings;
}

/**
 * Databases with zero rows. Reported as flags only: archiving a database
 * is a different call than archiving a page, so fix never touches these.
 */
export function detectEmptyDatabases(databases: DatabaseRecord[]): Finding[] {
  const findings: Finding[] = [];
  for (const db of databases) {
    if (db.archived || !db.empty) continue;
    findings.push({
      kind: "empty_database",
      page: {
        id: db.id,
        title: db.title,
        url: db.url,
        parentType: "workspace",
        lastEditedTime: db.lastEditedTime,
        createdTime: db.lastEditedTime,
        archived: db.archived,
        hasChildren: false,
      },
      detail: "Database has no rows",
    });
  }
  return findings;
}

/**
 * One finding per page that links out to at least one dead URL. "Dead"
 * is strictly 404/410 - anything inconclusive (timeouts, 403 bot walls,
 * 5xx, offline) never produces a finding.
 */
export function deadLinkFindings(
  pages: PageRecord[],
  urlsByPage: ReadonlyMap<string, readonly string[]>,
  deadUrls: ReadonlySet<string>
): Finding[] {
  const findings: Finding[] = [];
  for (const page of pages) {
    if (page.archived) continue;
    const urls = urlsByPage.get(page.id) ?? [];
    const dead = [...new Set(urls.filter((u) => deadUrls.has(u)))];
    if (dead.length === 0) continue;
    const shown = dead.slice(0, 3);
    findings.push({
      kind: "dead_link",
      page,
      detail:
        `Dead link${dead.length === 1 ? "" : "s"}: ${shown.join(", ")}` +
        (dead.length > shown.length ? `, and ${dead.length - shown.length} more` : ""),
    });
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
