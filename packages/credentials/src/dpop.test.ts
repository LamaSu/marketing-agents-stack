import { describe, it, expect } from "vitest";
import { sign as cryptoSign } from "node:crypto";
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

  it("produces deterministic CLAIMS for fixed key+clock+jti (ES256 signature still varies)", async () => {
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
    expect((await verifyDpopProof(a, { htm: "GET", htu: "https://h/x", now: FIXED_MS, jtiStore: createMemoryJtiStore() })).valid).toBe(true);
    expect((await verifyDpopProof(b, { htm: "GET", htu: "https://h/x", now: FIXED_MS, jtiStore: createMemoryJtiStore() })).valid).toBe(true);
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
  it("accepts a proof that matches method + url, and returns a stable jkt", async () => {
    const signer = createDpopSigner(generateDpopKeyPair(alg), { clock: fixedClock, jti: () => "j" });
    const proof = signer.proof({ htm: "GET", htu: "https://api.example.com/v1/x" });
    // fresh store: the ES256 and EdDSA runs both mint jti "j"; the default singleton would treat
    // the second run as a replay. Scoping to a per-run store keeps this an acceptance test.
    const res = await verifyDpopProof(proof, {
      htm: "get",
      htu: "https://api.example.com/v1/x",
      now: FIXED_MS,
      jtiStore: createMemoryJtiStore(),
    });
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.jkt).toBe(signer.jkt); // verifier-derived jkt == signer's jkt
  });

  it("rejects when the HTTP METHOD differs (binding works)", async () => {
    const signer = createDpopSigner(generateDpopKeyPair(alg), { clock: fixedClock });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    const res = await verifyDpopProof(proof, { htm: "POST", htu: "https://h/x", now: FIXED_MS });
    expect(res).toMatchObject({ valid: false, reason: "htm mismatch" });
  });

  it("rejects when the URL differs (binding works)", async () => {
    const signer = createDpopSigner(generateDpopKeyPair(alg), { clock: fixedClock });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    const res = await verifyDpopProof(proof, { htm: "GET", htu: "https://h/y", now: FIXED_MS });
    expect(res).toMatchObject({ valid: false, reason: "htu mismatch" });
  });
});

// --- verification: freshness, nonce, replay, tamper --------------------------

describe("DPoP verify guards", () => {
  it("rejects an expired proof (iat older than maxAge)", async () => {
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    const res = await verifyDpopProof(proof, {
      htm: "GET",
      htu: "https://h/x",
      now: FIXED_MS + 400_000, // 400s later, default maxAge 300s
    });
    expect(res).toMatchObject({ valid: false, reason: "proof expired" });
  });

  it("rejects a proof whose iat is in the future beyond skew", async () => {
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: () => FIXED_MS + 60_000 });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    const res = await verifyDpopProof(proof, { htm: "GET", htu: "https://h/x", now: FIXED_MS });
    expect(res).toMatchObject({ valid: false, reason: "iat in the future" });
  });

  it("enforces nonce match when the verifier expects one", async () => {
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock });
    const good = signer.proof({ htm: "GET", htu: "https://h/x", nonce: "n1" });
    expect((await verifyDpopProof(good, { htm: "GET", htu: "https://h/x", now: FIXED_MS, nonce: "n1" })).valid).toBe(true);
    const bad = await verifyDpopProof(good, { htm: "GET", htu: "https://h/x", now: FIXED_MS, nonce: "n2" });
    expect(bad).toMatchObject({ valid: false, reason: "nonce mismatch" });
  });

  it("#9: a proof verifies once, then a SECOND verification of the same proof is rejected as replay", async () => {
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    const store = createMemoryJtiStore();
    const first = await verifyDpopProof(proof, { htm: "GET", htu: "https://h/x", now: FIXED_MS, jtiStore: store });
    expect(first.valid).toBe(true);
    const second = await verifyDpopProof(proof, { htm: "GET", htu: "https://h/x", now: FIXED_MS, jtiStore: store });
    expect(second).toMatchObject({ valid: false, reason: "replay" });
  });

  it("#9: the DEFAULT store (no jtiStore supplied) rejects replays out of the box", async () => {
    // a unique jti so this test does not collide with any other test's default-store usage
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock, jti: () => "default-store-replay-uniq" });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    expect((await verifyDpopProof(proof, { htm: "GET", htu: "https://h/x", now: FIXED_MS })).valid).toBe(true);
    expect(await verifyDpopProof(proof, { htm: "GET", htu: "https://h/x", now: FIXED_MS })).toMatchObject({
      valid: false,
      reason: "replay",
    });
  });

  it("#9: an invalid proof does NOT consume its jti (store is not poisoned by junk)", async () => {
    const store = createMemoryJtiStore();
    // a proof presented against the WRONG method fails binding before the replay check, so its
    // jti must remain usable afterwards:
    const bad = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock, jti: () => "poison-test" }).proof({
      htm: "GET",
      htu: "https://h/x",
    });
    expect(await verifyDpopProof(bad, { htm: "POST", htu: "https://h/x", now: FIXED_MS, jtiStore: store })).toMatchObject({
      valid: false,
      reason: "htm mismatch",
    });
    // same jti on a correctly-bound proof still succeeds (it was never consumed above). NOTE: replay
    // is keyed on (jkt, jti), so the good proof MUST reuse the same key as the bad one -- a fresh
    // keypair would change the jkt and make this pass for the wrong reason. Reuse one keypair:
    const kp = generateDpopKeyPair();
    const badSameKey = createDpopSigner(kp, { clock: fixedClock, jti: () => "poison-test-2" }).proof({
      htm: "GET",
      htu: "https://h/x",
    });
    expect(await verifyDpopProof(badSameKey, { htm: "POST", htu: "https://h/x", now: FIXED_MS, jtiStore: store })).toMatchObject({
      valid: false,
      reason: "htm mismatch",
    });
    const goodSameKey = createDpopSigner(kp, { clock: fixedClock, jti: () => "poison-test-2" }).proof({
      htm: "GET",
      htu: "https://h/x",
    });
    expect((await verifyDpopProof(goodSameKey, { htm: "GET", htu: "https://h/x", now: FIXED_MS, jtiStore: store })).valid).toBe(true);
  });

  it("rejects a tampered signature and malformed input, without throwing", async () => {
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    const parts = proof.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${"A".repeat((parts[2] ?? "").length)}`;
    expect((await verifyDpopProof(tampered, { htm: "GET", htu: "https://h/x", now: FIXED_MS })).valid).toBe(false);
    expect((await verifyDpopProof("not-a-jwt", { htm: "GET", htu: "https://h/x", now: FIXED_MS })).valid).toBe(false);
  });

  it("#9a: a valid-signature proof carrying a MALFORMED htu resolves invalid -- never throws/rejects", async () => {
    // The signer normalizes htu at mint time, so a malformed htu can only arrive on a hand-crafted,
    // self-signed proof (the attacker owns the JWK embedded in the header). It reaches the binding
    // compare, where normalizeHtu(payload.htu) would `new URL(...)` -> throw. verifyDpopProof
    // documents "never throws/rejects to the caller", so this must be a graceful rejection.
    const kp = generateDpopKeyPair("EdDSA");
    const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    const header = { typ: "dpop+jwt", alg: "EdDSA", jwk: kp.publicJwk };
    const payload = { htm: "GET", htu: "not-a-valid-url", iat: 1_700_000_000, jti: "malformed-htu-jti" };
    const signingInput = `${b64u(header)}.${b64u(payload)}`;
    const sig = cryptoSign(null, Buffer.from(signingInput, "utf8"), kp.privateKey).toString("base64url");
    const proof = `${signingInput}.${sig}`;
    // .resolves (not .rejects) is the assertion that verify did NOT throw; the value is the rejection.
    await expect(
      verifyDpopProof(proof, { htm: "GET", htu: "https://h/x", now: FIXED_MS }),
    ).resolves.toMatchObject({ valid: false, reason: "malformed htu" });
  });
});

// --- replay store: expiry-based eviction (#9b) -------------------------------

describe("#9b: jti store evicts by expiry, never by volume", () => {
  it("does NOT evict a still-fresh jti under a flood (no count-based eviction)", () => {
    let nowMs = FIXED_MS;
    const store = createMemoryJtiStore({ maxEntries: 3, ttlSeconds: 300, clock: () => nowMs });
    expect(store.consume("victim")).toBe(true); // a fresh jti we must never forget while it is in-window
    expect(store.consume("f1")).toBe(true);
    expect(store.consume("f2")).toBe(true); // now at capacity (3), all unexpired
    // a 4th fresh jti must NOT silently evict "victim" -- it is rejected as full (fail closed)...
    expect(store.consume("f3")).toBe(false);
    // ...and "victim" is still remembered, so replaying it is still caught (it was NOT evicted by volume):
    expect(store.consume("victim")).toBe(false);
  });

  it("reclaims capacity once entries EXPIRE (not by forgetting a fresh jti)", () => {
    let nowMs = FIXED_MS;
    const store = createMemoryJtiStore({ maxEntries: 2, ttlSeconds: 300, clock: () => nowMs });
    expect(store.consume("a")).toBe(true);
    expect(store.consume("b")).toBe(true); // full
    expect(store.consume("c")).toBe(false); // rejected while a,b are still fresh
    nowMs += 301_000; // advance past the ttl -> a,b are now expired (outside any verifier window)
    expect(store.consume("c")).toBe(true); // capacity reclaimed by EXPIRY
    expect(store.consume("a")).toBe(true); // a's slot was freed by expiry; a re-appearing jti is fine
    // (a proof carrying an expired iat is rejected on FRESHNESS before it ever reaches the store)
  });
});

// --- replay store: async / shared store + fail-closed (#9c) -------------------

describe("#9c: verifyDpopProof awaits an async (Promise-returning) jti store", () => {
  it("accepts via an async store, then rejects a replay via the same async store", async () => {
    // a minimal async atomic store (models Redis `SET jti <v> NX PX <ttl>`): consume -> Promise<boolean>
    const seen = new Set<string>();
    const asyncStore = {
      consume: (key: string): Promise<boolean> =>
        Promise.resolve().then(() => {
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
    };
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock, jti: () => "async-jti" });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    const first = await verifyDpopProof(proof, { htm: "GET", htu: "https://h/x", now: FIXED_MS, jtiStore: asyncStore });
    expect(first.valid).toBe(true);
    const second = await verifyDpopProof(proof, { htm: "GET", htu: "https://h/x", now: FIXED_MS, jtiStore: asyncStore });
    expect(second).toMatchObject({ valid: false, reason: "replay" });
  });

  it("fails CLOSED when the async store throws (reason: replay store error)", async () => {
    const throwingStore = { consume: (): Promise<boolean> => Promise.reject(new Error("redis down")) };
    const signer = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock, jti: () => "store-err-jti" });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    const res = await verifyDpopProof(proof, { htm: "GET", htu: "https://h/x", now: FIXED_MS, jtiStore: throwingStore });
    expect(res).toMatchObject({ valid: false, reason: "replay store error" });
  });
});

// --- replay is scoped per key: (jkt, jti) not bare jti (follow-up) ------------

describe("replay keying + expectedJkt (per-key binding)", () => {
  it("two DIFFERENT keys minting the SAME jti do not collide (no cross-key false replay)", async () => {
    const store = createMemoryJtiStore();
    const a = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock, jti: () => "shared-jti" });
    const b = createDpopSigner(generateDpopKeyPair(), { clock: fixedClock, jti: () => "shared-jti" }); // different key, same jti
    const pa = a.proof({ htm: "GET", htu: "https://h/x" });
    const pb = b.proof({ htm: "GET", htu: "https://h/x" });
    // both accepted: replay is keyed on (jkt, jti), so key A's jti does not burn key B's identical jti
    expect((await verifyDpopProof(pa, { htm: "GET", htu: "https://h/x", now: FIXED_MS, jtiStore: store })).valid).toBe(true);
    expect((await verifyDpopProof(pb, { htm: "GET", htu: "https://h/x", now: FIXED_MS, jtiStore: store })).valid).toBe(true);
    // ...but replaying A's own proof is still caught:
    expect(await verifyDpopProof(pa, { htm: "GET", htu: "https://h/x", now: FIXED_MS, jtiStore: store })).toMatchObject({
      valid: false,
      reason: "replay",
    });
  });

  it("expectedJkt: accepts the matching key, rejects a different one (reason: jkt mismatch)", async () => {
    const signer = createDpopSigner(generateDpopKeyPair("ES256"), { clock: fixedClock });
    const proof = signer.proof({ htm: "GET", htu: "https://h/x" });
    const ok = await verifyDpopProof(proof, {
      htm: "GET",
      htu: "https://h/x",
      now: FIXED_MS,
      expectedJkt: signer.jkt,
      jtiStore: createMemoryJtiStore(),
    });
    expect(ok.valid).toBe(true);
    const bad = await verifyDpopProof(proof, {
      htm: "GET",
      htu: "https://h/x",
      now: FIXED_MS,
      expectedJkt: "some-other-key-thumbprint",
      jtiStore: createMemoryJtiStore(),
    });
    expect(bad).toMatchObject({ valid: false, reason: "jkt mismatch" });
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
    const res = await verifyDpopProof(proof as string, { htm: "GET", htu: "https://example.com/api/x", now: FIXED_MS });
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
