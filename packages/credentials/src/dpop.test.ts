import { describe, it, expect } from "vitest";
import {
  generateDpopKeyPair,
  createDpopSigner,
  verifyDpopProof,
  createMemoryJtiStore,
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

  it("produces deterministic CLAIMS for fixed key+clock+jti (ES256 signature still varies)", () => {
    const kp = generateDpopKeyPair("ES256");
    const opts = { clock: fixedClock, jti: () => "fixed" };
    const a = createDpopSigner(kp, opts).proof({ htm: "GET", htu: "https://h/x" });
    const b = createDpopSigner(kp, opts).proof({ htm: "GET", htu: "https://h/x" });
    // The signed content (header + payload) is byte-identical — no hidden randomness
    // in what we sign for fixed inputs.
    expect(a.split(".").slice(0, 2).join(".")).toBe(b.split(".").slice(0, 2).join("."));
    // ...but ECDSA (ES256) draws a fresh random nonce per signature (it is NOT
    // deterministic without RFC 6979), so the full proofs differ — and each still
    // verifies. DPoP proofs are single-use anyway, so this is correct, not a defect.
    expect(a).not.toBe(b);
    // Fresh per-verify stores: this test reuses jti "fixed" on purpose (to prove claim
    // determinism), which the default consuming store would otherwise reject as a replay.
    expect(verifyDpopProof(a, { htm: "GET", htu: "https://h/x", now: FIXED_MS, jtiStore: createMemoryJtiStore() }).valid).toBe(true);
    expect(verifyDpopProof(b, { htm: "GET", htu: "https://h/x", now: FIXED_MS, jtiStore: createMemoryJtiStore() }).valid).toBe(true);
  });

  it("EdDSA proofs ARE fully deterministic for fixed key+clock+jti (RFC 8032 deterministic nonce)", () => {
    const kp = generateDpopKeyPair("EdDSA");
    const opts = { clock: fixedClock, jti: () => "fixed" };
    const a = createDpopSigner(kp, opts).proof({ htm: "GET", htu: "https://h/x" });
    const b = createDpopSigner(kp, opts).proof({ htm: "GET", htu: "https://h/x" });
    // Ed25519 signatures are deterministic, so the whole JWT is byte-for-byte equal.
    expect(a).toBe(b);
  });
});

// --- verification: valid + binding ------------------------------------------

describe.each(["ES256", "EdDSA"] as const)("DPoP verify (%s)", (alg) => {
  it("accepts a proof that matches method + url, and returns a stable jkt", () => {
    const signer = createDpopSigner(generateDpopKeyPair(alg), { clock: fixedClock, jti: () => "j" });
    const proof = signer.proof({ htm: "GET", htu: "https://api.example.com/v1/x" });
    // fresh store: the ES256 and EdDSA runs both mint jti "j"; the default singleton would treat
    // the second run as a replay. Scoping to a per-run store keeps this an acceptance test.
    const res = verifyDpopProof(proof, {
      htm: "get",
      htu: "https://api.example.com/v1/x",
      now: FIXED_MS,
      jtiStore: createMemoryJtiStore(),
    });
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

  it("#9: a proof verifies once, then a SECOND verification of the same proof is rejected as replay", () => {
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    const store = createMemoryJtiStore();
    const first = verifyDpopProof(proof, { htm: "GET", htu: "https://h/x", now: FIXED_MS, jtiStore: store });
    expect(first.valid).toBe(true);
    const second = verifyDpopProof(proof, { htm: "GET", htu: "https://h/x", now: FIXED_MS, jtiStore: store });
    expect(second).toMatchObject({ valid: false, reason: "replay" });
  });

  it("#9: the DEFAULT store (no jtiStore supplied) rejects replays out of the box", () => {
    // a unique jti so this test does not collide with any other test's default-store usage
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock, jti: () => "default-store-replay-uniq" });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    expect(verifyDpopProof(proof, { htm: "GET", htu: "https://h/x", now: FIXED_MS }).valid).toBe(true);
    expect(verifyDpopProof(proof, { htm: "GET", htu: "https://h/x", now: FIXED_MS })).toMatchObject({
      valid: false,
      reason: "replay",
    });
  });

  it("#9: an invalid proof does NOT consume its jti (store is not poisoned by junk)", () => {
    const store = createMemoryJtiStore();
    // a proof presented against the WRONG method fails binding before the replay check, so its
    // jti must remain usable afterwards:
    const bad = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock, jti: () => "poison-test" }).proof({
      htm: "GET",
      htu: "https://h/x",
    });
    expect(verifyDpopProof(bad, { htm: "POST", htu: "https://h/x", now: FIXED_MS, jtiStore: store })).toMatchObject({
      valid: false,
      reason: "htm mismatch",
    });
    // same jti on a correctly-bound proof still succeeds (it was never consumed above):
    const good = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock, jti: () => "poison-test" }).proof({
      htm: "GET",
      htu: "https://h/x",
    });
    expect(verifyDpopProof(good, { htm: "GET", htu: "https://h/x", now: FIXED_MS, jtiStore: store }).valid).toBe(true);
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
  // #4: a secret-injecting provider must be bound to a base; the DPoP tests call example.com.
  registry.register({ providerId: "fake", keyNames: ["FAKE_API_KEY"], baseUrl: "https://example.com" });
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

  it("refuses query-param secret injection (secrets go in headers; nothing reaches the wire)", async () => {
    const signer = createDpopSigner(generateDpopKeyPair("ES256"), { clock: fixedClock });
    const { broker, captured } = brokerWith(signer);
    await expect(
      broker.proxyCall({
        providerId: "fake",
        method: "GET",
        url: "https://example.com/api/x",
        authInject: { query: "access_token" },
      }),
    ).rejects.toThrow(/query param/i);
    expect(captured.url).toBe(""); // refused before fetch -- nothing captured
  });
});
