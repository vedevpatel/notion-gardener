import { Client } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import {
  inboundLinkCounts,
  type DatabaseRecord,
  type PageRecord,
} from "../core/detectors.js";
import { makeDigest, type ContentDigest } from "../core/duplicates.js";

/**
 * The slice of the Notion client the audit uses. Structural, so tests can
 * drive every fetcher with a fake - no network anywhere in the test suite.
 */
export interface NotionLike {
  search(args: Record<string, unknown>): Promise<NotionListResponse>;
  blocks: { children: { list(args: Record<string, unknown>): Promise<NotionListResponse> } };
  databases: { query(args: Record<string, unknown>): Promise<NotionListResponse> };
  comments: { list(args: Record<string, unknown>): Promise<NotionListResponse> };
}

export interface NotionListResponse {
  results: unknown[];
  has_more: boolean;
  next_cursor: string | null;
}

export function clientFromToken(token: string): NotionLike {
  return new Client({ auth: token }) as unknown as NotionLike;
}

/** True when the page has at least one content block or subpage. */
async function pageHasChildren(notion: NotionLike, pageId: string): Promise<boolean> {
  const res = await notion.blocks.children.list({ block_id: pageId, page_size: 1 });
  return res.results.length > 0;
}

/**
 * Runs async checks over a list with bounded concurrency, preserving order.
 * Notion rate-limits at ~3 requests/second, so keep this low.
 */
export async function mapPool<T, R>(
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

export interface FetchPagesOptions {
  /**
   * Check each active page for content with a lightweight children.list
   * call. Default true. Pass false when the caller is about to fetch full
   * block content anyway (the audit does, for link extraction) and will
   * derive hasChildren itself.
   */
  checkContent?: boolean;
  onProgress?: (fetched: number, total: number) => void;
}

/**
 * Walks the whole workspace visible to the integration via the search
 * endpoint. With checkContent on (the default), each active page also gets
 * one lightweight children.list call for the empty-page detector, so large
 * workspaces take a bit.
 */
export async function fetchWorkspacePages(
  notion: NotionLike,
  opts: FetchPagesOptions = {}
): Promise<PageRecord[]> {
  const checkContent = opts.checkContent ?? true;
  const raw: PageObjectResponse[] = [];
  let cursor: string | undefined = undefined;

  do {
    const res = await notion.search({
      filter: { property: "object", value: "page" },
      page_size: 100,
      start_cursor: cursor,
    });
    for (const result of res.results as PageObjectResponse[]) {
      if (result.object !== "page" || !("properties" in result)) continue;
      raw.push(result);
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);

  // Archived pages are ignored by the detectors, so skip their content check.
  let checked = 0;
  const hasChildren = checkContent
    ? await mapPool(raw, 3, async (page) => {
        if (page.archived) return true;
        const result = await pageHasChildren(notion, page.id);
        checked++;
        opts.onProgress?.(checked, raw.length);
        return result;
      })
    : raw.map(() => true);

  return raw.map((page, i) => {
    const title = Object.values(page.properties)
      .filter((prop) => prop.type === "title")
      .map((prop) => (prop.type === "title" ? prop.title.map((t) => t.plain_text).join("") : ""))
      .join("");
    const parent = page.parent;
    return {
      id: page.id,
      title,
      url: page.url,
      parentType: parent.type,
      parentId:
        parent.type === "page_id"
          ? parent.page_id
          : parent.type === "block_id"
            ? parent.block_id
            : parent.type === "database_id"
              ? parent.database_id
              : null,
      lastEditedTime: new Date(page.last_edited_time),
      createdTime: new Date(page.created_time),
      archived: page.archived,
      hasChildren: hasChildren[i],
    };
  });
}

export interface BlockSignals {
  /** Page ids the content links to or mentions. Containment is not a link. */
  pageRefs: Set<string>;
  /** External http(s) URLs found in the content, deduplicated. */
  urls: string[];
}

const MAX_URLS_PER_PAGE = 50;

/** Internal links arrive as page refs, not as URLs to dead-check. */
const NOTION_HOST = /^https?:\/\/([^/]+\.)?(notion\.so|notion\.site)(\/|$)/i;

/**
 * Pulls the audit signals out of one page's blocks (API response shapes):
 * mentions and link_to_page blocks become page references, and external
 * URLs come from rich-text hrefs, bookmarks, embeds and link previews.
 *
 * child_page blocks are skipped on purpose: a subpage is containment (the
 * sidebar tree), not a link. Media blocks (image/file/video/pdf) are also
 * skipped: Notion-hosted files use expiring signed URLs, which are noise
 * for a dead-link check.
 */
export function extractBlockSignals(blocks: unknown[]): BlockSignals {
  const pageRefs = new Set<string>();
  const urls: string[] = [];
  const addUrl = (u: unknown): void => {
    if (typeof u !== "string" || !/^https?:\/\//i.test(u)) return;
    if (NOTION_HOST.test(u)) return;
    if (urls.length < MAX_URLS_PER_PAGE && !urls.includes(u)) urls.push(u);
  };
  const walkRichText = (richText: unknown): void => {
    if (!Array.isArray(richText)) return;
    for (const rt of richText as any[]) {
      if (typeof rt?.href === "string") addUrl(rt.href);
      else if (typeof rt?.text?.link?.url === "string") addUrl(rt.text.link.url);
      if (rt?.type === "mention" && rt?.mention?.type === "page") {
        const id = rt.mention.page?.id;
        if (typeof id === "string") pageRefs.add(id);
      }
      if (rt?.type === "mention" && rt?.mention?.type === "link_preview") {
        addUrl(rt.mention.link_preview?.url);
      }
    }
  };
  for (const raw of blocks as any[]) {
    const type = raw?.type;
    if (typeof type !== "string") continue;
    const body = raw[type];
    if (!body || typeof body !== "object") continue;
    walkRichText(body.rich_text);
    if (type === "bookmark" || type === "embed" || type === "link_preview") {
      addUrl(body.url);
    }
    if (type === "link_to_page" && typeof body.page_id === "string") {
      pageRefs.add(body.page_id);
    }
  }
  return { pageRefs, urls };
}

/**
 * All top-level blocks of a page, paginated. Nested blocks (inside toggles
 * or columns) are not walked - depth one keeps the scan affordable and
 * catches the links people actually leave lying around.
 */
async function listAllBlocks(notion: NotionLike, pageId: string): Promise<unknown[]> {
  const blocks: unknown[] = [];
  let cursor: string | undefined = undefined;
  do {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      start_cursor: cursor,
    });
    blocks.push(...res.results);
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  return blocks;
}

/**
 * Fingerprint a page's content for the duplicate diff: the text of every
 * block (rich text and child page/database titles) plus the block-type
 * mix. Same block shapes as extractBlockSignals.
 */
export function digestBlocks(blocks: unknown[]): ContentDigest {
  const blockTypes: Record<string, number> = {};
  const texts: string[] = [];
  for (const raw of blocks as any[]) {
    const type = raw?.type;
    if (typeof type !== "string") continue;
    blockTypes[type] = (blockTypes[type] ?? 0) + 1;
    const body = raw[type];
    if (!body || typeof body !== "object") continue;
    if (Array.isArray(body.rich_text)) {
      for (const rt of body.rich_text as any[]) {
        if (typeof rt?.plain_text === "string") texts.push(rt.plain_text);
      }
    }
    // child_page / child_database carry their title on the block itself.
    if (typeof body.title === "string") texts.push(body.title);
  }
  return makeDigest(texts.join("\n"), blockTypes);
}

export interface WorkspaceSignals {
  /** Page id -> number of distinct other active pages that link to it. */
  inbound: Map<string, number>;
  /** Page id -> external URLs found in its content. */
  urlsByPage: Map<string, string[]>;
  /** Page id -> content fingerprint, for the duplicate diff. */
  digests: Map<string, ContentDigest>;
}

/**
 * Reads every active page's content (three at a time, per Notion's rate
 * limit), fills in hasChildren, and builds the workspace link graph plus
 * the external URL list.
 */
export async function gatherSignals(
  notion: NotionLike,
  pages: PageRecord[],
  onProgress?: (done: number, total: number) => void
): Promise<WorkspaceSignals> {
  const active = pages.filter((p) => !p.archived);
  let done = 0;
  const signals = await mapPool(active, 3, async (page) => {
    const blocks = await listAllBlocks(notion, page.id);
    page.hasChildren = blocks.length > 0;
    done++;
    onProgress?.(done, active.length);
    return { links: extractBlockSignals(blocks), digest: digestBlocks(blocks) };
  });
  const outbound = new Map<string, ReadonlySet<string>>();
  const urlsByPage = new Map<string, string[]>();
  const digests = new Map<string, ContentDigest>();
  active.forEach((page, i) => {
    outbound.set(page.id, signals[i].links.pageRefs);
    if (signals[i].links.urls.length > 0) urlsByPage.set(page.id, signals[i].links.urls);
    digests.set(page.id, signals[i].digest);
  });
  return { inbound: inboundLinkCounts(pages, outbound), urlsByPage, digests };
}

/**
 * Every database the integration can see, with an emptiness flag from a
 * one-row query (we only need to know whether ANY row exists).
 */
export async function fetchDatabases(
  notion: NotionLike,
  onProgress?: (done: number, total: number) => void
): Promise<DatabaseRecord[]> {
  const raw: any[] = [];
  let cursor: string | undefined = undefined;
  do {
    const res = await notion.search({
      filter: { property: "object", value: "database" },
      page_size: 100,
      start_cursor: cursor,
    });
    for (const result of res.results as any[]) {
      if (result?.object === "database") raw.push(result);
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);

  let done = 0;
  const empty = await mapPool(raw, 3, async (db) => {
    if (db.archived) return false;
    const res = await notion.databases.query({ database_id: db.id, page_size: 1 });
    done++;
    onProgress?.(done, raw.length);
    return res.results.length === 0;
  });

  return raw.map((db, i) => ({
    id: db.id,
    title: (Array.isArray(db.title) ? db.title : [])
      .map((t: any) => (typeof t?.plain_text === "string" ? t.plain_text : ""))
      .join(""),
    url: typeof db.url === "string" ? db.url : "",
    lastEditedTime: new Date(db.last_edited_time),
    archived: Boolean(db.archived),
    empty: empty[i],
  }));
}

export interface CommentScan {
  /** Page id -> comment count. Only childless active pages are queried. */
  counts: Map<string, number>;
  /**
   * False when the integration can't read comments (the capability is
   * off, or every call fails): hollow-page detection is skipped entirely
   * rather than guessed.
   */
  available: boolean;
}

/**
 * Comment counts for pages that have no content - the hollow-page signal.
 * Only the first page of comments is fetched; the detector just needs to
 * know the thread isn't empty. One failure disables the whole check:
 * capability errors hit every page, and a flaky network should never
 * produce hollow findings.
 */
export async function fetchCommentCounts(
  notion: NotionLike,
  pages: PageRecord[],
  onProgress?: (done: number, total: number) => void
): Promise<CommentScan> {
  const candidates = pages.filter((p) => !p.archived && !p.hasChildren);
  const counts = new Map<string, number>();
  let available = true;
  let done = 0;
  await mapPool(candidates, 3, async (page) => {
    if (!available) return;
    try {
      const res = await notion.comments.list({ block_id: page.id, page_size: 100 });
      counts.set(page.id, res.results.length);
    } catch {
      available = false;
      counts.clear();
    }
    done++;
    onProgress?.(done, candidates.length);
  });
  return { counts: available ? counts : new Map(), available };
}

export async function archivePage(token: string, pageId: string): Promise<void> {
  const notion = new Client({ auth: token });
  await notion.pages.update({ page_id: pageId, archived: true });
}
