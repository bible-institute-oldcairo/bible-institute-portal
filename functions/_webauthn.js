// WebAuthn (biometric login) support — minimal, dependency-free implementation
// for the Cloudflare Pages Functions runtime (Web Crypto only, no Node APIs).
//
// Scope / trade-offs (intentional, documented for future maintenance):
//  - Only "none" / self-attestation is used — we decode attestationObject to pull
//    out the public key, but we do NOT verify the attestation signature chain
//    against manufacturer root certs. This is the standard trade-off for
//    "convenience biometric unlock" (not a high-assurance enrollment system) and
//    matches what most small self-hosted WebAuthn setups do.
//  - Supported algorithms: ES256 (-7, P-256 ECDSA — Face ID/Touch ID/Android/most
//    platform authenticators) and RS256 (-257 — some Windows Hello TPM setups).
//  - Challenges are stateless: instead of a server-side table, the challenge
//    itself is an HMAC-signed, expiring token (same pattern as the session
//    cookie in _utils.js), so no extra D1 writes/cleanup are needed.

import { b64url, b64urlToBytes } from "./_utils.js";

// ---------------- signed / stateless challenge ----------------

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

// Produces the raw challenge bytes given to the browser's WebAuthn API. The
// bytes themselves ARE the signed token, so whatever the browser echoes back
// inside clientDataJSON.challenge is exactly what we re-verify — no storage.
export async function makeChallenge(env, userId, purpose) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `${purpose}.${userId || ""}.${Date.now() + 5 * 60 * 1000}.${nonce}`;
  const key = await hmacKey(env.SESSION_SECRET);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const token = `${b64url(new TextEncoder().encode(payload))}.${b64url(sig)}`;
  return token; // used directly as the base64url "challenge" field
}

export async function verifyChallenge(env, token, purpose, userId) {
  const [payloadB64, sigB64] = String(token || "").split(".");
  if (!payloadB64 || !sigB64) return false;
  try {
    const key = await hmacKey(env.SESSION_SECRET);
    const valid = await crypto.subtle.verify(
      "HMAC", key, b64urlToBytes(sigB64), b64urlToBytes(payloadB64)
    );
    if (!valid) return false;
    const payload = new TextDecoder().decode(b64urlToBytes(payloadB64));
    const [p, uid, exp, ] = payload.split(".");
    if (p !== purpose) return false;
    if (Number(exp) < Date.now()) return false;
    if (userId && uid !== userId) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------- minimal CBOR decoder ----------------
// Supports the subset WebAuthn actually produces: uint, negative int, byte
// string, text string, array, map, bool/null. Returns { value, offset }.

function cborReadLength(view, offset, infoBits) {
  if (infoBits < 24) return { len: infoBits, offset };
  if (infoBits === 24) return { len: view.getUint8(offset), offset: offset + 1 };
  if (infoBits === 25) return { len: view.getUint16(offset), offset: offset + 2 };
  if (infoBits === 26) return { len: view.getUint32(offset), offset: offset + 4 };
  if (infoBits === 27) {
    const hi = view.getUint32(offset), lo = view.getUint32(offset + 4);
    return { len: hi * 2 ** 32 + lo, offset: offset + 8 };
  }
  throw new Error("CBOR: unsupported length encoding");
}

export function cborDecode(bytes, offset = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const first = view.getUint8(offset);
  const type = first >> 5;
  const info = first & 0x1f;
  offset += 1;

  if (type === 0) { // unsigned int
    const { len, offset: o2 } = cborReadLength(view, offset, info);
    return { value: len, offset: o2 };
  }
  if (type === 1) { // negative int
    const { len, offset: o2 } = cborReadLength(view, offset, info);
    return { value: -1 - len, offset: o2 };
  }
  if (type === 2) { // byte string
    const { len, offset: o2 } = cborReadLength(view, offset, info);
    return { value: bytes.slice(o2, o2 + len), offset: o2 + len };
  }
  if (type === 3) { // text string
    const { len, offset: o2 } = cborReadLength(view, offset, info);
    const str = new TextDecoder().decode(bytes.slice(o2, o2 + len));
    return { value: str, offset: o2 + len };
  }
  if (type === 4) { // array
    const { len, offset: o2 } = cborReadLength(view, offset, info);
    let o = o2; const arr = [];
    for (let i = 0; i < len; i++) { const r = cborDecode(bytes, o); arr.push(r.value); o = r.offset; }
    return { value: arr, offset: o };
  }
  if (type === 5) { // map
    const { len, offset: o2 } = cborReadLength(view, offset, info);
    let o = o2; const map = {};
    for (let i = 0; i < len; i++) {
      const k = cborDecode(bytes, o); o = k.offset;
      const v = cborDecode(bytes, o); o = v.offset;
      map[k.value] = v.value;
    }
    return { value: map, offset: o };
  }
  if (type === 7) { // simple/float
    if (info === 20) return { value: false, offset };
    if (info === 21) return { value: true, offset };
    if (info === 22) return { value: null, offset };
    throw new Error("CBOR: unsupported simple value " + info);
  }
  throw new Error("CBOR: unsupported major type " + type);
}

// ---------------- authenticatorData parsing ----------------
// Layout: rpIdHash(32) | flags(1) | counter(4) | [attestedCredentialData if AT flag]

export function parseAuthenticatorData(authData) {
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  const rpIdHash = authData.slice(0, 32);
  const flags = view.getUint8(32);
  const counter = view.getUint32(33, false);
  const userPresent = !!(flags & 0x01);
  const userVerified = !!(flags & 0x04);
  const attestedCredentialDataIncluded = !!(flags & 0x40);

  let credentialId = null, coseKey = null, offset = 37;
  if (attestedCredentialDataIncluded) {
    offset += 16; // aaguid
    const credIdLen = view.getUint16(offset, false); offset += 2;
    credentialId = authData.slice(offset, offset + credIdLen); offset += credIdLen;
    const decoded = cborDecode(authData, offset);
    coseKey = decoded.value;
    offset = decoded.offset;
  }
  return { rpIdHash, flags, counter, userPresent, userVerified, credentialId, coseKey };
}

// ---------------- COSE key -> importable CryptoKey ----------------
// COSE_Key map keys are integers: 1=kty, 3=alg, -1=crv/n, -2=x/e, -3=y

export async function coseKeyToCryptoKey(coseKey) {
  const kty = coseKey[1];
  const alg = coseKey[3];

  if (kty === 2) { // EC2 (ES256, P-256)
    const x = coseKey[-2], y = coseKey[-3];
    const raw = new Uint8Array(1 + x.length + y.length);
    raw[0] = 0x04; // uncompressed point marker
    raw.set(x, 1);
    raw.set(y, 1 + x.length);
    const key = await crypto.subtle.importKey(
      "raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
    );
    return { key, alg: -7 };
  }

  if (kty === 3) { // RSA (RS256)
    const n = coseKey[-1], e = coseKey[-2];
    const jwk = { kty: "RSA", n: b64url(n), e: b64url(e), ext: true };
    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
    );
    return { key, alg: -257 };
  }

  throw new Error("Unsupported COSE key type: " + kty);
}

// Re-derive a verifiable CryptoKey from what we persisted in D1 (a JWK string).
export async function jwkToCryptoKey(jwkJson, alg) {
  const jwk = JSON.parse(jwkJson);
  if (alg === -7) {
    return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  }
  if (alg === -257) {
    return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  }
  throw new Error("Unsupported alg: " + alg);
}

// Converts an ECDSA/EC2 CryptoKey (imported above) into the JWK we store.
export async function cryptoKeyToStorableJwk(cryptoKeyInfo) {
  const jwk = await crypto.subtle.exportKey("jwk", cryptoKeyInfo.key);
  return JSON.stringify(jwk);
}

// ---------------- ECDSA signature: DER -> raw (P1363) ----------------
// WebAuthn/CBOR signatures for ES256 come back ASN.1 DER-encoded; Web Crypto's
// verify() for ECDSA expects raw concatenated r||s (32 bytes each for P-256).

export function derEcdsaSignatureToRaw(der) {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error("Bad DER signature");
  offset++; // total length (ignored, may be 1 or 2 bytes for our sizes — handled below)
  // total length could itself be long-form; handle the common short form only,
  // recomputing offset defensively by scanning for the two INTEGER tags instead.
  offset = 2;
  if (der[1] & 0x80) { // long-form length rare for P-256 sigs but guard anyway
    const numLenBytes = der[1] & 0x7f;
    offset = 2 + numLenBytes;
  }
  if (der[offset++] !== 0x02) throw new Error("Bad DER signature (r)");
  let rLen = der[offset++];
  let r = der.slice(offset, offset + rLen); offset += rLen;
  if (der[offset++] !== 0x02) throw new Error("Bad DER signature (s)");
  let sLen = der[offset++];
  let s = der.slice(offset, offset + sLen); offset += sLen;

  const stripLeadingZeros = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.slice(i); };
  r = stripLeadingZeros(r); s = stripLeadingZeros(s);
  const padTo32 = (b) => { const out = new Uint8Array(32); out.set(b, 32 - b.length); return out; };

  const raw = new Uint8Array(64);
  raw.set(padTo32(r), 0);
  raw.set(padTo32(s), 32);
  return raw;
}

export async function verifySignature({ alg, cryptoKey, signature, signedData }) {
  if (alg === -7) {
    const raw = derEcdsaSignatureToRaw(signature);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, cryptoKey, raw, signedData);
  }
  if (alg === -257) {
    return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, cryptoKey, signature, signedData);
  }
  throw new Error("Unsupported alg: " + alg);
}
