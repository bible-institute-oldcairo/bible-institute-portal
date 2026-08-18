import { json, badRequest, unauthorized, forbidden } from "../_utils.js";

// All actions here are Super Admin only.
// Excel parsing happens IN THE BROWSER (SheetJS) — this API only ever receives/returns plain JSON rows,
// and the browser turns JSON back into an .xlsx file for "download all tables".
//
// GET  /api/admin?action=features
// GET  /api/admin?action=excuse-days
// GET  /api/admin?action=export&table=users|students|courses|lectures|attendance|excuses|degrees
// POST /api/admin { action:"feature-toggle", feature_key, enabled }
// POST /api/admin { action:"excuse-day-add", day_date }
// POST /api/admin { action:"excuse-day-toggle", id, is_active }
// POST /api/admin { action:"upload-users", rows:[{user_id, role, full_name}] }
// POST /api/admin { action:"upload-students", rows:[{user_id, full_name, email, phone, level, program}] }
// POST /api/admin { action:"upload-degrees", rows:[{student, course_code, degree}] }   student = user_id
// POST /api/admin { action:"exam-cover", course_code, exam_date, duration_minutes, instructions }
// POST /api/admin { action:"disable-user", user_id, is_active }

const VALID_TABLES = {
  users: "SELECT * FROM users",
  students: "SELECT * FROM students",
  courses: "SELECT * FROM courses",
  lectures: "SELECT * FROM lectures",
  attendance: "SELECT * FROM attendance_events",
  excuses: "SELECT * FROM excuses",
  degrees: "SELECT * FROM course_degrees",
};

export async function onRequestGet({ request, env, data }) {
  const user = data.user;
  if (!user) return unauthorized();
  if (user.role !== "super_admin") return forbidden();
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  if (action === "features") {
    const rows = await env.DB.prepare("SELECT * FROM feature_flags").all();
    return json({ features: rows.results });
  }

  if (action === "excuse-days") {
    const rows = await env.DB.prepare("SELECT * FROM excuse_days ORDER BY day_date DESC").all();
    return json({ days: rows.results });
  }

  if (action === "export") {
    const table = url.searchParams.get("table");
    const q = VALID_TABLES[table];
    if (!q) return badRequest("Unknown table. Valid: " + Object.keys(VALID_TABLES).join(", "));
    const rows = await env.DB.prepare(q).all();
    return json({ table, rows: rows.results });
  }

  return badRequest("Unknown action");
}

export async function onRequestPost({ request, env, data }) {
  const user = data.user;
  if (!user) return unauthorized();
  if (user.role !== "super_admin") return forbidden();
  const body = await request.json().catch(() => ({}));

  if (body.action === "feature-toggle") {
    const { feature_key, enabled } = body;
    if (!feature_key) return badRequest("feature_key required");
    await env.DB.prepare(
      `INSERT INTO feature_flags (feature_key, enabled, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(feature_key) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')`
    ).bind(feature_key, enabled ? 1 : 0).run();
    return json({ ok: true });
  }

  if (body.action === "excuse-day-add") {
    const { day_date } = body;
    if (!day_date) return badRequest("day_date required (YYYY-MM-DD)");
    await env.DB.prepare(
      "INSERT OR IGNORE INTO excuse_days (day_date, is_active) VALUES (?, 1)"
    ).bind(day_date).run();
    return json({ ok: true });
  }

  if (body.action === "excuse-day-toggle") {
    const { id, is_active } = body;
    if (!id) return badRequest("id required");
    await env.DB.prepare("UPDATE excuse_days SET is_active = ? WHERE id = ?")
      .bind(is_active ? 1 : 0, id).run();
    return json({ ok: true });
  }

  if (body.action === "disable-user") {
    const { user_id, is_active } = body;
    if (!user_id) return badRequest("user_id required");
    await env.DB.prepare("UPDATE users SET is_active = ? WHERE user_id = ?")
      .bind(is_active ? 1 : 0, user_id).run();
    return json({ ok: true });
  }

  if (body.action === "upload-users") {
    const rows = body.rows;
    if (!Array.isArray(rows)) return badRequest("rows array required");
    let inserted = 0, errors = [];
    for (const r of rows) {
      if (!r.user_id || !r.role) { errors.push({ row: r, error: "missing user_id/role" }); continue; }
      try {
        await env.DB.prepare(
          `INSERT INTO users (user_id, role, full_name) VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, full_name = excluded.full_name`
        ).bind(String(r.user_id), r.role, r.full_name || null).run();
        inserted++;
      } catch (e) { errors.push({ row: r, error: String(e) }); }
    }
    return json({ ok: true, inserted, errors });
  }

  if (body.action === "upload-students") {
    const rows = body.rows;
    if (!Array.isArray(rows)) return badRequest("rows array required");
    let inserted = 0, errors = [];
    for (const r of rows) {
      if (!r.user_id) {
        errors.push({ row: r, error: "missing user_id" }); continue;
      }
      try {
        if (r.full_name) {
          await env.DB.prepare("UPDATE users SET full_name = ? WHERE user_id = ?")
            .bind(r.full_name, String(r.user_id)).run();
        }
        await env.DB.prepare(
          `INSERT INTO students (user_id, email, phone, level, program)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             email = excluded.email, phone = excluded.phone, level = excluded.level,
             program = excluded.program, updated_at = datetime('now')`
        ).bind(String(r.user_id),
               r.email || null, r.phone || null, r.level || null, r.program || null).run();
        inserted++;
      } catch (e) { errors.push({ row: r, error: String(e) }); }
    }
    return json({ ok: true, inserted, errors });
  }

  if (body.action === "upload-degrees") {
    const rows = body.rows;
    if (!Array.isArray(rows)) return badRequest("rows array required");
    let inserted = 0, errors = [];
    for (const r of rows) {
      if (!r.student || !r.course_code || r.degree === undefined) {
        errors.push({ row: r, error: "missing student/course_code/degree" }); continue;
      }
      const student = await env.DB.prepare(
        "SELECT user_id FROM students WHERE user_id = ?"
      ).bind(String(r.student)).first();
      if (!student) { errors.push({ row: r, error: "student not found" }); continue; }
      try {
        await env.DB.prepare(
          `INSERT INTO course_degrees (course_code, student_id, degree) VALUES (?, ?, ?)
           ON CONFLICT(course_code, student_id) DO UPDATE SET degree = excluded.degree, uploaded_at = datetime('now')`
        ).bind(r.course_code, student.user_id, Number(r.degree)).run();
        inserted++;
      } catch (e) { errors.push({ row: r, error: String(e) }); }
    }
    return json({ ok: true, inserted, errors });
  }

  if (body.action === "exam-cover") {
    const { course_code, exam_date, duration_minutes, instructions } = body;
    if (!course_code || !exam_date) return badRequest("course_code and exam_date required");

    const course = await env.DB.prepare("SELECT * FROM courses WHERE course_code = ?").bind(course_code).first();
    if (!course) return badRequest("Course not found");

    // Every active student is implicitly enrolled in every active course —
    // there's no enrollments table, so the exam-cover roster is just every active student.
    const students = await env.DB.prepare(
      `SELECT s.user_id, u.full_name FROM students s
       JOIN users u ON u.user_id = s.user_id
       WHERE u.is_active = 1 ORDER BY u.full_name`
    ).all();

    await env.DB.prepare(
      `INSERT INTO exam_covers (course_code, exam_date, duration_minutes, instructions, generated_by)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(course_code, exam_date, duration_minutes || null, instructions || null, user.user_id).run();

    return json({
      ok: true,
      cover: {
        course_name: course.name,
        course_code: course.course_code,
        teacher_name: course.teacher_name,
        exam_date, duration_minutes, instructions,
        students: students.results,
      },
    });
  }

  return badRequest("Unknown action");
}
