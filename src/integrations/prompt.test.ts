import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { WalkthroughItem } from "../core/interactive.js";
import { keypressChooser, previewLines } from "./prompt.js";

function item(overrides: Partial<WalkthroughItem["page"]> = {}): WalkthroughItem {
  return {
    page: {
      id: "p1",
      title: "Meeting notes",
      url: "https://notion.so/x",
      parentType: "workspace",
      lastEditedTime: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      createdTime: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      archived: false,
      hasChildren: false,
      ...overrides,
    },
    issues: ["Page has no content and no subpages"],
  };
}

/** A stdin stand-in that acts like a TTY for the keypress picker. */
function fakeTty(): NodeJS.ReadStream {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (m: boolean) => void };
  stream.isTTY = true;
  stream.setRawMode = () => {};
  return stream as unknown as NodeJS.ReadStream;
}

function press(stdin: PassThrough, ...keys: string[]): void {
  for (const k of keys) stdin.write(k);
}

describe("previewLines", () => {
  it("shows position, title, reasons, age, and url", () => {
    const lines = previewLines(item(), 0, 5);
    expect(lines[0]).toContain("[1/5] Meeting notes");
    expect(lines.join("\n")).toContain("Page has no content and no subpages");
    expect(lines.join("\n")).toContain("30 days ago");
    expect(lines.join("\n")).toContain("https://notion.so/x");
  });

  it("labels untitled pages", () => {
    const lines = previewLines(item({ title: "   " }), 2, 5);
    expect(lines[0]).toContain("[3/5] (untitled)");
  });
});

describe("keypressChooser", () => {
  it("archives on 'a' + enter", async () => {
    const stdin = fakeTty();
    const choice = keypressChooser(stdin, item(), 0, 1);
    press(stdin as unknown as PassThrough, "a", "\r");
    await expect(choice).resolves.toBe("archive");
  });

  it("archives on right arrow + enter", async () => {
    const stdin = fakeTty();
    const choice = keypressChooser(stdin, item(), 0, 1);
    press(stdin as unknown as PassThrough, "\x1b[C", "\r");
    await expect(choice).resolves.toBe("archive");
  });

  it("defaults to skip on bare enter", async () => {
    const stdin = fakeTty();
    const choice = keypressChooser(stdin, item(), 0, 1);
    press(stdin as unknown as PassThrough, "\r");
    await expect(choice).resolves.toBe("skip");
  });

  it("skips on left arrow + enter even after picking archive", async () => {
    const stdin = fakeTty();
    const choice = keypressChooser(stdin, item(), 0, 1);
    press(stdin as unknown as PassThrough, "a", "\x1b[D", "\r");
    await expect(choice).resolves.toBe("skip");
  });

  it("quits on 'q'", async () => {
    const stdin = fakeTty();
    const choice = keypressChooser(stdin, item(), 0, 1);
    press(stdin as unknown as PassThrough, "q");
    await expect(choice).resolves.toBe("quit");
  });
});
