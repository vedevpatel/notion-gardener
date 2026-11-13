import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { Client } from "@notionhq/client";
import { CONFIG_FILENAME, loadConfig } from "../core/config.js";
import { loadDotenv, parseEnv, resolveToken } from "../core/env.js";

/** Console surface for the wizard, so tests can drive it without a TTY. */
export interface InitIO {
  ask(question: string): Promise<string>;
  out(line?: string): void;
}

export interface AccessibleItem {
  name: string;
  kind: "page" | "database";
}

export interface InitDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Confirms the token with the Notion API; resolves to the integration's name. */
  verify(token: string): Promise<string>;
  /** Top-level pages/databases the token can see. */
  listAccessible(token: string): Promise<AccessibleItem[]>;
}

const TOKEN_PREFIXES = ["secret_", "ntn_"];

/** Cheap shape check before bothering the API. Both Notion token eras count. */
export function looksLikeToken(token: string): boolean {
  const t = token.trim();
  return TOKEN_PREFIXES.some((p) => t.startsWith(p)) && t.trim().length > 12;
}

const MAX_TOKEN_ATTEMPTS = 3;

export interface InitResult {
  token: string;
  /** ".env", ".gardener.yml", "not saved", or "already set" (kept existing token). */
  savedTo: string;
  /** Top-level pages/databases the integration can see after setup. */
  accessibleCount: number;
}

/** Where a usable token already lives, if anywhere: env, then .env, then .gardener.yml. */
export function findExistingToken(deps: InitDeps): { token: string; source: string } | undefined {
  const fromEnv = deps.env.NOTION_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "NOTION_TOKEN environment variable" };
  try {
    const parsed = parseEnv(fs.readFileSync(path.join(deps.cwd, ".env"), "utf8"));
    if (parsed.NOTION_TOKEN?.trim()) return { token: parsed.NOTION_TOKEN.trim(), source: ".env" };
  } catch {
    // no readable .env - fine
  }
  try {
    const token = loadConfig(undefined, deps.cwd).token;
    if (token) return { token, source: CONFIG_FILENAME };
  } catch {
    // no readable config - fine
  }
  return undefined;
}

/** Write NOTION_TOKEN into <cwd>/.env, preserving other entries, and keep it out of git. */
export function saveToDotEnv(cwd: string, token: string): void {
  const file = path.join(cwd, ".env");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // new file
  }
  const line = `NOTION_TOKEN=${token}`;
  text = /^NOTION_TOKEN=/m.test(text)
    ? text.replace(/^NOTION_TOKEN=.*$/m, line)
    : (text && !text.endsWith("\n") ? text + "\n" : text) + line + "\n";
  fs.writeFileSync(file, text);
  ensureGitignored(cwd, ".env");
}

/** Add an entry to <cwd>/.gitignore unless already covered. Returns true when it wrote. */
export function ensureGitignored(cwd: string, entry: string): boolean {
  const file = path.join(cwd, ".gitignore");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // new file
  }
  const covered = text
    .split(/\r?\n/)
    .some((l) => l.trim() === entry || l.trim() === `/${entry}`);
  if (covered) return false;
  fs.writeFileSync(file, (text && !text.endsWith("\n") ? text + "\n" : text) + entry + "\n");
  return true;
}

/** Write the token key into <cwd>/.gardener.yml, replacing an existing token line. */
export function saveToConfig(cwd: string, token: string): void {
  const file = path.join(cwd, CONFIG_FILENAME);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // new file
  }
  const line = `token: "${token.replace(/(["\\])/g, "\\$1")}"`;
  if (/^token\s*:/m.test(text)) {
    text = text.replace(/^token\s*:.*$/m, line);
  } else {
    const lead = text && !text.endsWith("\n") ? text + "\n" : text;
    text =
      lead +
      (lead ? "\n" : "") +
      "# Notion integration token. Keep this file out of git, or move the token to .env instead.\n" +
      line +
      "\n";
  }
  fs.writeFileSync(file, text);
}

const INTEGRATIONS_URL = "https://www.notion.so/my-integrations";

function printTokenSteps(io: InitIO): void {
  io.out("Get a token - two minutes, three steps:");
  io.out(`  1. Open ${INTEGRATIONS_URL} and click "New integration".`);
  io.out('     Name it anything (e.g. "notion-gardener") and save.');
  io.out('  2. Copy the "Internal Integration Secret" (starts with secret_ or ntn_).');
  io.out("  3. Paste it here.");
  io.out();
}

function printShareSteps(io: InitIO): void {
  io.out("It can't see anything yet. Notion only shows an integration the pages you share with it:");
  io.out("  1. Open a top-level page in Notion (your team wiki home, your notes, anything).");
  io.out('  2. Click the ••• menu at the top right, then "Connections" (or "Connect to").');
  io.out("  3. Search for your integration's name and pick it. Everything under that page comes along.");
}

async function promptForToken(io: InitIO, deps: InitDeps): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_TOKEN_ATTEMPTS; attempt++) {
    const answer = (await io.ask("Token: ")).trim();
    if (!looksLikeToken(answer)) {
      io.out("That doesn't look like a Notion token - it should start with secret_ or ntn_.");
      continue;
    }
    try {
      const name = await deps.verify(answer);
      io.out(`Works - this is the "${name}" integration.`);
      return answer;
    } catch {
      io.out(
        attempt < MAX_TOKEN_ATTEMPTS
          ? "Notion rejected that token. Copy the whole secret from my-integrations and paste it again."
          : "Still rejected. Nothing was saved - run init again when you have the token."
      );
    }
  }
  return null;
}

async function promptSave(io: InitIO, deps: InitDeps, token: string): Promise<string> {
  io.out();
  for (;;) {
    const answer = (
      await io.ask(
        "Save it so you never paste it again?\n" +
          "  [1] .env file in this directory (recommended - stays out of git)\n" +
          `  [2] ${CONFIG_FILENAME} config file\n` +
          "  [3] Don't save\n" +
          "Choice [1]: "
      )
    )
      .trim()
      .toLowerCase();
    if (answer === "" || answer === "1") {
      saveToDotEnv(deps.cwd, token);
      io.out(`Saved to ${path.join(deps.cwd, ".env")} (and .env is git-ignored here).`);
      return ".env";
    }
    if (answer === "2") {
      saveToConfig(deps.cwd, token);
      io.out(`Saved to ${path.join(deps.cwd, CONFIG_FILENAME)}.`);
      return CONFIG_FILENAME;
    }
    if (answer === "3" || answer === "n" || answer === "no") {
      io.out("Not saved - you'll need NOTION_TOKEN or --token on every run.");
      return "not saved";
    }
    io.out("Please answer 1, 2, or 3.");
  }
}

const MAX_ACCESS_ROUNDS = 2;

async function confirmAccess(io: InitIO, deps: InitDeps, token: string): Promise<number> {
  io.out();
  io.out("Checking what your integration can see…");
  for (let round = 0; ; round++) {
    let items: AccessibleItem[];
    try {
      items = await deps.listAccessible(token);
    } catch {
      io.out("Couldn't reach Notion to check access - your token is saved, so just run a scan.");
      return 0;
    }
    if (items.length > 0) {
      io.out(`It can see ${items.length} top-level ${items.length === 1 ? "item" : "items"}:`);
      for (const item of items.slice(0, 10)) io.out(`  - ${item.name || "(untitled)"} (${item.kind})`);
      if (items.length > 10) io.out(`  …and ${items.length - 10} more.`);
      return items.length;
    }
    if (round >= MAX_ACCESS_ROUNDS) {
      io.out("Still nothing shared - a scan will report an empty workspace until you share a page.");
      return 0;
    }
    printShareSteps(io);
    const answer = (await io.ask('Press enter when done (or "skip"): ')).trim().toLowerCase();
    if (answer === "skip" || answer === "q") return 0;
  }
}

/**
 * The first-run wizard: get a token (or confirm an existing one), save it,
 * and verify the integration can actually see pages. Returns null when the
 * user bails or no token validates.
 */
export async function runInit(io: InitIO, deps: InitDeps): Promise<InitResult | null> {
  io.out("notion-gardener setup");
  io.out();

  let token: string | undefined;
  const existing = findExistingToken(deps);
  if (existing) {
    io.out(`You already have a token in your ${existing.source}.`);
    const answer = (await io.ask("Keep it? [Y/n] ")).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") {
      io.out("Checking it with Notion…");
      try {
        const name = await deps.verify(existing.token);
        io.out(`Works - this is the "${name}" integration.`);
        token = existing.token;
      } catch {
        io.out("Notion rejected that token. Let's set a new one.");
      }
    }
  }

  if (!token) {
    printTokenSteps(io);
    token = (await promptForToken(io, deps)) ?? undefined;
    if (!token) return null;
  }

  const savedTo = existing?.token === token ? "already set" : await promptSave(io, deps, token);
  const accessibleCount = await confirmAccess(io, deps, token);

  io.out();
  if (accessibleCount > 0) {
    io.out("You're all set. Run your first audit:");
  } else {
    io.out("Setup done. Once you've shared a page, run your first audit:");
  }
  io.out("  npx notion-gardener scan");
  return { token, savedTo, accessibleCount };
}

export interface EnsureTokenDeps extends InitDeps {
  isTTY: boolean;
  /** Token from .gardener.yml when the caller already loaded the config. */
  configToken?: string;
}

/**
 * Token for scan/fix: resolve it quietly, and when there's none and a human
 * is at the keyboard, offer the wizard. Returns null when there's no token
 * and no wizard run (the caller prints the error and exits).
 */
export async function ensureToken(
  flag: string | undefined,
  io: InitIO,
  deps: EnsureTokenDeps
): Promise<string | null> {
  const token = resolveToken({
    flag,
    env: deps.env,
    configToken: deps.configToken,
    cwd: deps.cwd,
  });
  if (token) return token;
  if (!deps.isTTY) return null;
  io.out("No Notion token found.");
  const answer = (await io.ask("Run setup now? It takes two minutes. [Y/n] ")).trim().toLowerCase();
  if (answer !== "" && answer !== "y" && answer !== "yes") return null;
  const result = await runInit(io, deps);
  return result?.token ?? null;
}

/** Line-prompt IO over stdin/stdout. */
export function makeConsoleIO(): InitIO {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (question) => rl.question(question),
    out: (line = "") => console.log(line),
  };
}

function pageTitle(page: any): string {
  return Object.values(page.properties ?? {})
    .filter((p: any) => p?.type === "title")
    .map((p: any) => p.title.map((t: any) => t.plain_text ?? "").join(""))
    .join("");
}

/** Production deps backed by the real Notion client. */
export function makeNotionDeps(): InitDeps {
  return {
    cwd: process.cwd(),
    env: process.env,
    async verify(token) {
      const client = new Client({ auth: token });
      const me = (await client.users.me({})) as any;
      return typeof me?.name === "string" && me.name ? me.name : "unnamed";
    },
    async listAccessible(token) {
      const client = new Client({ auth: token });
      const res = await client.search({ page_size: 100 });
      return (res.results as any[])
        .filter((r) => r?.parent?.type === "workspace")
        .map((r) =>
          r.object === "database"
            ? {
                kind: "database" as const,
                name: (Array.isArray(r.title) ? r.title : [])
                  .map((t: any) => t?.plain_text ?? "")
                  .join(""),
              }
            : { kind: "page" as const, name: pageTitle(r) }
        );
    },
  };
}
