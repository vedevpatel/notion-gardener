import type { Finding, PageRecord } from "./detectors.js";

export type FixChoice = "archive" | "skip" | "quit";

export interface WalkthroughItem {
  page: PageRecord;
  /** Human-readable reasons the page is in the archive plan. */
  issues: string[];
}

export interface WalkthroughResult {
  archive: PageRecord[];
  skipped: PageRecord[];
  /** False when the user quit before reaching the end of the plan. */
  completed: boolean;
}

/** Pairs each planned page with the finding details that put it in the plan. */
export function buildWalkthroughItems(plan: PageRecord[], findings: Finding[]): WalkthroughItem[] {
  return plan.map((page) => ({
    page,
    issues: findings.filter((f) => f.page.id === page.id).map((f) => f.detail),
  }));
}

/**
 * Walks the archive plan one page at a time, delegating each archive/skip
 * call to `choose`. The prompt layer lives in the CLI, so the decision flow
 * is fully testable with a scripted chooser. Duplicates never reach this
 * list - planArchives already excludes them.
 */
export async function walkthroughPlan(
  items: WalkthroughItem[],
  choose: (item: WalkthroughItem, index: number, total: number) => Promise<FixChoice>
): Promise<WalkthroughResult> {
  const result: WalkthroughResult = { archive: [], skipped: [], completed: true };
  for (let i = 0; i < items.length; i++) {
    const choice = await choose(items[i], i, items.length);
    if (choice === "quit") {
      result.completed = false;
      break;
    }
    if (choice === "archive") result.archive.push(items[i].page);
    else result.skipped.push(items[i].page);
  }
  return result;
}
