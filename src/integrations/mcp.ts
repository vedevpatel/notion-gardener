#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_STALE_DAYS, type FindingKind } from "../core/detectors.js";
import { auditWorkspace } from "./audit.js";
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
        "Scan the connected Notion workspace for stale, empty, untitled, duplicate and orphaned pages, dead links, empty databases and hollow pages. Duplicate titles come with a diff of what differs between the copies and a suggestion for which to keep. Returns the full hygiene report.",
      inputSchema: {
        staleDays: z.number().int().positive().optional(),
        format: z.enum(["markdown", "json"]).optional(),
      },
    },
    async ({ staleDays, format }) => {
      const days = staleDays ?? DEFAULT_STALE_DAYS;
      const audit = await auditWorkspace(requireToken(), { staleDays: days });
      const text =
        format === "json"
          ? renderJson(audit.pages, audit.findings, audit.score, audit.duplicateDiffs)
          : renderMarkdown(
              audit.pages,
              audit.findings,
              audit.score,
              days,
              null,
              audit.duplicateDiffs
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
      const audit = await auditWorkspace(requireToken(), { staleDays });
      const byKind: Partial<Record<FindingKind, number>> = {};
      for (const f of audit.findings) {
        byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
      }
      const text = JSON.stringify({
        score: audit.score,
        pagesScanned: audit.pages.filter((p) => !p.archived).length,
        findings: byKind,
      });
      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}

export async function serve(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
