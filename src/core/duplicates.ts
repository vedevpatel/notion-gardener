import { normalizeTitle, type PageRecord } from "./detectors.js";

/**
 * A content fingerprint for one page, built while the scan reads blocks:
 * how much text there is, what kind of blocks hold it, the significant
 * words (for overlap between copies), and a short preview. This is what
 * makes "these two pages share a title" actionable - the diff shows what
 * actually differs instead of leaving the whole call to the human.
 */
export interface ContentDigest {
  /** Total characters of text content across the page's blocks. */
  charCount: number;
  /** Top-level block type -> count (paragraph, to_do, heading_2, ...). */
  blockTypes: Record<string, number>;
  /** Significant lowercased words in the content, for overlap checks. */
  words: Set<string>;
  /** First characters of the text, for previews. */
  preview: string;
}

export type DuplicateSuggestion = "keep_newest" | "keep_contentful" | "review";

export interface DuplicatePageComparison {
  page: PageRecord;
  /** Null when the page's content wasn't read this run. */
  digest: ContentDigest | null;
  /** Significant words only this copy has (a handful, for the report). */
  uniqueWords: string[];
}

export interface DuplicateComparison {
  /** Display title the copies share (from the newest copy). */
  title: string;
  /** The copies, newest edit first. */
  pages: DuplicatePageComparison[];
  suggestion: DuplicateSuggestion;
  /** One sentence a human can act on. Advisory only - fix never archives duplicates. */
  suggestionText: string;
  /** What actually differs between the copies, as short bullets. */
  differences: string[];
}

const MAX_UNIQUE_WORDS_SHOWN = 5;
const PREVIEW_LENGTH = 160;

const STOP_WORDS = new Set([
  "this", "that", "with", "from", "have", "been", "were", "they", "them",
  "then", "than", "when", "what", "your", "about", "there", "here",
  "and", "the", "for", "are", "was", "not", "you", "all", "can", "but",
]);

/** Significant words in free text: lowercase, alphanumeric, not filler. */
export function digestWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length >= 3 && !STOP_WORDS.has(token)) words.add(token);
  }
  return words;
}

/** Builds a digest from plain block text and block type names. */
export function makeDigest(text: string, blockTypes: Record<string, number> = {}): ContentDigest {
  return {
    charCount: text.length,
    blockTypes,
    words: digestWords(text),
    preview: text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LENGTH),
  };
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatBlockMix(blockTypes: Record<string, number>): string {
  const entries = Object.entries(blockTypes).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "no blocks";
  const shown = entries.slice(0, 4).map(([type, n]) => `${n} ${type.replace(/_/g, " ")}`);
  if (entries.length > shown.length) shown.push(`+${entries.length - shown.length} more types`);
  return shown.join(", ");
}

/**
 * Diffs every group of pages that share a title. For each group: how the
 * copies differ (edit dates, content length, block mix, words only one
 * copy has) and a concrete suggestion - keep the newest copy, keep the
 * copy with content, or review by hand when both copies carry unique
 * content. Advisory only: duplicates never auto-archive.
 */
export function diffDuplicates(
  pages: PageRecord[],
  digests: ReadonlyMap<string, ContentDigest>
): DuplicateComparison[] {
  const active = pages.filter((p) => !p.archived);
  const byTitle = new Map<string, PageRecord[]>();
  for (const page of active) {
    const key = normalizeTitle(page.title);
    if (!key) continue;
    const group = byTitle.get(key) ?? [];
    group.push(page);
    byTitle.set(key, group);
  }

  const comparisons: DuplicateComparison[] = [];
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(
      (a, b) => b.lastEditedTime.getTime() - a.lastEditedTime.getTime()
    );

    const pages: DuplicatePageComparison[] = sorted.map((page) => {
      const digest = digests.get(page.id) ?? null;
      const uniqueWords: string[] = [];
      if (digest) {
        for (const word of digest.words) {
          const shared = sorted.some(
            (other) => other.id !== page.id && (digests.get(other.id)?.words.has(word) ?? false)
          );
          if (!shared) uniqueWords.push(word);
        }
      }
      return { page, digest, uniqueWords: uniqueWords.slice(0, MAX_UNIQUE_WORDS_SHOWN) };
    });

    comparisons.push(buildComparison(pages));
  }

  comparisons.sort((a, b) => b.pages.length - a.pages.length || a.title.localeCompare(b.title));
  return comparisons;
}

function buildComparison(pages: DuplicatePageComparison[]): DuplicateComparison {
  const newest = pages[0];
  const oldest = pages[pages.length - 1];
  const title = newest.page.title.trim();

  const differences: string[] = [];
  if (newest.page.lastEditedTime.getTime() !== oldest.page.lastEditedTime.getTime()) {
    differences.push(
      `last edited ${formatDate(newest.page.lastEditedTime)} (newest) vs ${formatDate(oldest.page.lastEditedTime)} (oldest)`
    );
  } else {
    differences.push(`all edited ${formatDate(newest.page.lastEditedTime)}`);
  }
  const charCounts = pages.map((p) => (p.digest ? `${p.digest.charCount} chars` : "content unread"));
  if (new Set(charCounts).size > 1) differences.push(`content length: ${charCounts.join(" vs ")}`);
  for (const p of pages) {
    if (p.digest && p.uniqueWords.length > 0) {
      differences.push(
        `only in the ${formatDate(p.page.lastEditedTime)} copy: ${p.uniqueWords.join(", ")}`
      );
    }
  }

  const missing = pages.some((p) => p.digest === null);
  const withContent = pages.filter((p) => (p.digest?.charCount ?? 0) > 0);
  const withUniqueContent = withContent.filter((p) => p.uniqueWords.length > 0);

  let suggestion: DuplicateSuggestion;
  let suggestionText: string;
  if (missing) {
    suggestion = "review";
    suggestionText = "Could not read every copy's content this run - review by hand.";
  } else if (withUniqueContent.length >= 2) {
    suggestion = "review";
    suggestionText = "Both copies have unique content - review before archiving either.";
  } else if (withContent.length > 0 && withContent.length < pages.length) {
    suggestion = "keep_contentful";
    suggestionText = `Keep the copy with content (edited ${formatDate(
      withContent[0].page.lastEditedTime
    )}); the other ${pages.length - withContent.length === 1 ? "copy is" : "copies are"} empty.`;
  } else {
    suggestion = "keep_newest";
    suggestionText = `Contents are near-identical; keep the newest copy (edited ${formatDate(
      newest.page.lastEditedTime
    )}) and archive the older ${pages.length === 2 ? "one" : "ones"}.`;
  }

  return { title, pages, suggestion, suggestionText, differences };
}

/** Markdown lines for one comparison, used by the report's duplicate section. */
export function renderComparisonMarkdown(c: DuplicateComparison): string[] {
  const lines: string[] = [];
  lines.push(`### "${c.title}" — ${c.pages.length} copies`);
  lines.push("");
  for (const p of c.pages) {
    const label = p.page.title.trim() || "(untitled)";
    const stats = p.digest
      ? `${p.digest.charCount} chars, ${formatBlockMix(p.digest.blockTypes)}`
      : "content not read this run";
    lines.push(`- [${label}](${p.page.url}) — edited ${formatDate(p.page.lastEditedTime)}, ${stats}`);
  }
  lines.push("");
  lines.push(`Suggestion: ${c.suggestionText}`);
  for (const diff of c.differences) lines.push(`- ${diff}`);
  lines.push("");
  return lines;
}

/** Serializable shape for the --json report. */
export function comparisonToJson(c: DuplicateComparison): Record<string, unknown> {
  return {
    title: c.title,
    suggestion: c.suggestion,
    suggestionText: c.suggestionText,
    differences: c.differences,
    copies: c.pages.map((p) => ({
      id: p.page.id,
      title: p.page.title,
      url: p.page.url,
      lastEditedTime: p.page.lastEditedTime.toISOString(),
      charCount: p.digest?.charCount ?? null,
      blockTypes: p.digest?.blockTypes ?? null,
      uniqueWords: p.uniqueWords,
    })),
  };
}
