-- Run this once after the schema is created, to bootstrap your first login.
-- Edit the user_id and full_name below to whatever you want to log in with.

INSERT OR IGNORE INTO users (user_id, role, full_name)
VALUES ('admin1', 'super_admin', 'Super Admin');

-- Optional: an example excuse day so the student "Add Excuse" page has something to pick from.
-- INSERT OR IGNORE INTO excuse_days (day_date, is_active) VALUES ('2026-08-01', 1);
