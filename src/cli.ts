#!/usr/bin/env node
import readline from "node:readline/promises";
import { detectFindings, DEFAULT_STALE_DAYS } from "./core/detectors.js";
import { fetchWorkspacePages } from "./integrations/notion.js";
import { renderJson, renderMarkdown, scoreWorkspace } from "./core/report.js";
import { applyArchives, planArchives } from "./core/fix.js";
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
  token?: string;
  staleDays: number;
}

function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const [command = "help", ...rest] = argv;
  const flags: Flags = {
    json: false,
    apply: false,
    includeStale: false,
    summarize: false,
    staleDays: Number(process.env.STALE_DAYS) || DEFAULT_STALE_DAYS,
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--include-stale") flags.includeStale = true;
    else if (arg === "--summarize") flags.summarize = true;
    else if (arg === "--token") flags.token = rest[++i];
    else if (arg === "--stale-days") flags.staleDays = Number(rest[++i]);
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
  notion-gardener scan [--json] [--summarize] [--stale-days N]
  notion-gardener fix  [--apply] [--include-stale] [--stale-days N]
  notion-gardener serve

Commands:
  scan   Audit the workspace and print a hygiene report.
  fix    Archive untitled and empty pages. Dry-run unless --apply is given;
         --apply always asks for confirmation before changing anything.
         Duplicates are reported but never auto-archived.
  serve  Run as an MCP server over stdio, so an agent (Claude, Cursor) can
         run the audit itself.

Flags:
  --json            Machine-readable report (scan only)
  --summarize       Add LLM summaries of stale/duplicate clusters (scan only;
                    needs OPENAI_API_KEY, silently skipped without one)
  --stale-days N    Days without an edit before a page counts as stale (default ${DEFAULT_STALE_DAYS})
  --include-stale   Let fix also archive stale pages
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

  if (command !== "scan" && command !== "fix") {
    console.error(`Unknown command: ${command}\n`);
    console.log(HELP);
    process.exit(2);
  }

  const token = resolveToken(flags);
  const pages = await fetchWorkspacePages(token, (done, total) =>
    process.stderr.write(`\rChecking page content… ${done}/${total}`)
  );
  process.stderr.write(`\rScanned ${pages.length} pages.\n`);

  const findings = detectFindings(pages, { staleDays: flags.staleDays });
  const score = scoreWorkspace(findings);

  if (command === "scan") {
    let summaries: ClusterSummary[] = [];
    if (flags.summarize) {
      const config = resolveLlmConfig();
      if (config) {
        summaries = await summarizeClusters(clusterFindings(findings), config);
      } else {
        process.stderr.write("No OPENAI_API_KEY set - printing the plain report.\n");
      }
    }
    if (flags.json) {
      const report = JSON.parse(renderJson(pages, findings, score));
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
    let out = renderMarkdown(pages, findings, score, flags.staleDays);
    if (summaries.length > 0) {
      out += "\n" + renderClusterMarkdown(summaries).join("\n");
    }
    console.log(out);
    return;
  }

  // fix
  const plan = planArchives(findings, { includeStale: flags.includeStale });
  if (plan.length === 0) {
    console.log("Nothing to archive. Workspace is in good shape.");
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
