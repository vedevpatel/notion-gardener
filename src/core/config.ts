import fs from "node:fs";
import path from "node:path";
import { parse, YAMLParseError } from "yaml";
import { normalizeTitle } from "./detectors.js";

export const CONFIG_FILENAME = ".gardener.yml";

/**
 * What a .gardener.yml can say. Every key is optional; a missing file or
 * an empty one means the built-in defaults.
 *
 * - staleDays: days without an edit before a page is stale.
 * - protectedPages: pages the tool must never touch. Treated as if they
 *   weren't in the workspace for every detector (they never get findings,
 *   and they don't take part in duplicate grouping), and refused again at
 *   fix time. They still count as link sources, so a protected index page
 *   keeps the pages it links to from looking orphaned.
 * - ignore: pages whose findings are dropped from the report, the score
 *   and the fix plan. Unlike protected pages they are analyzed normally,
 *   so an ignored page still counts as a duplicate twin of another page.
 *
 * Both lists take Notion page/database IDs (32 hex characters, dashes
 * optional) or title patterns (case-insensitive, whole title, `*` matches
 * any run of characters).
 */
export interface GardenerConfig {
  staleDays?: number;
  protectedPages: string[];
  ignore: string[];
}

export const EMPTY_CONFIG: GardenerConfig = { protectedPages: [], ignore: [] };

const KNOWN_KEYS = ["staleDays", "protectedPages", "ignore"] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Parse and validate config text. `source` is only used in error messages. */
export function parseConfig(text: string, source = CONFIG_FILENAME): GardenerConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    const msg = err instanceof YAMLParseError ? err.message : String(err);
    throw new ConfigError(`${source}: invalid YAML - ${msg}`);
  }
  if (raw === null || raw === undefined) return { ...EMPTY_CONFIG, protectedPages: [], ignore: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${source}: expected a mapping of settings at the top level`);
  }
  const obj = raw as Record<string, unknown>;

  const unknown = Object.keys(obj).filter((k) => !(KNOWN_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new ConfigError(
      `${source}: unknown key${unknown.length === 1 ? "" : "s"} ${unknown
        .map((k) => `"${k}"`)
        .join(", ")} (allowed: ${KNOWN_KEYS.join(", ")})`
    );
  }

  const config: GardenerConfig = { protectedPages: [], ignore: [] };

  if (obj.staleDays !== undefined) {
    const v = obj.staleDays;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new ConfigError(`${source}: staleDays must be a positive whole number, got ${JSON.stringify(v)}`);
    }
    config.staleDays = v;
  }
  for (const key of ["protectedPages", "ignore"] as const) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) {
      throw new ConfigError(`${source}: ${key} must be a list`);
    }
    v.forEach((item, i) => {
      if (typeof item !== "string") {
        throw new ConfigError(
          `${source}: ${key}[${i}] must be a string, got ${JSON.stringify(item)} (quote IDs and patterns that look like numbers)`
        );
      }
      if (!item.trim()) throw new ConfigError(`${source}: ${key}[${i}] is empty`);
    });
    config[key] = (v as string[]).map((s) => s.trim());
  }
  return config;
}

/**
 * Load the config. An explicit path must exist (a typo'd --config should
 * fail loudly, not silently run with defaults). Without one, look for
 * .gardener.yml in `cwd`; no file there means defaults.
 */
export function loadConfig(explicitPath?: string, cwd: string = process.cwd()): GardenerConfig {
  const file = explicitPath ? path.resolve(cwd, explicitPath) : path.join(cwd, CONFIG_FILENAME);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !explicitPath) {
      return { protectedPages: [], ignore: [] };
    }
    throw new ConfigError(
      `Could not read config ${file}: ${code === "ENOENT" ? "file not found" : (err as Error).message}`
    );
  }
  return parseConfig(text, explicitPath ?? CONFIG_FILENAME);
}

const normalizeId = (s: string) => s.replace(/-/g, "").toLowerCase();
const isId = (s: string) => /^[0-9a-f]{32}$/.test(normalizeId(s));

export type PageMatcher = (page: { id: string; title: string }) => boolean;

/** Compile ID / title patterns into a predicate. An empty list matches nothing. */
export function compileMatcher(patterns: readonly string[]): PageMatcher {
  const ids = new Set<string>();
  const rawIds = new Set<string>();
  const titles: RegExp[] = [];
  for (const p of patterns) {
    rawIds.add(p);
    if (isId(p)) {
      ids.add(normalizeId(p));
      continue;
    }
    const source = normalizeTitle(p)
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    titles.push(new RegExp(`^${source}$`, "s"));
  }
  return (page) => {
    if (rawIds.has(page.id) || ids.has(normalizeId(page.id))) return true;
    const title = normalizeTitle(page.title);
    return titles.some((re) => re.test(title));
  };
}

/** How many findings the config hid, for the "suppressed by config" line. */
export interface Suppressed {
  protected: number;
  ignored: number;
}

export const NO_SUPPRESSED: Suppressed = { protected: 0, ignored: 0 };

/** Stale window precedence: CLI flag, then config file, then STALE_DAYS env, then the default. */
export function resolveStaleDays(
  flag: number | undefined,
  config: GardenerConfig,
  env: string | undefined,
  fallback: number
): number {
  return flag ?? config.staleDays ?? (Number(env) || fallback);
}
