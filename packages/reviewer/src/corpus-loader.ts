/**
 * @mstack/reviewer — corpus-loader.ts
 *
 * Reads the offline sample corpus (see data/README.md for the fixture
 * shapes) into the typed values this package and Wave-3's agent pipeline
 * consume:
 *   - `data/corpus/guidelines.json`       -> Guideline[] (20 curated rule rows)
 *   - `data/corpus/approved-messaging.md` -> Guideline[] (chunked prose
 *                                            passages, `type:
 *                                            "approved_messaging"`, one row
 *                                            per level-2 `##` section — the
 *                                            richer RAG-ingest source
 *                                            data/README.md describes: "the
 *                                            actual document ... chunks and
 *                                            embeds")
 *   - `data/corpus/assets/assets.json`    -> ReviewRequest[] (4 sample partner
 *                                            submissions, incl. the ABC Corp
 *                                            asset planting all six
 *                                            ClaimCategory violations)
 *
 * `loadFullGuidelineCorpus()` combines the first two into the single
 * `Guideline[]` `LanceCorpus.ingest()` expects — guidelines.json's 20 curated
 * rows (lexicon/denylist/allowlist/tier_map/approved_messaging) plus the
 * approved-messaging.md chunks give the retriever more (and longer, more
 * context-bearing) passages than the 7 short approved_messaging rows in
 * guidelines.json alone.
 *
 * Every loader validates through the REAL `@mstack/core` zod schemas — the
 * same discipline `data/validate.test.ts` uses for the raw fixture files — so
 * a malformed row fails loudly here rather than silently reaching an agent.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Guideline, ReviewRequest } from "@mstack/core";

/** `noUncheckedIndexedAccess` types every `RegExpExecArray` bracket access as
 *  possibly-undefined; centralizes the `?? ""` fallback in one place. */
function group(m: RegExpExecArray, i: number): string {
  return m[i] ?? "";
}

function resolveDefault(relativeToThisFile: string): string {
  return fileURLToPath(new URL(relativeToThisFile, import.meta.url));
}

/** data/corpus/guidelines.json, resolved relative to this file (src/ ->
 *  reviewer/ -> packages/ -> repo root -> data/corpus/...). */
export const DEFAULT_GUIDELINES_JSON_PATH = resolveDefault("../../../data/corpus/guidelines.json");
/** data/corpus/approved-messaging.md, same resolution. */
export const DEFAULT_APPROVED_MESSAGING_MD_PATH = resolveDefault("../../../data/corpus/approved-messaging.md");
/** data/corpus/assets/assets.json, same resolution. */
export const DEFAULT_ASSETS_JSON_PATH = resolveDefault("../../../data/corpus/assets/assets.json");

/** Reads + validates the curated rule rows (lexicon/denylist/allowlist/tier_map/approved_messaging). */
export async function loadGuidelinesJson(path: string = DEFAULT_GUIDELINES_JSON_PATH): Promise<Guideline[]> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error(`loadGuidelinesJson: expected a JSON array at ${path}`);
  }
  return raw.map((row) => Guideline.parse(row));
}

/** Reads the raw approved-messaging prose, unparsed — feed it to `chunkApprovedMessagingMarkdown`. */
export async function loadApprovedMessagingMarkdown(path: string = DEFAULT_APPROVED_MESSAGING_MD_PATH): Promise<string> {
  return readFile(path, "utf8");
}

/** Reads + validates the sample partner submissions. */
export async function loadReviewRequests(path: string = DEFAULT_ASSETS_JSON_PATH): Promise<ReviewRequest[]> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error(`loadReviewRequests: expected a JSON array at ${path}`);
  }
  return raw.map((row) => ReviewRequest.parse(row));
}

/* ─────────────────── markdown -> Guideline[] chunker ─────────────────── */

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

/** Best-effort section -> free-form `Guideline.category` mapping. `category`
 *  is free-form per the schema (schemas.ts: "free-form grouping; the six
 *  ClaimCategory values are common") — only lexicon/denylist/allowlist/
 *  tier_map rows need to land on an exact ClaimCategory value for rules.ts to
 *  scan them, and none of those come from this markdown chunker (it only
 *  ever emits `type: "approved_messaging"` rows). */
function inferSectionCategory(header: string): string {
  const h = header.toLowerCase();
  if (h.includes("positioning")) return "positioning";
  if (h.includes("what klz orchestrate does") || h.includes("capabilit")) return "product_capability";
  if (h.includes("proof")) return "customer_proof";
  if (h.includes("partnership") || h.includes("tier")) return "partnership";
  if (h.includes("language to avoid")) return "brand_rules";
  if (h.includes("spokespe") || h.includes("quote")) return "unapproved_spokesperson_quote";
  if (h.includes("trust") || h.includes("governance")) return "trust_and_security";
  if (h.includes("roadmap")) return "roadmap_disclosure";
  return "positioning"; // conservative fallback for an unrecognized heading
}

/**
 * Splits the approved-messaging doc into one retrievable `Guideline` per
 * level-2 (`##`) section — coarse enough to stay a handful of well-formed
 * passages (8 sections in the sample doc), fine enough that retrieval isn't
 * just "return the whole document." Sections under 40 chars of body text
 * (e.g. a stray header with no prose) are dropped. Deterministic ids
 * (`md-<slug>`) so re-chunking the same doc is idempotent, and can never
 * collide with guidelines.json's `gl-*`-prefixed ids.
 */
export function chunkApprovedMessagingMarkdown(markdown: string, opts?: { source?: string }): Guideline[] {
  const source = opts?.source ?? "approved-messaging.md";
  const lines = markdown.split(/\r?\n/);
  const headerRe = /^##\s+(.*)$/; // level-2 only; deliberately not ### or #

  const sections: Array<{ header: string; body: string[] }> = [];
  let current: { header: string; body: string[] } | null = null;
  for (const line of lines) {
    const h = headerRe.exec(line);
    const headerText = h ? group(h, 1).trim() : "";
    if (h && headerText) {
      if (current) sections.push(current);
      current = { header: headerText, body: [] };
    } else if (current) {
      current.body.push(line);
    }
    // Lines before the first `##` header (title/status preamble) are dropped.
  }
  if (current) sections.push(current);

  return sections
    .map((s) => ({ header: s.header, content: s.body.join("\n").trim() }))
    .filter((s) => s.content.length >= 40)
    .map((s) =>
      Guideline.parse({
        id: `md-${slugify(s.header)}`,
        category: inferSectionCategory(s.header),
        type: "approved_messaging",
        content: `## ${s.header}\n\n${s.content}`,
        severity: "low",
        source,
        version: "1",
      }),
    );
}

/**
 * The combined corpus `LanceCorpus.ingest()` / the reviewer pipeline expects:
 * guidelines.json's curated rows + approved-messaging.md's chunked passages.
 */
export async function loadFullGuidelineCorpus(opts?: {
  guidelinesJsonPath?: string;
  approvedMessagingMdPath?: string;
}): Promise<Guideline[]> {
  const [rows, markdown] = await Promise.all([
    loadGuidelinesJson(opts?.guidelinesJsonPath),
    loadApprovedMessagingMarkdown(opts?.approvedMessagingMdPath),
  ]);
  return [...rows, ...chunkApprovedMessagingMarkdown(markdown)];
}
