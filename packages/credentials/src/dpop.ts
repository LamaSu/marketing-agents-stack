/**
 * DPoP -- Demonstrating Proof-of-Possession at the Application Layer (RFC 9449).
 *
 * This is the 2026 SOTA hardening for the credential-broker boundary (research/10 §2.10:
 * "do the DPoP hardening regardless"). It lets `proxyCall` attach a `DPoP` proof header that
 * cryptographically binds each outbound request to the AGENT'S OWN key and to the exact
 * (method, URL) being called -- so a proof captured off the wire cannot be replayed against a
 * different endpoint or method, and the agent's private key never leaves this process.
 *
 * WHY THIS FITS THE SEAM (and why it stays OFF by default):
 *  - The private key lives only inside the `DpopSigner` closure; nothing here ever exports it,
 *    and only the PUBLIC JWK is embedded in the proof header. This does not weaken the package's
 *    "agent never sees the key" invariant -- the DPoP key is a *request-binding* identity, not
 *    a provider secret. Provider secrets are still resolved/injected only inside a broker.
 *  - `htu` is normalized to strip the query string (RFC 9449 §4.2), so even when `LocalBroker`
 *    query-injects a provider secret into the outbound URL, that secret can NEVER appear inside
 *    a DPoP proof. Binding is to scheme+host+path+method only.
 *  - Everything is injectable (key, clock, jti) -> deterministic offline tests, no network.
 *
 * Supported algorithms: ES256 (ECDSA P-256, JWS raw r||s via `dsaEncoding:"ieee-p1363"`) and
 * EdDSA (Ed25519). Both are produced/verified with `node:crypto` only -- no new dependency.
 */
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

/** DPoP proof signing algorithms this module supports (JWS `alg` values). */
export type DpopAlg = "ES256" | "EdDSA";

/** The canonical PUBLIC JWK embedded in a DPoP proof header (private members are never present). */
export type DpopPublicJwk =
  | { kty: "EC"; crv: "P-256"; x: string; y: string }
  | { kty: "OKP"; crv: "Ed25519"; x: string };

/** A DPoP key pair. The private key is a `node:crypto` `KeyObject` and is never serialized. */
export interface DpopKeyPair {
  readonly alg: DpopAlg;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly publicJwk: DpopPublicJwk;
}

/** Millisecond-epoch clock; injectable so tests get deterministic `iat`. Defaults to `Date.now`. */
export type Clock = () => number;

export interface DpopSignerOptions {
  /** injectable clock (ms epoch); defaults to Date.now. */
  clock?: Clock;
  /** injectable unique-id source for `jti`; defaults to randomUUID. Keep it unique per proof. */
  jti?: () => string;
}

/** The per-request binding inputs. `htu` may include a query string -- it is stripped internally. */
export interface DpopProofInput {
  /** HTTP method, e.g. "GET" (compared case-insensitively; emitted uppercase). */
  htm: string;
  /** Target URL. Query + fragment are stripped for the `htu` claim (RFC 9449 §4.2). */
  htu: string;
  /** optional server-provided DPoP nonce (RFC 9449 §8) to include in the proof. */
  nonce?: string;
}

/** A configured signer: holds the private key in its closure, mints proofs on demand. */
export interface DpopSigner {
  readonly alg: DpopAlg;
  readonly publicJwk: DpopPublicJwk;
  /** RFC 7638 JWK thumbprint (base64url) -- the stable "bound key" identity (`jkt`). */
  readonly jkt: string;
  /** Build a compact DPoP proof JWT bound to this method + URL. */
  proof(input: DpopProofInput): string;
}

/** The decoded, validated claims of a DPoP proof. */
export interface DpopProofPayload {
  htm: string;
  htu: string;
  iat: number;
  jti: string;
  nonce?: string;
}

// ---- encoding helpers -------------------------------------------------------

function b64uEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function b64uDecodeToString(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

/** RFC 7638 JWK thumbprint: SHA-256 over the required members in lexicographic order, base64url. */
function jwkThumbprint(jwk: DpopPublicJwk): string {
  const canonical =
    jwk.kty === "EC"
      ? `{"crv":"${jwk.crv}","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`
      : `{"crv":"${jwk.crv}","kty":"OKP","x":"${jwk.x}"}`;
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

/**
 * Normalize a URL to its RFC 9449 `htu` form: scheme + host (lowercased, default port removed) +
 * path, with NO query and NO fragment. `new URL` handles the case/port normalization; we strip
 * search + hash. This is what keeps a query-injected provider secret out of the proof.
 */
export function normalizeHtu(url: string): string {
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  return u.toString();
}

// ---- key material -----------------------------------------------------------

/** Read a KeyObject's PUBLIC JWK and narrow it to `DpopPublicJwk`, asserting the alg's shape. */
function toPublicJwk(publicKey: KeyObject, alg: DpopAlg): DpopPublicJwk {
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  if (alg === "ES256") {
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
      throw new Error(`DPoP: ES256 requires an EC P-256 key, got kty=${String(jwk.kty)} crv=${String(jwk.crv)}`);
    }
    return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error(`DPoP: EdDSA requires an Ed25519 (OKP) key, got kty=${String(jwk.kty)} crv=${String(jwk.crv)}`);
  }
  return { kty: "OKP", crv: "Ed25519", x: jwk.x };
}

/** Generate a fresh DPoP key pair (ES256 by default). The private key stays a live KeyObject. */
export function generateDpopKeyPair(alg: DpopAlg = "ES256"): DpopKeyPair {
  const { privateKey, publicKey } =
    alg === "ES256" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("ed25519");
  return { alg, privateKey, publicKey, publicJwk: toPublicJwk(publicKey, alg) };
}

/** Build a DpopKeyPair from an already-held private KeyObject (e.g. one injected in tests). */
export function dpopKeyPairFromPrivateKey(privateKey: KeyObject, alg: DpopAlg): DpopKeyPair {
  const publicKey = createPublicKey(privateKey);
  return { alg, privateKey, publicKey, publicJwk: toPublicJwk(publicKey, alg) };
}

// ---- signing ----------------------------------------------------------------

/** Sign the JWS signing input with the given key/alg, returning a JOSE-format (raw) signature. */
function signJose(signingInput: string, privateKey: KeyObject, alg: DpopAlg): Buffer {
  const data = Buffer.from(signingInput, "utf8");
  // ES256 => ECDSA with a JOSE raw r||s signature (NOT DER); Ed25519 => algorithm `null`.
  return alg === "ES256"
    ? cryptoSign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" })
    : cryptoSign(null, data, privateKey);
}

/**
 * Create a DPoP signer. The private key is captured in the returned closure and is never
 * exposed; callers get only `proof()`, `publicJwk`, and `jkt`.
 */
export function createDpopSigner(keyPair: DpopKeyPair, options: DpopSignerOptions = {}): DpopSigner {
  const clock: Clock = options.clock ?? Date.now;
  const nextJti = options.jti ?? (() => randomUUID());
  const jkt = jwkThumbprint(keyPair.publicJwk);
  const header = { typ: "dpop+jwt", alg: keyPair.alg, jwk: keyPair.publicJwk };
  const encodedHeader = b64uEncode(JSON.stringify(header));

  return {
    alg: keyPair.alg,
    publicJwk: keyPair.publicJwk,
    jkt,
    proof(input: DpopProofInput): string {
      const payload: DpopProofPayload = {
        htm: input.htm.toUpperCase(),
        htu: normalizeHtu(input.htu),
        iat: Math.floor(clock() / 1000),
        jti: nextJti(),
        ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
      };
      const signingInput = `${encodedHeader}.${b64uEncode(JSON.stringify(payload))}`;
      const signature = signJose(signingInput, keyPair.privateKey, keyPair.alg).toString("base64url");
      return `${signingInput}.${signature}`;
    },
  };
}

// ---- verification -----------------------------------------------------------

export interface DpopVerifyOptions {
  /** the HTTP method the request actually used (compared case-insensitively). */
  htm: string;
  /** the URL the request actually targeted (normalized before comparison). */
  htu: string;
  /** current time (ms epoch); defaults to Date.now. Injectable for deterministic tests. */
  now?: number;
  /** max accepted age of the proof's `iat`, in seconds. Default 300 (short-lived). */
  maxAgeSeconds?: number;
  /** allowed clock skew for a future `iat`, in seconds. Default 5. */
  clockSkewSeconds?: number;
  /** if provided, the proof's `nonce` must equal this exactly. */
  nonce?: string;
  /** optional replay guard: return true if this `jti` has already been seen. */
  isReplay?: (jti: string) => boolean;
}

export type DpopVerifyResult =
  | { valid: true; jkt: string; payload: DpopProofPayload }
  | { valid: false; reason: string };

interface DpopHeader {
  typ: unknown;
  alg: unknown;
  jwk: unknown;
}

function isDpopAlg(value: unknown): value is DpopAlg {
  return value === "ES256" || value === "EdDSA";
}

/** Narrow an untrusted parsed value to a DpopPublicJwk (used to rebuild the verifying key). */
function parsePublicJwk(value: unknown): DpopPublicJwk | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const jwk = value as Record<string, unknown>;
  if (jwk.kty === "EC" && jwk.crv === "P-256" && typeof jwk.x === "string" && typeof jwk.y === "string") {
    return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  }
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string") {
    return { kty: "OKP", crv: "Ed25519", x: jwk.x };
  }
  return undefined;
}

function verifyJose(signingInput: string, signature: Buffer, jwk: DpopPublicJwk, alg: DpopAlg): boolean {
  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  const data = Buffer.from(signingInput, "utf8");
  return alg === "ES256"
    ? cryptoVerify("sha256", data, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)
    : cryptoVerify(null, data, publicKey, signature);
}

/**
 * Verify a DPoP proof against the request it should be bound to. Order: structure -> signature
 * (authenticity first) -> `htm`/`htu` binding -> freshness (`iat`) -> optional nonce/replay.
 * Returns the RFC 7638 `jkt` on success so a caller can bind the proof to an access token.
 * Fails closed on any malformed input (never throws to the caller).
 */
export function verifyDpopProof(proofJwt: string, options: DpopVerifyOptions): DpopVerifyResult {
  const maxAgeSeconds = options.maxAgeSeconds ?? 300;
  const clockSkewSeconds = options.clockSkewSeconds ?? 5;
  const nowSec = Math.floor((options.now ?? Date.now()) / 1000);

  let header: DpopHeader;
  let payload: DpopProofPayload;
  let signature: Buffer;
  let signingInput: string;
  try {
    const parts = proofJwt.split(".");
    if (parts.length !== 3) return { valid: false, reason: "malformed: expected 3 JWT segments" };
    const [h, p, s] = parts as [string, string, string];
    header = JSON.parse(b64uDecodeToString(h)) as DpopHeader;
    const rawPayload = JSON.parse(b64uDecodeToString(p)) as Record<string, unknown>;
    if (
      typeof rawPayload.htm !== "string" ||
      typeof rawPayload.htu !== "string" ||
      typeof rawPayload.iat !== "number" ||
      typeof rawPayload.jti !== "string" ||
      (rawPayload.nonce !== undefined && typeof rawPayload.nonce !== "string")
    ) {
      return { valid: false, reason: "malformed: missing/invalid claims" };
    }
    payload = {
      htm: rawPayload.htm,
      htu: rawPayload.htu,
      iat: rawPayload.iat,
      jti: rawPayload.jti,
      ...(typeof rawPayload.nonce === "string" ? { nonce: rawPayload.nonce } : {}),
    };
    signature = Buffer.from(s, "base64url");
    signingInput = `${h}.${p}`;
  } catch {
    return { valid: false, reason: "malformed: undecodable proof" };
  }

  if (header.typ !== "dpop+jwt") return { valid: false, reason: "invalid typ (expected dpop+jwt)" };
  if (!isDpopAlg(header.alg)) return { valid: false, reason: `unsupported alg: ${String(header.alg)}` };
  const jwk = parsePublicJwk(header.jwk);
  if (!jwk) return { valid: false, reason: "invalid or missing jwk" };
  // The embedded JWK's key type must match the declared alg (no EC key under EdDSA, etc.).
  if ((header.alg === "ES256") !== (jwk.kty === "EC")) {
    return { valid: false, reason: "jwk/alg mismatch" };
  }

  let signatureOk: boolean;
  try {
    signatureOk = verifyJose(signingInput, signature, jwk, header.alg);
  } catch {
    return { valid: false, reason: "signature verification error" };
  }
  if (!signatureOk) return { valid: false, reason: "bad signature" };

  // Binding checks -- this is what makes a captured proof non-replayable against another target.
  if (payload.htm.toUpperCase() !== options.htm.toUpperCase()) {
    return { valid: false, reason: "htm mismatch" };
  }
  if (normalizeHtu(payload.htu) !== normalizeHtu(options.htu)) {
    return { valid: false, reason: "htu mismatch" };
  }

  // Freshness -- short TTL window around `iat`.
  if (payload.iat > nowSec + clockSkewSeconds) return { valid: false, reason: "iat in the future" };
  if (payload.iat < nowSec - maxAgeSeconds) return { valid: false, reason: "proof expired" };

  if (options.nonce !== undefined && payload.nonce !== options.nonce) {
    return { valid: false, reason: "nonce mismatch" };
  }
  if (options.isReplay?.(payload.jti)) return { valid: false, reason: "replay: jti already used" };

  return { valid: true, jkt: jwkThumbprint(jwk), payload };
}
