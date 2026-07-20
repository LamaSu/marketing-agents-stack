/**
 * Minimal local email validation: syntax + MX/DNS existence, plus role-account and
 * free-provider heuristics. Deliberately NOT live SMTP probing —
 * research/tools/B-enrichment-data.md §8: SMTP probing is unreliable (Gmail/Outlook
 * don't reveal validity) and risks sender-IP blacklisting. The safe, free subset
 * (syntax + MX/DNS + role/free-provider inference) is what's built here;
 * `AfterShip/email-verifier` (Go, MIT) is the documented fuller local option (adds
 * catch-all/disposable-domain detection) for a later wave if needed — not built here.
 */
import { resolveMx as nodeResolveMx } from "node:dns/promises";

// RFC 5322-ish practical syntax check (not the full grammar — a pragmatic subset every
// enrichment/CRM tool actually uses).
const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

const ROLE_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "info", "admin", "support", "sales", "contact", "hello", "help",
  "noreply", "no-reply", "postmaster", "webmaster", "billing", "careers",
]);

const FREE_PROVIDERS: ReadonlySet<string> = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
  "aol.com", "proton.me", "protonmail.com", "live.com", "msn.com",
]);

export interface EmailCheckResult {
  email: string;
  syntaxValid: boolean;
  domain: string | null;
  /** null = not checked (invalid syntax, or `skipMx`) — NOT "confirmed no MX record". */
  hasMx: boolean | null;
  isRoleAccount: boolean;
  isFreeProvider: boolean;
}

export type ResolveMx = (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;

export interface CheckEmailOptions {
  /** injectable MX resolver — defaults to `node:dns/promises` `resolveMx`. Inject a fake in tests to stay offline. */
  resolveMx?: ResolveMx;
  /** skip the DNS lookup entirely (syntax + heuristics only). */
  skipMx?: boolean;
}

export async function checkEmail(email: string, opts: CheckEmailOptions = {}): Promise<EmailCheckResult> {
  const trimmed = email.trim();
  const syntaxValid = EMAIL_RE.test(trimmed);
  const atIndex = trimmed.lastIndexOf("@");
  const localPart = syntaxValid ? trimmed.slice(0, atIndex).toLowerCase() : null;
  const domain = syntaxValid ? trimmed.slice(atIndex + 1).toLowerCase() : null;

  let hasMx: boolean | null = null;
  if (syntaxValid && domain && !opts.skipMx) {
    const resolveMx = opts.resolveMx ?? nodeResolveMx;
    try {
      const records = await resolveMx(domain);
      hasMx = records.length > 0;
    } catch {
      // NXDOMAIN / no MX record / DNS failure -- treat as "no mail route", not a crash.
      hasMx = false;
    }
  }

  return {
    email: trimmed,
    syntaxValid,
    domain,
    hasMx,
    isRoleAccount: localPart !== null && ROLE_LOCAL_PARTS.has(localPart),
    isFreeProvider: domain !== null && FREE_PROVIDERS.has(domain),
  };
}

/** Constructs the common `{first}.{last}@domain` pattern guess. Does NOT verify it —
 *  pipe the result through `checkEmail` (or a live verifier) before using it. */
export function guessEmail(person: { firstName: string; lastName: string }, domain: string): string {
  const first = person.firstName.trim().toLowerCase();
  const last = person.lastName.trim().toLowerCase();
  return `${first}.${last}@${domain.trim().toLowerCase()}`;
}
