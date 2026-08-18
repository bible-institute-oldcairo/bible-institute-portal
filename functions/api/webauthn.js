import { json, badRequest, unauthorized, createSessionCookie, getSessionUser, b64url, b64urlToBytes } from "../_utils.js";
import {
  makeChallenge, verifyChallenge,
  cborDecode, parseAuthenticatorData,
  coseKeyToCryptoKey, jwkToCryptoKey, cryptoKeyToStorableJwk,
  verifySignature,
} from "../_webauthn.js";

// POST /api/webauthn   body: { action, ... }
//   action=register-options   (logged in)            -> challenge + creation options
//   action=register-verify    (logged in)             -> stores the new credential
//   action=login-options       body:{ user_id }        -> challenge + allowCredentials
//   action=login-verify        body:{ user_id, ... }  -> verifies, logs the user in
//   action=delete               body:{ id } (logged in) -> removes a saved credential
// GET  /api/webauthn   (logged in)                     -> list saved credentials

function rpInfo(request) {
  const url = new URL(request.url);
  return { rpId: url.hostname, origin: url.origin };
}

export async function onRequestGet({ request, env }) {
  const user = await getSessionUser(request, env);
  if (!user) return unauthorized();
  const rows = await env.DB.prepare(
    "SELECT id, device_label, created_at, last_used_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC"
  ).bind(user.user_id).all();
  return json({ credentials: rows.results || [] });
}

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const { rpId, origin } = rpInfo(request);

  // ---------------- registration: start ----------------
  if (body.action === "register-options") {
    const user = await getSessionUser(request, env);
    if (!user) return unauthorized();

    const existing = await env.DB.prepare(
      "SELECT credential_id FROM webauthn_credentials WHERE user_id = ?"
    ).bind(user.user_id).all();

    const challenge = await makeChallenge(env, user.user_id, "register");
    return json({
      challenge,
      rp: { id: rpId, name: "Bible Institute Attendance Portal" },
      user: { id: b64url(new TextEncoder().encode(user.user_id)), name: user.user_id, displayName: user.user_id },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }, { alg: -257, type: "public-key" }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
      timeout: 60000,
      attestation: "none",
      excludeCredentials: (existing.results || []).map((r) => ({ id: r.credential_id, type: "public-key" })),
    });
  }

  // ---------------- registration: verify + store ----------------
  if (body.action === "register-verify") {
    const user = await getSessionUser(request, env);
    if (!user) return unauthorized();

    const { credential, challenge, deviceLabel } = body;
    if (!credential?.response?.clientDataJSON || !credential?.response?.attestationObject) {
      return badRequest("Malformed credential");
    }

    const ok = await verifyChallenge(env, challenge, "register", user.user_id);
    if (!ok) return badRequest("Registration challenge expired — please try again.");

    const clientDataJSON = JSON.parse(new TextDecoder().decode(b64urlToBytes(credential.response.clientDataJSON)));
    if (clientDataJSON.type !== "webauthn.create") return badRequest("Unexpected client data type");
    if (clientDataJSON.challenge !== challenge) return badRequest("Challenge mismatch");
    if (clientDataJSON.origin !== origin) return badRequest("Origin mismatch");

    const attestationObject = b64urlToBytes(credential.response.attestationObject);
    const att = cborDecode(attestationObject).value; // { fmt, attStmt, authData }
    const parsed = parseAuthenticatorData(att.authData);
    if (!parsed.credentialId || !parsed.coseKey) return badRequest("No credential data in attestation");
    if (!parsed.userVerified) return badRequest("Biometric verification was not confirmed by your device");

    const credentialIdB64 = b64url(parsed.credentialId);
    const cryptoKeyInfo = await coseKeyToCryptoKey(parsed.coseKey);
    const publicKeyJwk = await cryptoKeyToStorableJwk(cryptoKeyInfo);

    const dup = await env.DB.prepare("SELECT id FROM webauthn_credentials WHERE credential_id = ?").bind(credentialIdB64).first();
    if (dup) return badRequest("This device is already registered");

    const label = (deviceLabel || "").slice(0, 80) || "Unnamed device";
    await env.DB.prepare(
      `INSERT INTO webauthn_credentials (user_id, credential_id, public_key_jwk, alg, sign_count, device_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(user.user_id, credentialIdB64, publicKeyJwk, cryptoKeyInfo.alg, parsed.counter, label).run();

    return json({ ok: true });
  }

  // ---------------- login: start ----------------
  if (body.action === "login-options") {
    const userId = (body.user_id || "").trim();
    if (!userId) return badRequest("user_id is required");

    const userRow = await env.DB.prepare("SELECT user_id, is_active FROM users WHERE user_id = ?").bind(userId).first();
    if (!userRow || !userRow.is_active) return badRequest("Unknown or disabled user ID");

    const creds = await env.DB.prepare(
      "SELECT credential_id FROM webauthn_credentials WHERE user_id = ?"
    ).bind(userId).all();
    if (!creds.results || creds.results.length === 0) {
      return badRequest("No biometric credential registered for this user ID");
    }

    const challenge = await makeChallenge(env, userId, "login");
    return json({
      challenge,
      rpId,
      timeout: 60000,
      userVerification: "required",
      allowCredentials: creds.results.map((r) => ({ id: r.credential_id, type: "public-key" })),
    });
  }

  // ---------------- login: verify ----------------
  if (body.action === "login-verify") {
    const userId = (body.user_id || "").trim();
    const { credential, challenge } = body;
    if (!userId || !credential?.response) return badRequest("Malformed request");

    const ok = await verifyChallenge(env, challenge, "login", userId);
    if (!ok) return badRequest("Login challenge expired — please try again.");

    const clientDataJSON = JSON.parse(new TextDecoder().decode(b64urlToBytes(credential.response.clientDataJSON)));
    if (clientDataJSON.type !== "webauthn.get") return badRequest("Unexpected client data type");
    if (clientDataJSON.challenge !== challenge) return badRequest("Challenge mismatch");
    if (clientDataJSON.origin !== origin) return badRequest("Origin mismatch");

    const credentialIdB64 = credential.id;
    const row = await env.DB.prepare(
      "SELECT * FROM webauthn_credentials WHERE credential_id = ? AND user_id = ?"
    ).bind(credentialIdB64, userId).first();
    if (!row) return badRequest("Credential not recognized");

    const authData = b64urlToBytes(credential.response.authenticatorData);
    const parsed = parseAuthenticatorData(authData);
    if (!parsed.userPresent) return badRequest("User presence not confirmed");
    if (!parsed.userVerified) return badRequest("Biometric verification was not confirmed by your device");
    if (parsed.counter !== 0 && row.sign_count !== 0 && parsed.counter <= row.sign_count) {
      return badRequest("This credential looks like it may have been cloned. Please re-register.");
    }

    const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", b64urlToBytes(credential.response.clientDataJSON)));
    const signedData = new Uint8Array(authData.length + clientDataHash.length);
    signedData.set(authData, 0);
    signedData.set(clientDataHash, authData.length);

    const cryptoKey = await jwkToCryptoKey(row.public_key_jwk, row.alg);
    const signature = b64urlToBytes(credential.response.signature);
    const valid = await verifySignature({ alg: row.alg, cryptoKey, signature, signedData });
    if (!valid) return badRequest("Signature verification failed");

    const user = await env.DB.prepare(
      "SELECT user_id, role, full_name, is_active FROM users WHERE user_id = ?"
    ).bind(userId).first();
    if (!user || !user.is_active) return badRequest("This account has been disabled");

    await env.DB.prepare(
      "UPDATE webauthn_credentials SET sign_count = ?, last_used_at = datetime('now') WHERE id = ?"
    ).bind(parsed.counter, row.id).run();

    const cookie = await createSessionCookie(user, env);
    return new Response(JSON.stringify({ user }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": cookie },
    });
  }

  // ---------------- remove a saved device ----------------
  if (body.action === "delete") {
    const user = await getSessionUser(request, env);
    if (!user) return unauthorized();
    if (!body.id) return badRequest("id is required");
    await env.DB.prepare(
      "DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?"
    ).bind(body.id, user.user_id).run();
    return json({ ok: true });
  }

  return badRequest("Unknown action");
}
