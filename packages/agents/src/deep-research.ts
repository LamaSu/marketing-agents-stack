/**
 * deep-research.ts — an OPT-IN `deepResearch` tool for the SDR-Researcher,
 * backed by a **GPT-Researcher** HTTP sidecar (Apache-2.0, assafelovic/
 * gpt-researcher — an autonomous deep-research agent that plans sub-queries,
 * scrapes, and writes a cited report), per research/10-sota-integration-design.md
 * §2.3 (Wave C2).
 *
 * IT IS A TOOL THE AGENT CAN CALL, NOT A REPLACEMENT. The offline default
 * SDR-Researcher stays bound to persisted `signalId`s ("never invent a signal");
 * this tool is only constructed and handed to the agent when a deployer is
 * online + keyed. It is NOT in any default tool-set — a caller opts in by adding
 * `deepResearchTool(...)` to the tools it passes to `runAgent`. So the keyless
 * `mstack demo` is entirely unaffected: no sidecar, no network, no tool.
 *
 * GPT-Researcher is Python. Per docs/build-conventions.md's sidecar rule (Python
 * tools — even Apache/MIT ones — run as separate processes, never vendored into
 * the strict-ESM TS tree), this file only ever talks to it over HTTP.
 * `docker/gpt-researcher.md` has the run command; nothing here spawns or imports
 * Python.
 *
 * DEGRADE, NEVER CRASH: deep research being unavailable (sidecar down, timeout,
 * unkeyed search backend) is a DEGRADED MODE, not a bug — the agent should fall
 * back to its persisted signals. So on ANY failure the handler returns a
 * structured `{ ok: false, report: "", sources: [], error }` (and warns) rather
 * than throwing; the agent reads `ok:false` and carries on. Same graceful-
 * degradation discipline as `adapters-enrichment`'s `crawl4aiFetchSite`.
 *
 * ASSUMPTION — VERIFY ON THE SPARK BUILD / a real sidecar (written without
 * `pnpm install` or a live GPT-Researcher container, per docs/build-conventions.md):
 * GPT-Researcher's server exposes `POST /report/` taking
 *   { "task": <query>, "report_type": <string>, "report_source": <string> }
 * and returning a JSON body carrying the finished report. Field names vary by
 * version, so `extractReport` reads `report` → `research_information` →
 * `answer` → `output` (first string wins) and sources from `source_urls` →
 * `sources` → []. If a live server's shape differs, widen `GptrReportResponse` /
 * `extractReport` below — the tool's signature and every test are unaffected.
 * This mirrors `crawl4ai.ts`'s documented-assumption approach exactly.
 */
import { z } from "zod";
import type { AgentTool } from "./types.js";

export interface DeepResearchConfig {
  /** GPT-Researcher sidecar base URL (trailing slash stripped). Defaults to the
   *  `GPTR_URL` env var, then `http://localhost:8001`. */
  baseUrl?: string;
  /** injectable fetch — defaults to `globalThis.fetch`. Inject a fake in tests. */
  fetchImpl?: typeof fetch;
  /** abort + degrade after this many ms. Deep research is SLOW (it plans, scrapes,
   *  and writes) — default 180000 (3 min). */
  timeoutMs?: number;
  /** GPT-Researcher report_type. Default "research_report". */
  reportType?: string;
  /** GPT-Researcher report_source. Default "web". */
  reportSource?: string;
}

const DEFAULT_BASE_URL = "http://localhost:8001";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_REPORT_TYPE = "research_report";
const DEFAULT_REPORT_SOURCE = "web";

interface GptrReportResponse {
  report?: string;
  research_information?: string;
  answer?: string;
  output?: string;
  source_urls?: string[];
  sources?: string[];
}

/** First non-empty string among the known report fields; "" if none. */
function extractReport(json: GptrReportResponse): string {
  for (const v of [json.report, json.research_information, json.answer, json.output]) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

function extractSources(json: GptrReportResponse): string[] {
  if (Array.isArray(json.source_urls)) return json.source_urls;
  if (Array.isArray(json.sources)) return json.sources;
  return [];
}

/** The tool's result shape — `ok` lets the agent branch on availability. */
export interface DeepResearchResult {
  ok: boolean;
  report: string;
  sources: string[];
  error?: string;
}

/**
 * Build the OPT-IN `deepResearch` `AgentTool`. Hand it to `runAgent` only when
 * online + keyed; it is never part of a default tool-set. On any sidecar failure
 * it returns `{ ok: false, ... }` (degraded), never throws.
 */
export function deepResearchTool(config: DeepResearchConfig = {}): AgentTool {
  const baseUrl = (config.baseUrl ?? process.env["GPTR_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const reportType = config.reportType ?? DEFAULT_REPORT_TYPE;
  const reportSource = config.reportSource ?? DEFAULT_REPORT_SOURCE;

  const inputSchema = z.object({
    query: z
      .string()
      .describe("the research question, e.g. 'What is ACME Corp's 2026 cloud-migration strategy?'"),
  });

  return {
    name: "deep_research",
    description:
      "Run an autonomous deep-research pass (plans sub-queries, scrapes the web, writes a cited report) " +
      "and get back a report plus its source URLs. Use it ONLY when you need external context a persisted " +
      "signal cannot give — it is slow and online. Cite the returned source URLs; never invent findings. " +
      "If it returns ok:false, the backend is unavailable — fall back to the persisted signals.",
    inputSchema,
    handler: async (args): Promise<DeepResearchResult> => {
      const { query } = inputSchema.parse(args);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl}/report/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task: query, report_type: reportType, report_source: reportSource }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`gpt-researcher sidecar at ${baseUrl} responded ${res.status}`);
        }
        const json = (await res.json()) as GptrReportResponse;
        const report = extractReport(json).trim();
        if (!report) {
          throw new Error("gpt-researcher sidecar returned an empty report");
        }
        return { ok: true, report, sources: extractSources(json) };
      } catch (err) {
        console.warn(
          `[@mstack/agents] deepResearch: sidecar at ${baseUrl} failed for query (${String(err)}); ` +
            "returning ok:false — the agent should fall back to persisted signals (degraded, not broken)",
        );
        return { ok: false, report: "", sources: [], error: String(err) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
