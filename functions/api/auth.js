import { json, badRequest, unauthorized, createSessionCookie, clearSessionCookie, getSessionUser } from "../_utils.js";

// GET /api/auth        -> current logged-in user
// POST /api/auth        body: { action: "login", user_id } | { action: "logout" }

export async function onRequestGet({ request, env }) {
  const user = await getSessionUser(request, env);
  if (!user) return unauthorized();

  // enrich with name for display
  const row = await env.DB.prepare(
    "SELECT user_id, role, full_name, is_active FROM users WHERE user_id = ?"
  ).bind(user.user_id).first();

  if (!row || !row.is_active) return unauthorized("Account disabled");
  return json({ user: row });
}

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));

  if (body.action === "logout") {
    return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
  }

  const userId = (body.user_id || "").trim();
  if (!userId) return badRequest("user_id is required");

  const user = await env.DB.prepare(
    "SELECT user_id, role, full_name, is_active FROM users WHERE user_id = ?"
  ).bind(userId).first();

  if (!user) return badRequest("Unknown user ID");
  if (!user.is_active) return badRequest("This account has been disabled");

  const cookie = await createSessionCookie(user, env);
  return new Response(JSON.stringify({ user }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": cookie },
  });
}
