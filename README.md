# Component Invoice Manager

A single-page web application for creating **Proforma Invoices (PI)** and **Commercial Invoices (CI)**,
tailored for an electronic components trading company.

Light theme only · [Bootstrap 5](https://getbootstrap.com/) · SQLite via [sql.js](https://sql.js.org/) (vendored, works offline) · no build step · 68 automated tests

## Features

- **Two invoice types** — Proforma (offer/quotation) and Commercial (final invoice for shipment), with
  type-specific fields (offer validity for PI; related PI number, gross/net weight, cartons
  and shipping marks for CI).
- **Component-trading fields** — item description, qty and unit price; customer PO, payment terms,
  beneficiary bank details (incl. bank code / branch code), business registration number.
- **Full CRUD** — create, read (search + filter by type/status), update and delete invoices and their
  line items.
- **Duplicate & edit** — one click clones an invoice (with all line items) to a new auto-numbered
  invoice in `Draft` status.
- **Create CI from PI** — PI rows offer a one-click conversion into a Draft Commercial Invoice,
  numbered for today, with the *Related Proforma No.* pre-filled and all items copied.
- **Repeat buyers** — the editor's *“Copy a previous buyer”* picker fills the whole Bill To block
  (contact, address, tel, email) from that buyer's most recent invoice.
- **Company chop** — upload a PNG/SVG company chop in Settings; it is stamped (slightly rotated,
  semi-transparent) over the signature area of every printed invoice, and travels with the database
  on export/import.
- **Status quick-toggle** — change Draft / Issued / Paid / Cancelled straight from the list,
  without opening the editor.
- **Import / export SQLite DB** — the entire database (invoices, items, settings) can be exported as a
  real `.db` file and imported back on any machine or browser. Data also autosaves to the browser's
  localStorage, so a refresh won't lose anything.
- **Print as PDF (with preview)** — invoices render as a formal A4 document. A full-screen **print
  preview** (zoom in/out, fit to window) shows exactly how the PDF will look before printing —
  accessible from the editor (previews unsaved edits) and the invoice list. Printing uses the
  browser's print dialog (choose “Save as PDF”). Includes amount in words, bank details,
  declaration (CI) and signature block.
- **Auto invoice numbering** — `PREFIX-YYMMDD-#` derived from the invoice date (e.g. `PI-261001-1`);
  prefixes configurable in Settings. Numbers are **never reissued**: deleting the last invoice of a
  day does not free its number (a persisted high-water mark), and a manually typed higher number
  raises the sequence.
- **Auto-save everywhere — no Save buttons** — every edit saves itself: settings and the database
  persist on a debounced change-detecting watchdog, and a valid invoice (number + at least one line
  item) is written to the database automatically as you type. Incomplete invoices are kept as a
  restorable draft. "Print" flushes the pending save before printing.

## Running locally

It's a fully static site — no build or server-side code required.

```bash
# from this directory
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly from the filesystem usually works too, but a local server is recommended.
The SQLite engine is **bundled with the app** (`js/vendor/`), so invoices work fully offline; only the
Bootstrap/Font Awesome styling (and the Inter font) come from CDNs — without a connection the page
may look plain, but all functionality and data remain available. CDN stylesheets carry Subresource
Integrity hashes.

## Automated tests

The test suite lives in `tests/` and runs on Node's built-in test runner (no test framework).
Dev dependencies (`jsdom`, `sql.js` — the same sql.js version the app uses) are installed via npm:

```bash
npm install        # once
npm test           # everything: 44 tests across three suites
npm run test:unit  # just the unit tests (DB layer + helpers/print doc)
npm run test:dom   # just the jsdom integration tests
```

| Suite | What it covers |
|---|---|
| `tests/unit-db.test.js` | SQLite layer: schema/defaults, settings (incl. the swift_code regression), CRUD, computed totals, `PREFIX-YYMMDD-#` numbering (incl. never-reissue high-water mark), duplicate detection/copy, PI→CI conversion, repeat buyers, status updates, export/import round-trip, invalid/duplicate-import rejection, the auto-save watchdog (incl. storage-failure retry), persistence across reload, wipe |
| `tests/unit-app.test.js` | Pure helpers (`esc`, dates, money, amount-in-words, storage alerts…) and the print-document builder: PI vs CI layouts, bank details, multi-line descriptions, removed-field regressions, XSS escaping |
| `tests/dom.test.js` | The full app booted in jsdom (real `index.html`, `db.js`, `app.js`, sql.js) and driven through the UI: boot, new-invoice defaults, live totals, automatic save (no Save button), list, duplicate, delete-with-confirm, PI/CI toggle, settings auto-save, draft save/restore, print preview (open, zoom, print, Esc), Print (flush + print), failing-storage auto-save warning, status quick-toggle, previous-buyer picker, Create CI from PI, modal keyboard handling (focus, Tab wrap, Escape), company chop upload/reject/print/remove |
| `tests/vendor.test.js` | Vendored sql.js must match the pinned npm devDependency byte-for-byte; index.html must load the engine locally (no CDN) with SRI on CDN stylesheets; no inline event handlers |

**CI/CD**: the GitHub Actions workflow (`.github/workflows/deploy.yml`) runs `npm test` on every
push to `main` — the site only deploys to GitHub Pages if all tests pass.

> Note: `package.json` / `node_modules` are test-harness only. The deployed app itself remains
> dependency-free static files.

## Deploying to GitHub Pages (CI/CD included)

The short version — the full step-by-step manual (with custom domains and troubleshooting) is in
**[DEPLOYMENT.md](DEPLOYMENT.md)**:

1. Create a new GitHub repository and push this code:
   ```bash
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. In GitHub, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Every push to `main` now triggers `.github/workflows/deploy.yml`: it runs the full test suite,
   and only if all tests pass does it deploy the site (served from the repository root as-is — no
   build step). You can also trigger a deploy manually via
   **Actions → Deploy to GitHub Pages → Run workflow**.

The site then lives at `https://<you>.github.io/<repo>/`.

## Data management

- **Auto-save (on detected change)** — whenever anything changes (a keystroke in the editor,
  Settings, or a database update), a debounced save runs almost immediately; there are no Save
  buttons. A valid invoice (number + at least one line item) is saved to the database automatically
  as you type — the editor subtitle confirms "All changes are saved automatically" and explains
  what's missing while an invoice is still incomplete. Incomplete invoices are kept as a
  **restorable draft**. A watchdog writes the SQLite database to the browser's localStorage whenever
  its content changed since the last snapshot (including automatic retries after transient storage
  failures), with a slow safety-net tick for changes that produce no event. The Settings form
  auto-saves on change (and is flushed when you leave the tab or close the page). A green
  "Autosaved …" indicator in the footer shows when the last auto-save happened.
- **Export DB** (top bar) — downloads a real SQLite `.db` file containing everything: invoices, line
  items and settings. Use this as your backup.
- **Import DB** (top bar) — loads a previously exported `.db` file, replacing the current data (after
  a confirmation prompt). Files containing **duplicate invoice numbers are rejected**. This is how
  you move data between machines/browsers.
- **Clear All Local Data** (Settings) — wipes the browser copy after a confirmation.

## Tech stack

| Layer     | Choice                                            |
|-----------|---------------------------------------------------|
| UI        | Bootstrap 5.3 (CSS) + vanilla JS                 |
| Fonts     | Inter (Google Fonts)                              |
| Icons     | Font Awesome 6 (free)                             |
| Database  | SQLite via sql.js 1.10 (WebAssembly), vendored in `js/vendor/` |
| PDF       | Print stylesheet + `window.print()` (A4)        |
| CI/CD     | GitHub Actions → GitHub Pages                     |

## Project structure

```
.
├── index.html                    # the single page (list / editor / settings views)
├── css/app.css                   # theme & print styles on top of Bootstrap 5
├── js/vendor/sql-wasm.{js,wasm}  # sql.js 1.10.2 — vendored, matches the npm devDependency
├── js/db.js                      # SQLite layer (sql.js): schema, CRUD, import/export
├── js/app.js                     # UI logic, print document builder
├── DEPLOYMENT.md                 # manual: deploying to GitHub Pages
└── .github/workflows/deploy.yml  # CI/CD: test-gated deploy to GitHub Pages
```

## Notes

- The app is fully client-side; no invoice data ever leaves your machine except when you
  deliberately export it.
- All amounts are calculated live (subtotal = Σ qty × unit price; total = subtotal +
  freight & handling).
- Invoice numbers are checked for uniqueness before saving, and never reissued after a delete.
- If browser storage starts failing (e.g. quota exceeded) or the database nears the ~5 MB
  localStorage limit, a warning toast tells you to export a backup.
