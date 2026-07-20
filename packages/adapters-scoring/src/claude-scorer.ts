/**
 * ClaudeScorer -- cold-start ICP fit scoring via Claude, no training data required. See
 * research/06-architecture.md §3.2 + research/tools/D-warehouse-scoring.md ("LLM-as-
 * scorer... the cold-start scorer... complements the ML model [and] returns an
 * agent-actionable rationale a numeric score can't").
 *
 * The `Anthropic` client is INJECTABLE (constructor option `client`) so tests run fully
 * offline against a fake client -- no network, no API key required. When no client is
 * injected, one is constructed lazily on first `score()` call (never at import or at
 * `new ClaudeScorer()` construction time). A construction or call failure surfaces as a
 * rejected `score()` promise, which HybridScorer catches and degrades from -- never a
 * crash at import or construction.
 *
 * Output handling: plain `messages.create` + a Zod-v3 `safeParse` of the returned JSON
 * (matching @mstack/agents' approach). We deliberately do NOT use the SDK's
 * `messages.parse()` + `zodOutputFormat()` structured-output helper: that helper's types
 * require Zod v4, and this repo is standardized on Zod v3 (see @mstack/core). One shape,
 * one zod version, no cross-version type friction.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { modelFor, AccountTier, type ScoringProvider, type ScoreResult, type Account, type Signal } from "@mstack/core";

/** {score,tier,rationale} -- exactly ScoreResult's shape. */
const ClaudeScoreSchema = z.object({
  score: z.number().min(0).max(100),
  tier: AccountTier,
  rationale: z.string(),
});

const SYSTEM_PROMPT =
  "You produce a cold-start ICP fit score for one B2B account. Given firmographic data " +
  "and its recent signals, output a 0-100 fit score, a tier (STRONG_FIT, FIT, " +
  "PARTIAL_FIT, or DISQUALIFIED), and a short rationale citing the specific facts and " +
  "signals that drove the score. Use only the facts given in the input -- never invent " +
  "a firmographic detail or signal that is not present. If a signal indicates the " +
  "account should not be contacted (opted out, unsubscribed, do-not-contact), say so " +
  "plainly and score it low with tier DISQUALIFIED.\n\n" +
  'Respond with ONLY a JSON object of the form {"score": <0-100 number>, "tier": ' +
  '"STRONG_FIT"|"FIT"|"PARTIAL_FIT"|"DISQUALIFIED", "rationale": "<one or two sentences>"} ' +
  "and nothing else.";

/** How many of the most-recent signals to include in the context pack -- token
 *  discipline, mirrors research/06-architecture.md §3.2 "Context-pack discipline". */
const MAX_SIGNALS_IN_CONTEXT = 25;

function buildUserContent(account: Account, signals: Signal[]): string {
  const recent = [...signals].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, MAX_SIGNALS_IN_CONTEXT);
  return JSON.stringify(
    {
      account: {
        domain: account.domain,
        name: account.name,
        firmographic: account.firmographic,
        lifecycleStage: account.lifecycleStage ?? null,
      },
      signals: recent.map((s) => ({ id: s.id, ts: s.ts, kind: s.kind, source: s.source, action: s.action ?? null })),
    },
    null,
    2,
  );
}

/** Strip a ```json fence if present, then parse. Falls back to the first {...} block. */
function parseJsonLoose(text: string): unknown {
  const fenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(fenced);
  } catch {
    const match = fenced.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("ClaudeScorer: no JSON object found in model output");
  }
}

export interface ClaudeScorerOptions {
  /** Inject a pre-built Anthropic client -- a real one, or a test double cast to
   *  `Anthropic` (see index.test.ts). This is the injection point tests use to stay offline. */
  client?: Anthropic;
  /** Anthropic API key, only used if `client` is not supplied (passed to `new Anthropic()`). */
  apiKey?: string;
  /** Overrides the centralized `@mstack/core` model-id map (default: `modelFor("scoreAssist")`). */
  model?: string;
}

export class ClaudeScorer implements ScoringProvider {
  readonly name = "claude";
  readonly #apiKey: string | undefined;
  readonly #model: string;
  #client: Anthropic | undefined;

  constructor(options: ClaudeScorerOptions = {}) {
    this.#client = options.client;
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? modelFor("scoreAssist");
  }

  /** Constructed lazily -- never at `new ClaudeScorer()` time. */
  #ensureClient(): Anthropic {
    if (!this.#client) {
      this.#client = new Anthropic(this.#apiKey ? { apiKey: this.#apiKey } : undefined);
    }
    return this.#client;
  }

  async score(account: Account, signals: Signal[]): Promise<ScoreResult> {
    const client = this.#ensureClient();
    const response = await client.messages.create({
      model: this.#model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserContent(account, signals) }],
    });

    if (response.stop_reason === "refusal") {
      throw new Error("ClaudeScorer: request refused");
    }
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const parsed = ClaudeScoreSchema.safeParse(parseJsonLoose(text));
    if (!parsed.success) {
      throw new Error(`ClaudeScorer: model output did not match the score schema: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}
