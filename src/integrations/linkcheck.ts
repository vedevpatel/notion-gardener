import { mapPool } from "./notion.js";

export type LinkStatus = "alive" | "dead" | "unknown";
export type FetchLike = typeof fetch;

export interface CheckLinksOptions {
  concurrency?: number;
  timeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * One URL. HEAD first; anything inconclusive falls back to GET. "Dead" is
 * strictly 404/410 from either method - 403 bot walls, 5xx, rate limits,
 * timeouts and offline errors all come back "unknown" and never produce a
 * finding. A flaky network must not flag links.
 */
async function checkOne(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<LinkStatus> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await fetchImpl(url, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404 || res.status === 410) return "dead";
      if (res.status >= 200 && res.status < 400) return "alive";
      if (method === "GET") return "unknown";
      // Inconclusive HEAD (405, 403, 5xx): some servers refuse HEAD but
      // answer GET fine, so fall through and try it.
    } catch {
      if (method === "GET") return "unknown";
      // HEAD failed outright (DNS, timeout, refused): try GET once.
    }
  }
  return "unknown";
}

/**
 * Checks a batch of external URLs, deduplicated, non-http(s) entries
 * dropped. Bounded concurrency and a short per-request timeout keep a run
 * over a big workspace quick.
 */
export async function checkLinks(
  urls: readonly string[],
  fetchImpl: FetchLike = fetch,
  opts: CheckLinksOptions = {}
): Promise<Map<string, LinkStatus>> {
  const unique = [...new Set(urls.filter((u) => /^https?:\/\//i.test(u)))];
  const concurrency = opts.concurrency ?? 5;
  const timeoutMs = opts.timeoutMs ?? 5000;
  let done = 0;
  const statuses = await mapPool(unique, concurrency, async (url) => {
    const status = await checkOne(fetchImpl, url, timeoutMs);
    done++;
    opts.onProgress?.(done, unique.length);
    return status;
  });
  return new Map(unique.map((url, i) => [url, statuses[i]]));
}
