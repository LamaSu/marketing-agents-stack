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
 *
 * FIELD PROJECTION (audit finding #11): `pushDecision`/`pushOutcome` used to
 * POST the caller's `decision`/`outcome` object directly, so an object
 * carrying extra enumerable fields (e.g. smuggled on via an upstream
 * `as any` cast — `{ ...decision, recipient, subject, body }`) would
 * serialize ALL of them to the CRM endpoint. Both now go through `project()`
 * below, which re-`parse()`s the value through its own `Decision`/`Outcome`
 * zod schema first — zod's default (no `.strict()`/`.passthrough()`) object
 * behavior strips unknown keys, so only the schema's real fields ever reach
 * `JSON.stringify`. `pushScore` was already safe (it hand-picks
 * domain/score/tier/lastScoredAt onto a fresh literal) and is unchanged.
 */
import { Decision, Outcome } from "@mstack/core";
import type { Account } from "@mstack/core";
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
 * Parse `value` through `schema`, returning ONLY the schema's recognized
 * fields (zod's default unknown-key-stripping — see the file header's FIELD
 * PROJECTION note). Never throws: if `value` doesn't actually satisfy
 * `schema` (a genuinely malformed shape, not merely extra fields — those are
 * the point of this function and are silently dropped), this degrades to a
 * warning and `undefined`, matching this module's "never break the caller"
 * contract exactly like a network failure would.
 */
function project<T>(label: string, schema: { parse(value: unknown): T }, value: unknown): T | undefined {
  try {
    return schema.parse(value);
  } catch (err) {
    console.warn(
      `[@mstack/adapters-crm] httpCrmSync: ${label} push skipped — payload failed schema validation (${String(err)}); ` +
        `refusing to forward unvalidated fields to the CRM`,
    );
    return undefined;
  }
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
      // Project through the Decision schema first (finding #11) -- strips any
      // extra runtime fields before they can ever reach JSON.stringify/the wire.
      const projected = project("decision", Decision, decision);
      if (projected === undefined) return;
      await post("decision", "/decisions", projected);
    },
    async pushOutcome(outcome: Outcome): Promise<void> {
      const projected = project("outcome", Outcome, outcome);
      if (projected === undefined) return;
      await post("outcome", "/outcomes", projected);
    },
  };
}
