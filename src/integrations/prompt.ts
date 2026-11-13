import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import type { FixChoice, WalkthroughItem } from "../core/interactive.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function previewLines(item: WalkthroughItem, index: number, total: number): string[] {
  const p = item.page;
  const title = p.title.trim() || "(untitled)";
  const ageDays = Math.floor((Date.now() - p.lastEditedTime.getTime()) / DAY_MS);
  const issues = item.issues.length > 0 ? item.issues.join("; ") : "flagged for cleanup";
  return [
    `\n[${index + 1}/${total}] ${title}`,
    `  why:      ${issues}`,
    `  edited:   ${ageDays} days ago`,
    `  url:      ${p.url}`,
  ];
}

interface KeypressStream extends NodeJS.ReadStream {
  isTTY: boolean;
}

/**
 * Arrow-key picker: left/s highlights skip, right/a highlights archive,
 * enter confirms the highlighted choice, q quits. Defaults to skip, so an
 * accidental enter never archives anything.
 */
export function keypressChooser(
  stdin: KeypressStream,
  item: WalkthroughItem,
  index: number,
  total: number
): Promise<FixChoice> {
  return new Promise((resolve) => {
    for (const line of previewLines(item, index, total)) console.log(line);
    let selection: "skip" | "archive" = "skip";
    const render = (): void => {
      const skipLabel = selection === "skip" ? "[ skip ]" : "  skip  ";
      const archiveLabel = selection === "archive" ? "[ archive ]" : "  archive  ";
      process.stdout.write(
        `\r  ${skipLabel} ${archiveLabel}  (arrows or a/s, enter confirms, q quits)[K`
      );
    };
    const cleanup = (): void => {
      stdin.off("keypress", onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
    };
    const onKey = (str: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key?.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        process.exit(130);
      }
      if (str === "q") {
        cleanup();
        process.stdout.write("\n");
        resolve("quit");
        return;
      }
      if (str === "a" || key?.name === "right") {
        selection = "archive";
        render();
        return;
      }
      if (str === "s" || key?.name === "left") {
        selection = "skip";
        render();
        return;
      }
      if (key?.name === "return" || str === "\r" || str === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(selection);
      }
    };
    emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    render();
    stdin.on("keypress", onKey);
  });
}

/** Plain line prompt for terminals without raw mode (--interactive while piped). */
function makeLineChooser(): (
  item: WalkthroughItem,
  index: number,
  total: number
) => Promise<FixChoice> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return async (item, index, total) => {
    for (const line of previewLines(item, index, total)) console.log(line);
    for (;;) {
      const answer = (
        await rl.question("  archive this page? [a]rchive / [s]kip / [q]uit (default: skip): ")
      )
        .trim()
        .toLowerCase();
      if (answer === "" || answer === "s" || answer === "skip") return "skip";
      if (answer === "a" || answer === "archive") return "archive";
      if (answer === "q" || answer === "quit") {
        rl.close();
        return "quit";
      }
      console.log("  please answer a, s, or q");
    }
  };
}

/** Picks the prompt style for this terminal: arrow keys when raw mode works, lines otherwise. */
export function makeChooser(
  forceInteractive: boolean
): (item: WalkthroughItem, index: number, total: number) => Promise<FixChoice> {
  const stdin = process.stdin as KeypressStream;
  const canRaw = stdin.isTTY && typeof stdin.setRawMode === "function";
  if (canRaw) return (item, index, total) => keypressChooser(stdin, item, index, total);
  if (forceInteractive) return makeLineChooser();
  // The caller only builds a chooser for interactive runs; fall back to lines.
  return makeLineChooser();
}
