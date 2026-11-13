import fs from "node:fs";
import path from "node:path";

/**
 * Minimal .env parser: KEY=value lines, `#` comments, an optional `export`
 * prefix, and optional single or double quotes around the value. Double
 * quotes support the \", \\ and \n escapes; unquoted values drop a trailing
 * ` # comment`. Lines that don't look like KEY=value are skipped, never
 * errors - a half-written .env shouldn't break a scan.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\(["\\n])/g, (_m, c: string) => (c === "n" ? "\n" : c));
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Read <cwd>/.env if it exists and merge it into `env`. Real environment
 * variables always win - .env only fills gaps (empty strings count as
 * gaps). Returns the parsed entries ({} when there's no file).
 */
export function loadDotenv(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  filename = ".env"
): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(path.join(cwd, filename), "utf8");
  } catch {
    return {};
  }
  const parsed = parseEnv(text);
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined || env[key] === "") env[key] = value;
  }
  return parsed;
}

/**
 * Token precedence: the --token flag, then NOTION_TOKEN in the environment,
 * then NOTION_TOKEN in ./.env (merged in by loadDotenv), then the token key
 * in .gardener.yml. Empty strings count as unset.
 */
export function resolveToken(opts: {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  configToken?: string;
  cwd?: string;
}): string | undefined {
  const env = opts.env ?? process.env;
  loadDotenv(opts.cwd ?? process.cwd(), env);
  const pick = (v: string | undefined): string | undefined =>
    v !== undefined && v.trim() ? v : undefined;
  return pick(opts.flag) ?? pick(env.NOTION_TOKEN) ?? pick(opts.configToken);
}
