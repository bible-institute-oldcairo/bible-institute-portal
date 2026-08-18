-- ============================================================
-- Attendance / Academy Portal — Cloudflare D1 (SQLite) schema
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------
-- USERS (login is by user_id only, no password)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  user_id     TEXT PRIMARY KEY,          -- the ID typed on the login page
  role        TEXT NOT NULL CHECK (role IN
                ('student','dean','support','attendance_control','super_admin')),
  full_name   TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------
-- STUDENTS (profile data — uploaded by super admin via Excel)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS students (
  user_id       TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  email         TEXT,
  phone         TEXT,
  level         TEXT,
  program       TEXT,
  photo_url     TEXT,                    -- used on the academy card
  card_number   TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by    TEXT                     -- user_id of dean/admin who last edited
);


-- ---------------------------------------------------------
-- COURSES
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS courses (
  course_code  TEXT PRIMARY KEY,         -- system-generated code
  name         TEXT NOT NULL,
  banner_url   TEXT,
  teacher_name TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_by   TEXT,                     -- support user_id
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lectures (
  lecture_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  course_code  TEXT NOT NULL REFERENCES courses(course_code) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  lecture_date TEXT,                     -- ISO date
  links        TEXT,                     -- newline-separated URLs, numbered on display
  notes        TEXT,                     -- optional note from support; column hidden in UI when null
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- NOTE: there is no enrollments table. Every active student is implicitly a
-- member of every active course — course membership is computed live
-- (active students × active courses), never stored.

-- course degrees uploaded by super admin (student, course, degree) Excel sheet
CREATE TABLE IF NOT EXISTS course_degrees (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  course_code  TEXT NOT NULL REFERENCES courses(course_code) ON DELETE CASCADE,
  student_id   TEXT NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  degree       REAL NOT NULL,
  uploaded_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(course_code, student_id)
);

-- ---------------------------------------------------------
-- ATTENDANCE
-- ---------------------------------------------------------
-- one row per check-in/out event (self by student, or manual by attendance_control)
CREATE TABLE IF NOT EXISTS attendance_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     TEXT NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  event_date     TEXT NOT NULL,          -- YYYY-MM-DD
  event_time     TEXT NOT NULL DEFAULT (datetime('now')),
  source         TEXT NOT NULL CHECK (source IN ('self','manual')),
  recorded_by    TEXT NOT NULL,          -- user_id: the student themself, or the attendance_control/admin user
  distance_m     REAL,                   -- distance from the static point at time of check-in (self only)
  lat            REAL,
  lng            REAL,
  ip_address     TEXT,                   -- client IP (Cloudflare CF-Connecting-IP), captured server-side
  device_info    TEXT                    -- JSON: browser/device fields from the client + Cloudflare edge geo/ISP data
);

CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance_events(student_id, event_date);

-- Auto-derived daily summary: first check-in / last check-out per student per day
CREATE VIEW IF NOT EXISTS attendance_summary AS
SELECT
  student_id,
  event_date,
  MIN(event_time) AS first_check_in,
  MAX(event_time) AS last_check_out,
  COUNT(*)        AS events_count
FROM attendance_events
GROUP BY student_id, event_date;

-- ---------------------------------------------------------
-- EXCUSES
-- ---------------------------------------------------------
-- days the super admin makes available for filing an excuse
CREATE TABLE IF NOT EXISTS excuse_days (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day_date    TEXT UNIQUE NOT NULL,      -- YYYY-MM-DD
  is_active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS excuses (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id         TEXT NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  excuse_day_id      INTEGER NOT NULL REFERENCES excuse_days(id),
  lecture_choice     TEXT NOT NULL CHECK (lecture_choice IN ('first','second','both')),
  excuse_text        TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','decided','canceled')),
  approval_percentage INTEGER,           -- 0 = rejected, >0 = approved at that %, NULL = not decided yet
  decided_by         TEXT,
  decided_at         TEXT,
  canceled_by        TEXT,
  canceled_at        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- a student may only have one active (non-canceled) excuse per excuse day;
-- canceling frees them to file again for that same day
CREATE UNIQUE INDEX IF NOT EXISTS idx_excuses_one_per_day
  ON excuses(student_id, excuse_day_id) WHERE status != 'canceled';

CREATE TABLE IF NOT EXISTS excuse_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  excuse_id   INTEGER NOT NULL REFERENCES excuses(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  file_url    TEXT NOT NULL
);

-- ---------------------------------------------------------
-- SUPER ADMIN CONTROLS
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS feature_flags (
  feature_key  TEXT PRIMARY KEY,
  enabled      INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO feature_flags (feature_key, enabled) VALUES
 ('attendance_checkin', 1),
 ('add_excuse', 1),
 ('course_registration', 1),
 ('academy_card', 1);

CREATE TABLE IF NOT EXISTS exam_covers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  course_code  TEXT NOT NULL REFERENCES courses(course_code),
  exam_date    TEXT NOT NULL,
  duration_minutes INTEGER,
  instructions TEXT,
  generated_by TEXT,
  generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------
-- BIOMETRIC LOGIN (WebAuthn) — additive, existing user_id login stays intact
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  credential_id  TEXT NOT NULL UNIQUE,   -- base64url authenticator credential ID
  public_key_jwk TEXT NOT NULL,          -- JWK of the credential's public key
  alg            INTEGER NOT NULL,       -- COSE alg: -7 (ES256) or -257 (RS256)
  sign_count     INTEGER NOT NULL DEFAULT 0,
  device_label   TEXT,                  -- e.g. "Chrome on Windows", user-editable
  created_at     TEXT DEFAULT (datetime('now')),
  last_used_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_id ON webauthn_credentials(user_id);
