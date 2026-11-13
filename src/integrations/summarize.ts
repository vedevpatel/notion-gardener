import type { Finding } from "../core/detectors.js";

export interface Cluster {
  label: string;
  findings: Finding[];
}

export interface ClusterSummary extends Cluster {
  summary?: string;
}

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_CLUSTERS = 12;

/**
 * LLM settings from the environment. Any OpenAI-compatible endpoint works.
 * Returns null when no key is set: summaries are optional, so a missing key
 * is a silent skip rather than an error.
 */
export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: env.OPENAI_MODEL ?? DEFAULT_MODEL,
  };
}

const STOP_WORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "notes",
  "note",
  "page",
  "pages",
  "untitled",
  "misc",
]);

/** Words worth clustering on: lowercase, alphanumeric, long enough to mean something. */
export function significantTokens(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));
}

class UnionFind {
  private parent: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }

  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }

  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }
}

/**
 * Groups stale and duplicate findings into clusters a human can judge at a
 * glance. Pages sharing a title always land together; otherwise pages join
 * when their titles share a significant word. Untitled and empty findings
 * are excluded: there's nothing to deliberate about, fix already handles
 * them.
 */
export function clusterFindings(findings: Finding[]): Cluster[] {
  const candidates = findings.filter((f) => f.kind === "stale" || f.kind === "duplicate");
  const pageById = new Map(candidates.map((f) => [f.page.id, f.page]));
  const pageIds = [...pageById.keys()];
  const index = new Map(pageIds.map((id, i) => [id, i]));
  const uf = new UnionFind(pageIds.length);

  const byTitle = new Map<string, number>();
  const byToken = new Map<string, number>();
  for (const [id, i] of index) {
    const page = pageById.get(id);
    if (!page) continue;
    const title = page.title.trim().toLowerCase().replace(/\s+/g, " ");
    if (title) {
      const first = byTitle.get(title);
      if (first === undefined) byTitle.set(title, i);
      else uf.union(first, i);
    }
    for (const token of significantTokens(page.title)) {
      const first = byToken.get(token);
      if (first === undefined) byToken.set(token, i);
      else uf.union(first, i);
    }
  }

  const groups = new Map<number, Finding[]>();
  for (const f of candidates) {
    const i = index.get(f.page.id);
    if (i === undefined) continue;
    const root = uf.find(i);
    const group = groups.get(root) ?? [];
    group.push(f);
    groups.set(root, group);
  }

  const clusters = [...groups.values()].map((group) => ({
    label: clusterLabel(group),
    findings: group.sort((a, b) => a.page.title.localeCompare(b.page.title)),
  }));
  clusters.sort((a, b) => b.findings.length - a.findings.length);
  return clusters.slice(0, MAX_CLUSTERS);
}

function clusterLabel(findings: Finding[]): string {
  const dup = findings.find((f) => f.kind === "duplicate");
  if (dup && dup.page.title.trim()) return `"${dup.page.title.trim()}" duplicates`;
  const counts = new Map<string, number>();
  for (const f of findings) {
    for (const token of significantTokens(f.page.title)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? `${top[0]} pages` : "misc pages";
}

export function buildSummaryPrompt(clusters: Cluster[]): string {
  const lines = ["These clusters come from a Notion workspace audit. Summarize each one.", ""];
  clusters.forEach((cluster, i) => {
    lines.push(`${i + 1}. ${cluster.label} (${cluster.findings.length} findings):`);
    for (const f of cluster.findings.slice(0, 15)) {
      const title = f.page.title.trim() || "(untitled)";
      lines.push(`   - ${title} - ${f.detail}`);
    }
  });
  return lines.join("\n");
}

/** Splits "1. ... 2. ..." model output back into per-cluster text. */
export function splitNumbered(text: string, count: number): (string | undefined)[] {
  const out: (string | undefined)[] = new Array(count).fill(undefined);
  const matches = [...text.matchAll(/^(\d+)[.)]\s*/gm)];
  for (let i = 0; i < matches.length; i++) {
    const n = Number(matches[i][1]);
    if (n < 1 || n > count) continue;
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    out[n - 1] = text.slice(start, end).trim();
  }
  return out;
}

const SYSTEM_PROMPT =
  "You summarize clusters of stale and duplicated pages from a Notion workspace audit. " +
  "For each numbered cluster, write one or two short sentences: what the pages look like " +
  "and whether they read as safe to archive or worth a human look first. " +
  "Plain language, no markdown. Number your answers to match the clusters.";

export type FetchLike = typeof fetch;

/**
 * One chat completion for all clusters. Any failure (bad key, rate limit,
 * offline) returns the clusters unsummarized; the plain report still works.
 */
export async function summarizeClusters(
  clusters: Cluster[],
  config: LlmConfig,
  fetchImpl: FetchLike = fetch
): Promise<ClusterSummary[]> {
  if (clusters.length === 0) return [];
  let text: string;
  try {
    const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.3,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildSummaryPrompt(clusters) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`llm request failed: ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    text = data.choices?.[0]?.message?.content ?? "";
  } catch {
    return clusters.map((c) => ({ ...c }));
  }
  const parts = splitNumbered(text, clusters.length);
  return clusters.map((cluster, i) => ({ ...cluster, summary: parts[i] }));
}

/** Markdown lines for the report's cluster section. */
export function renderClusterMarkdown(summaries: ClusterSummary[]): string[] {
  const lines: string[] = ["## Cluster summaries", ""];
  for (const cluster of summaries) {
    lines.push(`### ${cluster.label} — ${cluster.findings.length} findings`);
    lines.push("");
    lines.push(cluster.summary ?? "(no summary)");
    lines.push("");
  }
  return lines;
}
