"use strict";

/* global initSqlJs */

/**
 * DB — SQLite persistence layer built on sql.js (SQLite compiled to WebAssembly).
 *
 * The whole database lives in memory and is autosaved to localStorage as base64.
 * It can be exported as a real .db file and re-imported from a file, so data can
 * be backed up or moved between machines/browsers.
 */
const DB = (() => {
  const STORAGE_KEY = "cim_sqlite_b64";
  // Vendored copy of sql.js (js/vendor/) — matches the pinned npm devDependency.
  // Relative so it works both at a domain root and under a GitHub Pages /repo/ path.
  const SQLJS_BASE = "js/vendor/";

  const DEFAULT_SETTINGS = {
    company_name: "",
    company_address: "",
    company_tel: "",
    company_email: "",
    company_website: "",
    company_br: "",
    // Company chop as a data URL (PNG/SVG), stamped on the printed signature
    // area. Managed by its own upload handler — there is deliberately NO
    // `set-company-chop` form field, so the settings-form auto-save can never
    // clobber it (saveSettings only updates keys it was given).
    company_chop: "",
    bank_name: "",
    bank_code: "",
    bank_address: "",
    account_name: "",
    account_no: "",
    swift_code: "",
    default_currency: "USD",
    prefix_pi: "PI",
    prefix_ci: "CI",
  };

  const INVOICE_COLUMNS = [
    "invoice_no", "type", "invoice_date", "status", "currency", "customer_po", "related_invoice_no",
    "buyer_company", "buyer_attn", "buyer_address", "buyer_tel", "buyer_email",
    "ship_same_as_bill", "ship_company", "ship_address",
    "payment_terms", "validity",
    "gross_weight", "net_weight", "cartons", "shipping_marks",
    "freight", "remarks",
  ];

  const ITEM_COLUMNS = [
    "description", "qty", "unit_price",
  ];

  const SCHEMA = `
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS counters (
      key   TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no         TEXT NOT NULL,
      type               TEXT NOT NULL DEFAULT 'PI',
      invoice_date       TEXT DEFAULT '',
      status             TEXT DEFAULT 'Draft',
      currency           TEXT DEFAULT 'USD',
      customer_po        TEXT DEFAULT '',
      related_invoice_no TEXT DEFAULT '',
      buyer_company      TEXT DEFAULT '',
      buyer_attn         TEXT DEFAULT '',
      buyer_address      TEXT DEFAULT '',
      buyer_tel          TEXT DEFAULT '',
      buyer_email        TEXT DEFAULT '',
      ship_same_as_bill  INTEGER DEFAULT 1,
      ship_company       TEXT DEFAULT '',
      ship_address       TEXT DEFAULT '',
      payment_terms      TEXT DEFAULT '',
      validity           TEXT DEFAULT '',
      gross_weight       TEXT DEFAULT '',
      net_weight         TEXT DEFAULT '',
      cartons            TEXT DEFAULT '',
      shipping_marks     TEXT DEFAULT '',
      freight            REAL DEFAULT 0,
      remarks            TEXT DEFAULT '',
      created_at         TEXT DEFAULT (datetime('now')),
      updated_at         TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS invoice_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      sort_order   INTEGER DEFAULT 0,
      description  TEXT DEFAULT '',
      qty          REAL DEFAULT 0,
      unit_price   REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
  `;

  let SQL = null;
  let db = null;
  let lastPersistOk = true;
  let lastSnapshot = null; // last database bytes written to localStorage

  /* ---------------- base64 helpers (chunk-safe) ---------------- */

  const toB64 = (bytes) => {
    let bin = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  };

  const fromB64 = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  /* ---------------- low-level query helpers ---------------- */

  function all(sql, params = [], conn = db) {
    const stmt = conn.prepare(sql);
    try {
      if (params && params.length) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function run(sql, params = [], conn = db) {
    if (params && params.length) {
      const stmt = conn.prepare(sql);
      try {
        stmt.bind(params);
        stmt.step();
      } finally {
        stmt.free();
      }
    } else {
      conn.run(sql);
    }
  }

  /* ---------------- schema & persistence ---------------- */

  function ensurePragmas() {
    db.run("PRAGMA foreign_keys = ON;");
  }

  function ensureSchema() {
    db.run(SCHEMA);
    // Seed any missing default settings keys (INSERT OR IGNORE).
    const ins = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
    try {
      for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        ins.bind([k, String(v)]);
        ins.step();
        ins.reset();
      }
    } finally {
      ins.free();
    }
  }

  function persist() {
    try {
      const bytes = db.export();
      localStorage.setItem(STORAGE_KEY, toB64(bytes));
      lastSnapshot = bytes;
      lastPersistOk = true;
    } catch (e) {
      console.warn("Could not autosave database to localStorage", e);
      lastPersistOk = false;
    }
    return lastPersistOk;
  }

  /**
   * Periodic auto-save: writes the database to localStorage only if its bytes
   * changed since the last snapshot. Catches any change not yet persisted and
   * retries after transient storage failures. Returns true if it saved.
   */
  function autosaveIfChanged() {
    if (!db) return false;
    // Every mutation persists immediately, so a healthy last persist means
    // nothing is outstanding — skip the export/byte-compare entirely (this
    // used to re-export the whole database on every 30s tick even when idle).
    // The watchdog's real job is retrying after a failed persist.
    if (lastPersistOk) return false;
    let bytes;
    try {
      bytes = db.export();
    } catch (e) {
      return false;
    }
    if (lastSnapshot && lastSnapshot.length === bytes.length) {
      let same = true;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== lastSnapshot[i]) { same = false; break; }
      }
      if (same) return false;
    }
    try {
      localStorage.setItem(STORAGE_KEY, toB64(bytes));
      lastSnapshot = bytes;
      lastPersistOk = true;
      return true;
    } catch (e) {
      console.warn("Auto-save to localStorage failed", e);
      lastPersistOk = false;
      return false;
    }
  }

  async function init() {
    SQL = await initSqlJs({ locateFile: (f) => SQLJS_BASE + f });
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        db = new SQL.Database(fromB64(saved));
        ensurePragmas();
        ensureSchema();
        persist(); // baseline snapshot for change detection
        return { restored: true };
      } catch (e) {
        console.warn("Stored database unreadable, starting fresh.", e);
      }
    }
    db = new SQL.Database();
    ensurePragmas();
    ensureSchema();
    persist();
    return { restored: false };
  }

  /* ---------------- domain: invoices ---------------- */

  function listInvoices() {
    return all(`
      SELECT i.*,
             COALESCE((SELECT SUM(ii.qty * ii.unit_price)
                       FROM invoice_items ii WHERE ii.invoice_id = i.id), 0) AS subtotal,
             COALESCE((SELECT SUM(ii.qty * ii.unit_price)
                       FROM invoice_items ii WHERE ii.invoice_id = i.id), 0)
               + i.freight AS total
      FROM invoices i
      ORDER BY i.updated_at DESC, i.id DESC
    `);
  }

  function getInvoice(id) {
    const rows = all("SELECT * FROM invoices WHERE id = ?", [id]);
    if (!rows.length) return null;
    const inv = rows[0];
    inv.ship_same_as_bill = !!inv.ship_same_as_bill;
    inv.items = all("SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id", [id]);
    return inv;
  }

  // Coerce a value into something sql.js can bind.
  const bindable = (v) => {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v === undefined || v === null) return "";
    return v;
  };

  function saveInvoice(inv, items) {
    db.run("BEGIN");
    try {
      const vals = INVOICE_COLUMNS.map((c) => bindable(inv[c]));

      if (inv.id) {
        const sets = INVOICE_COLUMNS.map((c) => `${c} = ?`).join(", ");
        run(`UPDATE invoices SET ${sets}, updated_at = datetime('now') WHERE id = ?`, [...vals, inv.id]);
        run("DELETE FROM invoice_items WHERE invoice_id = ?", [inv.id]);
      } else {
        const cols = INVOICE_COLUMNS.join(", ");
        const qs = INVOICE_COLUMNS.map(() => "?").join(", ");
        run(`INSERT INTO invoices (${cols}) VALUES (${qs})`, vals);
        inv.id = all("SELECT last_insert_rowid() AS id")[0].id;
      }

      const ins = db.prepare(
        `INSERT INTO invoice_items (invoice_id, sort_order, ${ITEM_COLUMNS.join(", ")})
         VALUES (?, ?, ${ITEM_COLUMNS.map(() => "?").join(", ")})`
      );
      try {
        items.forEach((it, i) => {
          ins.bind([inv.id, i, ...ITEM_COLUMNS.map((c) => bindable(it[c]))]);
          ins.step();
          ins.reset();
        });
      } finally {
        ins.free();
      }

      // Record the issued number on the high-water mark, so deleted invoices
      // never free their number — and a manually typed high number (e.g.
      // PI-261001-7) raises the sequence for that prefix + date.
      const hm = /^([A-Z0-9]+)-(\d{6})-(\d+)$/.exec(String(inv.invoice_no || ""));
      if (hm) {
        run(
          `INSERT INTO counters (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = MAX(value, excluded.value)`,
          [`${hm[1]}-${hm[2]}`, parseInt(hm[3], 10)]
        );
      }

      db.run("COMMIT");
      persist();
      return inv.id;
    } catch (e) {
      try { db.run("ROLLBACK"); } catch (_) { /* noop */ }
      throw e;
    }
  }

  function deleteInvoice(id) {
    run("DELETE FROM invoice_items WHERE invoice_id = ?", [id]);
    run("DELETE FROM invoices WHERE id = ?", [id]);
    persist();
  }

  /** Light-weight status change from the invoice list (items untouched). */
  function setInvoiceStatus(id, status) {
    run("UPDATE invoices SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, id]);
    persist();
  }

  /**
   * Repeat buyers for the editor's "Copy a previous buyer" picker: one row per
   * company, with the details from that buyer's most recently created invoice
   * (MAX(id) — deterministic even when updated_at ties) and the invoice count.
   */
  function listBuyers() {
    return all(`
      SELECT i.buyer_company, i.buyer_attn, i.buyer_address, i.buyer_tel, i.buyer_email,
             (SELECT COUNT(*) FROM invoices x WHERE x.buyer_company = i.buyer_company) AS invoice_count
      FROM invoices i
      WHERE TRIM(COALESCE(i.buyer_company, '')) != ''
        AND i.id = (SELECT MAX(x.id) FROM invoices x WHERE x.buyer_company = i.buyer_company)
      ORDER BY i.updated_at DESC, i.id DESC
    `);
  }

  /**
   * Next invoice number for a type: PREFIX-YYMMDD-# (e.g. PI-261001-1),
   * where YYMMDD comes from the given invoice date (defaults to today)
   * and # is the next sequence for that prefix + date.
   */
  function nextInvoiceNo(type, dateStr) {
    const s = getSettings();
    const raw = (type === "CI" ? s.prefix_ci : s.prefix_pi) || type;
    const prefix = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "") || type;

    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
    let ymd;
    if (m) {
      ymd = `${m[1].slice(2)}${m[2]}${m[3]}`; // YYMMDD from the invoice date
    } else {
      const now = new Date();
      ymd = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    }

    const like = `${prefix}-${ymd}-%`;
    let max = 0;
    for (const r of all("SELECT invoice_no FROM invoices WHERE invoice_no LIKE ?", [like])) {
      const mm = /(\d+)\s*$/.exec(String(r.invoice_no || ""));
      if (mm) max = Math.max(max, parseInt(mm[1], 10));
    }
    // High-water mark: a number that was ever issued stays issued — deleting
    // the last invoice of the day must not free its number for reuse.
    const ctr = all("SELECT value FROM counters WHERE key = ?", [`${prefix}-${ymd}`])[0];
    if (ctr) max = Math.max(max, parseInt(ctr.value, 10) || 0);
    return `${prefix}-${ymd}-${max + 1}`;
  }

  function findDuplicateNo(invoiceNo, excludeId) {
    const rows = all("SELECT id FROM invoices WHERE invoice_no = ? AND id != ?", [invoiceNo, excludeId ?? -1]);
    return rows.length > 0;
  }

  function duplicateInvoice(id) {
    const src = getInvoice(id);
    if (!src) return null;
    const copy = {};
    INVOICE_COLUMNS.forEach((c) => { copy[c] = bindable(src[c]); });
    // Number the copy from the source invoice's own date, so a duplicate of
    // PI-261001-1 becomes PI-261001-2 (not a number for today's date).
    copy.invoice_no = nextInvoiceNo(src.type, src.invoice_date);
    copy.status = "Draft";
    const items = src.items.map((it) => {
      const o = {};
      ITEM_COLUMNS.forEach((c) => { o[c] = bindable(it[c]); });
      return o;
    });
    const newId = saveInvoice({ ...copy, id: null }, items);
    return { id: newId, invoice_no: copy.invoice_no };
  }

  /**
   * Turn a Proforma invoice into a new Draft Commercial Invoice: copies all
   * fields and line items, drops the PI-only validity, sets related_invoice_no
   * to the source PI, and numbers/dates the CI for `dateStr` (the caller
   * passes today). Only PIs can be converted; returns null otherwise.
   */
  function convertToCI(id, dateStr) {
    const src = getInvoice(id);
    if (!src || src.type !== "PI") return null;
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.test(String(dateStr || "")) ? String(dateStr) : src.invoice_date;
    const copy = {};
    INVOICE_COLUMNS.forEach((c) => { copy[c] = bindable(src[c]); });
    copy.type = "CI";
    copy.invoice_date = date;
    copy.invoice_no = nextInvoiceNo("CI", date);
    copy.related_invoice_no = src.invoice_no;
    copy.status = "Draft";
    copy.validity = ""; // PI-only field
    const items = src.items.map((it) => {
      const o = {};
      ITEM_COLUMNS.forEach((c) => { o[c] = bindable(it[c]); });
      return o;
    });
    const newId = saveInvoice({ ...copy, id: null }, items);
    return { id: newId, invoice_no: copy.invoice_no };
  }

  /* ---------------- domain: settings ---------------- */

  function getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const row of all("SELECT key, value FROM settings")) out[row.key] = row.value;
    return out;
  }

  function saveSettings(obj) {
    const upd = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    try {
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          upd.bind([k, String(obj[k] ?? "")]);
          upd.step();
          upd.reset();
        }
      }
    } finally {
      upd.free();
    }
    persist();
  }

  /* ---------------- import / export ---------------- */

  /**
   * Open and validate app-database bytes. Returns the OPEN candidate database
   * plus row counts; throws (and closes the candidate) if invalid. Internal —
   * callers either adopt the candidate (importBytes) or close it
   * (inspectDatabase), so a cancelled import can never leak a connection.
   */
  function openValidated(bytes) {
    let candidate = null;
    try {
      candidate = new SQL.Database(bytes); // throws on invalid file
      const tables = all("SELECT name FROM sqlite_master WHERE type = 'table'", [], candidate).map((r) => r.name);
      const required = ["settings", "invoices", "invoice_items"];
      const missing = required.filter((t) => !tables.includes(t));
      if (missing.length) {
        throw new Error("Not a Component Invoice database (missing tables: " + missing.join(", ") + ")");
      }
      // Duplicate invoice numbers are bad data for a financial document (and
      // the app refuses to save duplicates itself) — refuse the import.
      const dups = all(
        "SELECT invoice_no, COUNT(*) AS c FROM invoices GROUP BY invoice_no HAVING COUNT(*) > 1 ORDER BY c DESC LIMIT 1",
        [], candidate
      );
      if (dups.length) {
        throw new Error(`contains duplicate invoice numbers (e.g. ${dups[0].invoice_no} ×${dups[0].c})`);
      }
      const invoices = all("SELECT COUNT(*) AS c FROM invoices", [], candidate)[0].c;
      const items = all("SELECT COUNT(*) AS c FROM invoice_items", [], candidate)[0].c;
      return { candidate, invoices, items };
    } catch (e) {
      if (candidate) { try { candidate.close(); } catch (_) { /* noop */ } }
      throw e;
    }
  }

  /**
   * Validate app-database bytes WITHOUT keeping anything open — safe to call
   * before asking the user to confirm an import. Returns { invoices, items };
   * throws if the bytes are not a valid, duplicate-free app database.
   */
  function inspectDatabase(bytes) {
    const { candidate, invoices, items } = openValidated(bytes);
    try { candidate.close(); } catch (_) { /* noop */ }
    return { invoices, items };
  }

  function importBytes(bytes) {
    const { candidate, invoices, items } = openValidated(bytes);
    if (db) { try { db.close(); } catch (_) { /* noop */ } }
    db = candidate;
    ensurePragmas();
    ensureSchema(); // fills in any missing tables (counters on old files) + default settings keys
    persist();
    return { invoices, items };
  }

  function exportBytes() {
    return db.export(); // Uint8Array — a real SQLite .db file
  }

  function wipe() {
    localStorage.removeItem(STORAGE_KEY);
    db = new SQL.Database();
    ensurePragmas();
    ensureSchema();
    persist();
  }

  /* ---------------- stats ---------------- */

  function stats() {
    const invoices = all("SELECT COUNT(*) AS c FROM invoices")[0].c;
    const items = all("SELECT COUNT(*) AS c FROM invoice_items")[0].c;
    // Size from the last persisted snapshot: every mutation persists right
    // away, so this is current — without re-exporting the whole database
    // (stats() runs on every list render and save).
    const bytes = lastSnapshot || (lastSnapshot = db.export());
    return { invoices, items, sizeKB: Math.round(bytes.length / 102.4) / 10 };
  }

  /* ---------------- public API ---------------- */

  return {
    init,
    persist,
    autosaveIfChanged,
    listInvoices,
    getInvoice,
    saveInvoice,
    deleteInvoice,
    setInvoiceStatus,
    nextInvoiceNo,
    findDuplicateNo,
    duplicateInvoice,
    convertToCI,
    listBuyers,
    getSettings,
    saveSettings,
    inspectDatabase,
    importBytes,
    exportBytes,
    wipe,
    stats,
    get persistOk() { return lastPersistOk; },
  };
})();
