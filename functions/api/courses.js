import { json, badRequest, unauthorized, forbidden, requireRole, genCourseCode, isFeatureEnabled } from "../_utils.js";

// GET  /api/courses?action=list                          -> student: every active course (new→old), with lectures
// GET  /api/courses?action=all                           -> support/admin: every course (to manage)
// POST /api/courses  { action:"add", name, banner_url, teacher_name }
// POST /api/courses  { action:"lecture-add", course_code, name, lecture_date, links, notes }
// POST /api/courses  { action:"lecture-update", lecture_id, name, lecture_date, links, notes }
//
// links: a single string, one URL per line — rendered as a numbered list on the frontend.
// NOTE: there is no enrollments table. Every active student is implicitly a
// member of every active course, so "list" below is just every active course —
// no per-student membership check needed.

export async function onRequestGet({ request, env, data }) {
  const user = data.user;
  if (!user) return unauthorized();
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "list";

  if (action === "all") {
    if (!requireRole(user, ["support"])) return forbidden();
    const rows = await env.DB.prepare(
      "SELECT * FROM courses ORDER BY created_at DESC"
    ).all();
    return json({ courses: rows.results });
  }

  if (action === "list") {
    if (!requireRole(user, ["student"])) return forbidden();
    if (!(await isFeatureEnabled(env, "course_registration")))
      return forbidden("Course access is currently disabled");

    const courses = await env.DB.prepare(
      `SELECT * FROM courses WHERE is_active = 1 ORDER BY created_at DESC`
    ).all();

    for (const course of courses.results) {
      const lectures = await env.DB.prepare(
        "SELECT * FROM lectures WHERE course_code = ? ORDER BY lecture_date"
      ).bind(course.course_code).all();
      course.lectures = lectures.results;
    }
    return json({ courses: courses.results });
  }

  if (action === "lectures") {
    if (!requireRole(user, ["support"])) return forbidden();
    const code = url.searchParams.get("course_code");
    if (!code) return badRequest("course_code required");
    const lectures = await env.DB.prepare(
      "SELECT * FROM lectures WHERE course_code = ? ORDER BY lecture_date"
    ).bind(code).all();
    return json({ lectures: lectures.results });
  }

  return badRequest("Unknown action");
}

export async function onRequestPost({ request, env, data }) {
  const user = data.user;
  if (!user) return unauthorized();
  const body = await request.json().catch(() => ({}));

  if (body.action === "add") {
    if (!requireRole(user, ["support"])) return forbidden();
    const { name, banner_url, teacher_name } = body;
    if (!name) return badRequest("name required");
    const code = genCourseCode();
    await env.DB.prepare(
      `INSERT INTO courses (course_code, name, banner_url, teacher_name, created_by)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(code, name, banner_url || null, teacher_name || null, user.user_id).run();
    return json({ ok: true, course_code: code });
  }

  if (body.action === "update") {
    if (!requireRole(user, ["support"])) return forbidden();
    const { course_code, name, banner_url, teacher_name, is_active } = body;
    if (!course_code) return badRequest("course_code required");
    await env.DB.prepare(
      `UPDATE courses SET name = COALESCE(?, name), banner_url = COALESCE(?, banner_url),
       teacher_name = COALESCE(?, teacher_name), is_active = COALESCE(?, is_active)
       WHERE course_code = ?`
    ).bind(name ?? null, banner_url ?? null, teacher_name ?? null,
           is_active === undefined ? null : (is_active ? 1 : 0), course_code).run();
    return json({ ok: true });
  }

  if (body.action === "lecture-add") {
    if (!requireRole(user, ["support"])) return forbidden();
    const { course_code, name, lecture_date, links, notes } = body;
    if (!course_code || !name) return badRequest("course_code and name required");
    const result = await env.DB.prepare(
      `INSERT INTO lectures (course_code, name, lecture_date, links, notes) VALUES (?, ?, ?, ?, ?)`
    ).bind(course_code, name, lecture_date || null, links || null, notes || null).run();
    return json({ ok: true, lecture_id: result.meta.last_row_id });
  }

  if (body.action === "lecture-update") {
    if (!requireRole(user, ["support"])) return forbidden();
    const { lecture_id, name, lecture_date, links, notes } = body;
    if (!lecture_id) return badRequest("lecture_id required");
    await env.DB.prepare(
      `UPDATE lectures SET name = COALESCE(?, name), lecture_date = COALESCE(?, lecture_date),
       links = ?, notes = ?, updated_at = datetime('now') WHERE lecture_id = ?`
    ).bind(name ?? null, lecture_date ?? null, links || null, notes || null, lecture_id).run();
    return json({ ok: true });
  }

  return badRequest("Unknown action");
}
