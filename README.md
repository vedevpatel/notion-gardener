# notion-gardener

Notion workspaces rot. Untitled pages pile up, notes from eight months ago sit next to the actual source of truth, and nobody can tell what's current. notion-gardener audits a workspace through the Notion API, scores its hygiene, and cleans up the dead weight — with your sign-off before anything gets archived.

## What it does

- Scans every page your integration can see, via the Notion search API
- Flags four kinds of rot: **untitled** pages, **empty** pages, **stale** pages (no edits in 90 days, configurable), and **duplicate** titles
- Scores the workspace 0–100 and prints a markdown or JSON report
- Optionally groups stale and duplicate findings into clusters and summarizes each cluster with an LLM, so "keep or kill" becomes a 30-second decision
- Runs as an MCP server, so an agent in Claude or Cursor can run the audit itself
- `fix` walks you through the plan page by page in a terminal — archive or skip each with the arrow keys, and only what you pick gets archived. Piped or scripted runs stay dry-run unless `--apply` is passed
- Duplicates are reported but never auto-archived. Which copy is the real one is a human's call.
- Every scan is recorded in a local `.gardener-history.jsonl`, so the report shows the score's trend (`67 -> 94, +27 since Nov 12`) and `history` prints recent runs

## Setup

1. Create an internal integration at [notion.so/my-integrations](https://www.notion.so/my-integrations) and copy the token.
2. In Notion, share the top-level pages you want audited with the integration. Notion only shows an integration what you explicitly share — this is the step everyone forgets.
3. `cp .env.example .env` and paste your token.
4. Optional, for cluster summaries: set `OPENAI_API_KEY`. Any OpenAI-compatible endpoint works via `OPENAI_BASE_URL` and `OPENAI_MODEL` (defaults to `gpt-4o-mini`). Without a key, `scan --summarize` just prints the plain report.

## Usage

```bash
npm install

npm run scan                 # markdown report to stdout
npm run scan -- --json       # machine-readable, pipe it wherever
npm run scan -- --stale-days 30

npm run fix                  # interactive walkthrough in a terminal: archive/skip each page
npm run fix -- --yes         # scripted mode: prints the archive plan, changes nothing
npm run fix -- --yes --apply # asks for "yes", then archives
npm run fix -- --yes --apply --include-stale   # also archives stale pages

npm run history              # recent scores from .gardener-history.jsonl

npm run scan -- --summarize  # adds an LLM-written summary per stale/duplicate cluster
```

Every scan appends one line to `.gardener-history.jsonl` in the current directory. It's local state, already in `.gitignore` — keep it out of version control.

### MCP server mode

```bash
npm run serve                # stdio MCP server
```

It exposes two tools: `audit_workspace` (the full report, markdown or JSON) and `get_hygiene_score` (just the score and finding counts). Point a client at it, e.g. in Claude Desktop's config:

```json
{
  "mcpServers": {
    "notion-gardener": {
      "command": "npx",
      "args": ["tsx", "/path/to/notion-gardener/src/integrations/mcp.ts"],
      "env": { "NOTION_TOKEN": "secret_..." }
    }
  }
}
```

Archiving is reversible in Notion (they land in Trash), but the tool still treats every change as opt-in.

## Project structure

```
src/
  cli.ts                 # entry point: scan, fix, history, serve (prompt layer lives here)
  core/
    detectors.ts         # pure finding detection over page records
    report.ts            # hygiene score + markdown/JSON rendering
    fix.ts               # archive planning and confirmation flow
    interactive.ts       # page-by-page fix walkthrough (decision flow, prompt-agnostic)
    history.ts           # score history: append/read .gardener-history.jsonl, trend line
  integrations/
    notion.ts            # Notion API client
    prompt.ts            # interactive fix picker (arrow keys, line fallback)
    summarize.ts         # LLM cluster summaries (optional, keyless no-op)
    mcp.ts               # MCP server over stdio
```

Tests sit next to what they cover (`*.test.ts`).

## How the score works

100 minus weighted penalties, each capped per category so one messy corner can't tank an otherwise healthy workspace:

| Finding | Penalty | Cap |
| --- | --- | --- |
| Untitled page | 5 | 25 |
| Empty page | 3 | 20 |
| Stale page | 1 | 30 |
| Duplicate title | 2 | 25 |

An "empty" page is one with no content blocks and no subpages. The scanner checks this with one lightweight `blocks.children.list` call per page (three at a time, to stay inside Notion's rate limit), so the content check is real rather than guessed from titles.

## Why I built it

Every team I've worked in treats Notion as the system of record and then lets it decay until search is useless. The fix is always the same manual sweep someone does once a year. This is that sweep as a tool: run it in CI, run it before onboarding a new teammate, run it when search starts returning garbage.

## Roadmap

Shipped: interactive fix walkthrough, score history with trends, LLM summaries of stale clusters (`scan --summarize`), and MCP server mode (`serve`).

- Scheduled sweeps with a Slack digest of the report
- `fix` suggestions driven by the cluster summaries (archive these, keep those)
- Shareable HTML report built from the score history

## Tests

```bash
npm test
```

The detectors are pure functions over plain page records, so the whole detection pass is covered without touching the API.

MIT license.
