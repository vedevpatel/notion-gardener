#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type FindingKind } from "../core/detectors.js";
import { auditWorkspace } from "./audit.js";
import { loadConfig } from "../core/config.js";
import { renderJson, renderMarkdown } from "../core/report.js";

function requireToken(): string {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    throw new Error(
      "NOTION_TOKEN is not set. Create an internal integration at " +
        "https://www.notion.so/my-integrations, share pages with it, and " +
        "pass the token in the server's env."
    );
  }
  return token;
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "notion-gardener", version: "0.2.0" });

  server.registerTool(
    "audit_workspace",
    {
      title: "Audit workspace",
      description:
        "Scan the connected Notion workspace for stale, empty, untitled, duplicate and orphaned pages, dead links, empty databases and hollow pages. Duplicate titles come with a diff of what differs between the copies and a suggestion for which to keep. Honors .gardener.yml (or the file named by GARDENER_CONFIG): custom stale window, protected pages and ignore list. Returns the full hygiene report.",
      inputSchema: {
        staleDays: z.number().int().positive().optional(),
        format: z.enum(["markdown", "json"]).optional(),
      },
    },
    async ({ staleDays, format }) => {
      const config = loadConfig(process.env.GARDENER_CONFIG);
      const audit = await auditWorkspace(requireToken(), { staleDays, config });
      const days = audit.staleDays;
      const text =
        format === "json"
          ? renderJson(audit.pages, audit.findings, audit.score, audit.duplicateDiffs, audit.suppressed)
          : renderMarkdown(
              audit.pages,
              audit.findings,
              audit.score,
              days,
              null,
              audit.duplicateDiffs,
              audit.suppressed
            );
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "get_hygiene_score",
    {
      title: "Get hygiene score",
      description:
        "Scan the connected Notion workspace and return just the 0-100 hygiene score with finding counts by kind.",
      inputSchema: {
        staleDays: z.number().int().positive().optional(),
      },
    },
    async ({ staleDays }) => {
      const config = loadConfig(process.env.GARDENER_CONFIG);
      const audit = await auditWorkspace(requireToken(), { staleDays, config });
      const byKind: Partial<Record<FindingKind, number>> = {};
      for (const f of audit.findings) {
        byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
      }
      const text = JSON.stringify({
        score: audit.score,
        pagesScanned: audit.pages.filter((p) => !p.archived).length,
        findings: byKind,
        suppressed: audit.suppressed,
      });
      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}

export async function serve(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
