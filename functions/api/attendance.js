import {
  json, badRequest, unauthorized, forbidden,
  requireRole, haversineMeters, isFeatureEnabled, todayISO, buildDeviceInfo,
} from "../_utils.js";

// GET  /api/attendance?action=mine                     -> student: their own event log + today's distance check
// GET  /api/attendance?action=summary&student=&from=&to=  -> dean/attendance_control/admin: summary table
// POST /api/attendance  { action:"checkin", lat, lng, device_info }  -> student self check-in/out
// POST /api/attendance  { action:"manual", student_id, device_info } -> attendance_control logs a record for a student
//
// device_info: JSON string from collectDeviceInfo() in public/js/app.js — browser/device
// fields collected client-side, no permission prompts required. Merged server-side with
// IP + Cloudflare edge geo/ISP data (see buildDeviceInfo in functions/_utils.js) and stored
// on the attendance_events row. For "manual", this is the attendance_control operator's
// device, not the student's — there is no student device involved in a manual entry.

export async function onRequestGet({ request, env, data }) {
  const user = data.user;
  if (!user) return unauthorized();
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "mine";

  if (action === "mine") {
    if (user.role !== "student" && user.role !== "super_admin") return forbidden();
    const studentId = url.searchParams.get("student") || user.user_id;
    const events = await env.DB.prepare(
      `SELECT id, event_date, event_time, source, distance_m
       FROM attendance_events WHERE student_id = ?
       ORDER BY event_time DESC LIMIT 200`
    ).bind(studentId).all();
    const summary = await env.DB.prepare(
      `SELECT * FROM attendance_summary WHERE student_id = ?
       ORDER BY event_date DESC LIMIT 60`
    ).bind(studentId).all();
    return json({ events: events.results, summary: summary.results });
  }

  if (action === "summary") {
    if (!requireRole(user, ["dean", "attendance_control"])) return forbidden();
    const studentId = url.searchParams.get("student");
    let q = `SELECT u.full_name, a.* FROM attendance_summary a
             JOIN users u ON u.user_id = a.student_id WHERE 1=1`;
    const binds = [];
    if (studentId) { q += " AND a.student_id = ?"; binds.push(studentId); }
    q += " ORDER BY a.event_date DESC LIMIT 500";
    const rows = await env.DB.prepare(q).bind(...binds).all();
    return json({ summary: rows.results });
  }

  return badRequest("Unknown action");
}

export async function onRequestPost({ request, env, data }) {
  const user = data.user;
  if (!user) return unauthorized();
  const body = await request.json().catch(() => ({}));

  if (body.action === "checkin") {
    if (user.role !== "student") return forbidden("Only students self check-in");
    if (!(await isFeatureEnabled(env, "attendance_checkin")))
      return forbidden("Attendance check-in is currently disabled");

    const { lat, lng, device_info } = body;
    if (typeof lat !== "number" || typeof lng !== "number")
      return badRequest("lat/lng required");

    const siteLat = parseFloat(env.SITE_LAT);
    const siteLng = parseFloat(env.SITE_LNG);
    const maxDist = parseFloat(env.MAX_DISTANCE_M);
    const distance = haversineMeters(lat, lng, siteLat, siteLng);

    // Server-side is the authority — never trust the client's enable/disable state
    if (distance > maxDist) {
      return json({ error: "Too far from the lecture location", distance_m: Math.round(distance) }, 403);
    }

    const studentExists = await env.DB.prepare(
      "SELECT user_id FROM students WHERE user_id = ?"
    ).bind(user.user_id).first();
    if (!studentExists) return badRequest("Student profile not found");

    const dev = buildDeviceInfo(request, device_info);

    await env.DB.prepare(
      `INSERT INTO attendance_events (student_id, event_date, source, recorded_by, distance_m, lat, lng, ip_address, device_info)
       VALUES (?, ?, 'self', ?, ?, ?, ?, ?, ?)`
    ).bind(user.user_id, todayISO(), user.user_id, distance, lat, lng, dev.ip, dev.json).run();

    return json({ ok: true, distance_m: Math.round(distance) });
  }

  if (body.action === "manual") {
    if (!requireRole(user, ["attendance_control"])) return forbidden();
    const { student_id, device_info } = body;
    if (!student_id) return badRequest("student_id required");

    const student = await env.DB.prepare(
      "SELECT user_id FROM students WHERE user_id = ?"
    ).bind(student_id).first();
    if (!student) return badRequest("No student found with that ID");

    const dev = buildDeviceInfo(request, device_info);

    await env.DB.prepare(
      `INSERT INTO attendance_events (student_id, event_date, source, recorded_by, ip_address, device_info)
       VALUES (?, ?, 'manual', ?, ?, ?)`
    ).bind(student.user_id, todayISO(), user.user_id, dev.ip, dev.json).run();

    return json({ ok: true });
  }

  return badRequest("Unknown action");
}
