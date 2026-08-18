# Academy Attendance Portal — deployment guide

This is a Cloudflare Pages app: static HTML/CSS/JS in `public/`, API routes in
`functions/` (Cloudflare Pages Functions, which run on Workers), all data in
**D1** (SQL). There is no file-storage backend — banners, lecture files, and
excuse attachments are stored as plain pasted links (text columns in D1), not
uploaded binaries.

Nothing here needs Node.js at runtime — the only thing you need locally is the
`wrangler` CLI to create resources and deploy.

## 0. Install Wrangler and log in

```bash
npm install -g wrangler
wrangler login
```

This opens a browser to authorize Wrangler against your Cloudflare account.

## 1. D1 database — already done

The database `attendance-portal-db` exists (id already filled into
`wrangler.toml`), the schema is loaded (14 tables), and it's seeded — the
`admin1` super_admin login is confirmed present. Nothing to do here.

## 2. Set the session secret

This signs the login cookie. Use any long random string:

```bash
wrangler pages secret put SESSION_SECRET --project-name=attendance-portal
```

(If the project doesn't exist yet, do step 3 first, then come back and run this.)

## 3. Create the Pages project and deploy

```bash
wrangler pages project create attendance-portal
wrangler pages deploy public --project-name=attendance-portal
```

Wrangler will detect `functions/` automatically and deploy it alongside the
static site. After the first deploy, go to the Cloudflare dashboard →
Workers & Pages → attendance-portal → Settings → Functions, and make sure the
D1 (`DB`) binding from `wrangler.toml` is attached (Wrangler usually does this
for you automatically from `wrangler.toml`, but it's worth checking the first
time).

Also double check in Settings → Environment variables that `SITE_LAT`,
`SITE_LNG`, `MAX_DISTANCE_M`, and the `SESSION_SECRET` secret are all present
for the **Production** environment.

## 4. Log in

Visit your `*.pages.dev` URL (or your custom domain once attached), and log in
with the user ID you put in `seed.sql` (default `admin1`). That account is
`super_admin`, so from there you can:

- Upload your real users/students spreadsheets (Admin → Uploads)
- Add excuse days (Admin → Excuse Days)
- Jump into any other role's screens directly (Admin → Overview)

## Ongoing changes

Whenever you edit files in `public/` or `functions/`, redeploy with:

```bash
wrangler pages deploy public --project-name=attendance-portal
```

If you ever change `schema.sql` (e.g. add a column), re-run the relevant
`ALTER TABLE` manually via `wrangler d1 execute ... --command="ALTER TABLE ..."`
— re-running the whole `schema.sql` is safe (everything is `CREATE TABLE IF
NOT EXISTS`) but won't retroactively add columns to tables that already exist.

## Notes on how things work

- **Login**: by design, per your spec, there's no password — a valid `user_id`
  in the `users` table is enough. Anyone who knows or guesses a valid ID can
  log in as that person. If that's a concern later, the cleanest upgrade path
  is adding a `pin` or `password_hash` column to `users` and checking it in
  `functions/api/auth.js` — the session-cookie plumbing is already there.
- **Geofence**: the check-in button uses the browser's geolocation to show/hide
  itself, but the **server independently recomputes the distance** from
  `SITE_LAT`/`SITE_LNG` in `wrangler.toml` before accepting a check-in — a
  client that lies about being close will still be rejected server-side.
- **Attendance summary**: `attendance_summary` is a SQL `VIEW` (first/last
  event per student per day), not a separately-maintained table — it's always
  in sync with the raw `attendance_events` log.
- **Excel import/export**: handled entirely by SheetJS in the browser
  (Admin page) — the Worker only ever sees/returns plain JSON rows, which
  keeps the server code simple and avoids bundling a parsing library into it.
- **Files** (banners, lecture attachments, excuse attachments): there is no
  storage backend. Support staff and students paste external links (e.g. a
  Drive/Dropbox share link) directly into text fields, which are stored as-is
  in D1.
