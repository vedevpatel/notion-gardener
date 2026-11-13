import { describe, expect, it } from "vitest";
import { checkLinks, type FetchLike } from "./linkcheck.js";

type Behavior = { HEAD?: number | "error"; GET?: number | "error" };

/** A fetch stand-in scripted per URL and method; records every call. */
function fakeFetch(script: Record<string, Behavior>) {
  const calls: { url: string; method: string }[] = [];
  const impl = (async (url: unknown, init?: { method?: string }) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: u, method });
    const behavior = script[u]?.[method as keyof Behavior];
    if (behavior === undefined || behavior === "error") throw new Error("network failed");
    return { status: behavior } as Response;
  }) as unknown as FetchLike;
  return { impl, calls };
}

describe("checkLinks", () => {
  it("calls 404 and 410 dead from HEAD alone", async () => {
    const { impl, calls } = fakeFetch({
      "https://gone.dev/a": { HEAD: 404 },
      "https://gone.dev/b": { HEAD: 410 },
    });
    const statuses = await checkLinks(["https://gone.dev/a", "https://gone.dev/b"], impl);
    expect(statuses.get("https://gone.dev/a")).toBe("dead");
    expect(statuses.get("https://gone.dev/b")).toBe("dead");
    expect(calls.every((c) => c.method === "HEAD")).toBe(true);
  });

  it("treats 2xx and 3xx as alive without a GET fallback", async () => {
    const { impl, calls } = fakeFetch({
      "https://ok.dev/a": { HEAD: 200 },
      "https://ok.dev/b": { HEAD: 301 },
    });
    const statuses = await checkLinks(["https://ok.dev/a", "https://ok.dev/b"], impl);
    expect(statuses.get("https://ok.dev/a")).toBe("alive");
    expect(statuses.get("https://ok.dev/b")).toBe("alive");
    expect(calls.some((c) => c.method === "GET")).toBe(false);
  });

  it("falls back to GET when HEAD is inconclusive", async () => {
    const { impl, calls } = fakeFetch({
      "https://picky.dev/a": { HEAD: 405, GET: 200 },
      "https://walled.dev/b": { HEAD: 403, GET: 404 },
      "https://flaky.dev/c": { HEAD: "error", GET: 200 },
    });
    const statuses = await checkLinks(
      ["https://picky.dev/a", "https://walled.dev/b", "https://flaky.dev/c"],
      impl
    );
    expect(statuses.get("https://picky.dev/a")).toBe("alive");
    expect(statuses.get("https://walled.dev/b")).toBe("dead");
    expect(statuses.get("https://flaky.dev/c")).toBe("alive");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(3);
  });

  it("never flags on an inconclusive or failed check", async () => {
    const { impl } = fakeFetch({
      "https://broken.dev/a": { HEAD: 500, GET: 500 },
      "https://down.dev/b": { HEAD: "error", GET: "error" },
      "https://walled.dev/c": { HEAD: 403, GET: 403 },
    });
    const statuses = await checkLinks(
      ["https://broken.dev/a", "https://down.dev/b", "https://walled.dev/c"],
      impl
    );
    expect([...statuses.values()]).toEqual(["unknown", "unknown", "unknown"]);
  });

  it("deduplicates and drops non-http(s) urls", async () => {
    const { impl, calls } = fakeFetch({ "https://a.dev/x": { HEAD: 200 } });
    const statuses = await checkLinks(
      ["https://a.dev/x", "https://a.dev/x", "ftp://old.dev/file", "mailto:a@b.c"],
      impl
    );
    expect(calls).toHaveLength(1);
    expect(statuses.size).toBe(1);
  });
});
