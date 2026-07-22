import { describe, it, expect } from "vitest";
import {
  generateDpopKeyPair,
  createDpopSigner,
  verifyDpopProof,
  normalizeHtu,
  LocalBroker,
  ProviderRegistry,
} from "./index.js";

// --- helpers -----------------------------------------------------------------

const FIXED_MS = 1_700_000_000_000; // -> iat 1_700_000_000
const fixedClock = () => FIXED_MS;

function decodePayload(proofJwt: string): Record<string, unknown> {
  const part = proofJwt.split(".")[1];
  if (part === undefined) throw new Error("no payload segment");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}
function decodeHeader(proofJwt: string): Record<string, unknown> {
  const part = proofJwt.split(".")[0];
  if (part === undefined) throw new Error("no header segment");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

// --- proof shape -------------------------------------------------------------

describe("DPoP proof shape (RFC 9449)", () => {
  it("binds htm/htu/iat/jti with an injected key + fixed clock", () => {
    const signer = createDpopSigner(generateDpopKeyPair("ES256"), { clock: fixedClock, jti: () => "jti-1" });
    const proof = signer.proof({ htm: "get", htu: "https://api.example.com/v1/x?a=1#frag" });

    const header = decodeHeader(proof);
    const payload = decodePayload(proof);
    expect(header).toMatchObject({ typ: "dpop+jwt", alg: "ES256" });
    expect((header.jwk as Record<string, unknown>).kty).toBe("EC");
    expect(payload.htm).toBe("GET"); // uppercased
    expect(payload.htu).toBe("https://api.example.com/v1/x"); // query + fragment stripped
    expect(payload.iat).toBe(1_700_000_000);
    expect(payload.jti).toBe("jti-1");
    expect(payload.nonce).toBeUndefined();
  });

  it("includes a server nonce when provided", () => {
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock });
    const payload = decodePayload(signer.proof({ htm: "POST", htu: "https://h/x", nonce: "srv-nonce-9" }));
    expect(payload.nonce).toBe("srv-nonce-9");
  });

  it("normalizeHtu lowercases host, drops default port, strips query+fragment", () => {
    expect(normalizeHtu("HTTPS://API.Example.com:443/v1/x?tok=secret#f")).toBe("https://api.example.com/v1/x");
  });
});

// --- non-replayability / uniqueness -----------------------------------------

describe("DPoP proof uniqueness + determinism", () => {
  it("changes per request via a unique jti (default randomUUID)", () => {
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock }); // real jti source
    const a = signer.proof({ htm: "GET", htu: "https://h/x" });
    const b = signer.proof({ htm: "GET", htu: "https://h/x" });
    expect(a).not.toBe(b);
    expect(decodePayload(a).jti).not.toBe(decodePayload(b).jti);
  });

  it("is deterministic when key + clock + jti are all fixed", () => {
    const kp = generateDpopKeyPair("ES256");
    const opts = { clock: fixedClock, jti: () => "fixed" };
    const a = createDpopSigner(kp, opts).proof({ htm: "GET", htu: "https://h/x" });
    const b = createDpopSigner(kp, opts).proof({ htm: "GET", htu: "https://h/x" });
    expect(a).toBe(b);
  });
});

// --- verification: valid + binding ------------------------------------------

describe.each(["ES256", "EdDSA"] as const)("DPoP verify (%s)", (alg) => {
  it("accepts a proof that matches method + url, and returns a stable jkt", () => {
    const signer = createDpopSigner(generateDpopKeyPair(alg), { clock: fixedClock, jti: () => "j" });
    const proof = signer.proof({ htm: "GET", htu: "https://api.example.com/v1/x" });
    const res = verifyDpopProof(proof, { htm: "get", htu: "https://api.example.com/v1/x", now: FIXED_MS });
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.jkt).toBe(signer.jkt); // verifier-derived jkt == signer's jkt
  });

  it("rejects when the HTTP METHOD differs (binding works)", () => {
    const signer = createDpopSigner(generateDpopKeyPair(alg), { clock: fixedClock });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    const res = verifyDpopProof(proof, { htm: "POST", htu: "https://h/x", now: FIXED_MS });
    expect(res).toMatchObject({ valid: false, reason: "htm mismatch" });
  });

  it("rejects when the URL differs (binding works)", () => {
    const signer = createDpopSigner(generateDpopKeyPair(alg), { clock: fixedClock });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    const res = verifyDpopProof(proof, { htm: "GET", htu: "https://h/y", now: FIXED_MS });
    expect(res).toMatchObject({ valid: false, reason: "htu mismatch" });
  });
});

// --- verification: freshness, nonce, replay, tamper --------------------------

describe("DPoP verify guards", () => {
  it("rejects an expired proof (iat older than maxAge)", () => {
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    const res = verifyDpopProof(proof, {
      htm: "GET",
      htu: "https://h/x",
      now: FIXED_MS + 400_000, // 400s later, default maxAge 300s
    });
    expect(res).toMatchObject({ valid: false, reason: "proof expired" });
  });

  it("rejects a proof whose iat is in the future beyond skew", () => {
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: () => FIXED_MS + 60_000 });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    const res = verifyDpopProof(proof, { htm: "GET", htu: "https://h/x", now: FIXED_MS });
    expect(res).toMatchObject({ valid: false, reason: "iat in the future" });
  });

  it("enforces nonce match when the verifier expects one", () => {
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock });
    const good = signer.proof({ htm: "GET", htu: "https://h/x", nonce: "n1" });
    expect(verifyDpopProof(good, { htm: "GET", htu: "https://h/x", now: FIXED_MS, nonce: "n1" }).valid).toBe(true);
    const bad = verifyDpopProof(good, { htm: "GET", htu: "https://h/x", now: FIXED_MS, nonce: "n2" });
    expect(bad).toMatchObject({ valid: false, reason: "nonce mismatch" });
  });

  it("rejects a replayed jti via the isReplay guard", () => {
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock, jti: () => "used-jti" });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    const seen = new Set<string>(["used-jti"]);
    const res = verifyDpopProof(proof, { htm: "GET", htu: "https://h/x", now: FIXED_MS, isReplay: (j) => seen.has(j) });
    expect(res).toMatchObject({ valid: false, reason: "replay: jti already used" });
  });

  it("rejects a tampered signature and malformed input, without throwing", () => {
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    const parts = proof.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${"A".repeat((parts[2] ?? "").length)}`;
    expect(verifyDpopProof(tampered, { htm: "GET", htu: "https://h/x", now: FIXED_MS }).valid).toBe(false);
    expect(verifyDpopProof("not-a-jwt", { htm: "GET", htu: "https://h/x", now: FIXED_MS }).valid).toBe(false);
  });
});

// --- the private key never leaves the signer --------------------------------

describe("DPoP key custody", () => {
  it("the signer exposes only alg/publicJwk/jkt/proof -- no private key material", () => {
    const signer = createDpopSigner(generateDpopKeyPair("ES256"));
    expect(Object.keys(signer).sort()).toEqual(["alg", "jkt", "proof", "publicJwk"]);
    expect((signer as unknown as Record<string, unknown>).privateKey).toBeUndefined();
    expect(JSON.stringify(signer.publicJwk)).not.toContain('"d"'); // no private EC scalar
  });
});

// --- LocalBroker integration: default off, opt-in on --------------------------

const SECRET = "shh-do-not-log-me-9f2c";

function brokerWith(dpopSigner?: ReturnType<typeof createDpopSigner>) {
  const registry = new ProviderRegistry();
  registry.register({ providerId: "fake", keyNames: ["FAKE_API_KEY"] });
  const captured: { url: string; headers: Record<string, string> } = { url: "", headers: {} };
  const fetchImpl: typeof fetch = async (input, init) => {
    captured.url = input.toString();
    captured.headers = (init?.headers as Record<string, string>) ?? {};
    return new Response("{}", { status: 200 });
  };
  const broker = new LocalBroker({
    registry,
    env: { FAKE_API_KEY: SECRET },
    fetchImpl,
    log: () => {},
    ...(dpopSigner ? { dpopSigner } : {}),
  });
  return { broker, captured };
}

describe("LocalBroker + DPoP (opt-in)", () => {
  it("OFFLINE DEFAULT: with no dpopSigner, NO DPoP header is attached (behavior unchanged)", async () => {
    const { broker, captured } = brokerWith();
    await broker.proxyCall({ providerId: "fake", method: "GET", url: "https://example.com/api/x" });
    expect(captured.headers.DPoP).toBeUndefined();
  });

  it("attaches a DPoP proof header that verifies against the request when a signer is configured", async () => {
    const signer = createDpopSigner(generateDpopKeyPair("ES256"), { clock: fixedClock });
    const { broker, captured } = brokerWith(signer);
    await broker.proxyCall({
      providerId: "fake",
      method: "GET",
      url: "https://example.com/api/x",
      authInject: { header: "Authorization" },
    });
    const proof = captured.headers.DPoP;
    expect(typeof proof).toBe("string");
    const res = verifyDpopProof(proof as string, { htm: "GET", htu: "https://example.com/api/x", now: FIXED_MS });
    expect(res.valid).toBe(true);
  });

  it("the query-injected secret NEVER appears inside the DPoP proof (htu strips the query)", async () => {
    const signer = createDpopSigner(generateDpopKeyPair("ES256"), { clock: fixedClock });
    const { broker, captured } = brokerWith(signer);
    await broker.proxyCall({
      providerId: "fake",
      method: "GET",
      url: "https://example.com/api/x",
      authInject: { query: "access_token" }, // secret goes into the outbound URL
    });
    expect(captured.url).toContain(SECRET); // secret is on the wire URL...
    const proof = captured.headers.DPoP as string;
    expect(proof).not.toContain(SECRET); // ...but never inside the proof
    // and the proof is still valid, bound to the clean (query-less) target
    const res = verifyDpopProof(proof, { htm: "GET", htu: "https://example.com/api/x", now: FIXED_MS });
    expect(res.valid).toBe(true);
  });
});
