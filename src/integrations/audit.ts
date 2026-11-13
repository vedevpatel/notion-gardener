import {
  DEFAULT_STALE_DAYS,
  deadLinkFindings,
  detectEmptyDatabases,
  detectFindings,
  detectHollowPages,
  detectOrphans,
  type DatabaseRecord,
  type Finding,
  type PageRecord,
} from "../core/detectors.js";
import { scoreWorkspace } from "../core/report.js";
import {
  compileMatcher,
  EMPTY_CONFIG,
  type GardenerConfig,
  type Suppressed,
} from "../core/config.js";
import { diffDuplicates, type DuplicateComparison } from "../core/duplicates.js";
import { checkLinks, type FetchLike } from "./linkcheck.js";
import {
  clientFromToken,
  fetchCommentCounts,
  fetchDatabases,
  fetchWorkspacePages,
  gatherSignals,
  type NotionLike,
} from "./notion.js";

export interface AuditOptions {
  /** Explicit stale window (a CLI flag). Wins over config.staleDays. */
  staleDays?: number;
  /** Loaded .gardener.yml. Omitted = built-in defaults, no suppression. */
  config?: GardenerConfig;
  /**
   * Check external links over HTTP. Default true for scans; fix passes
   * false because dead links never feed the archive plan anyway.
   */
  checkExternalLinks?: boolean;
  /** Injectable for tests - no network in the suite. */
  notion?: NotionLike;
  /** Injectable for tests. */
  fetchImpl?: FetchLike;
  onProgress?: (phase: AuditPhase, done: number, total: number) => void;
}

export type AuditPhase = "content" | "databases" | "comments" | "links";

export interface AuditResult {
  pages: PageRecord[];
  databases: DatabaseRecord[];
  findings: Finding[];
  score: number;
  warnings: string[];
  /** Per-title diff for duplicate pages: what differs and what to do about it. */
  duplicateDiffs: DuplicateComparison[];
  /** Stale window actually used: flag, else config, else default. */
  staleDays: number;
  /** Findings hidden by the config (protected pages, ignore list). */
  suppressed: Suppressed;
}

/** External links checked per run at most, to bound wall-clock time. */
export const MAX_URLS_PER_SCAN = 500;

/**
 * The full audit: fetch the workspace, read every page's content for the
 * link graph and external URLs, check databases and comment threads, then
 * run every detector and score the result.
 */
export async function auditWorkspace(token: string, opts: AuditOptions = {}): Promise<AuditResult> {
  const notion = opts.notion ?? clientFromToken(token);
  const warnings: string[] = [];

  const pages = await fetchWorkspacePages(notion, { checkContent: false });
  const signals = await gatherSignals(notion, pages, (done, total) =>
    opts.onProgress?.("content", done, total)
  );

  const config = opts.config ?? EMPTY_CONFIG;
  const staleDays = opts.staleDays ?? config.staleDays ?? DEFAULT_STALE_DAYS;
  const isProtected = compileMatcher(config.protectedPages);
  const isIgnored = compileMatcher(config.ignore);

  const databases = await fetchDatabases(notion, (done, total) =>
    opts.onProgress?.("databases", done, total)
  );

  const comments = await fetchCommentCounts(notion, pages, (done, total) =>
    opts.onProgress?.("comments", done, total)
  );
  if (!comments.available) {
    warnings.push(
      "Could not read comments - skipped the hollow-page check. " +
        "Grant the integration comment access in Notion to enable it."
    );
  }

  let deadUrls = new Set<string>();
  if (opts.checkExternalLinks ?? true) {
    const unique = [...new Set([...signals.urlsByPage.values()].flat())];
    const capped = unique.slice(0, MAX_URLS_PER_SCAN);
    if (unique.length > capped.length) {
      warnings.push(
        `Found ${unique.length} external links; checked the first ${capped.length} this run.`
      );
    }
    if (capped.length > 0) {
      const statuses = await checkLinks(capped, opts.fetchImpl ?? fetch, {
        onProgress: (done, total) => opts.onProgress?.("links", done, total),
      });
      deadUrls = new Set(
        [...statuses.entries()].filter(([, s]) => s === "dead").map(([url]) => url)
      );
    }
  }

  const detect = (pageSet: PageRecord[], dbSet: DatabaseRecord[]): Finding[] => [
    ...detectFindings(pageSet, { staleDays }),
    // Link sources come from the whole workspace: a protected index page
    // still links to what it links to.
    ...detectOrphans(pageSet, signals.inbound),
    ...detectEmptyDatabases(dbSet),
    ...(comments.available ? detectHollowPages(pageSet, comments.counts) : []),
    ...deadLinkFindings(pageSet, signals.urlsByPage, deadUrls),
  ];

  // Protected pages are removed before detection, so they get no findings
  // and don't take part in duplicate grouping. The suppressed count is
  // what an unprotected run would have reported on them.
  const keptPages = pages.filter((p) => !isProtected(p));
  const keptDbs = databases.filter((d) => !isProtected(d));
  const unprotected = detect(pages, databases).filter((f) => isProtected(f.page)).length;
  const afterProtection = detect(keptPages, keptDbs);
  const findings = afterProtection.filter((f) => !isIgnored(f.page));
  const suppressed: Suppressed = {
    protected: unprotected,
    ignored: afterProtection.length - findings.length,
  };
  // A duplicate group stays in the diff while at least one copy is still
  // being reported; a group made only of ignored pages disappears.
  const duplicateDiffs = diffDuplicates(keptPages, signals.digests).filter((c) =>
    c.pages.some((p) => !isIgnored(p.page))
  );

  return {
    pages,
    databases,
    findings,
    score: scoreWorkspace(findings),
    warnings,
    duplicateDiffs,
    staleDays,
    suppressed,
  };
}
