# Bible Institute Portal — Redesign Notes

## What changed
Only front-end files were touched: `public/css/style.css`, `public/js/app.js`, and all
six `public/*.html` pages, plus a new `public/assets/logo.png`. Every API call, element
`id`, and backend file in `functions/`, `schema.sql`, `seed.sql`, and `wrangler.toml` is
untouched — all existing functionality (check-in geofencing, excuses, uploads, exports,
exam covers, etc.) works exactly as before.

## Design system
**Colors** — extracted directly from the logo:
- Navy `#243461` (primary — buttons, header, headings) — 12:1 contrast on white
- Mint `#89D2B7` (accent — active nav, highlights, decorative backgrounds)
- Dark mint `#145F48` used for success text/icons (7.6:1 contrast — mint itself is too
  light to use as text and fails contrast, so a darker in-family shade carries that role)
- Semantic amber/red for warning/danger states, both AA/AAA-compliant on white

**Type** — system font stack at a 17px base (up from the old default ~16px browser
default), 1.9rem headings, 1.55 line-height. Everything scales with `rem`.

**Components** — one shared card, button (primary/accent/ghost/danger), pill/badge,
form-field, table, and empty-state pattern reused identically across all six pages, so
the whole app now reads as one product instead of six separately styled screens.

## Accessibility (WCAG-aligned)
- All text/background pairs checked for ≥4.5:1 contrast (most exceed 7:1)
- Visible 3px focus ring on every interactive element (not just mouse hover)
- 48px minimum touch targets on all buttons and inputs (WCAG 2.5.5 / Apple & Material guidance)
- `aria-live` regions on status/error messages so screen readers announce them
- Skip-to-content link on every page
- Semantic `role="tab"`/`aria-selected` wired into the existing tab switcher
- Tables collapse into labeled stacked cards below 700px instead of forcing horizontal
  scrolling of tiny text
- Empty states use plain language + icon instead of a bare "No rows"

## UX recommendations for older users
1. **Bigger, calmer nav** — pill-style section nav instead of thin underlined tabs,
   each with an icon + label so people can recognize a section without reading first.
2. **One clear primary action per screen** — check-in, submit, search, create all use
   the same solid navy button so it's never ambiguous what to tap.
3. **Explanatory hint text** — short one-line explanations added above forms (e.g. the
   5‑meter check-in rule, the required spreadsheet columns) so people don't have to guess.
4. **Consistent status colors** — green = approved/success, amber = pending, red = error,
   used identically everywhere (attendance, excuses, feature toggles).
5. **Mobile-first stacked tables** — on a phone, dense grids are the #1 usability
   complaint from older users; stacked "field: value" cards fix that without losing
   any data.

## Further suggestions (not yet implemented — flagging for your call)
- **Arabic/RTL mode**: the brand is Arabic-first but the app content is English. If your
  users are primarily Arabic speakers, a full RTL translation would help far more than
  any visual polish — happy to do this as a follow-up.
- **Password/PIN login**: per your README, login is currently just a known user ID with
  no password. Worth revisiting for a public-facing portal.
- **Native file uploads**: course banners, lecture files, and excuse attachments are
  currently pasted links only (by original design, no storage backend). If budget allows
  R2 storage later, real "choose file" uploads would be friendlier for less technical users.
