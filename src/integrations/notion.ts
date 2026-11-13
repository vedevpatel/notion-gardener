import { Client } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import type { PageRecord } from "../core/detectors.js";

/** True when the page has at least one content block or subpage. */
async function pageHasChildren(notion: Client, pageId: string): Promise<boolean> {
  const res = await notion.blocks.children.list({ block_id: pageId, page_size: 1 });
  return res.results.length > 0;
}

/**
 * Runs async checks over a list with bounded concurrency, preserving order.
 * Notion rate-limits at ~3 requests/second, so keep this low.
 */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

/**
 * Walks the whole workspace visible to the integration via the search
 * endpoint, then checks each active page for content (one lightweight
 * children.list call per page, so large workspaces take a bit).
 */
export async function fetchWorkspacePages(
  token: string,
  onProgress?: (fetched: number, total: number) => void
): Promise<PageRecord[]> {
  const notion = new Client({ auth: token });
  const raw: PageObjectResponse[] = [];
  let cursor: string | undefined = undefined;

  do {
    const res = await notion.search({
      filter: { property: "object", value: "page" },
      page_size: 100,
      start_cursor: cursor,
    });
    for (const result of res.results) {
      if (result.object !== "page" || !("properties" in result)) continue;
      raw.push(result);
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);

  // Archived pages are ignored by the detectors, so skip their content check.
  let checked = 0;
  const hasChildren = await mapPool(raw, 3, async (page) => {
    if (page.archived) return true;
    const result = await pageHasChildren(notion, page.id);
    checked++;
    onProgress?.(checked, raw.length);
    return result;
  });

  return raw.map((page, i) => {
    const title = Object.values(page.properties)
      .filter((prop) => prop.type === "title")
      .map((prop) => (prop.type === "title" ? prop.title.map((t) => t.plain_text).join("") : ""))
      .join("");
    return {
      id: page.id,
      title,
      url: page.url,
      parentType: page.parent.type,
      lastEditedTime: new Date(page.last_edited_time),
      createdTime: new Date(page.created_time),
      archived: page.archived,
      hasChildren: hasChildren[i],
    };
  });
}

export async function archivePage(token: string, pageId: string): Promise<void> {
  const notion = new Client({ auth: token });
  await notion.pages.update({ page_id: pageId, archived: true });
}
