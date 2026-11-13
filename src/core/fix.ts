import type { Finding, PageRecord } from "./detectors.js";
import { affectedPages } from "./detectors.js";
import type { PageMatcher } from "./config.js";
import { archivePage } from "../integrations/notion.js";

export interface FixOptions {
  /** Also archive stale pages. Untitled and empty pages are always included. */
  includeStale: boolean;
  /**
   * Hard guard for protected pages (from .gardener.yml). The audit already
   * keeps them out of the findings; this refuses them again here so no
   * caller can plan an archive of a protected page.
   */
  isProtected?: PageMatcher;
}

/**
 * Picks the pages an archive run would touch. Duplicates, dead links,
 * hollow pages and empty databases are never auto-archived: which copy
 * of a duplicate is real is a human's call, dead links and hollow pages
 * are flags for judgment (the comments may matter), and databases can't
 * be archived through the pages API anyway.
 */
export function planArchives(findings: Finding[], opts: FixOptions): PageRecord[] {
  const kinds: Finding["kind"][] = ["untitled", "empty", "orphan"];
  if (opts.includeStale) kinds.push("stale");
  const { isProtected } = opts;
  return affectedPages(findings.filter((f) => kinds.includes(f.kind))).filter(
    (p) => !isProtected?.(p)
  );
}

export interface ApplyResult {
  archived: PageRecord[];
  failed: { page: PageRecord; error: string }[];
}

export async function applyArchives(
  token: string,
  pages: PageRecord[],
  onProgress?: (done: number, total: number) => void
): Promise<ApplyResult> {
  const result: ApplyResult = { archived: [], failed: [] };
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    try {
      await archivePage(token, page.id);
      result.archived.push(page);
    } catch (err) {
      result.failed.push({ page, error: err instanceof Error ? err.message : String(err) });
    }
    onProgress?.(i + 1, pages.length);
  }
  return result;
}
