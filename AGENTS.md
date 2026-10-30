# AGENTS.md

Working notes for AI coding agents operating on this repository.

## What this is

**Component Invoice Manager** — a single-page web app for creating Proforma (PI) and Commercial (CI)
invoices for an electronic components trading company. Pure static site: **no build step, no bundler,
no runtime dependencies**. Deployed to GitHub Pages straight from the repo root.

Everything runs client-side: the database is SQLite in WebAssembly (sql.js), persisted to
localStorage, importable/exportable as a real `.db` file.

## Commands

```bash
python3 -m http.server 8000     # dev server -> http://localhost:8000
npm install                     # once — installs test-only dev deps (jsdom, sql.js)
npm test                        # full suite (68 tests, ~8s) — MUST pass before committing
npm run test:unit               # DB layer + pure helpers/print doc only
npm run test:dom                # jsdom integration tests only
node --check js/app.js          # quick syntax gate
```

There is no linter, no formatter, and no build. Do not introduce one without being asked.

## Architecture

```
index.html          # the entire UI (list / editor / settings views + preview overlay + datalists)
css/app.css         # theme on top of Bootstrap 5 + the A4 print stylesheet
js/vendor/          # sql.js 1.10.2 vendored (sql-wasm.js + sql-wasm.wasm) — the app's DB engine
js/db.js            # SQLite layer via sql.js — exposes global `DB` (schema, CRUD, import/export,
                    #   auto-save watchdog, settings, PREFIX-YYMMDD-# numbering)
js/app.js           # all UI logic — views, editor, list, drafts, print-preview, toasts, modal
tests/              # node:test suites + helpers (see Testing below)
DEPLOYMENT.md       # manual: deploying to GitHub Pages (custom domains, troubleshooting)
.github/workflows/deploy.yml   # CI: `npm test` gates the GitHub Pages deploy
```

### How the code is wired (important)

- Scripts are **classic, non-module** `<script>` tags loaded in order: sql.js → db.js → app.js.
  `db.js` is an IIFE that assigns top-level `const DB`; `app.js` references it as a global.
  **Do not convert to ES modules** — the app must keep working when opened as plain static files.
- `app.js` bootstraps on `DOMContentLoaded` (`bindEvents()` + `showView("list")` + `startAutosave()`).
- Views are sections toggled by `showView()` (`#view-list` / `#view-edit` / `#view-settings`);
  PI/CI-specific fields are toggled via `[data-show-for]` attributes.
- Invoice-list rows are event-delegated: buttons carry `data-action`
  (edit/duplicate/make-ci/print/delete, handled on click) and the status pill is a
  `select[data-action="status"]` handled on **change** — updated in place, never re-rendered
  mid-list (a re-render would re-sort by `updated_at` and make the row jump).
- Editor extras: the "Copy a previous buyer" picker (`DB.listBuyers()`) fills the Bill To block
  programmatically — such fills fire **no DOM events**, so they must call `scheduleDirty()`
  themselves. `doMakeCI` (list action `make-ci`) turns a PI into a Draft CI via `DB.convertToCI`.
- Modal focus handling is shared (`trapFocus` / `releaseFocus` / `focusTrapKeydown`): the confirm
  dialog and the print preview trap Tab, open on a safe button, and restore focus on close.
- **Auto-save system**: event-driven. Any `input`/`change`/`click` (document-level) schedules a
  debounced (~400ms) `autosaveTick()` that (1) byte-compares the DB against the last snapshot
  (`DB.autosaveIfChanged` — also retries after localStorage quota failures), (2) **saves the editor
  form to the database automatically once it is valid** (`validateInvoice()`: number + ≥1 line item
  + unique number); not-yet-valid forms are kept as a localStorage draft (`cim_editor_draft`)
  restorable via the draft banner, and (3) saves the Settings form when it changed. There are
  **no Save buttons**: the editor's Print button flushes the pending save before printing, leaving
  the editor flushes pending saves, and only *incomplete* invoices ask before leaving (their draft
  survives). The editor subtitle (`updateDirtyState()`) reports the pending/validation state.
  A slow 30s watchdog interval is a safety net, and pending saves flush on tab-hide/`beforeunload`.
- **Printing**: `buildPrintDoc(inv, settings)` is a *pure* function producing the formal A4
  document. The same output is used by `#print-area` (`@media print`) and the on-screen preview
  overlay. If you change the print layout, check both.
- Line-item Description fields are auto-growing textareas (auto-grow on input; multi-line text
  prints with `<br>`).

### Data model conventions (where past bugs came from)

- Settings form field IDs map to settings keys by `set-foo-bar` ⇄ `foo_bar`. The field list is
  **derived from `DB.getSettings()` keys** (`settingsFields()`) — never hardcode it. (A hand-written
  list once mapped `set-swift` → `swift` instead of `swift_code` and silently dropped the value.)
  Exception: `company_chop` deliberately has **no** `set-company-chop` form field — the chop is a
  data URL managed by its own upload/remove handlers, so the settings-form auto-save (which only
  writes keys it collected from fields) can never clobber it.
- Invoice inserts/updates are driven by `INVOICE_COLUMNS` / `ITEM_COLUMNS` in db.js. The schema uses
  `CREATE TABLE IF NOT EXISTS`, so **existing localStorage/imported databases are never migrated** —
  removed columns linger harmlessly (defaults cover them), but you must drop removed fields from the
  column lists, `collectInvoice()`, `fillEditor()`, and the print doc together.
- Invoice numbers are `PREFIX-YYMMDD-#` derived from the **invoice date**, sequenced per prefix+date.
  A `counters` table keeps a high-water mark per prefix+date (bumped on every save), so numbers are
  never reissued after a delete; manually entered higher numbers raise the sequence.
  `duplicateInvoice` deliberately numbers the copy from the *source invoice's* date.

## Testing rules

- Every bug fix gets a **regression test** in the suite that would have caught it.
- `tests/helpers.js` loads the non-module scripts: `loadDB()` (isolated localStorage, real sql.js),
  `loadAppPure()` (pure helpers), `createDomApp()` (full app in jsdom).
- jsdom gotchas already solved in the helper — don't regress them:
  - jsdom fires its natural DOMContentLoaded *after* the constructor; the helper waits for it and
    only dispatches a manual boot as a timeout fallback, otherwise **every listener gets bound twice**.
  - `setInterval` is captured (not scheduled) — call `app.fireAutosaveTick()` to run the watchdog
    tick deterministically; this also keeps the Node process from hanging. Note the event-driven
    debounced saves use real `setTimeout`s — tests that rely on them must `sleep()` past the
    debounce (400ms) instead.
  - jsdom has no layout: `offsetWidth`/`clientWidth` are 0; code touching them must tolerate that
    (the preview zoom already does).
  - Set input values via `setInput()` (value + dispatched event) — jsdom doesn't fire events on
    programmatic changes.
  - jsdom's real `localStorage` **silently ignores property overrides** (assigning `ls.setItem`
    does nothing), so `createDomApp()` swaps the window property for the same isolated,
    fail-switchable stub `loadDB()` uses. Simulate quota errors with
    `app.window.localStorage.fail = true`.
  - The app uploads/reads files (company chop) via `FileReader`, which jsdom supports — drive it
    by `Object.defineProperty(input, "files", { value: [file] })` + a dispatched `change`, then
    `sleep()` past the async read.
- DOM tests build on each other sequentially (boot → edit → save → list → …). Keep that ordering
  in mind when inserting new ones.

## UI conventions

- **Bootstrap 5.3.8 (CSS only, no Bootstrap JS).** Inputs need `form-control` / `form-select`
  classes — bare inputs are unstyled. Buttons are `btn btn-*`.
- Custom classes that intentionally avoid Bootstrap collisions: `.panel`/`.panel-header` (not
  `.card`), `.app-toast` (not `.toast`).
- Light theme only; brand accent is `--accent: #2563eb` in css/app.css.
- Small screens (<768px): invoice list rows and line items render as cards via CSS grid/block
  layouts; keep both layouts working when touching markup. Inputs use 16px font on phones
  (prevents iOS zoom-on-focus).
- **sql.js is vendored, not CDN-loaded**: `js/vendor/sql-wasm.{js,wasm}` are committed and must
  stay **byte-identical to the pinned npm devDependency** (`tests/vendor.test.js` enforces this —
  copy from `node_modules/sql.js/dist/` when bumping the version).
- CDN assets in index.html: Bootstrap 5.3.8 and Font Awesome 6.5.2 stylesheets carry
  **Subresource Integrity** (`integrity` + `crossorigin`) — recompute the hash when bumping a
  version. Google Fonts can't have SRI (its CSS is served dynamically); that's accepted.
  Foundation is gone (migrated).

## CI/CD

Push to `main` → `test` job (`npm ci` + `npm test`) → `deploy` job uploads the repo root to GitHub
Pages (`needs: test`). `package.json` / `node_modules` are test-harness only; the deployed app has
zero dependencies. `node_modules/` is gitignored; `package-lock.json` is committed.

**DEPLOYMENT.md** is the full manual for putting the site live (enabling Pages, triggering
redeploys, custom domains, troubleshooting) — keep it in sync when changing the workflow.

## Definition of done for any change

1. `npm test` fully green (add/adjust tests for behavior you touched).
2. `node --check` passes for modified JS.
3. Verified in the browser at http://localhost:8000 when the change is visual.
4. One focused commit with an imperative summary line.
