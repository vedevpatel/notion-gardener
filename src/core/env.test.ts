import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDotenv, parseEnv, resolveToken } from "./env.js";

describe("parseEnv", () => {
  it("parses KEY=value lines and skips blanks and comments", () => {
    expect(parseEnv("# c\n\nNOTION_TOKEN=secret_abc\nSTALE_DAYS=30\n")).toEqual({
      NOTION_TOKEN: "secret_abc",
      STALE_DAYS: "30",
    });
  });

  it("supports the export prefix and whitespace around the key", () => {
    expect(parseEnv("export NOTION_TOKEN = secret_abc\n")).toEqual({
      NOTION_TOKEN: "secret_abc",
    });
  });

  it("unquotes double quotes with escapes, single quotes verbatim", () => {
    expect(parseEnv('A="x\\"y\\nz"\nB=\'x"y\\nz\'\n')).toEqual({
      A: 'x"y\nz',
      B: 'x"y\\nz',
    });
  });

  it("strips trailing comments from unquoted values only", () => {
    expect(parseEnv('A=secret_abc # token\nB="keep # this"\n')).toEqual({
      A: "secret_abc",
      B: "keep # this",
    });
  });

  it("skips lines that aren't KEY=value instead of throwing", () => {
    expect(parseEnv("garbage\n=novalue\n1BAD=x\nOK=1\n")).toEqual({ OK: "1" });
  });

  it("keeps empty values", () => {
    expect(parseEnv("EMPTY=\n")).toEqual({ EMPTY: "" });
  });
});

describe("loadDotenv", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gardener-env-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns {} when there is no .env", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadDotenv(dir, env)).toEqual({});
    expect(env).toEqual({});
  });

  it("merges file entries into the env", () => {
    fs.writeFileSync(path.join(dir, ".env"), "NOTION_TOKEN=secret_from_file\n");
    const env: NodeJS.ProcessEnv = {};
    expect(loadDotenv(dir, env)).toEqual({ NOTION_TOKEN: "secret_from_file" });
    expect(env.NOTION_TOKEN).toBe("secret_from_file");
  });

  it("never overwrites a real environment variable", () => {
    fs.writeFileSync(path.join(dir, ".env"), "NOTION_TOKEN=secret_from_file\nOTHER=x\n");
    const env: NodeJS.ProcessEnv = { NOTION_TOKEN: "secret_real_env" };
    loadDotenv(dir, env);
    expect(env.NOTION_TOKEN).toBe("secret_real_env");
    expect(env.OTHER).toBe("x");
  });
});

describe("resolveToken", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gardener-env-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("prefers the flag over everything", () => {
    fs.writeFileSync(path.join(dir, ".env"), "NOTION_TOKEN=secret_file\n");
    const env: NodeJS.ProcessEnv = { NOTION_TOKEN: "secret_env" };
    expect(
      resolveToken({ flag: "secret_flag", env, configToken: "secret_cfg", cwd: dir })
    ).toBe("secret_flag");
  });

  it("uses NOTION_TOKEN from the environment before .env and config", () => {
    fs.writeFileSync(path.join(dir, ".env"), "NOTION_TOKEN=secret_file\n");
    const env: NodeJS.ProcessEnv = { NOTION_TOKEN: "secret_env" };
    expect(resolveToken({ env, configToken: "secret_cfg", cwd: dir })).toBe("secret_env");
  });

  it("auto-loads .env before the config token", () => {
    fs.writeFileSync(path.join(dir, ".env"), "NOTION_TOKEN=secret_file\n");
    const env: NodeJS.ProcessEnv = {};
    expect(resolveToken({ env, configToken: "secret_cfg", cwd: dir })).toBe("secret_file");
    // and the file value landed in the env for anything else that reads it
    expect(env.NOTION_TOKEN).toBe("secret_file");
  });

  it("falls back to the config token when nothing else is set", () => {
    expect(resolveToken({ env: {}, configToken: "secret_cfg", cwd: dir })).toBe("secret_cfg");
  });

  it("treats empty strings as unset", () => {
    fs.writeFileSync(path.join(dir, ".env"), "NOTION_TOKEN=secret_file\n");
    expect(resolveToken({ flag: "", env: { NOTION_TOKEN: "" }, cwd: dir })).toBe("secret_file");
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "gardener-env-"));
    expect(resolveToken({ env: {}, configToken: "  ", cwd: empty })).toBeUndefined();
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it("returns undefined when no source has a token", () => {
    expect(resolveToken({ env: {}, cwd: dir })).toBeUndefined();
  });
});
