#!/usr/bin/env node
import readline from "node:readline/promises";
import { DEFAULT_STALE_DAYS } from "./core/detectors.js";
import { CONFIG_FILENAME, ConfigError, compileMatcher, loadConfig, resolveStaleDays } from "./core/config.js";
import { auditWorkspace, type AuditPhase } from "./integrations/audit.js";
import { renderJson, renderMarkdown } from "./core/report.js";
import { renderHtml, writeHtmlReport } from "./core/report-html.js";
import { applyArchives, planArchives } from "./core/fix.js";
import {
  appendHistory,
  formatShortDate,
  formatTrend,
  makeEntry,
  readHistory,
  HISTORY_FILENAME,
} from "./core/history.js";
import {
  buildWalkthroughItems,
  walkthroughPlan,
} from "./core/interactive.js";
import { makeChooser } from "./integrations/prompt.js";
import {
  clusterFindings,
  renderClusterMarkdown,
  resolveLlmConfig,
  summarizeClusters,
  type ClusterSummary,
} from "./integrations/summarize.js";

interface Flags {
  json: boolean;
  apply: boolean;
  includeStale: boolean;
  summarize: boolean;
  interactive: boolean;
  yes: boolean;
  token?: string;
  /** Only set when --stale-days is passed; flag > config > STALE_DAYS env > default. */
  staleDays?: number;
  config?: string;
  /** Path for the standalone HTML report (scan only). */
  html?: string;
}

function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const [command = "help", ...rest] = argv;
  const flags: Flags = {
    json: false,
    apply: false,
    includeStale: false,
    summarize: false,
    interactive: false,
    yes: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--include-stale") flags.includeStale = true;
    else if (arg === "--summarize") flags.summarize = true;
    else if (arg === "--interactive") flags.interactive = true;
    else if (arg === "--yes") flags.yes = true;
    else if (arg === "--token") flags.token = rest[++i];
    else if (arg === "--stale-days") {
      const n = Number(rest[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        console.error("--stale-days needs a positive number");
        process.exit(2);
      }
      flags.staleDays = n;
    } else if (arg === "--config") {
      const value = rest[++i];
      if (!value) {
        console.error("--config needs a path");
        process.exit(2);
      }
      flags.config = value;
    } else if (arg === "--html") {
      const value = rest[++i];
      if (!value || value.startsWith("--")) {
        console.error("--html needs a path");
        process.exit(2);
      }
      flags.html = value;
    }
    else {
      console.error(`Unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  return { command, flags };
}

function resolveToken(flags: Flags): string {
  const token = flags.token ?? process.env.NOTION_TOKEN;
  if (!token) {
    console.error(
      "No Notion token. Set NOTION_TOKEN (see .env.example) or pass --token.\n" +
        "Create an internal integration at https://www.notion.so/my-integrations " +
        "and share the pages you want audited with it."
    );
    process.exit(1);
  }
  return token;
}

const HELP = `notion-gardener — audit and clean up a Notion workspace

Usage:
  notion-gardener scan [--json] [--html PATH] [--summarize] [--stale-days N] [--config PATH]
  notion-gardener fix  [--apply] [--include-stale] [--interactive] [--yes] [--stale-days N] [--config PATH]
  notion-gardener history
  notion-gardener serve

Commands:
  scan     Audit the workspace and print a hygiene report: untitled, empty,
           stale and duplicate pages, plus orphaned pages (nothing links to
           them), dead external links, empty databases, and hollow pages
           (no content, just comments). Duplicates get a diff: what differs
           between the copies and a suggestion for which to keep. Every
           scan is appended to
           ${HISTORY_FILENAME} in the current directory, so the report can
           show how the score is trending.
  fix      Archive untitled, empty and orphaned pages. In a terminal this
           walks you through the plan page by page - archive or skip each
           with the arrow keys (a/s work too), enter confirms, q quits.
           Nothing is archived that you didn't pick. Non-interactively
           (piped, or with --yes) it's a dry run unless --apply is given,
           and --apply asks for confirmation before changing anything.
           Duplicates, dead links, hollow pages and empty databases are
           reported but never auto-archived - run scan for the duplicate
           diff and its keep/archive suggestion.
  history  Print recent scores from ${HISTORY_FILENAME}.
  serve    Run as an MCP server over stdio, so an agent (Claude, Cursor) can
           run the audit itself.

Flags:
  --json            Machine-readable report (scan only)
  --html PATH       Also write a standalone HTML report to PATH (scan only).
                    One self-contained file - no scripts, no external assets -
                    you can send anyone.
  --summarize       Add LLM summaries of stale/duplicate clusters (scan only;
                    needs OPENAI_API_KEY, silently skipped without one)
  --stale-days N    Days without an edit before a page counts as stale (default ${DEFAULT_STALE_DAYS})
  --config PATH     Settings file (default: ./${CONFIG_FILENAME} if it exists). Sets staleDays,
                    protectedPages (never flagged or archived) and ignore (findings dropped).
                    --stale-days wins over the file.
  --include-stale   Let fix also archive stale pages
  --interactive     Force the page-by-page fix walkthrough, even when piped
  --yes             Skip the walkthrough and keep the scripted plan/confirm flow
  --token TOKEN     Notion integration token (or set NOTION_TOKEN)
`;

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }

  if (command === "serve") {
    const { serve } = await import("./integrations/mcp.js");
    await serve();
    return;
  }

  if (command === "history") {
    const entries = readHistory();
    if (entries.length === 0) {
      console.log(`No scans recorded yet. Run a scan and it will append to ${HISTORY_FILENAME}.`);
      return;
    }
    console.log(`Recent scores (${HISTORY_FILENAME}):`);
    for (const e of entries.slice(-20)) {
      const c = e.counts;
      console.log(
        `  ${formatShortDate(e.timestamp)}  ${e.score}/100  ` +
          `(${e.pagesScanned} pages; ${c.untitled} untitled, ${c.empty} empty, ` +
          `${c.stale} stale, ${c.duplicate} duplicate, ${c.orphan} orphan, ` +
          `${c.dead_link} dead link, ${c.empty_database} empty db, ${c.hollow} hollow)`
      );
    }
    const trend = formatTrend(entries);
    if (trend) console.log(`\nTrend: ${trend}`);
    return;
  }

  if (command !== "scan" && command !== "fix") {
    console.error(`Unknown command: ${command}\n`);
    console.log(HELP);
    process.exit(2);
  }

  if (flags.html && command !== "scan") {
    console.error("--html only applies to scan");
    process.exit(2);
  }

  const token = resolveToken(flags);
  let config;
  try {
    config = loadConfig(flags.config);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  const phaseLabels: Record<AuditPhase, string> = {
    content: "Reading page content",
    databases: "Checking databases",
    comments: "Checking comments",
    links: "Checking external links",
  };
  const audit = await auditWorkspace(token, {
    config,
    staleDays: resolveStaleDays(flags.staleDays, config, process.env.STALE_DAYS, DEFAULT_STALE_DAYS),
    // Dead links never feed the archive plan, so fix skips the HTTP checks.
    checkExternalLinks: command === "scan",
    onProgress: (phase, done, total) =>
      process.stderr.write(`\r${phaseLabels[phase]}… ${done}/${total}`),
  });
  process.stderr.write(
    `\rScanned ${audit.pages.length} pages and ${audit.databases.length} databases.\n`
  );
  for (const warning of audit.warnings) process.stderr.write(`${warning}\n`);

  const { pages, findings, score } = audit;

  if (command === "scan") {
    // Record every scan so the score becomes a trend. Local state only -
    // .gardener-history.jsonl belongs in .gitignore.
    let trend: string | null = null;
    try {
      appendHistory(makeEntry(pages.filter((p) => !p.archived).length, findings, score));
      trend = formatTrend(readHistory());
    } catch (err) {
      process.stderr.write(
        `Could not write ${HISTORY_FILENAME}: ${err instanceof Error ? err.message : err}\n`
      );
    }
    let summaries: ClusterSummary[] = [];
    if (flags.summarize) {
      const config = resolveLlmConfig();
      if (config) {
        summaries = await summarizeClusters(clusterFindings(findings), config);
      } else {
        process.stderr.write("No OPENAI_API_KEY set - printing the plain report.\n");
      }
    }
    if (flags.html) {
      const html = renderHtml(pages, findings, score, {
        staleDays: audit.staleDays,
        trend,
        duplicateDiffs: audit.duplicateDiffs,
        suppressed: audit.suppressed,
      });
      writeHtmlReport(flags.html, html);
      process.stderr.write(`HTML report written to ${flags.html}\n`);
    }
    if (flags.json) {
      const report = JSON.parse(renderJson(pages, findings, score, audit.duplicateDiffs));
      if (trend) report.trend = trend;
      if (summaries.length > 0) {
        report.clusters = summaries.map((c) => ({
          label: c.label,
          summary: c.summary ?? null,
          findings: c.findings.length,
        }));
      }
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    let out = renderMarkdown(
      pages,
      findings,
      score,
      audit.staleDays,
      trend,
      audit.duplicateDiffs,
      audit.suppressed
    );
    if (summaries.length > 0) {
      out += "\n" + renderClusterMarkdown(summaries).join("\n");
    }
    console.log(out);
    return;
  }

  // fix
  const plan = planArchives(findings, {
    includeStale: flags.includeStale,
    isProtected: compileMatcher(config.protectedPages),
  });
  if (plan.length === 0) {
    console.log("Nothing to archive. Workspace is in good shape.");
    return;
  }

  const interactive =
    !flags.yes && (flags.interactive || (process.stdin.isTTY && process.stdout.isTTY));

  if (interactive) {
    const items = buildWalkthroughItems(plan, findings);
    console.log(
      `Walking through ${items.length} pages. Archive or skip each - nothing changes until you pick it.`
    );
    const result = await walkthroughPlan(items, makeChooser(flags.interactive));
    const unprocessed = items.length - result.archive.length - result.skipped.length;
    console.log(
      `\n${result.archive.length} to archive, ${result.skipped.length} skipped` +
        (result.completed ? "" : `, ${unprocessed} not reviewed (quit early)`)
    );
    if (result.archive.length === 0) {
      console.log("Nothing selected. Workspace unchanged.");
      return;
    }
    const applied = await applyArchives(token, result.archive, (done, total) =>
      process.stderr.write(`\rArchiving… ${done}/${total}`)
    );
    process.stderr.write("\n");
    console.log(`Archived ${applied.archived.length} pages.`);
    if (applied.failed.length > 0) {
      console.log(`Failed to archive ${applied.failed.length}:`);
      for (const f of applied.failed) {
        console.log(`- ${f.page.url} — ${f.error}`);
      }
      process.exit(1);
    }
    if (result.skipped.length > 0) {
      console.log(`\nSkipped ${result.skipped.length} (left in place):`);
      for (const p of result.skipped) {
        console.log(`- ${p.title.trim() || "(untitled)"} — ${p.url}`);
      }
    }
    return;
  }

  console.log(`Archive plan (${plan.length} pages):`);
  for (const page of plan) {
    console.log(`- ${page.title.trim() || "(untitled)"} — ${page.url}`);
  }
  if (!flags.apply) {
    console.log("\nDry run. Re-run with --apply to archive these pages.");
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nArchive ${plan.length} pages? Type "yes" to confirm: `);
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") {
    console.log("Aborted. Nothing changed.");
    return;
  }
  const result = await applyArchives(token, plan, (done, total) =>
    process.stderr.write(`\rArchiving… ${done}/${total}`)
  );
  process.stderr.write("\n");
  console.log(`Archived ${result.archived.length} pages.`);
  if (result.failed.length > 0) {
    console.log(`Failed to archive ${result.failed.length}:`);
    for (const f of result.failed) {
      console.log(`- ${f.page.url} — ${f.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
