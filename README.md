# notion-gardener

Notion workspaces rot. Untitled pages pile up, notes from eight months ago sit next to the actual source of truth, and nobody can tell what's current. notion-gardener audits a workspace through the Notion API, scores its hygiene, and cleans up the dead weight — with your sign-off before anything gets archived.

## What it does

- Scans every page your integration can see, via the Notion search API
- Flags four kinds of rot: **untitled** pages, **empty** pages, **stale** pages (no edits in 90 days, configurable), and **duplicate** titles
- Scores the workspace 0–100 and prints a markdown or JSON report
- `fix` archives the untitled and empty pages — dry-run by default, and `--apply` still asks you to confirm before anything changes
- Duplicates are reported but never auto-archived. Which copy is the real one is a human's call.

## Setup

1. Create an internal integration at [notion.so/my-integrations](https://www.notion.so/my-integrations) and copy the token.
2. In Notion, share the top-level pages you want audited with the integration. Notion only shows an integration what you explicitly share — this is the step everyone forgets.
3. `cp .env.example .env` and paste your token.

## Usage

```bash
npm install

npm run scan                 # markdown report to stdout
npm run scan -- --json       # machine-readable, pipe it wherever
npm run scan -- --stale-days 30

npm run fix                  # prints the archive plan, changes nothing
npm run fix -- --apply       # asks for "yes", then archives
npm run fix -- --apply --include-stale   # also archives stale pages
```

Archiving is reversible in Notion (they land in Trash), but the tool still treats every change as opt-in.

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

- Scheduled sweeps with a Slack digest of the report
- An LLM pass that summarizes stale clusters so "keep or kill" becomes a 30-second decision
- MCP server mode, so an agent can run the audit from Claude or Cursor directly

## Tests

```bash
npm test
```

The detectors are pure functions over plain page records, so the whole detection pass is covered without touching the API.

MIT license.
