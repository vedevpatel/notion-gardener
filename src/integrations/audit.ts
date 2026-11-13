import {
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
  staleDays?: number;
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

  const findings = detectFindings(pages, { staleDays: opts.staleDays });
  findings.push(...detectOrphans(pages, signals.inbound));

  const databases = await fetchDatabases(notion, (done, total) =>
    opts.onProgress?.("databases", done, total)
  );
  findings.push(...detectEmptyDatabases(databases));

  const comments = await fetchCommentCounts(notion, pages, (done, total) =>
    opts.onProgress?.("comments", done, total)
  );
  if (comments.available) {
    findings.push(...detectHollowPages(pages, comments.counts));
  } else {
    warnings.push(
      "Could not read comments - skipped the hollow-page check. " +
        "Grant the integration comment access in Notion to enable it."
    );
  }

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
      const dead = new Set(
        [...statuses.entries()].filter(([, s]) => s === "dead").map(([url]) => url)
      );
      findings.push(...deadLinkFindings(pages, signals.urlsByPage, dead));
    }
  }

  return { pages, databases, findings, score: scoreWorkspace(findings), warnings };
}
