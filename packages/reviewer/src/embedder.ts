/**
 * @mstack/reviewer — embedder.ts
 *
 * The `Embedder` seam `LanceCorpus` (lance-corpus.ts) embeds passages and
 * queries through. Two implementations ship here:
 *   - `FakeEmbedder`        — deterministic, offline, dependency-free
 *     hashing-trick bag-of-words vectorizer. What every test in this package
 *     uses (docs/build-conventions.md: no network, no model download in tests
 *     run against the dev tablet).
 *   - `HuggingFaceEmbedder` — real `bge-small-en-v1.5` embeddings via
 *     Transformers.js. NOT exercised by this package's tests (that would
 *     require a network call + an ONNX model download, which the offline-test
 *     requirement rules out) — its correctness is a Wave-3 / live-smoke-test
 *     concern. Constructing it never touches the network; only `embed()`
 *     does (lazy pipeline load), so it's safe to construct as a default even
 *     in a path that never calls it.
 *
 * PACKAGE NAME — verified live 2026-07-20, not assumed from
 * research/tools/C-claim-verification.md's `@xenova/transformers`:
 * `npm view @xenova/transformers version` → 2.17.2 (frozen — Xenova
 * transferred Transformers.js to Hugging Face; this is the pre-transfer v2
 * package, last published against that line). `npm view @huggingface/transformers
 * version` → 4.2.0 (the actively maintained v3+ successor). This package
 * depends on `@huggingface/transformers`.
 *
 * API SHAPE — confirmed against the package's own shipped `.d.ts` files at
 * the verified version (types/pipelines/feature-extraction.d.ts embeds this
 * exact usage as its documented example):
 *   const extractor = await pipeline('feature-extraction', modelId);
 *   const output = await extractor(texts, { pooling: 'mean', normalize: true });
 *   output.tolist() // -> nested JS array, shape [texts.length, hiddenSize]
 * Not run locally — docs/build-conventions.md: no local `pnpm install` /
 * model download; this was verified by inspecting the published type
 * declarations and JSDoc examples, not by executing the code.
 */
import { pipeline } from "@huggingface/transformers";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/* ───────────────────────────── FakeEmbedder ─────────────────────────────── */

/**
 * Deterministic hashing-trick bag-of-words embedder: tokenize -> hash each
 * token into one of `dims` buckets (FNV-1a) -> term-frequency vector -> L2
 * normalize. No model, no network, no filesystem access — the same input
 * always produces the same output vector, and lexically-similar text
 * produces higher-cosine-similarity vectors than unrelated text, so
 * retrieval tests built on this embedder exercise real ranking behavior, not
 * just ingest/retrieve plumbing.
 */
export class FakeEmbedder implements Embedder {
  constructor(private readonly dims: number = 128) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dims).fill(0);
    for (const token of tokenize(text)) {
      const bucket = fnv1a(token) % this.dims;
      vec[bucket] = (vec[bucket] ?? 0) + 1;
    }
    return l2Normalize(vec);
  }
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** FNV-1a 32-bit hash, unsigned. Cheap, deterministic, well-distributed
 *  enough for a bucket count in the low hundreds. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function l2Normalize(vec: number[]): number[] {
  let sumSquares = 0;
  for (const v of vec) sumSquares += v * v;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/* ────────────────────────── HuggingFaceEmbedder ─────────────────────────── */

const DEFAULT_MODEL_ID = "Xenova/bge-small-en-v1.5";

/**
 * Real embeddings via Transformers.js, `bge-small-en-v1.5` by default
 * (research/tools/C-claim-verification.md §6/§9 "DEFAULT design for v1").
 * Lazily loads the pipeline on the first `embed()` call.
 */
export class HuggingFaceEmbedder implements Embedder {
  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(private readonly modelId: string = DEFAULT_MODEL_ID) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    // Tensor.tolist() is typed `any[]` upstream (types/utils/tensor.js); for a
    // batched feature-extraction call its documented shape is
    // [texts.length, hiddenSize] (see file header) -- the cast is narrowing a
    // deliberately-loose upstream type, not asserting past a real ambiguity.
    return output.tolist() as number[][];
  }

  private async getExtractor(): Promise<FeatureExtractionPipeline> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = pipeline("feature-extraction", this.modelId);
    }
    return this.pipelinePromise;
  }
}
