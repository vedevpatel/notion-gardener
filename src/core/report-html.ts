import { writeFileSync } from "node:fs";
import type { Finding, FindingKind, PageRecord } from "./detectors.js";
import type { Suppressed } from "./config.js";
import type { DuplicateComparison } from "./duplicates.js";

/**
 * A single-file, shareable HTML rendering of the audit report: inline
 * CSS, no scripts, no external assets. Everything dynamic is escaped -
 * page titles and details are user data and must never become markup.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const KIND_HEADINGS: Record<FindingKind, string> = {
  untitled: "Untitled pages",
  empty: "Empty pages",
  stale: "Stale pages",
  duplicate: "Duplicate titles",
  orphan: "Orphaned pages",
  dead_link: "Dead links",
  empty_database: "Empty databases",
  hollow: "Hollow pages",
};

/** Mirrors the markdown report: long groups truncate with a "+N more" line. */
const LIST_LIMIT = 25;

export interface HtmlReportOptions {
  staleDays: number;
  trend?: string | null;
  duplicateDiffs?: DuplicateComparison[];
  suppressed?: Suppressed;
  /** Fixed clock for tests; the generated-at line uses it verbatim. */
  generatedAt?: Date;
}

function formatDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function scoreClass(score: number): string {
  if (score >= 80) return "good";
  if (score >= 60) return "ok";
  return "bad";
}

const SUGGESTION_LABELS: Record<DuplicateComparison["suggestion"], string> = {
  keep_newest: "keep newest",
  keep_contentful: "keep the one with content",
  review: "review by hand",
};

function renderFindingItem(f: Finding): string {
  const label = f.page.title.trim() || "(untitled)";
  return (
    `<li><a href="${escapeHtml(f.page.url)}">${escapeHtml(label)}</a>` +
    `<span class="detail">${escapeHtml(f.detail)}</span></li>`
  );
}

function renderDuplicateSection(c: DuplicateComparison): string {
  const parts: string[] = [];
  parts.push(
    `<article class="dup"><h3>&ldquo;${escapeHtml(c.title)}&rdquo; ` +
      `<span class="count">${c.pages.length} copies</span></h3>`
  );
  parts.push(`<ul class="copies">`);
  for (const p of c.pages) {
    const label = p.page.title.trim() || "(untitled)";
    const stats = p.digest
      ? `${p.digest.charCount} chars, ${formatBlockMix(p.digest.blockTypes)}`
      : "content not read this run";
    parts.push(
      `<li><a href="${escapeHtml(p.page.url)}">${escapeHtml(label)}</a>` +
        `<span class="detail">edited ${formatDate(p.page.lastEditedTime)}, ${escapeHtml(stats)}</span></li>`
    );
  }
  parts.push(`</ul>`);
  parts.push(
    `<p class="suggestion"><span class="badge badge-${c.suggestion.replace(/_/g, "-")}">` +
      `${SUGGESTION_LABELS[c.suggestion]}</span> ${escapeHtml(c.suggestionText)}</p>`
  );
  if (c.differences.length > 0) {
    parts.push(`<ul class="diffs">`);
    for (const diff of c.differences) parts.push(`<li>${escapeHtml(diff)}</li>`);
    parts.push(`</ul>`);
  }
  parts.push(`</article>`);
  return parts.join("\n");
}

function formatBlockMix(blockTypes: Record<string, number>): string {
  const entries = Object.entries(blockTypes).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "no blocks";
  const shown = entries.slice(0, 4).map(([type, n]) => `${n} ${type.replace(/_/g, " ")}`);
  if (entries.length > shown.length) shown.push(`+${entries.length - shown.length} more types`);
  return shown.join(", ");
}

const CSS = `
:root {
  --bg: #f7f6f3; --fg: #1f2328; --muted: #656d76; --card: #ffffff;
  --border: #e3e1dc; --good: #1a7f37; --ok: #9a6700; --bad: #cf222e;
  --accent: #0969da;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --card: #161b22;
    --border: #30363d; --good: #3fb950; --ok: #d29922; --bad: #f85149;
    --accent: #58a6ff;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}
main { max-width: 760px; margin: 0 auto; padding: 48px 20px 64px; }
header { text-align: center; margin-bottom: 40px; }
h1 { font-size: 1.6rem; margin: 0 0 8px; }
.meta { color: var(--muted); margin: 0 0 24px; font-size: 0.9rem; }
.score {
  display: inline-flex; align-items: baseline; gap: 4px;
  padding: 16px 28px; border: 1px solid var(--border); border-radius: 16px;
  background: var(--card); margin-bottom: 12px;
}
.score .num { font-size: 3rem; font-weight: 700; line-height: 1; }
.score .denom { font-size: 1.2rem; color: var(--muted); }
.score.good .num { color: var(--good); }
.score.ok .num { color: var(--ok); }
.score.bad .num { color: var(--bad); }
.trend, .suppressed { color: var(--muted); margin: 4px 0; font-size: 0.95rem; }
section { margin-bottom: 32px; }
h2 { font-size: 1.15rem; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
.count { color: var(--muted); font-weight: 400; font-size: 0.85em; }
ul { margin: 8px 0; padding-left: 22px; }
li { margin: 4px 0; }
li .detail { color: var(--muted); display: block; font-size: 0.85rem; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.dup { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; margin: 12px 0; }
.dup h3 { margin: 0 0 8px; font-size: 1rem; }
.suggestion { margin: 10px 0 6px; font-size: 0.95rem; }
.badge {
  display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.75rem;
  font-weight: 600; margin-right: 6px; vertical-align: 1px;
}
.badge-keep-newest, .badge-keep-contentful { color: var(--good); border: 1px solid var(--good); }
.badge-review { color: var(--ok); border: 1px solid var(--ok); }
.diffs { color: var(--muted); font-size: 0.85rem; }
.clean {
  text-align: center; color: var(--good); border: 1px solid var(--good);
  border-radius: 12px; padding: 24px; font-weight: 600;
}
.more { color: var(--muted); font-size: 0.85rem; list-style: none; }
footer {
  margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border);
  color: var(--muted); font-size: 0.8rem; text-align: center;
}
`;

/**
 * Renders the full audit as one standalone HTML document. Same inputs as
 * the markdown report; the score, every finding, duplicate diffs and
 * config suppression counts all survive the trip to the browser.
 */
/**
 * Writes the rendered report to disk. Kept in this module so the CLI
 * stays a thin wrapper (and the write itself is test-covered).
 */
export function writeHtmlReport(path: string, html: string): void {
  writeFileSync(path, html, "utf8");
}

export function renderHtml(
  pages: PageRecord[],
  findings: Finding[],
  score: number,
  opts: HtmlReportOptions
): string {
  const active = pages.filter((p) => !p.archived);
  const generatedAt = opts.generatedAt ?? new Date();
  const body: string[] = [];

  body.push(`<header>`);
  body.push(`<h1>Notion workspace audit</h1>`);
  body.push(
    `<p class="meta">Generated ${escapeHtml(formatDateTime(generatedAt))} &middot; ` +
      `${active.length} active pages scanned` +
      (pages.length - active.length > 0 ? ` (${pages.length - active.length} archived)` : "") +
      `</p>`
  );
  body.push(
    `<div class="score ${scoreClass(score)}">` +
      `<span class="num">${score}</span><span class="denom">/100</span></div>`
  );
  if (opts.trend) body.push(`<p class="trend">Trend: ${escapeHtml(opts.trend)}</p>`);
  body.push(
    `<p class="trend">${findings.length} finding${findings.length === 1 ? "" : "s"}</p>`
  );
  const hidden = (opts.suppressed?.protected ?? 0) + (opts.suppressed?.ignored ?? 0);
  if (opts.suppressed && hidden > 0) {
    body.push(
      `<p class="suppressed">${hidden} finding${hidden === 1 ? "" : "s"} suppressed by config ` +
        `(${opts.suppressed.protected} on protected pages, ${opts.suppressed.ignored} ignored)</p>`
    );
  }
  body.push(`</header>`);

  for (const kind of Object.keys(KIND_HEADINGS) as FindingKind[]) {
    const group = findings.filter((f) => f.kind === kind);
    if (group.length === 0) continue;
    const heading =
      kind === "stale" ? `${KIND_HEADINGS[kind]} (&gt;${opts.staleDays} days)` : KIND_HEADINGS[kind];
    body.push(`<section data-kind="${kind}">`);
    body.push(`<h2>${heading} <span class="count">${group.length}</span></h2>`);
    if (kind === "duplicate" && opts.duplicateDiffs && opts.duplicateDiffs.length > 0) {
      for (const c of opts.duplicateDiffs) body.push(renderDuplicateSection(c));
    } else {
      body.push(`<ul>`);
      for (const f of group.slice(0, LIST_LIMIT)) body.push(renderFindingItem(f));
      if (group.length > LIST_LIMIT) {
        body.push(`<li class="more">&hellip;and ${group.length - LIST_LIMIT} more</li>`);
      }
      body.push(`</ul>`);
    }
    body.push(`</section>`);
  }

  if (findings.length === 0) {
    body.push(`<p class="clean">No findings. This workspace is clean.</p>`);
  }

  body.push(
    `<footer>Generated by <a href="https://github.com/vedevpatel/notion-gardener">notion-gardener</a>. ` +
      `Suggestions are advisory - nothing was changed by this report.</footer>`
  );

  return [
    "<!doctype html>",
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>Notion workspace audit - ${score}/100</title>`,
    `<style>${CSS}</style>`,
    `</head>`,
    `<body>`,
    `<main>`,
    body.join("\n"),
    `</main>`,
    `</body>`,
    `</html>`,
    "",
  ].join("\n");
}
