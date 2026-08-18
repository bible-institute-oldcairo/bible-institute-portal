import { json, badRequest, unauthorized, forbidden, requireRole, isFeatureEnabled } from "../_utils.js";

// GET  /api/students?action=me                    -> student: own profile
// GET  /api/students?action=card                  -> student: academy card data
// GET  /api/students?action=degrees                -> student: own course degrees
// GET  /api/students?action=search&code=...        -> dean/attendance_control: full student data by code
// GET  /api/students?action=list                   -> dean/attendance_control: every active student (cards + filters)
// POST /api/students  { action:"update", student_id, full_name, email, phone, level, program, photo_url }  (dean)

async function fullStudentBundle(env, studentUserId) {
  const profile = await env.DB.prepare(
    "SELECT s.*, u.full_name FROM students s JOIN users u ON u.user_id = s.user_id WHERE s.user_id = ?"
  ).bind(studentUserId).first();
  if (!profile) return null;

  const degrees = await env.DB.prepare(
    `SELECT cd.degree, c.name AS course_name, c.course_code
     FROM course_degrees cd JOIN courses c ON c.course_code = cd.course_code
     WHERE cd.student_id = ?`
  ).bind(studentUserId).all();

  const summary = await env.DB.prepare(
    `SELECT * FROM attendance_summary WHERE student_id = ? ORDER BY event_date DESC LIMIT 60`
  ).bind(studentUserId).all();

  const excuses = await env.DB.prepare(
    `SELECT e.*, d.day_date FROM excuses e JOIN excuse_days d ON d.id = e.excuse_day_id
     WHERE e.student_id = ? ORDER BY e.created_at DESC`
  ).bind(studentUserId).all();

  return { profile, degrees: degrees.results, attendance: summary.results, excuses: excuses.results };
}

export async function onRequestGet({ request, env, data }) {
  const user = data.user;
  if (!user) return unauthorized();
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "me";

  if (action === "me") {
    if (user.role !== "student" && user.role !== "super_admin") return forbidden();
    const profile = await env.DB.prepare(
      "SELECT s.*, u.full_name FROM students s JOIN users u ON u.user_id = s.user_id WHERE s.user_id = ?"
    ).bind(user.user_id).first();
    if (!profile) return badRequest("Student profile not found");
    return json({ profile });
  }

  if (action === "card") {
    if (user.role !== "student") return forbidden();
    if (!(await isFeatureEnabled(env, "academy_card")))
      return forbidden("Academy card is currently disabled");
    const profile = await env.DB.prepare(
      `SELECT s.user_id, u.full_name, s.photo_url, s.card_number, s.level, s.program
       FROM students s JOIN users u ON u.user_id = s.user_id WHERE s.user_id = ?`
    ).bind(user.user_id).first();
    if (!profile) return badRequest("Student profile not found");
    return json({ card: profile });
  }

  if (action === "degrees") {
    if (user.role !== "student") return forbidden();
    const rows = await env.DB.prepare(
      `SELECT cd.degree, c.name AS course_name, c.course_code
       FROM course_degrees cd JOIN courses c ON c.course_code = cd.course_code
       WHERE cd.student_id = ?`
    ).bind(user.user_id).all();
    return json({ degrees: rows.results });
  }

  if (action === "search") {
    if (!requireRole(user, ["dean", "attendance_control"])) return forbidden();
    const code = url.searchParams.get("code");
    if (!code) return badRequest("code required");
    const student = await env.DB.prepare(
      "SELECT user_id FROM students WHERE user_id = ?"
    ).bind(code).first();
    if (!student) return badRequest("No student found with that ID");
    const bundle = await fullStudentBundle(env, student.user_id);
    return json(bundle);
  }

  if (action === "list") {
    if (!requireRole(user, ["dean", "attendance_control"])) return forbidden();
    const rows = await env.DB.prepare(
      `SELECT s.user_id, u.full_name, s.level, s.program, s.photo_url, s.card_number
       FROM students s JOIN users u ON u.user_id = s.user_id
       WHERE u.is_active = 1
       ORDER BY u.full_name`
    ).all();
    return json({ students: rows.results });
  }

  return badRequest("Unknown action");
}

export async function onRequestPost({ request, env, data }) {
  const user = data.user;
  if (!user) return unauthorized();
  const body = await request.json().catch(() => ({}));

  if (body.action === "update") {
    if (!requireRole(user, ["dean"])) return forbidden();
    const { student_id, full_name, email, phone, level, program, photo_url, card_number } = body;
    if (!student_id) return badRequest("student_id required");
    if (full_name) {
      await env.DB.prepare("UPDATE users SET full_name = ? WHERE user_id = ?")
        .bind(full_name, student_id).run();
    }
    await env.DB.prepare(
      `UPDATE students SET
        email       = COALESCE(?, email),
        phone       = COALESCE(?, phone),
        level       = COALESCE(?, level),
        program     = COALESCE(?, program),
        photo_url   = COALESCE(?, photo_url),
        card_number = COALESCE(?, card_number),
        updated_at  = datetime('now'),
        updated_by  = ?
       WHERE user_id = ?`
    ).bind(email ?? null, phone ?? null, level ?? null,
           program ?? null, photo_url ?? null, card_number ?? null, user.user_id, student_id).run();
    return json({ ok: true });
  }

  return badRequest("Unknown action");
}
