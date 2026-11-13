import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureGitignored,
  ensureToken,
  findExistingToken,
  looksLikeToken,
  runInit,
  saveToConfig,
  saveToDotEnv,
  type AccessibleItem,
  type InitDeps,
  type InitIO,
} from "./init.js";

const VALID = "secret_abcdefghij123";
const VALID2 = "ntn_abcdefghij123";

interface Harness {
  io: InitIO;
  out: () => string;
  deps: InitDeps;
  dir: string;
  setAccess(items: AccessibleItem[]): void;
  setVerify(fn: (token: string) => Promise<string>): void;
}

/** Scripted IO + fake Notion deps. Fails the test on any unscripted prompt. */
function makeHarness(answers: string[]): Harness {
  const lines: string[] = [];
  let i = 0;
  let access: AccessibleItem[] = [];
  let verify: (token: string) => Promise<string> = async () => "notion-gardener";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gardener-init-"));
  return {
    dir,
    io: {
      out: (line = "") => lines.push(line),
      ask: async (question) => {
        lines.push(question);
        const answer = answers[i++];
        if (answer === undefined) throw new Error(`unexpected prompt: ${question}`);
        return answer;
      },
    },
    out: () => lines.join("\n"),
    deps: {
      cwd: dir,
      env: {},
      verify: (token) => verify(token),
      listAccessible: async () => access,
    },
    setAccess: (items) => {
      access = items;
    },
    setVerify: (fn) => {
      verify = fn;
    },
  };
}

let dirs: string[] = [];
beforeEach(() => {
  dirs = [];
});
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
function track(h: Harness): Harness {
  dirs.push(h.dir);
  return h;
}

describe("looksLikeToken", () => {
  it("accepts secret_ and ntn_ tokens", () => {
    expect(looksLikeToken("secret_abcdefghij")).toBe(true);
    expect(looksLikeToken("  ntn_abcdefghij  ")).toBe(true);
  });

  it("rejects wrong prefixes and near-empty tokens", () => {
    expect(looksLikeToken("")).toBe(false);
    expect(looksLikeToken("tok_abcdefghij")).toBe(false);
    expect(looksLikeToken("secret_")).toBe(false);
    expect(looksLikeToken("nope")).toBe(false);
  });
});

describe("saveToDotEnv", () => {
  it("writes the token and gitignores .env", () => {
    const h = track(makeHarness([]));
    saveToDotEnv(h.dir, VALID);
    expect(fs.readFileSync(path.join(h.dir, ".env"), "utf8")).toBe(`NOTION_TOKEN=${VALID}\n`);
    expect(fs.readFileSync(path.join(h.dir, ".gitignore"), "utf8")).toBe(".env\n");
  });

  it("replaces an existing NOTION_TOKEN line and keeps other entries", () => {
    const h = track(makeHarness([]));
    fs.writeFileSync(path.join(h.dir, ".env"), "STALE_DAYS=30\nNOTION_TOKEN=secret_old\n");
    saveToDotEnv(h.dir, VALID);
    expect(fs.readFileSync(path.join(h.dir, ".env"), "utf8")).toBe(
      `STALE_DAYS=30\nNOTION_TOKEN=${VALID}\n`
    );
  });

  it("leaves a .gitignore that already covers .env untouched", () => {
    const h = track(makeHarness([]));
    fs.writeFileSync(path.join(h.dir, ".gitignore"), "node_modules/\n.env\n");
    expect(ensureGitignored(h.dir, ".env")).toBe(false);
    expect(fs.readFileSync(path.join(h.dir, ".gitignore"), "utf8")).toBe("node_modules/\n.env\n");
  });

  it("appends to a .gitignore without a trailing newline", () => {
    const h = track(makeHarness([]));
    fs.writeFileSync(path.join(h.dir, ".gitignore"), "node_modules/");
    expect(ensureGitignored(h.dir, ".env")).toBe(true);
    expect(fs.readFileSync(path.join(h.dir, ".gitignore"), "utf8")).toBe("node_modules/\n.env\n");
  });
});

describe("saveToConfig", () => {
  it("creates the config with the token quoted", () => {
    const h = track(makeHarness([]));
    saveToConfig(h.dir, VALID);
    expect(fs.readFileSync(path.join(h.dir, ".gardener.yml"), "utf8")).toContain(
      `token: "${VALID}"`
    );
  });

  it("replaces an existing token line and keeps other keys", () => {
    const h = track(makeHarness([]));
    fs.writeFileSync(path.join(h.dir, ".gardener.yml"), 'staleDays: 60\ntoken: "secret_old"\n');
    saveToConfig(h.dir, VALID);
    const text = fs.readFileSync(path.join(h.dir, ".gardener.yml"), "utf8");
    expect(text).toContain("staleDays: 60");
    expect(text).toContain(`token: "${VALID}"`);
    expect(text).not.toContain("secret_old");
  });
});

describe("runInit", () => {
  it("walks a new user through token, save to .env, and access check", async () => {
    const h = track(makeHarness([VALID, "1"]));
    h.setAccess([
      { name: "Team wiki", kind: "page" },
      { name: "Projects", kind: "database" },
    ]);
    const result = await runInit(h.io, h.deps);
    expect(result).toEqual({ token: VALID, savedTo: ".env", accessibleCount: 2 });
    expect(fs.readFileSync(path.join(h.dir, ".env"), "utf8")).toContain(VALID);
    const out = h.out();
    expect(out).toContain("https://www.notion.so/my-integrations");
    expect(out).toContain('"notion-gardener" integration');
    expect(out).toContain("Team wiki (page)");
    expect(out).toContain("Projects (database)");
    expect(out).toContain("npx notion-gardener scan");
  });

  it("retries a malformed token, then accepts a valid one", async () => {
    const h = track(makeHarness(["garbage", VALID, "3"]));
    h.setAccess([{ name: "Wiki", kind: "page" }]);
    const result = await runInit(h.io, h.deps);
    expect(result?.token).toBe(VALID);
    expect(result?.savedTo).toBe("not saved");
    expect(h.out()).toContain("doesn't look like a Notion token");
  });

  it("retries an API-rejected token and saves the good one to .gardener.yml", async () => {
    const h = track(makeHarness(["secret_rejected123", VALID2, "2"]));
    h.setAccess([{ name: "Wiki", kind: "page" }]);
    h.setVerify(async (token) => {
      if (token === VALID2) return "my-integration";
      throw new Error("unauthorized");
    });
    const result = await runInit(h.io, h.deps);
    expect(result?.token).toBe(VALID2);
    expect(result?.savedTo).toBe(".gardener.yml");
    expect(fs.readFileSync(path.join(h.dir, ".gardener.yml"), "utf8")).toContain(VALID2);
    expect(h.out()).toContain("Notion rejected that token");
  });

  it("gives up after three rejected tokens without saving anything", async () => {
    const h = track(makeHarness(["secret_bad1xxx", "secret_bad2xxx", "secret_bad3xxx"]));
    h.setVerify(async () => {
      throw new Error("unauthorized");
    });
    const result = await runInit(h.io, h.deps);
    expect(result).toBeNull();
    expect(fs.existsSync(path.join(h.dir, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(h.dir, ".gardener.yml"))).toBe(false);
    expect(h.out()).toContain("Nothing was saved");
  });

  it("keeps a working token from the environment without re-saving", async () => {
    const h = track(makeHarness([""]));
    h.deps.env.NOTION_TOKEN = VALID;
    h.setAccess([{ name: "Wiki", kind: "page" }]);
    const result = await runInit(h.io, h.deps);
    expect(result).toEqual({ token: VALID, savedTo: "already set", accessibleCount: 1 });
    expect(fs.existsSync(path.join(h.dir, ".env"))).toBe(false);
    expect(h.out()).toContain("NOTION_TOKEN environment variable");
  });

  it("replaces a dead saved token with a new one", async () => {
    const h = track(makeHarness(["y", VALID, "3"]));
    h.deps.env.NOTION_TOKEN = "secret_dead1234";
    h.setAccess([{ name: "Wiki", kind: "page" }]);
    h.setVerify(async (token) => {
      if (token === VALID) return "fresh";
      throw new Error("unauthorized");
    });
    const result = await runInit(h.io, h.deps);
    expect(result?.token).toBe(VALID);
    expect(result?.savedTo).toBe("not saved");
    expect(h.out()).toContain("rejected that token");
  });

  it("explains the share step when the integration sees nothing, then re-checks", async () => {
    const h = track(makeHarness([VALID, "1", ""]));
    let calls = 0;
    h.deps.listAccessible = async () => {
      calls++;
      return calls === 1 ? [] : [{ name: "Team wiki", kind: "page" }];
    };
    const result = await runInit(h.io, h.deps);
    expect(result?.accessibleCount).toBe(1);
    const out = h.out();
    expect(out).toContain("Connections");
    expect(out).toContain("You're all set");
  });

  it("finishes gracefully when nothing is ever shared", async () => {
    const h = track(makeHarness([VALID, "1", "", ""]));
    const result = await runInit(h.io, h.deps);
    expect(result?.accessibleCount).toBe(0);
    expect(h.out()).toContain("empty workspace");
  });

  it("finds an existing token in .env before .gardener.yml", () => {
    const h = track(makeHarness([]));
    fs.writeFileSync(path.join(h.dir, ".env"), `NOTION_TOKEN=${VALID}\n`);
    fs.writeFileSync(path.join(h.dir, ".gardener.yml"), `token: "${VALID2}"\n`);
    expect(findExistingToken(h.deps)).toEqual({ token: VALID, source: ".env" });
  });
});

describe("ensureToken", () => {
  it("returns the flag token without touching the wizard", async () => {
    const h = track(makeHarness([]));
    const token = await ensureToken("secret_flagtok", h.io, { ...h.deps, isTTY: false });
    expect(token).toBe("secret_flagtok");
    expect(h.out()).toBe("");
  });

  it("reads the token from .env in the cwd", async () => {
    const h = track(makeHarness([]));
    fs.writeFileSync(path.join(h.dir, ".env"), `NOTION_TOKEN=${VALID}\n`);
    const token = await ensureToken(undefined, h.io, { ...h.deps, isTTY: false });
    expect(token).toBe(VALID);
  });

  it("returns null without a TTY so the caller can error out", async () => {
    const h = track(makeHarness([]));
    const token = await ensureToken(undefined, h.io, { ...h.deps, isTTY: false });
    expect(token).toBeNull();
    expect(h.out()).toBe("");
  });

  it("returns null when the user declines the wizard", async () => {
    const h = track(makeHarness(["n"]));
    const token = await ensureToken(undefined, h.io, { ...h.deps, isTTY: true });
    expect(token).toBeNull();
    expect(h.out()).toContain("No Notion token found.");
  });

  it("runs the wizard on yes and returns the new token", async () => {
    const h = track(makeHarness(["y", VALID, "1"]));
    h.setAccess([{ name: "Wiki", kind: "page" }]);
    const token = await ensureToken(undefined, h.io, { ...h.deps, isTTY: true });
    expect(token).toBe(VALID);
  });
});
