// Shared helpers used by every /functions/api/*.js file.

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

export function badRequest(msg) {
  return json({ error: msg }, 400);
}
export function unauthorized(msg = "Not logged in") {
  return json({ error: msg }, 401);
}
export function forbidden(msg = "Not allowed for your role") {
  return json({ error: msg }, 403);
}

// ---------- session cookie (HMAC-signed, no password — login is by user_id only) ----------

export function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

export async function createSessionCookie(user, env) {
  const payload = {
    user_id: user.user_id,
    role: user.role,
    exp: Date.now() + 1000 * 60 * 60 * 24 * 14, // 14 days
  };
  const payloadStr = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(env.SESSION_SECRET);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadStr));
  const token = `${payloadStr}.${b64url(sig)}`;
  const secure = "Secure; ";
  return `session=${token}; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=1209600`;
}

export function clearSessionCookie() {
  return `session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function getSessionUser(request, env) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
  if (!match) return null;
  const token = match[1];
  const [payloadStr, sigStr] = token.split(".");
  if (!payloadStr || !sigStr) return null;
  try {
    const key = await hmacKey(env.SESSION_SECRET);
    const valid = await crypto.subtle.verify(
      "HMAC", key, b64urlToBytes(sigStr), new TextEncoder().encode(payloadStr)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadStr)));
    if (payload.exp < Date.now()) return null;
    return payload; // { user_id, role, exp }
  } catch {
    return null;
  }
}

export function requireRole(user, roles) {
  if (!user) return false;
  if (user.role === "super_admin") return true; // super admin can do anything
  return roles.includes(user.role);
}

// ---------- geo ----------

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ---------- feature flags ----------

export async function isFeatureEnabled(env, key) {
  const row = await env.DB.prepare(
    "SELECT enabled FROM feature_flags WHERE feature_key = ?"
  ).bind(key).first();
  if (!row) return true; // unknown flag = not restricted
  return !!row.enabled;
}

// ---------- misc ----------

export function genCourseCode() {
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  const ts = Date.now().toString(36).slice(-4).toUpperCase();
  return `CRS-${ts}${rand}`;
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Combines client-collected device info (from public/js/app.js collectDeviceInfo())
// with server-observed data — IP and Cloudflare's edge geo/ISP info — into one
// JSON blob for storage. Never throws: bad/missing client JSON degrades gracefully.
export function buildDeviceInfo(request, clientDeviceInfoJson) {
  let client = null;
  if (clientDeviceInfoJson) {
    try { client = JSON.parse(clientDeviceInfoJson); } catch { client = { raw: String(clientDeviceInfoJson).slice(0, 500) }; }
  }
  const cf = request.cf || {};
  const server = {
    ip: request.headers.get("CF-Connecting-IP") || null,
    userAgent: request.headers.get("User-Agent") || null,
    country: cf.country || null,
    region: cf.region || null,
    city: cf.city || null,
    postalCode: cf.postalCode || null,
    timezone: cf.timezone || null,
    colo: cf.colo || null,
    asn: cf.asn || null,
    asOrganization: cf.asOrganization || null,
    httpProtocol: cf.httpProtocol || null,
  };
  return { ip: server.ip, json: JSON.stringify({ client, server }) };
}
