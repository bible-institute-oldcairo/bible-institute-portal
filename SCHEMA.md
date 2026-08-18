# Attendance Portal — Database Schema (D1 / SQLite)

Database: `attendance-portal-db`
Binding in `wrangler.toml`: `DB`

This file documents every table/column, plus copy-paste SQL you can run in
the Cloudflare dashboard (D1 → Console) or via:

```bash
wrangler d1 execute attendance-portal-db --remote --command="PASTE SQL HERE"
```

to sanity-check that each table works.

**No enrollments table.** Every active student is implicitly a member of
every active course — membership is computed live (active students × active
courses) and never stored, so there's nothing to insert/query/clean up for it.

---

## 1. `users` — every login, regardless of role

| Column | Type | Notes |
|---|---|---|
| `user_id` | TEXT (PK) | the ID typed on the login page |
| `role` | TEXT | one of: `student`, `dean`, `support`, `attendance_control`, `super_admin` |
| `full_name` | TEXT | |
| `is_active` | INTEGER | default `1` |
| `created_at` | TEXT | default now |

**Test it:**
```sql
SELECT user_id, role, full_name, is_active FROM users ORDER BY role;
```
Expect one row per test account already created: `admin1`, `support1`, `dean1`, `student1`, `attendance1`.

---

## 2. `students` — profile data for the `student` role

| Column | Type | Notes |
|---|---|---|
| `user_id` | TEXT (PK, → `users.user_id`) | |
| `email` | TEXT | |
| `phone` | TEXT | |
| `level` | TEXT | |
| `program` | TEXT | |
| `photo_url` | TEXT | pasted link, shown on academy card |
| `card_number` | TEXT | |
| `updated_at` | TEXT | |
| `updated_by` | TEXT | user_id of dean/admin who last edited |

**Test it:**
```sql
SELECT s.user_id, u.full_name, s.level, s.program FROM students s JOIN users u ON u.user_id = s.user_id;
```
Expect `student1` / `STU-0001`.

---

## 3. `courses`

| Column | Type | Notes |
|---|---|---|
| `course_code` | TEXT (PK) | system-generated |
| `name` | TEXT | |
| `banner_url` | TEXT | pasted link |
| `teacher_name` | TEXT | |
| `is_active` | INTEGER | |
| `created_by` | TEXT | support user_id |
| `created_at` | TEXT | |

**Test it (create a course, then confirm):**
```sql
INSERT INTO courses (course_code, name, teacher_name, created_by)
VALUES ('C-TEST-1', 'Test Course', 'Test Teacher', 'support1');

SELECT * FROM courses;
```

---

## 4. `lectures`

| Column | Type | Notes |
|---|---|---|
| `lecture_id` | INTEGER (PK, autoincrement) | |
| `course_code` | TEXT (→ `courses.course_code`) | |
| `name` | TEXT | |
| `lecture_date` | TEXT | ISO date |
| `video_link` | TEXT | |
| `created_at` / `updated_at` | TEXT | |

**Test it:**
```sql
INSERT INTO lectures (course_code, name, lecture_date)
VALUES ('C-TEST-1', 'Lecture 1', '2026-08-01');

SELECT * FROM lectures WHERE course_code = 'C-TEST-1';
```

---

## 5. `lecture_files`

| Column | Type | Notes |
|---|---|---|
| `file_id` | INTEGER (PK, autoincrement) | |
| `lecture_id` | INTEGER (→ `lectures.lecture_id`) | |
| `file_name` | TEXT | |
| `file_url` | TEXT | pasted external link (no storage backend) |
| `uploaded_at` | TEXT | |

**Test it:**
```sql
INSERT INTO lecture_files (lecture_id, file_name, file_url)
VALUES (1, 'Slides.pdf', 'https://example.com/slides.pdf');

SELECT * FROM lecture_files;
```

---

## 6. `course_degrees` — grades, uploaded via Excel by super admin

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER (PK) | |
| `course_code` | TEXT (→ `courses.course_code`) | |
| `student_id` | TEXT (→ `students.user_id`) | |
| `degree` | REAL | |
| `uploaded_at` | TEXT | |
| — | `UNIQUE(course_code, student_id)` | one grade per student per course |

**Test it:**
```sql
INSERT INTO course_degrees (course_code, student_id, degree) VALUES ('C-TEST-1', 'student1', 92.5);

SELECT * FROM course_degrees;
```

---

## 7. `attendance_events` — one row per check-in/out

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER (PK) | |
| `student_id` | TEXT (→ `students.user_id`) | |
| `event_date` | TEXT | `YYYY-MM-DD` |
| `event_time` | TEXT | |
| `source` | TEXT | `self` or `manual` |
| `recorded_by` | TEXT | who logged it |
| `distance_m` | REAL | geofence distance (self check-ins only) |
| `lat` / `lng` | REAL | |

**Test it:**
```sql
INSERT INTO attendance_events (student_id, event_date, source, recorded_by, distance_m, lat, lng)
VALUES ('student1', date('now'), 'manual', 'attendance1', NULL, NULL, NULL);

SELECT * FROM attendance_events;
```

---

## 8. `attendance_summary` — VIEW (not a table, always live)

First check-in / last check-out per student per day, derived from `attendance_events`.

**Test it (after adding events above):**
```sql
SELECT * FROM attendance_summary WHERE student_id = 'student1';
```

---

## 9. `excuse_days` — days open for filing an excuse

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER (PK) | |
| `day_date` | TEXT UNIQUE | `YYYY-MM-DD` |
| `is_active` | INTEGER | |

**Test it:**
```sql
INSERT INTO excuse_days (day_date) VALUES (date('now'));

SELECT * FROM excuse_days;
```

---

## 10. `excuses`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER (PK) | |
| `student_id` | TEXT (→ `students.user_id`) | |
| `excuse_day_id` | INTEGER (→ `excuse_days.id`) | |
| `lecture_choice` | TEXT | `first`, `second`, `both` |
| `excuse_text` | TEXT | |
| `status` | TEXT | `pending`, `decided`, `canceled` |
| `approval_percentage` | INTEGER | `NULL` = undecided, `0` = rejected |
| `decided_by` / `decided_at` | TEXT | |
| `canceled_by` / `canceled_at` | TEXT | |
| `created_at` | TEXT | |

**Constraint:** a partial unique index on `(student_id, excuse_day_id) WHERE status != 'canceled'` limits a student to one active excuse per excuse day. Canceling frees them to file again for that day. The API also pre-checks this and returns a friendly error rather than a raw constraint failure.

**Test it (use the excuse_day id from step 10):**
```sql
INSERT INTO excuses (student_id, excuse_day_id, lecture_choice, excuse_text)
VALUES ('student1', 1, 'both', 'Doctor appointment');

SELECT * FROM excuses;
```

---

## 11. `excuse_attachments`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER (PK) | |
| `excuse_id` | INTEGER (→ `excuses.id`) | |
| `file_name` | TEXT | |
| `file_url` | TEXT | pasted link |

**Test it:**
```sql
INSERT INTO excuse_attachments (excuse_id, file_name, file_url)
VALUES (1, 'Doctor note', 'https://example.com/note.pdf');

SELECT * FROM excuse_attachments;
```

---

## 12. `feature_flags` — on/off switches the super admin controls

| Column | Type | Notes |
|---|---|---|
| `feature_key` | TEXT (PK) | `attendance_checkin`, `add_excuse`, `course_registration`, `academy_card` |
| `enabled` | INTEGER | |
| `updated_at` | TEXT | |

**Test it:**
```sql
SELECT * FROM feature_flags;
```
Expect 4 rows, all `enabled = 1` by default.

---

## 13. `exam_covers`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER (PK) | |
| `course_code` | TEXT (→ `courses.course_code`) | |
| `exam_date` | TEXT | |
| `duration_minutes` | INTEGER | |
| `instructions` | TEXT | |
| `generated_by` / `generated_at` | TEXT | |

**Test it:**
```sql
INSERT INTO exam_covers (course_code, exam_date, duration_minutes, instructions, generated_by)
VALUES ('C-TEST-1', '2026-09-01', 60, 'Bring your student ID.', 'dean1');

SELECT * FROM exam_covers;
```

---

## 14. `webauthn_credentials`

*Biometric (Face ID / Fingerprint / Windows Hello) login credentials. Additive
— the original `user_id`-only login always still works; this just lets a
user skip typing their ID on a device they've registered.*

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER (PK) | |
| `user_id` | TEXT (→ `users.user_id`) | |
| `credential_id` | TEXT (UNIQUE) | base64url authenticator credential ID |
| `public_key_jwk` | TEXT | JWK of the credential's public key |
| `alg` | INTEGER | COSE alg: `-7` (ES256) or `-257` (RS256) |
| `sign_count` | INTEGER | Anti-clone replay counter |
| `device_label` | TEXT | e.g. "Chrome on Windows" |
| `created_at` / `last_used_at` | TEXT | |

**Test it:**
```sql
SELECT user_id, device_label, created_at, last_used_at FROM webauthn_credentials;
```

---

## Cleaning up test data

Once you've confirmed things work, remove the sample rows created above:

```sql
DELETE FROM exam_covers WHERE course_code = 'C-TEST-1';
DELETE FROM excuse_attachments WHERE excuse_id = 1;
DELETE FROM excuses WHERE student_id = 'student1';
DELETE FROM excuse_days WHERE day_date = date('now');
DELETE FROM attendance_events WHERE student_id = 'student1' AND source = 'manual';
DELETE FROM course_degrees WHERE course_code = 'C-TEST-1';
DELETE FROM lecture_files WHERE lecture_id = 1;
DELETE FROM lectures WHERE course_code = 'C-TEST-1';
DELETE FROM courses WHERE course_code = 'C-TEST-1';
```

(Leave `users`/`students` test accounts — `admin1`, `support1`, `dean1`,
`student1`, `attendance1` — in place; you're using those to log in.)
