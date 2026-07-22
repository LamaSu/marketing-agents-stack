/**
 * @mstack/reviewer — nli-backstop.ts — the grounded-NLI second opinion on the
 * judge step (research/10-sota-integration-design.md §2.2, Wave B2).
 *
 * The judge (Claude/Opus, review-agent.ts) is the sole grounding authority
 * today: it decides whether a claim is supported by a retrieved passage, and
 * every claim it marks unsupported/drifted becomes a `FindingDraft`. This
 * module adds a model-independent double-check on those findings: a small,
 * fast NLI (natural-language-inference) classifier that answers "does this
 * passage actually entail this claim?" independently of the LLM that produced
 * the finding. When it DISAGREES with the judge, `review-agent.ts` flags the
 * finding for a human instead of silently trusting either side.
 *
 * Same "opt-in sidecar behind an injectable seam, no-op offline default" shape
 * as `adapters-enrichment`'s `crawl4aiFetchSite` (Wave A1, see
 * `packages/adapters-enrichment/src/crawl4ai.ts` + `docker/crawl4ai.md`):
 *   - `noopNliBackstop` — the DEFAULT. Always agrees with the judge. Fully
 *     offline, zero network, zero config. `reviewAsset` behaves exactly as it
 *     did before this feature existed.
 *   - `createHhemBackstop` / `hhemBackstop` — the OPT-IN real implementation,
 *     backed by a Vectara HHEM-2.1-Open (Apache-2.0 model) sidecar reached over
 *     plain HTTP (`docker/hhem.md` has the run command + the minimal serving
 *     wrapper -- unlike Crawl4AI there is no ready-made "HHEM server" image, so
 *     that file's FastAPI wrapper is OUR OWN glue code, clearly marked as such).
 *     Never vendored into this strict-ESM TS tree (docs/build-conventions.md's
 *     sidecar rule -- Python/model-serving tools run as separate processes).
 *
 * Both fully injectable, matching this package's offline-testable idiom
 * (`ReviewAgentDeps.client`, `ReviewAgentDeps.corpus`).
 */

/** A grounded-NLI classifier: does `passage` entail `claim`? `score` is the
 *  raw model output (HHEM: a 0-1 factual-consistency score); `supported` is
 *  the thresholded boolean the pipeline actually branches on. */
export interface NliBackstop {
  entails(claim: string, passage: string): Promise<{ supported: boolean; score: number }>;
}

/**
 * The DEFAULT implementation: always agrees with the judge (`supported:
 * false` -- the judge's finding stands, nothing flagged). Fully offline, no
 * sidecar, no config. "Agrees with the judge" is the correct default because
 * every `FindingDraft` this backstop is called on already represents the
 * judge treating a claim as a violation (unsupported/drifted) -- `supported:
 * false` is literally "yes, I see it the same way," so wiring this in changes
 * nothing about `reviewAsset`'s output versus before this feature existed.
 */
export const noopNliBackstop: NliBackstop = {
  async entails(): Promise<{ supported: boolean; score: number }> {
    return { supported: false, score: 0 };
  },
};

export interface HhemBackstopConfig {
  /** HHEM sidecar base URL (no trailing slash needed -- stripped if present).
   *  Defaults to the `HHEM_URL` env var, then `http://localhost:8000` (the
   *  minimal wrapper's default port in `docker/hhem.md` -- an ASSUMPTION, since
   *  no official Vectara serving image exists; verify against your own sidecar
   *  on first real use, same discipline as `crawl4ai.ts`). */
  baseUrl?: string;
  /** injectable fetch -- defaults to `globalThis.fetch`. Inject a fake in tests. */
  fetchImpl?: typeof fetch;
  /** abort the sidecar call after this many ms. Default 10000. */
  timeoutMs?: number;
  /** HHEM outputs a 0-1 factual-consistency score; score >= threshold counts as
   *  "supported" (entailed -- a disagreement with a judge finding). Default 0.5. */
  threshold?: number;
}

const DEFAULT_BASE_URL = "http://localhost:8000";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_THRESHOLD = 0.5;

interface HhemPredictResponse {
  score?: number;
}

/**
 * Build an `NliBackstop` backed by an HHEM sidecar. On ANY failure (sidecar
 * unreachable, non-OK status, timeout, or a response with no numeric `score`)
 * it falls back to the SAME verdict `noopNliBackstop` returns (`supported:
 * false, score: 0`) -- degraded to "agrees with the judge," never a crash,
 * never a spurious `needsReview` flag from a flaky sidecar. Matches
 * `createCrawl4aiFetchSite`'s graceful-degradation discipline exactly.
 */
export function createHhemBackstop(config: HhemBackstopConfig = {}): NliBackstop {
  const baseUrl = (config.baseUrl ?? process.env["HHEM_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;

  return {
    async entails(claim: string, passage: string): Promise<{ supported: boolean; score: number }> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl}/predict`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ claim, passage }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`HHEM sidecar at ${baseUrl} responded ${res.status}`);
        }
        const json = (await res.json()) as HhemPredictResponse;
        if (typeof json.score !== "number") {
          throw new Error("HHEM sidecar returned no numeric score");
        }
        return { supported: json.score >= threshold, score: json.score };
      } catch (err) {
        console.warn(
          `[@mstack/reviewer] hhemBackstop: sidecar at ${baseUrl} failed (${String(err)}); ` +
            "falling back to the no-op verdict (agrees with the judge -- degraded, not broken)",
        );
        return { supported: false, score: 0 };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Ready-to-use default instance -- `HHEM_URL` env (or `http://localhost:8000`)
 * + global fetch. Pass directly: `reviewAsset(req, { corpus, nliBackstop:
 * hhemBackstop })`. For tests, use `createHhemBackstop({ fetchImpl })` instead
 * so nothing touches the real network -- or simpler still, hand-write a fake
 * `NliBackstop` object (see review-agent.test.ts).
 */
export const hhemBackstop: NliBackstop = createHhemBackstop();
