import { json, badRequest, unauthorized, forbidden, requireRole, isFeatureEnabled } from "../_utils.js";

// GET  /api/excuses?action=days                 -> active excuse days a student can pick from
// GET  /api/excuses?action=mine                 -> student's own excuses (status hidden from student per spec... see note)
// GET  /api/excuses?action=all                  -> dean: every excuse + student name
// POST /api/excuses  { action:"add", excuse_day_id, lecture_choice, excuse_text, attachments:[{file_name,file_url}] }
// POST /api/excuses  { action:"cancel", excuse_id }
// POST /api/excuses  { action:"decide", excuse_id, approval_percentage }   (dean)

export async function onRequestGet({ request, env, data }) {
  const user = data.user;
  if (!user) return unauthorized();
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "mine";

  if (action === "days") {
    const rows = await env.DB.prepare(
      "SELECT id, day_date FROM excuse_days WHERE is_active = 1 ORDER BY day_date"
    ).all();
    return json({ days: rows.results });
  }

  if (action === "mine") {
    if (user.role !== "student" && user.role !== "super_admin") return forbidden();
    const rows = await env.DB.prepare(
      `SELECT e.id, e.lecture_choice, e.excuse_text, e.status, e.created_at,
              e.canceled_at, d.day_date
       FROM excuses e JOIN excuse_days d ON d.id = e.excuse_day_id
       WHERE e.student_id = ? ORDER BY e.created_at DESC`
    ).bind(user.user_id).all();

    // Per spec: the dean's approval decision/percentage is never shown to the student —
    // only whether it's still active or the student canceled it themselves.
    const sanitized = rows.results.map((r) => ({
      ...r,
      status: r.status === "canceled" ? "canceled" : "submitted",
    }));
    return json({ excuses: sanitized });
  }

  if (action === "all") {
    if (!requireRole(user, ["dean"])) return forbidden();
    const rows = await env.DB.prepare(
      `SELECT e.*, u.full_name, d.day_date
       FROM excuses e
       JOIN users u ON u.user_id = e.student_id
       JOIN excuse_days d ON d.id = e.excuse_day_id
       ORDER BY e.created_at DESC`
    ).all();
    return json({ excuses: rows.results });
  }

  return badRequest("Unknown action");
}

export async function onRequestPost({ request, env, data }) {
  const user = data.user;
  if (!user) return unauthorized();
  const body = await request.json().catch(() => ({}));

  if (body.action === "add") {
    if (user.role !== "student") return forbidden("Only students file excuses");
    if (!(await isFeatureEnabled(env, "add_excuse")))
      return forbidden("Filing excuses is currently disabled");

    const { excuse_day_id, lecture_choice, excuse_text, attachments } = body;
    if (!excuse_day_id || !lecture_choice || !excuse_text)
      return badRequest("excuse_day_id, lecture_choice and excuse_text are required");
    if (!["first", "second", "both"].includes(lecture_choice))
      return badRequest("lecture_choice must be first, second, or both");

    const day = await env.DB.prepare(
      "SELECT id FROM excuse_days WHERE id = ? AND is_active = 1"
    ).bind(excuse_day_id).first();
    if (!day) return badRequest("That excuse day is not available");

    const existing = await env.DB.prepare(
      "SELECT id FROM excuses WHERE student_id = ? AND excuse_day_id = ? AND status != 'canceled'"
    ).bind(user.user_id, excuse_day_id).first();
    if (existing)
      return badRequest("You already have an excuse filed for this day. Cancel it first if you need to resubmit.");

    const result = await env.DB.prepare(
      `INSERT INTO excuses (student_id, excuse_day_id, lecture_choice, excuse_text)
       VALUES (?, ?, ?, ?)`
    ).bind(user.user_id, excuse_day_id, lecture_choice, excuse_text).run();

    const excuseId = result.meta.last_row_id;

    if (Array.isArray(attachments)) {
      for (const a of attachments.slice(0, 10)) {
        if (a.file_name && a.file_url) {
          await env.DB.prepare(
            "INSERT INTO excuse_attachments (excuse_id, file_name, file_url) VALUES (?, ?, ?)"
          ).bind(excuseId, a.file_name, a.file_url).run();
        }
      }
    }
    return json({ ok: true, excuse_id: excuseId });
  }

  if (body.action === "cancel") {
    if (user.role !== "student") return forbidden();
    const { excuse_id } = body;
    if (!excuse_id) return badRequest("excuse_id required");

    const excuse = await env.DB.prepare(
      "SELECT * FROM excuses WHERE id = ? AND student_id = ?"
    ).bind(excuse_id, user.user_id).first();
    if (!excuse) return badRequest("Excuse not found");
    if (excuse.status === "canceled") return badRequest("Already canceled");

    await env.DB.prepare(
      `UPDATE excuses SET status = 'canceled', canceled_by = ?, canceled_at = datetime('now')
       WHERE id = ?`
    ).bind(user.user_id, excuse_id).run();
    return json({ ok: true });
  }

  if (body.action === "decide") {
    if (!requireRole(user, ["dean"])) return forbidden();
    const { excuse_id, approval_percentage } = body;
    if (!excuse_id || approval_percentage === undefined)
      return badRequest("excuse_id and approval_percentage required");
    const pct = Number(approval_percentage);
    if (isNaN(pct) || pct < 0 || pct > 100) return badRequest("approval_percentage must be 0-100");

    await env.DB.prepare(
      `UPDATE excuses SET status = 'decided', approval_percentage = ?, decided_by = ?, decided_at = datetime('now')
       WHERE id = ?`
    ).bind(pct, user.user_id, excuse_id).run();
    return json({ ok: true });
  }

  return badRequest("Unknown action");
}
