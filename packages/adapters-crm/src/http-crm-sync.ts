/**
 * http-crm-sync.ts — `createHttpCrmSync`, an opt-in `CrmSync` that POSTs our
 * derived scores/decisions/outcomes to a CRM-facing HTTP endpoint (a
 * deployer's own middleware in front of Salesforce/HubSpot, or a thin proxy
 * they stand up). Mirrors `adapters-enrichment/src/crawl4ai.ts`'s
 * injectable-fetch + `AbortController` timeout + "degrade on ANY failure"
 * shape: a CRM outage, bad config, or non-2xx response NEVER throws — it
 * logs a redacted warning and resolves, exactly like `noopCrmSync`, so a CRM
 * push can never break the (offline-capable) loop that produced the
 * score/decision/outcome in the first place.
 *
 * WHY `baseUrl` AND `apiKey` ARE BOTH REQUIRED, NO ENV FALLBACK: unlike
 * `crawl4aiFetchSite` (which defaults to a local sidecar at
 * `http://localhost:11235` — a safe generic default), a CRM base URL names a
 * specific deployer's real tenant, and the key is always a secret. Neither
 * has a safe default, so both are explicit config — the same discipline
 * `composio-channel.ts`'s `apiKey` already uses ("this package never
 * auto-reads `process.env` for a secret").
 *
 * SECRET HYGIENE: `apiKey` is sent either as an `Authorization: Bearer`
 * header (default) or, for CRM middleware that requires it (`authStyle:
 * "query"` — e.g. HubSpot's older `hapikey`-style query-parameter auth),
 * appended to the request URL as a query parameter. Because a query-style
 * key necessarily lives in the URL, EVERY string this module could log (the
 * URL, any thrown error's message) is passed through `redactSecret` first —
 * the key is used to build a request, never to build a log line.
 */
import type { Account, Decision, Outcome } from "@mstack/core";
import type { CrmSync } from "./crm-sync.js";

export interface HttpCrmSyncConfig {
  /** CRM endpoint base URL (a deployer's own middleware in front of
   *  Salesforce/HubSpot, or a thin proxy). REQUIRED and explicit — see the
   *  file header on why there is no default. No trailing slash needed. */
  baseUrl: string;
  /** CRM auth key/token. REQUIRED and explicit; never read from
   *  `process.env`, never logged (see file header). */
  apiKey: string;
  /** "header" (default): `Authorization: Bearer <apiKey>`.
   *  "query": append `?<queryParamName>=<apiKey>` to the URL (some CRM
   *  middleware / legacy APIs require this). */
  authStyle?: "header" | "query";
  /** query param name when `authStyle: "query"`. Default `"api_key"`. */
  queryParamName?: string;
  /** injectable fetch — defaults to `globalThis.fetch`. Inject a fake in tests. */
  fetchImpl?: typeof fetch;
  /** abort the request after this many ms and degrade to a warning. Default 10000. */
  timeoutMs?: number;
  /** seam-required identity. Default "http". */
  name?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Replace every occurrence of `secret` in `text` before it is ever logged. */
function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join("[REDACTED]") : text;
}

/**
 * Build a `CrmSync` backed by a plain HTTP endpoint. On ANY failure (network
 * error, non-OK response, or timeout) it logs a secret-redacted warning and
 * resolves — never throws, never breaks the caller. Score/decision/outcome
 * pushes each hit their own sub-path so a real CRM-facing proxy can route
 * them to different underlying objects/fields.
 */
export function createHttpCrmSync(config: HttpCrmSyncConfig): CrmSync {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const apiKey = config.apiKey;
  const authStyle = config.authStyle ?? "header";
  const queryParamName = config.queryParamName ?? "api_key";
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const name = config.name ?? "http";

  async function post(label: string, path: string, body: unknown): Promise<void> {
    const url = new URL(`${baseUrl}${path}`);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authStyle === "query") {
      url.searchParams.set(queryParamName, apiKey);
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const urlString = url.toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(urlString, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`crm endpoint responded ${res.status}`);
      }
    } catch (err) {
      const safeUrl = redactSecret(urlString, apiKey);
      const safeErr = redactSecret(String(err), apiKey);
      console.warn(
        `[@mstack/adapters-crm] httpCrmSync: ${label} push to ${safeUrl} failed (${safeErr}); ` +
          `degrading to no-op (a CRM push is never allowed to break the caller)`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name,
    async pushScore(account: Account): Promise<void> {
      await post("score", `/accounts/${encodeURIComponent(account.domain)}/score`, {
        domain: account.domain,
        score: account.score ?? null,
        tier: account.tier ?? null,
        lastScoredAt: account.lastScoredAt ?? null,
      });
    },
    async pushDecision(decision: Decision): Promise<void> {
      await post("decision", "/decisions", decision);
    },
    async pushOutcome(outcome: Outcome): Promise<void> {
      await post("outcome", "/outcomes", outcome);
    },
  };
}
