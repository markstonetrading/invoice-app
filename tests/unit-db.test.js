"use strict";

/** Unit tests for js/db.js — the SQLite persistence layer. */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadDB, createStorage, initSqlJs } = require("./helpers");

const todayYYMMDD = () => {
  const d = new Date();
  return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};

async function freshDB() {
  const { DB } = loadDB(createStorage());
  await DB.init();
  return DB;
}

const sampleInvoice = (over = {}) => ({
  invoice_no: "PI-261001-1", type: "PI", invoice_date: "2026-10-01", status: "Draft",
  currency: "USD", buyer_company: "Acme Electronics Ltd.", ship_same_as_bill: 1,
  payment_terms: "T/T in advance", freight: 10, remarks: "test",
  items: [
    { description: "MCU 32-bit ARM", qty: 1000, unit_price: 0.5 },
    { description: "MLCC 10uF", qty: 500, unit_price: 0.02 },
  ],
  ...over,
});

/* ------------------------- settings ------------------------- */

test("init: creates schema and seeds default settings", async () => {
  const DB = await freshDB();
  const s = DB.getSettings();
  assert.equal(s.default_currency, "USD");
  assert.equal(s.prefix_pi, "PI");
  assert.equal(s.prefix_ci, "CI");
  assert.equal(s.bank_code, ""); // key must exist (settings-key mapping regression)
  assert.equal(s.swift_code, "");
  assert.equal(DB.stats().invoices, 0);
});

test("settings: saves and reads back every known key (incl. swift_code regression)", async () => {
  const DB = await freshDB();
  DB.saveSettings({
    company_name: "Chip Trading Co.",
    company_br: "12345678",
    bank_name: "HSBC",
    bank_code: "003 / 716",
    swift_code: "HSBCHKHH",
    account_no: "123-456789-001",
    default_currency: "HKD",
  });
  const s = DB.getSettings();
  assert.equal(s.company_name, "Chip Trading Co.");
  assert.equal(s.bank_code, "003 / 716");
  assert.equal(s.swift_code, "HSBCHKHH"); // the bug this suite guards against
  assert.equal(s.default_currency, "HKD");
});

test("settings: save does not clobber keys it was not given", async () => {
  const DB = await freshDB();
  DB.saveSettings({ company_name: "A" });
  DB.saveSettings({ company_tel: "123" });
  const s = DB.getSettings();
  assert.equal(s.company_name, "A");
  assert.equal(s.company_tel, "123");
});

test("settings: company chop round-trips and is never wiped by form saves", async () => {
  const DB = await freshDB();
  DB.saveSettings({ company_name: "Chop Co." });
  DB.saveSettings({ company_chop: "data:image/png;base64,iVBORw0KGgo=" });
  assert.equal(DB.getSettings().company_chop, "data:image/png;base64,iVBORw0KGgo=");
  assert.equal(DB.getSettings().company_name, "Chop Co.");
  // saving the rest of the settings form (which has no chop field) keeps the chop
  DB.saveSettings({ company_tel: "123" });
  assert.equal(DB.getSettings().company_chop, "data:image/png;base64,iVBORw0KGgo=");
});

/* ------------------------- invoices: CRUD ------------------------- */

test("invoice: insert, computed list totals, getInvoice with ordered items", async () => {
  const DB = await freshDB();
  const data = sampleInvoice();
  const id = DB.saveInvoice(data, data.items);
  assert.ok(id > 0);

  const rows = DB.listInvoices();
  assert.equal(rows.length, 1);
  assert.equal(Math.round(rows[0].subtotal * 100), 51000); // 500 + 10
  assert.equal(Math.round(rows[0].total * 100), 52000);    // +10 freight & handling

  const inv = DB.getInvoice(id);
  assert.equal(inv.items.length, 2);
  assert.equal(inv.items[0].description, "MCU 32-bit ARM");
  assert.equal(inv.items[1].description, "MLCC 10uF");
  assert.equal(inv.ship_same_as_bill, true);
});

test("invoice: update replaces the line items", async () => {
  const DB = await freshDB();
  const data = sampleInvoice();
  const id = DB.saveInvoice(data, data.items);
  const upd = { ...data, id, freight: 25, items: [{ description: "Only item", qty: 2, unit_price: 3 }] };
  DB.saveInvoice(upd, upd.items);

  const inv = DB.getInvoice(id);
  assert.equal(inv.items.length, 1);
  assert.equal(inv.items[0].description, "Only item");
  assert.equal(inv.freight, 25);
  // the removed discount field is no longer part of the model
  assert.equal(inv.discount, undefined);
});

test("invoice: delete removes the invoice and its items", async () => {
  const DB = await freshDB();
  const data = sampleInvoice();
  const id = DB.saveInvoice(data, data.items);
  DB.deleteInvoice(id);
  assert.equal(DB.listInvoices().length, 0);
  assert.equal(DB.stats().items, 0);
  assert.equal(DB.getInvoice(id), null);
});

/* ------------------------- numbering ------------------------- */

test("numbering: PREFIX-YYMMDD-# sequences per date and per type", async () => {
  const DB = await freshDB();
  assert.equal(DB.nextInvoiceNo("PI", "2026-10-01"), "PI-261001-1");

  const data = sampleInvoice(); // PI-261001-1
  DB.saveInvoice(data, data.items);
  assert.equal(DB.nextInvoiceNo("PI", "2026-10-01"), "PI-261001-2");
  assert.equal(DB.nextInvoiceNo("PI", "2026-10-02"), "PI-261002-1"); // new day restarts
  assert.equal(DB.nextInvoiceNo("CI", "2026-10-01"), "CI-261001-1"); // CI is independent

  for (let i = 2; i <= 10; i++) {
    const d = { ...sampleInvoice(), invoice_no: `PI-261001-${i}` };
    DB.saveInvoice(d, d.items);
  }
  assert.equal(DB.nextInvoiceNo("PI", "2026-10-01"), "PI-261001-11"); // double digits
});

test("numbering: invalid or missing dates fall back to today", async () => {
  const DB = await freshDB();
  assert.equal(DB.nextInvoiceNo("PI", "not-a-date"), `PI-${todayYYMMDD()}-1`);
  assert.equal(DB.nextInvoiceNo("PI"), `PI-${todayYYMMDD()}-1`);
});

test("numbering: honours custom prefixes from settings", async () => {
  const DB = await freshDB();
  DB.saveSettings({ prefix_pi: "PRO-FORMA!" });
  assert.equal(DB.nextInvoiceNo("PI", "2026-10-01"), "PROFORMA-261001-1");
});

test("numbering: duplicate-number detection with self exclusion", async () => {
  const DB = await freshDB();
  const data = sampleInvoice();
  const id = DB.saveInvoice(data, data.items);
  assert.equal(DB.findDuplicateNo("PI-261001-1", null), true);
  assert.equal(DB.findDuplicateNo("PI-261001-1", id), false); // editing itself
  assert.equal(DB.findDuplicateNo("PI-261001-9", null), false);
});

test("duplicateInvoice: copies items as Draft with the next number", async () => {
  const DB = await freshDB();
  const data = sampleInvoice();
  const id = DB.saveInvoice(data, data.items);
  const dup = DB.duplicateInvoice(id);
  assert.equal(dup.invoice_no, "PI-261001-2");
  const inv = DB.getInvoice(dup.id);
  assert.equal(inv.status, "Draft");
  assert.equal(inv.items.length, 2);
});

test("setInvoiceStatus: updates status without touching the line items", async () => {
  const DB = await freshDB();
  const data = sampleInvoice();
  const id = DB.saveInvoice(data, data.items);
  DB.setInvoiceStatus(id, "Paid");
  const inv = DB.getInvoice(id);
  assert.equal(inv.status, "Paid");
  assert.equal(inv.items.length, 2);
  assert.equal(DB.listInvoices().find((r) => r.id === id).status, "Paid");
});

test("listBuyers: one row per company, newest details win, counts invoices", async () => {
  const DB = await freshDB();
  let d = sampleInvoice({ buyer_attn: "Old Contact", buyer_address: "Old Rd" });
  DB.saveInvoice(d, d.items);
  d = sampleInvoice({ invoice_no: "PI-261001-2", buyer_company: "Beta Ltd." });
  DB.saveInvoice(d, d.items);
  // Acme orders again with new contact details — those must win (MAX(id) row)
  d = sampleInvoice({ invoice_no: "PI-261001-3", buyer_attn: "New Contact", buyer_address: "New Rd" });
  DB.saveInvoice(d, d.items);

  const buyers = DB.listBuyers();
  assert.equal(buyers.length, 2);
  const acme = buyers.find((b) => b.buyer_company === "Acme Electronics Ltd.");
  assert.equal(acme.invoice_count, 2);
  assert.equal(acme.buyer_attn, "New Contact");
  assert.equal(acme.buyer_address, "New Rd");
  assert.equal(buyers.find((b) => b.buyer_company === "Beta Ltd.").invoice_count, 1);
  assert.equal(buyers[0].buyer_company, "Acme Electronics Ltd.", "most recent activity first");

  // Blank buyer companies are never offered
  d = sampleInvoice({ invoice_no: "PI-261001-4", buyer_company: "   " });
  DB.saveInvoice(d, d.items);
  assert.equal(DB.listBuyers().length, 2);
});

test("convertToCI: creates a Draft CI referencing the PI, numbered for the given date", async () => {
  const DB = await freshDB();
  const data = sampleInvoice({ validity: "30 days" }); // PI-261001-1
  const id = DB.saveInvoice(data, data.items);

  const res = DB.convertToCI(id, "2026-10-29");
  assert.ok(res.invoice_no.startsWith("CI-261029-"), `CI number was: ${res.invoice_no}`);
  const ci = DB.getInvoice(res.id);
  assert.equal(ci.type, "CI");
  assert.equal(ci.status, "Draft");
  assert.equal(ci.related_invoice_no, "PI-261001-1");
  assert.equal(ci.invoice_date, "2026-10-29");
  assert.equal(ci.validity, "", "PI-only field must not carry over");
  assert.equal(ci.buyer_company, "Acme Electronics Ltd.");
  assert.equal(ci.items.length, 2);
  assert.equal(ci.payment_terms, data.payment_terms);

  const pi = DB.getInvoice(id); // source PI untouched
  assert.equal(pi.type, "PI");
  assert.equal(pi.related_invoice_no, "");

  assert.equal(DB.convertToCI(res.id, "2026-10-29"), null, "only PIs can be converted");
  assert.equal(DB.convertToCI(999, "2026-10-29"), null);
});

test("numbering: deleting the last invoice of a day never reissues its number (regression)", async () => {
  const DB = await freshDB();
  const data = sampleInvoice(); // PI-261001-1
  const id = DB.saveInvoice(data, data.items);
  DB.deleteInvoice(id);
  assert.equal(DB.nextInvoiceNo("PI", "2026-10-01"), "PI-261001-2",
    "a number that was issued once must not be handed out again after a delete");
});

test("numbering: a manually typed high number raises the sequence", async () => {
  const DB = await freshDB();
  const data = sampleInvoice({ invoice_no: "PI-261001-7" });
  DB.saveInvoice(data, data.items);
  assert.equal(DB.nextInvoiceNo("PI", "2026-10-01"), "PI-261001-8");
});

test("numbering: high-water mark survives an export/import round-trip", async () => {
  const storage = createStorage();
  const { DB } = loadDB(storage);
  await DB.init();
  const data = sampleInvoice();
  DB.saveInvoice(data, data.items);
  DB.deleteInvoice(DB.listInvoices()[0].id);
  const bytes = DB.exportBytes();

  const { DB: DB2 } = loadDB(createStorage());
  await DB2.init();
  DB2.importBytes(bytes);
  assert.equal(DB2.nextInvoiceNo("PI", "2026-10-01"), "PI-261001-2",
    "the imported high-water mark must keep deleted numbers consumed");
});

test("numbering: databases from older versions (no counters table) still work", async () => {
  const storage = createStorage();
  {
    const { DB } = loadDB(storage);
    await DB.init();
    const data = sampleInvoice();
    DB.saveInvoice(data, data.items);
    // Simulate a file written by an older app version without the counters table
    const SQL = await initSqlJs();
    const legacy = new SQL.Database(DB.exportBytes());
    legacy.run("DROP TABLE counters");
    const bytes = legacy.export();
    legacy.close();
    storage._data.cim_sqlite_b64 = Buffer.from(bytes).toString("base64");
  }
  const { DB } = loadDB(storage); // "reload" from the legacy bytes
  const restored = await DB.init();
  assert.equal(restored.restored, true);
  assert.equal(DB.nextInvoiceNo("PI", "2026-10-01"), "PI-261001-2"); // scan floor still applies
  // and the next save re-seeds the high-water mark
  const data = sampleInvoice({ invoice_no: "PI-261001-2" });
  DB.saveInvoice(data, data.items);
  DB.deleteInvoice(DB.listInvoices()[0].id);
  assert.equal(DB.nextInvoiceNo("PI", "2026-10-01"), "PI-261001-3");
});

/* ------------------------- import / export ------------------------- */

test("export/import: round-trip replaces the database with the file content", async () => {
  const DB = await freshDB();
  const data = sampleInvoice();
  DB.saveInvoice(data, data.items);

  const bytes = DB.exportBytes();
  assert.equal(bytes[0], 0x53); // SQLite file magic "SQ..."
  assert.equal(bytes[1], 0x51);

  const info = DB.inspectDatabase(bytes);
  assert.equal(info.invoices, 1);
  assert.equal(info.items, 2);

  const res = DB.importBytes(bytes);
  assert.equal(res.invoices, 1);
  assert.equal(DB.listInvoices().length, 1);
  assert.equal(DB.getInvoice(DB.listInvoices()[0].id).items.length, 2);
});

test("import: rejects files that are not SQLite databases", async () => {
  const DB = await freshDB();
  assert.throws(() => DB.inspectDatabase(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])));
});

test("import: rejects valid SQLite files without the app schema", async () => {
  const DB = await freshDB();
  const SQL = await initSqlJs();
  const foreign = new SQL.Database();
  foreign.run("CREATE TABLE unrelated (id INTEGER)");
  const bytes = foreign.export();
  foreign.close();
  assert.throws(() => DB.inspectDatabase(bytes), /missing tables/i);
});

test("import: rejects databases containing duplicate invoice numbers (regression)", async () => {
  const DB = await freshDB();
  // The DB layer itself does not enforce uniqueness (the UI does) — so build
  // the bad data directly, as an externally-edited file would contain it.
  DB.saveInvoice(sampleInvoice(), sampleInvoice().items);                          // PI-261001-1
  DB.saveInvoice(sampleInvoice({ type: "CI" }), sampleInvoice().items);            // PI-261001-1 again
  const bytes = DB.exportBytes();
  assert.throws(() => DB.inspectDatabase(bytes), /duplicate invoice numbers/i);
  assert.throws(() => DB.importBytes(bytes), /duplicate invoice numbers/i);
  // The failed import must not have replaced the working database either.
  assert.equal(DB.listInvoices().length, 2);
});

/* ------------------------- auto-save watchdog ------------------------- */

test("autosave watchdog: no writes while nothing changed", async () => {
  const storage = createStorage();
  const { DB } = loadDB(storage);
  await DB.init();
  assert.equal(DB.autosaveIfChanged(), false);

  const data = sampleInvoice();
  DB.saveInvoice(data, data.items); // persists immediately
  const before = storage.getItem("cim_sqlite_b64");
  assert.equal(DB.autosaveIfChanged(), false);
  assert.equal(storage.getItem("cim_sqlite_b64"), before); // no spurious writes
});

test("autosave watchdog: retries after a transient storage failure", async () => {
  const storage = createStorage();
  const { DB } = loadDB(storage);
  await DB.init();

  storage.fail = true; // simulate QuotaExceededError during the save's persist
  const data = sampleInvoice();
  DB.saveInvoice(data, data.items); // immediate persist fails silently

  storage.fail = false;
  assert.equal(DB.autosaveIfChanged(), true); // watchdog detects the pending change
  assert.equal(DB.autosaveIfChanged(), false); // and settles down again
});

/* ------------------------- misc ------------------------- */

test("persistence: state survives a reload from localStorage", async () => {
  const storage = createStorage();
  {
    const { DB } = loadDB(storage);
    await DB.init();
    const data = sampleInvoice();
    DB.saveInvoice(data, data.items);
    DB.saveSettings({ company_name: "Persisted Co." });
  }
  {
    const { DB } = loadDB(storage); // "reload"
    const restored = await DB.init();
    assert.equal(restored.restored, true);
    assert.equal(DB.getSettings().company_name, "Persisted Co.");
    assert.equal(DB.listInvoices().length, 1);
  }
});

test("wipe: clears all data and re-seeds defaults", async () => {
  const DB = await freshDB();
  const data = sampleInvoice();
  DB.saveInvoice(data, data.items);
  DB.saveSettings({ company_name: "X" });
  DB.wipe();
  assert.equal(DB.stats().invoices, 0);
  assert.equal(DB.getSettings().company_name, "");
});
