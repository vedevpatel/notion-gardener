import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compileMatcher,
  ConfigError,
  loadConfig,
  parseConfig,
  resolveStaleDays,
} from "./config.js";

describe("parseConfig", () => {
  it("reads every supported key", () => {
    const c = parseConfig(
      "staleDays: 30\nprotectedPages:\n  - Company wiki\n  - 0123456789abcdef0123456789abcdef\nignore:\n  - 'Scratch*'\n"
    );
    expect(c).toEqual({
      staleDays: 30,
      protectedPages: ["Company wiki", "0123456789abcdef0123456789abcdef"],
      ignore: ["Scratch*"],
    });
  });

  it("treats an empty or comment-only file as defaults", () => {
    for (const text of ["", "# nothing here\n"]) {
      const c = parseConfig(text);
      expect(c.staleDays).toBeUndefined();
      expect(c.protectedPages).toEqual([]);
      expect(c.ignore).toEqual([]);
    }
  });

  it("rejects unknown keys by name instead of ignoring them", () => {
    // the classic typo: stale_days would silently do nothing if ignored
    expect(() => parseConfig("stale_days: 30\n")).toThrow(/unknown key "stale_days"/);
    expect(() => parseConfig("a: 1\nb: 2\n")).toThrow(/unknown keys "a", "b"/);
  });

  it.each([["0"], ["-5"], ["1.5"], ["'30'"], ["true"], ["null"]])(
    "rejects staleDays: %s",
    (value) => {
      expect(() => parseConfig(`staleDays: ${value}\n`)).toThrow(ConfigError);
      expect(() => parseConfig(`staleDays: ${value}\n`)).toThrow(/staleDays/);
    }
  );

  it("rejects malformed YAML with the source name in the message", () => {
    expect(() => parseConfig("staleDays: [1, 2\n", "my.yml")).toThrow(/my\.yml: invalid YAML/);
  });

  it("rejects a top-level list or scalar", () => {
    expect(() => parseConfig("- a\n- b\n")).toThrow(/mapping/);
    expect(() => parseConfig("hello\n")).toThrow(/mapping/);
  });

  it("rejects lists that aren't lists of strings, and says how to fix numbers", () => {
    expect(() => parseConfig("protectedPages: Wiki\n")).toThrow(/protectedPages must be a list/);
    expect(() => parseConfig("ignore:\n  - 12345\n")).toThrow(/ignore\[0\] must be a string.*quote/);
    expect(() => parseConfig("ignore:\n  - ok\n  - '  '\n")).toThrow(/ignore\[1\] is empty/);
  });

  it("treats a bare 'protectedPages:' key as an empty list", () => {
    expect(parseConfig("protectedPages:\n").protectedPages).toEqual([]);
  });
});

describe("loadConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gardener-cfg-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns defaults when there is no .gardener.yml", () => {
    const c = loadConfig(undefined, dir);
    expect(c).toEqual({ protectedPages: [], ignore: [] });
  });

  it("picks up .gardener.yml from the working directory", () => {
    fs.writeFileSync(path.join(dir, ".gardener.yml"), "staleDays: 45\n");
    expect(loadConfig(undefined, dir).staleDays).toBe(45);
  });

  it("an explicit path wins over .gardener.yml and resolves relative to cwd", () => {
    fs.writeFileSync(path.join(dir, ".gardener.yml"), "staleDays: 45\n");
    fs.writeFileSync(path.join(dir, "team.yml"), "staleDays: 7\n");
    expect(loadConfig("team.yml", dir).staleDays).toBe(7);
  });

  it("fails loudly when an explicit path does not exist", () => {
    expect(() => loadConfig("nope.yml", dir)).toThrow(/Could not read config .*nope\.yml.*not found/);
  });

  it("reports validation errors from the file that was loaded", () => {
    fs.writeFileSync(path.join(dir, ".gardener.yml"), "bogus: 1\n");
    expect(() => loadConfig(undefined, dir)).toThrow(/\.gardener\.yml: unknown key "bogus"/);
  });
});

describe("compileMatcher", () => {
  const page = (id: string, title: string) => ({ id, title });
  const UUID = "0123456789abcdef0123456789abcdef";
  const DASHED = "01234567-89ab-cdef-0123-456789abcdef";

  it("matches nothing for an empty list", () => {
    expect(compileMatcher([])(page(UUID, "Anything"))).toBe(false);
  });

  it("matches IDs with or without dashes, in any case", () => {
    const m = compileMatcher([UUID.toUpperCase()]);
    expect(m(page(DASHED, "x"))).toBe(true);
    expect(m(page(UUID, "x"))).toBe(true);
    expect(m(page("fedcba9876543210fedcba9876543210", "x"))).toBe(false);
  });

  it("matches whole titles case-insensitively, not substrings", () => {
    const m = compileMatcher(["Company Wiki"]);
    expect(m(page("a", "company   wiki"))).toBe(true);
    expect(m(page("a", "Company Wiki 2025"))).toBe(false);
    expect(m(page("a", "The Company Wiki"))).toBe(false);
  });

  it("supports * as a wildcard anywhere", () => {
    const m = compileMatcher(["Archive/*", "*scratch*"]);
    expect(m(page("a", "Archive/2024"))).toBe(true);
    expect(m(page("a", "My scratch pad"))).toBe(true);
    expect(m(page("a", "Archived"))).toBe(false);
  });

  it("treats regex characters in patterns literally", () => {
    const m = compileMatcher(["a.b", "Q1 (draft)?"]);
    expect(m(page("a", "a.b"))).toBe(true);
    expect(m(page("a", "axb"))).toBe(false);
    expect(m(page("a", "Q1 (draft)?"))).toBe(true);
    expect(m(page("a", "Q1 draft"))).toBe(false);
  });

  it("never matches an untitled page by a normal pattern", () => {
    expect(compileMatcher(["Untitled"])(page("a", ""))).toBe(false);
  });
});

describe("resolveStaleDays", () => {
  const cfg = (staleDays?: number) => ({ staleDays, protectedPages: [], ignore: [] });
  it("flag beats config beats env beats default", () => {
    expect(resolveStaleDays(10, cfg(30), "60", 90)).toBe(10);
    expect(resolveStaleDays(undefined, cfg(30), "60", 90)).toBe(30);
    expect(resolveStaleDays(undefined, cfg(), "60", 90)).toBe(60);
    expect(resolveStaleDays(undefined, cfg(), undefined, 90)).toBe(90);
    expect(resolveStaleDays(undefined, cfg(), "garbage", 90)).toBe(90);
  });
});

describe("CLI config handling (no network reached)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gardener-cli-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const tsx = path.resolve("node_modules/.bin/tsx");
  const cli = path.resolve("src/cli.ts");
  const run = (args: string[]) =>
    spawnSync(tsx, [cli, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NOTION_TOKEN: "fake" },
      timeout: 30_000,
    });

  it("exits 2 with a clear message on a malformed .gardener.yml", () => {
    fs.writeFileSync(path.join(dir, ".gardener.yml"), "staleDays: [oops\n");
    const r = run(["scan"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/\.gardener\.yml: invalid YAML/);
  });

  it("exits 2 naming the unknown key", () => {
    fs.writeFileSync(path.join(dir, "team.yml"), "protected: [x]\n");
    const r = run(["fix", "--config", "team.yml"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/team\.yml: unknown key "protected"/);
  });

  it("exits 2 when --config points at a missing file", () => {
    const r = run(["scan", "--config", "missing.yml"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Could not read config .*missing\.yml/);
  });

  it("rejects --config without a path and a bad --stale-days", () => {
    expect(run(["scan", "--config"]).status).toBe(2);
    const r = run(["scan", "--stale-days", "abc"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--stale-days needs a positive number/);
  });
});
