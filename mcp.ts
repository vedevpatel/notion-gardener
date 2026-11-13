#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { detectFindings, DEFAULT_STALE_DAYS, type FindingKind } from "./detectors.js";
import { fetchWorkspacePages } from "./notion.js";
import { renderJson, renderMarkdown, scoreWorkspace } from "./report.js";

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
        "Scan the connected Notion workspace for stale, empty, untitled and duplicate pages, and return the full hygiene report.",
      inputSchema: {
        staleDays: z.number().int().positive().optional(),
        format: z.enum(["markdown", "json"]).optional(),
      },
    },
    async ({ staleDays, format }) => {
      const days = staleDays ?? DEFAULT_STALE_DAYS;
      const pages = await fetchWorkspacePages(requireToken());
      const findings = detectFindings(pages, { staleDays: days });
      const score = scoreWorkspace(findings);
      const text =
        format === "json"
          ? renderJson(pages, findings, score)
          : renderMarkdown(pages, findings, score, days);
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
      const pages = await fetchWorkspacePages(requireToken());
      const findings = detectFindings(pages, { staleDays });
      const byKind: Partial<Record<FindingKind, number>> = {};
      for (const f of findings) {
        byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
      }
      const text = JSON.stringify({
        score: scoreWorkspace(findings),
        pagesScanned: pages.filter((p) => !p.archived).length,
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
