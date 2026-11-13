import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Finding, FindingKind, PageRecord } from "./detectors.js";
import { diffDuplicates, makeDigest } from "./duplicates.js";
import { escapeHtml, renderHtml } from "./report-html.js";

function pageFor(id: string, overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    id,
    title: `Page ${id}`,
    url: `https://notion.so/${id}`,
    parentType: "workspace",
    lastEditedTime: new Date("2026-11-01T00:00:00Z"),
    createdTime: new Date("2026-10-01T00:00:00Z"),
    archived: false,
    hasChildren: true,
    ...overrides,
  };
}

function finding(kind: FindingKind, id = "p1", detail = "some detail"): Finding {
  return { kind, page: pageFor(id), detail };
}

const AT = new Date("2026-11-12T21:30:00Z");

function render(findings: Finding[], pages: PageRecord[] = [pageFor("p1")], score = 90) {
  return renderHtml(pages, findings, score, { staleDays: 90, generatedAt: AT });
}

describe("renderHtml", () => {
  it("is one standalone document: no scripts, no external stylesheets, inline CSS", () => {
    const html = render([finding("empty")]);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("src=");
    expect(html).toContain("<style>");
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("escapes user-controlled titles so a hostile title cannot inject markup", () => {
    const evil = pageFor("evil", { title: `<img src=x onerror=alert(1)>` });
    const html = render([{ kind: "empty", page: evil, detail: "x" }], [evil]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain(escapeHtml(`<img src=x onerror=alert(1)>`));
  });

  it("escapes user-controlled details and URLs", () => {
    const evil = pageFor("evil", { url: `https://notion.so/x"><script>alert(1)</script>` });
    const html = render(
      [{ kind: "stale", page: evil, detail: `<b>not bold</b>` }],
      [evil]
    );
    expect(html).not.toContain(`<script>alert(1)</script>`);
    expect(html).not.toContain(`<b>not bold</b>`);
    expect(html).toContain("&lt;b&gt;not bold&lt;/b&gt;");
    expect(html).toContain(escapeHtml(`https://notion.so/x"><script>alert(1)</script>`));
  });

  it("renders the score, page counts and generated time in the header", () => {
    const archived = pageFor("arch", { archived: true });
    const html = renderHtml([pageFor("p1"), archived], [], 84, {
      staleDays: 90,
      generatedAt: AT,
    });
    expect(html).toContain(`<span class="num">84</span><span class="denom">/100</span>`);
    expect(html).toContain("1 active pages scanned (1 archived)");
    expect(html).toContain("2026-11-12 21:30 UTC");
    expect(html).toContain("0 findings");
  });

  it("colors the score by health: 80+ good, 60-79 ok, below 60 bad", () => {
    const page = pageFor("p1");
    for (const [score, cls] of [
      [100, "good"],
      [80, "good"],
      [79, "ok"],
      [60, "ok"],
      [59, "bad"],
      [0, "bad"],
    ] as const) {
      expect(renderHtml([page], [], score, { staleDays: 90 })).toContain(
        `class="score ${cls}"`
      );
    }
  });

  it("groups findings under their kind sections and omits empty kinds", () => {
    const html = renderHtml(
      [pageFor("p1"), pageFor("p2")],
      [
        { kind: "empty", page: pageFor("p1"), detail: "no content" },
        { kind: "untitled", page: pageFor("p2", { title: "  " }), detail: "no title" },
      ],
      92,
      { staleDays: 90, generatedAt: AT }
    );
    expect(html).toContain(`<section data-kind="empty">`);
    expect(html).toContain(`<section data-kind="untitled">`);
    expect(html).not.toContain(`data-kind="orphan"`);
    expect(html).not.toContain(`data-kind="dead_link"`);
    expect(html).toContain("no content");
    // Untitled pages get a readable label, not an empty link.
    expect(html).toContain("(untitled)");
    expect(html).toContain(`<h2>Empty pages <span class="count">1</span></h2>`);
  });

  it("uses the configured stale window in the stale heading", () => {
    const html = renderHtml([pageFor("p1")], [finding("stale")], 99, {
      staleDays: 30,
      generatedAt: AT,
    });
    expect(html).toContain("Stale pages (&gt;30 days)");
    expect(html).not.toContain("90 days");
  });

  it("shows the trend when one is passed and omits it otherwise", () => {
    const withTrend = renderHtml([pageFor("p1")], [], 100, {
      staleDays: 90,
      trend: "improving (+6 over 3 scans)",
      generatedAt: AT,
    });
    expect(withTrend).toContain("Trend: improving (+6 over 3 scans)");
    const without = render([], []);
    expect(without).not.toContain("Trend:");
  });

  it("shows config suppression counts only when something was suppressed", () => {
    const page = pageFor("p1");
    const withSuppressed = renderHtml([page], [finding("empty")], 97, {
      staleDays: 90,
      suppressed: { protected: 2, ignored: 3 },
      generatedAt: AT,
    });
    expect(withSuppressed).toContain(
      "5 findings suppressed by config (2 on protected pages, 3 ignored)"
    );
    const none = render([finding("empty")]);
    expect(none).not.toContain("suppressed by config");
  });

  it("renders duplicate diffs: copies, suggestion and differences", () => {
    const a = pageFor("a", { title: "Reading List" });
    const b = pageFor("b", {
      title: "Reading List",
      lastEditedTime: new Date("2026-09-15T00:00:00Z"),
    });
    const digests = new Map([
      ["a", makeDigest("the latest recommendations and notes", { paragraph: 3 })],
      ["b", makeDigest("the latest recommendations and notes", { paragraph: 2 })],
    ]);
    const comparisons = diffDuplicates([a, b], digests);
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0].suggestion).toBe("keep_newest");

    const html = renderHtml([a, b], [finding("duplicate", "a"), finding("duplicate", "b")], 96, {
      staleDays: 90,
      duplicateDiffs: comparisons,
      generatedAt: AT,
    });
    expect(html).toContain(`&ldquo;Reading List&rdquo;`);
    expect(html).toContain("2 copies");
    expect(html).toContain("badge-keep-newest");
    expect(html).toContain(comparisons[0].suggestionText);
    for (const diff of comparisons[0].differences) {
      expect(html).toContain(escapeHtml(diff));
    }
  });

  it("falls back to a plain duplicate list when no diffs were computed", () => {
    const html = renderHtml(
      [pageFor("p1")],
      [finding("duplicate", "p1", "2 pages share this title")],
      98,
      { staleDays: 90, generatedAt: AT }
    );
    expect(html).toContain("2 pages share this title");
    expect(html).not.toContain(`<span class="badge`);
  });

  it("truncates long groups at 25 with a count of what is hidden", () => {
    const group = Array.from({ length: 30 }, (_, i) =>
      finding("stale", `p${i}`, "not edited recently")
    );
    const pages = group.map((f) => f.page);
    const html = renderHtml(pages, group, 70, { staleDays: 90, generatedAt: AT });
    expect(html).toContain("&hellip;and 5 more");
    // Exactly 25 rendered items in the stale list, not 30 and not 24.
    const items = html.match(/not edited recently/g) ?? [];
    expect(items).toHaveLength(25);
  });

  it("says the workspace is clean when there are no findings", () => {
    const html = render([], []);
    expect(html).toContain("No findings. This workspace is clean.");
  });
});

describe("escapeHtml", () => {
  it("escapes all five markup-significant characters", () => {
    expect(escapeHtml(`a & b < c > d " e ' f`)).toBe(
      "a &amp; b &lt; c &gt; d &quot; e &#39; f"
    );
  });
});

describe("CLI --html flag", () => {
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

  function run(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, NOTION_TOKEN: "" },
    });
  }

  it("accepts --html on scan (fails later on the missing token, not on the flag)", () => {
    const result = run(["scan", "--html", join(tmpdir(), "gardener-test-report.html")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No Notion token");
    expect(result.stderr).not.toContain("Unknown flag");
  });

  it("rejects --html without a path", () => {
    const result = run(["scan", "--html"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--html needs a path");
  });

  it("still rejects unknown flags", () => {
    const result = run(["scan", "--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown flag: --bogus");
  });
});

describe("writeHtmlReport", () => {
  it("writes the document to disk where the CLI can reach it", async () => {
    const { writeHtmlReport } = await import("./report-html.js");
    const target = join(tmpdir(), `gardener-html-${Date.now()}.html`);
    try {
      writeHtmlReport(target, render([]));
      expect(existsSync(target)).toBe(true);
      const written = readFileSync(target, "utf8");
      expect(written.startsWith("<!doctype html>")).toBe(true);
      expect(written).toContain("Notion workspace audit");
    } finally {
      rmSync(target, { force: true });
    }
  });
});
