import type { Finding, PageRecord } from "./detectors.js";
import { affectedPages } from "./detectors.js";
import { archivePage } from "./notion.js";

export interface FixOptions {
  /** Also archive stale pages. Untitled and empty pages are always included. */
  includeStale: boolean;
}

/**
 * Picks the pages an archive run would touch. Duplicates are never
 * auto-archived: which copy is the real one is a human's call.
 */
export function planArchives(findings: Finding[], opts: FixOptions): PageRecord[] {
  const kinds: Finding["kind"][] = ["untitled", "empty"];
  if (opts.includeStale) kinds.push("stale");
  return affectedPages(findings.filter((f) => kinds.includes(f.kind)));
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
