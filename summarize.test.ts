import { describe, expect, it } from "vitest";
import { detectFindings, type Finding, type PageRecord } from "./detectors.js";
import {
  buildSummaryPrompt,
  clusterFindings,
  resolveLlmConfig,
  significantTokens,
  splitNumbered,
  summarizeClusters,
  type Cluster,
} from "./summarize.js";

const NOW = new Date("2026-11-12T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function page(overrides: Partial<PageRecord>): PageRecord {
  return {
    id: Math.random().toString(36).slice(2),
    title: "A page",
    url: "https://notion.so/x",
    parentType: "workspace",
    lastEditedTime: new Date(NOW.getTime() - 120 * DAY),
    createdTime: new Date(NOW.getTime() - 300 * DAY),
    archived: false,
    hasChildren: true,
    ...overrides,
  };
}

function staleFinding(title: string): Finding {
  return detectFindings([page({ title })], { now: NOW })[0];
}

const CONFIG = { apiKey: "sk-test", baseUrl: "https://api.example.com/v1", model: "test-model" };

describe("resolveLlmConfig", () => {
  it("returns null without an api key", () => {
    expect(resolveLlmConfig({})).toBeNull();
  });

  it("fills in defaults", () => {
    const config = resolveLlmConfig({ OPENAI_API_KEY: "sk-x" });
    expect(config?.baseUrl).toBe("https://api.openai.com/v1");
    expect(config?.model).toBe("gpt-4o-mini");
  });

  it("honors a custom endpoint and strips trailing slashes", () => {
    const config = resolveLlmConfig({
      OPENAI_API_KEY: "sk-x",
      OPENAI_BASE_URL: "http://localhost:11434/v1/",
      OPENAI_MODEL: "llama3",
    });
    expect(config?.baseUrl).toBe("http://localhost:11434/v1");
    expect(config?.model).toBe("llama3");
  });
});

describe("clusterFindings", () => {
  it("clusters duplicate titles together", () => {
    const pages = [
      page({ title: "Sprint Retro" }),
      page({ title: "sprint retro" }),
      page({ title: "Unrelated Roadmap" }),
    ];
    const findings = detectFindings(pages, { now: NOW });
    const clusters = clusterFindings(findings);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].label).toBe('"Sprint Retro" duplicates');
    expect(clusters[0].findings.length).toBeGreaterThanOrEqual(2);
  });

  it("joins stale pages that share a significant word", () => {
    const findings = [
      staleFinding("Q1 roadmap draft"),
      staleFinding("Q3 roadmap update"),
      staleFinding("Grocery list"),
    ];
    const clusters = clusterFindings(findings);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.label)).toContain("roadmap pages");
  });

  it("skips untitled and empty findings", () => {
    const p = page({ title: "", hasChildren: false });
    const clusters = clusterFindings(detectFindings([p], { now: NOW }));
    expect(clusters.filter((c) => c.findings.some((f) => f.page.id === p.id))).toHaveLength(1);
    for (const cluster of clusters) {
      for (const f of cluster.findings) {
        expect(["stale", "duplicate"]).toContain(f.kind);
      }
    }
  });

  it("returns nothing for clean findings", () => {
    const fresh = page({ lastEditedTime: new Date(NOW.getTime() - DAY) });
    expect(clusterFindings(detectFindings([fresh], { now: NOW }))).toHaveLength(0);
  });
});

describe("significantTokens", () => {
  it("drops short and stop words", () => {
    expect(significantTokens("Notes on the Q2 launch")).toEqual(["launch"]);
  });
});

describe("buildSummaryPrompt", () => {
  it("numbers clusters and includes page details", () => {
    const clusters: Cluster[] = [
      { label: "roadmap pages", findings: [staleFinding("Q1 roadmap draft")] },
    ];
    const prompt = buildSummaryPrompt(clusters);
    expect(prompt).toContain("1. roadmap pages");
    expect(prompt).toContain("Q1 roadmap draft");
    expect(prompt).toContain("Last edited");
  });
});

describe("splitNumbered", () => {
  it("maps numbered answers back to clusters", () => {
    const parts = splitNumbered("1. First cluster.\n2. Second cluster, longer.", 2);
    expect(parts[0]).toBe("First cluster.");
    expect(parts[1]).toBe("Second cluster, longer.");
  });

  it("leaves gaps when the model skips a number", () => {
    const parts = splitNumbered("2. Only answered the second.", 2);
    expect(parts[0]).toBeUndefined();
    expect(parts[1]).toBe("Only answered the second.");
  });
});

describe("summarizeClusters", () => {
  it("attaches one summary per cluster", async () => {
    const clusters: Cluster[] = [
      { label: "a pages", findings: [staleFinding("A one")] },
      { label: "b pages", findings: [staleFinding("B two")] },
    ];
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "1. About a.\n2. About b." } }],
        }),
        { status: 200 }
      );
    const out = await summarizeClusters(clusters, CONFIG, fetchImpl as typeof fetch);
    expect(out[0].summary).toBe("About a.");
    expect(out[1].summary).toBe("About b.");
  });

  it("returns unsummarized clusters when the request fails", async () => {
    const clusters: Cluster[] = [{ label: "a pages", findings: [staleFinding("A one")] }];
    const fetchImpl = async () => {
      throw new Error("offline");
    };
    const out = await summarizeClusters(clusters, CONFIG, fetchImpl as typeof fetch);
    expect(out).toHaveLength(1);
    expect(out[0].summary).toBeUndefined();
  });

  it("returns unsummarized clusters on a non-200", async () => {
    const clusters: Cluster[] = [{ label: "a pages", findings: [staleFinding("A one")] }];
    const fetchImpl = async () => new Response("nope", { status: 429 });
    const out = await summarizeClusters(clusters, CONFIG, fetchImpl as typeof fetch);
    expect(out[0].summary).toBeUndefined();
  });
});
