"use strict";

/**
 * Integration tests: the complete app (real index.html, js/db.js, js/app.js
 * and the real sql.js engine) booted inside jsdom and driven through the
 * actual UI — clicks, input events, dialogs, tabs and the print preview.
 *
 * Tests run sequentially and build on each other (create -> save -> list ->
 * duplicate -> delete -> settings -> draft -> preview -> save & print).
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createDomApp, sleep, setInput } = require("./helpers");

let app;

before(async () => {
  app = await createDomApp();
}, { timeout: 30000 });

after(() => app.close());

const $ = (sel, root) => (root || app.document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || app.document).querySelectorAll(sel));

// Mirror of the app's todayISO() — the LOCAL calendar date (not UTC), so the
// suite stays correct when run while the local and UTC dates differ.
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const todayYYMMDD = () => todayISO().slice(2).replace(/-/g, "");

/* ------------------------------ boot ------------------------------ */

test("boots to the empty invoice list", () => {
  assert.equal($("#loading").hidden, true, "loading card should be dismissed");
  assert.equal($("#view-list").hidden, false);
  assert.equal($("#view-edit").hidden, true);
  assert.equal($("#view-settings").hidden, true);
  assert.equal($("#list-empty").hidden, false, "empty state should show");
  assert.equal($("#tab-count").hidden, true, "count badge hidden at zero");
  assert.equal(app.DB.stats().invoices, 0);

  // The empty-state button opens the editor (bound in app.js — no inline onclick)
  $("#btn-empty-new").click();
  assert.equal($("#view-edit").hidden, false);
});

/* --------------------------- editor basics --------------------------- */

test("new invoice: defaults to today's date and a PI-YYMMDD-1 number", () => {
  $("#btn-new").click();
  assert.equal($("#view-edit").hidden, false);
  assert.ok($("#ed-type-pi").checked);
  assert.equal($("#ed-date").value, todayISO());
  assert.equal($("#ed-no").value, `PI-${todayYYMMDD()}-1`);
  assert.equal($$("#items-tbody tr").length, 1, "one blank line item row");
});

test("line items: live totals, add and remove rows", async () => {
  const row = $("#items-tbody tr");
  setInput($(".it-desc", row), "MCU 32-bit ARM");
  setInput($(".it-qty", row), "1000");
  setInput($(".it-price", row), "0.5");
  assert.ok($("#t-subtotal").textContent.includes("500"), `subtotal was: ${$("#t-subtotal").textContent}`);

  $("#btn-add-item").click();
  assert.equal($$("#items-tbody tr").length, 2);
  const row2 = $$("#items-tbody tr")[1];
  setInput($(".it-desc", row2), "MLCC 10uF 0402");
  setInput($(".it-qty", row2), "10");
  setInput($(".it-price", row2), "2");
  assert.ok($("#t-total").textContent.includes("520"), `total was: ${$("#t-total").textContent}`);

  $(".it-del", row2).click(); // remove the second row
  assert.equal($$("#items-tbody tr").length, 1);
  assert.ok($("#t-subtotal").textContent.includes("500"));
});

test("auto-save: valid edits are written to the database automatically (no Save button)", async () => {
  setInput($("#ed-bill-company"), "Acme Electronics Ltd.");
  await sleep(700); // the debounced auto-save (~400ms) fires during this wait
  assert.equal(app.DB.stats().invoices, 1, "invoice stored without clicking anything");
  assert.equal(app.DB.listInvoices()[0].buyer_company, "Acme Electronics Ltd.");
  assert.equal(app.window.localStorage.getItem("cim_editor_draft"), null, "no draft once the invoice is in the DB");
  assert.equal($("#editor-subtitle").textContent, "All changes are saved automatically.",
    `subtitle was: ${$("#editor-subtitle").textContent}`);
});

/* ----------------------------- list view ----------------------------- */

test("saved invoice appears in the list with buyer and total", async () => {
  $("#btn-back").click(); // clean state — no confirmation expected
  await sleep(30);
  assert.equal($("#view-list").hidden, false);
  assert.equal($("#modal-confirm").hidden, true, "no leave-confirmation when clean");
  assert.equal($$("#invoice-tbody tr").length, 1);

  const rowText = $("#invoice-tbody tr").textContent;
  assert.ok(rowText.includes(`PI-${todayYYMMDD()}-1`));
  assert.ok(rowText.includes("Acme Electronics Ltd."));
  assert.ok(rowText.includes("500.00"));
  assert.equal($("#tab-count").textContent, "1");
  assert.equal($("#tab-count").hidden, false);
});

test("duplicate: one click copies the invoice as a new Draft", async () => {
  $("#invoice-tbody [data-action='duplicate']").click();
  await sleep(30);
  assert.equal($$("#invoice-tbody tr").length, 2);
  const dupRow = $$("#invoice-tbody tr")[0]; // newest first
  assert.ok(dupRow.textContent.includes(`PI-${todayYYMMDD()}-2`));
  assert.ok(dupRow.textContent.includes("Draft"));
});

test("delete: asks for confirmation, cancel keeps, confirm removes", async () => {
  const rows = () => $$("#invoice-tbody tr").length;
  const before = rows();

  $("#invoice-tbody [data-action='delete']").click();
  await sleep(20);
  assert.equal($("#modal-confirm").hidden, false, "confirmation dialog shown");
  $("#confirm-cancel").click();
  await sleep(20);
  assert.equal(rows(), before, "cancel keeps the row");
  assert.equal($("#modal-confirm").hidden, true);

  $("#invoice-tbody [data-action='delete']").click();
  await sleep(20);
  $("#confirm-ok").click();
  await sleep(30);
  assert.equal(rows(), before - 1, "confirm removes the row");
});

/* --------------------------- type behaviour --------------------------- */

test("type toggle: CI reveals Shipment Particulars and renumbers; PI hides it", () => {
  $("#btn-new").click();
  assert.equal($(".panel[data-show-for='CI']").hidden, true, "shipment panel hidden for PI");

  $("#ed-type-ci").checked = true;
  $("#ed-type-ci").dispatchEvent(new app.window.Event("change", { bubbles: true }));
  assert.equal($(".panel[data-show-for='CI']").hidden, false, "shipment panel visible for CI");
  assert.ok($("#ed-no").value.startsWith(`CI-${todayYYMMDD()}-`), `CI number was: ${$("#ed-no").value}`);

  $("#ed-type-pi").checked = true;
  $("#ed-type-pi").dispatchEvent(new app.window.Event("change", { bubbles: true }));
  assert.equal($(".panel[data-show-for='CI']").hidden, true);
  assert.ok($("#ed-no").value.startsWith(`PI-${todayYYMMDD()}-`));
});

test("leaving a dirty editor via a nav tab asks for confirmation too (regression)", async () => {
  // The editor is open and clean after the type-toggle test.
  setInput($("#ed-bill-company"), "Tab Nav Co.");

  // Dirty state is computed on demand (isDirty), so no debounce wait needed.
  $(".app-tab[data-view='settings']").click();
  await sleep(20);
  assert.equal($("#modal-confirm").hidden, false, "tab click with unsaved edits must confirm");
  $("#confirm-cancel").click();
  await sleep(20);
  assert.equal($("#view-edit").hidden, false, "cancel stays in the editor");
  assert.equal($("#modal-confirm").hidden, true);

  $(".app-tab[data-view='settings']").click();
  await sleep(20);
  assert.equal($("#modal-confirm").hidden, false);
  $("#confirm-ok").click(); // "Leave"
  await sleep(20);
  assert.equal($("#view-settings").hidden, false, "confirm navigates to Settings");

  // Clean up: discard the auto-saved draft so later tests start fresh.
  $(".app-tab[data-view='list']").click();
  await sleep(20);
  assert.equal($("#view-list").hidden, false);
  assert.equal($("#draft-banner").hidden, false, "edits were kept as a draft");
  $("#btn-draft-discard").click();
  await sleep(20);
  assert.equal($("#draft-banner").hidden, true);
});

/* --------------------------- settings auto-save --------------------------- */

test("settings: auto-save shortly after a change is detected, plus immediate flush on tab switch", async () => {
  $(".app-tab[data-view='settings']").click();
  assert.equal($("#view-settings").hidden, false);
  assert.equal($("#set-company-name").value, "");

  setInput($("#set-company-name"), "Golden Chip Trading Co.");
  assert.equal(app.DB.getSettings().company_name, "", "not saved before the debounce fires");

  await sleep(700); // event-driven save (400ms debounce) — no polling tick needed
  assert.equal(app.DB.getSettings().company_name, "Golden Chip Trading Co.", "auto-saved after the change");
  assert.ok($("#footer-autosave").textContent.includes("Autosaved"), `indicator was: ${$("#footer-autosave").textContent}`);

  setInput($("#set-company-tel"), "+852 1234 5678");
  $(".app-tab[data-view='list']").click(); // leaving flushes immediately
  await sleep(20);
  assert.equal(app.DB.getSettings().company_tel, "+852 1234 5678", "flushed when leaving Settings");
});

/* --------------------------- draft recovery --------------------------- */

test("draft: auto-saved while editing, banner + restore after leaving", async () => {
  $("#btn-new").click();
  setInput($("#ed-bill-company"), "Draft Test Co.");
  setInput($("#ed-po"), "PO-999");

  await sleep(700); // event-driven save (400ms debounce) stores the editor draft
  const draftRaw = app.window.localStorage.getItem("cim_editor_draft");
  assert.ok(draftRaw && draftRaw.includes("Draft Test Co."), "draft written to storage");

  $("#btn-back").click(); // dirty -> asks to leave
  await sleep(20);
  assert.equal($("#modal-confirm").hidden, false, "leave confirmation shown");
  $("#confirm-ok").click(); // "Leave"
  await sleep(20);
  assert.equal($("#view-list").hidden, false);
  assert.equal($("#draft-banner").hidden, false, "draft banner offered on the list");
  assert.ok($("#draft-time").textContent.length > 0);

  $("#btn-draft-restore").click();
  await sleep(20);
  assert.equal($("#view-edit").hidden, false);
  assert.equal($("#ed-bill-company").value, "Draft Test Co.", "buyer restored");
  assert.equal($("#ed-po").value, "PO-999", "PO restored");
  // The banner intentionally remains: the draft is still pending in storage
  // until the invoice is saved (Save clears it — covered by the dirty test).
  assert.equal($("#draft-banner").hidden, false);
});

/* --------------------------- print preview --------------------------- */

test("print preview: opens from the list, zooms, prints, closes on Esc", async () => {
  $("#btn-back").click(); // restored draft is a clean baseline -> no confirm
  await sleep(20);
  assert.equal($("#view-list").hidden, false);

  $("#invoice-tbody [data-action='print']").click();
  await sleep(20);
  assert.equal($("#preview-overlay").hidden, false, "preview opens");
  assert.equal(app.document.activeElement, $("#btn-preview-close"), "focus moves to the Close button");
  assert.ok($("#preview-name").textContent.includes("PI-"));
  assert.ok($("#preview-doc").innerHTML.includes("MCU 32-bit ARM"), "preview shows line items");
  assert.ok($("#preview-doc").innerHTML.includes("Golden Chip Trading Co."), "preview shows seller from settings");

  const labelBefore = $("#preview-zoom-label").textContent;
  $("#btn-zoom-in").click();
  assert.notEqual($("#preview-zoom-label").textContent, labelBefore, "zoom label updates");

  const printsBefore = app.printCalls();
  $("#btn-preview-print").click();
  await sleep(100);
  assert.equal(app.printCalls(), printsBefore + 1, "window.print called from the preview");
  assert.ok($("#print-area").innerHTML.includes("PROFORMA INVOICE"), "print document populated");

  app.document.dispatchEvent(new app.window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal($("#preview-overlay").hidden, true, "Esc closes the preview");
});

/* --------------------------- print --------------------------- */

test("Print: flushes the pending save, prints, and returns to the list", async () => {
  $("#btn-new").click();
  setInput($("#ed-bill-company"), "Print Test Co.");
  const row = $("#items-tbody tr");
  setInput($(".it-desc", row), "Resistor array");
  setInput($(".it-qty", row), "100");
  setInput($(".it-price", row), "0.1");

  const printsBefore = app.printCalls();
  $("#btn-print").click(); // no wait first: Print itself must flush the pending auto-save
  await sleep(250); // doPrint fires after a 60ms timeout
  assert.equal(app.printCalls(), printsBefore + 1, "printed");
  assert.equal($("#view-list").hidden, false, "returned to the list");
  assert.equal($$("#invoice-tbody tr").length, 2, "second invoice saved");
  assert.equal(app.DB.stats().invoices, 2);
});

/* --------------------------- storage failures --------------------------- */

test("an auto-save whose localStorage persist fails surfaces a warning toast (regression)", async () => {
  const alertToasts = () => $$("#toasts .app-toast.alert");
  const ls = app.window.localStorage; // isolated stub with a .fail switch (see helpers)

  ls.fail = true; // simulate QuotaExceededError
  $("#btn-new").click();
  setInput($("#ed-bill-company"), "Quota Test Co.");
  const row = $("#items-tbody tr");
  setInput($(".it-desc", row), "Part");
  setInput($(".it-qty", row), "1");
  setInput($(".it-price", row), "2");
  await sleep(700); // debounced auto-save: DB write ok, localStorage persist fails

  assert.equal(app.DB.stats().invoices, 3, "invoice saved in the in-memory DB");
  assert.ok(alertToasts().length >= 1, "a storage-failure alert toast must appear");
  assert.ok(alertToasts()[0].textContent.includes("Export DB"),
    `toast was: ${alertToasts()[0].textContent}`);

  // Storage recovers -> the watchdog retry re-persists the pending DB bytes.
  const stale = ls.getItem("cim_sqlite_b64");
  ls.fail = false;
  await app.fireAutosaveTick();
  assert.equal(app.DB.persistOk, true, "watchdog retry re-persisted the database");
  assert.notEqual(ls.getItem("cim_sqlite_b64"), stale, "DB bytes written back to storage");

  // And the alert is re-armed: a second failing auto-save warns again, not silently.
  const alertsBefore = alertToasts().length;
  ls.fail = true;
  setInput($("#ed-bill-company"), "Quota Test Co. 2");
  await sleep(700); // the edit triggers another auto-save whose persist fails
  assert.ok(alertToasts().length > alertsBefore, "a second failure warns again after recovery");
  assert.equal(app.DB.listInvoices()[0].buyer_company, "Quota Test Co. 2",
    "the edit was auto-saved despite the persist failure");

  ls.fail = false; // leave storage healthy
  await app.fireAutosaveTick(); // settle any pending write
});

/* --------------------- list actions: status, buyers, PI->CI --------------------- */

test("status quick-toggle: changing the pill updates the DB in place", async () => {
  const firstRow = $("#invoice-tbody tr"); // newest first
  const sel = $("select[data-action='status']", firstRow);
  assert.equal(sel.value, "Draft");
  assert.ok(sel.className.includes("st-draft"));

  setInput(sel, "Paid", "change");
  await sleep(20);
  const id = parseInt(firstRow.dataset.id, 10);
  assert.equal(app.DB.getInvoice(id).status, "Paid");
  assert.ok(sel.className.includes("st-paid"), `pill class was: ${sel.className}`);
  assert.ok($$("#toasts .app-toast").some((t) => t.textContent.includes("marked Paid")));
  // updated in place — the row must not jump (no re-sort mid-list)
  assert.equal($$("#invoice-tbody tr")[0], firstRow);
});

test("previous-buyer picker: fills the whole Bill To block from an earlier invoice", async () => {
  // Save one invoice with full buyer details to create a repeat buyer.
  $("#btn-new").click();
  setInput($("#ed-bill-company"), "Repeat Buyer Co.");
  setInput($("#ed-bill-attn"), "Ms. Lee");
  setInput($("#ed-bill-address"), "1 Tai Po Industrial Estate");
  setInput($("#ed-bill-tel"), "+852 2765 4321");
  setInput($("#ed-bill-email"), "lee@repeatbuyer.hk");
  const row = $("#items-tbody tr");
  setInput($(".it-desc", row), "Electrolytic capacitor");
  setInput($(".it-qty", row), "500");
  setInput($(".it-price", row), "0.05");
  await sleep(700); // debounced auto-save persists the invoice — no Save button
  assert.equal(app.DB.stats().invoices, 4);

  // A fresh editor offers that buyer in the picker.
  $("#btn-new").click();
  assert.equal($("#ed-bill-company").value, "");
  const pick = $("#ed-buyer-pick");
  assert.ok([...pick.options].some((o) => o.value === "Repeat Buyer Co."),
    "saved buyer should be offered in the picker");

  setInput(pick, "Repeat Buyer Co.", "change");
  await sleep(400); // dirty check is debounced at 250ms
  assert.equal($("#ed-bill-company").value, "Repeat Buyer Co.");
  assert.equal($("#ed-bill-attn").value, "Ms. Lee");
  assert.equal($("#ed-bill-address").value, "1 Tai Po Industrial Estate");
  assert.equal($("#ed-bill-tel").value, "+852 2765 4321");
  assert.equal($("#ed-bill-email").value, "lee@repeatbuyer.hk");
  assert.equal(pick.value, "", "picker resets to the placeholder");
  // No line item yet -> the invoice cannot auto-save; the subtitle must say why
  assert.ok($("#editor-subtitle").textContent.includes("line item"),
    `incomplete invoice should explain itself, subtitle was: ${$("#editor-subtitle").textContent}`);
});

test("Create CI from PI: one click opens a Draft CI that references the PI", async () => {
  $("#btn-back").click(); // dirty from the picker test -> confirm leaving
  await sleep(20);
  assert.equal($("#modal-confirm").hidden, false);
  $("#confirm-ok").click(); // "Leave"
  await sleep(20);
  $("#btn-draft-discard").click(); // drop the leftover picker draft
  await sleep(10);

  const firstRow = $("#invoice-tbody tr"); // newest = the Repeat Buyer PI
  const srcNo = $(".c-no strong", firstRow).textContent;
  const before = app.DB.stats().invoices;
  const btn = $("[data-action='make-ci']", firstRow);
  assert.ok(btn, "PI rows should offer 'Create CI'");
  btn.click();
  await sleep(30);

  assert.equal($("#view-edit").hidden, false, "editor opens with the new CI");
  assert.ok($("#ed-type-ci").checked);
  assert.equal($("#ed-related").value, srcNo, "Related Proforma No. pre-filled");
  assert.ok($("#ed-no").value.startsWith(`CI-${todayYYMMDD()}-1`), `CI number was: ${$("#ed-no").value}`);
  assert.equal($("#ed-status").value, "Draft");
  assert.equal($(".panel[data-show-for='CI']").hidden, false, "Shipment Particulars visible");
  assert.equal($(".it-desc", $("#items-tbody tr")).value, "Electrolytic capacitor", "line items copied");
  assert.equal(app.DB.stats().invoices, before + 1);
});

/* --------------------------- modal accessibility --------------------------- */

test("confirm dialog: focus starts on Cancel, Tab wraps, Escape cancels", async () => {
  $("#btn-back").click(); // the fresh CI is a clean baseline -> straight to the list
  await sleep(20);
  assert.equal($("#view-list").hidden, false);

  const rowsBefore = $$("#invoice-tbody tr").length;
  $("#invoice-tbody [data-action='delete']").click();
  await sleep(20);
  assert.equal($("#modal-confirm").hidden, false);
  assert.equal(app.document.activeElement, $("#confirm-cancel"),
    "focus should start on the safe (Cancel) button");

  // Tab from the last control wraps back to the first
  $("#confirm-ok").focus();
  app.document.dispatchEvent(new app.window.KeyboardEvent("keydown", { key: "Tab" }));
  assert.equal(app.document.activeElement, $("#confirm-cancel"), "Tab wraps back to Cancel");

  // Shift+Tab from the first control wraps to the last
  app.document.dispatchEvent(new app.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true }));
  assert.equal(app.document.activeElement, $("#confirm-ok"), "Shift+Tab wraps to Confirm");

  // Escape cancels: dialog closes, nothing is deleted, focus is released
  app.document.dispatchEvent(new app.window.KeyboardEvent("keydown", { key: "Escape" }));
  await sleep(20);
  assert.equal($("#modal-confirm").hidden, true);
  assert.equal($$("#invoice-tbody tr").length, rowsBefore, "Escape cancels the delete");
  assert.notEqual(app.document.activeElement, $("#confirm-ok"), "focus is released from the dialog");
});

/* --------------------------- company chop --------------------------- */

test("company chop: upload in Settings, survives form auto-save, stamped on print, removable", async () => {
  $(".app-tab[data-view='settings']").click();
  await sleep(20);
  assert.equal($("#view-settings").hidden, false);
  assert.ok($("#chop-preview").textContent.includes("No chop uploaded"), "starts empty");
  assert.equal($("#btn-chop-remove").hidden, true);

  const pickFile = (file) => {
    const input = $("#chop-file");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new app.window.Event("change", { bubbles: true }));
  };

  // Rejected: not a PNG/SVG
  pickFile(new app.window.File([new Uint8Array([1, 2, 3])], "chop.jpg", { type: "image/jpeg" }));
  await sleep(50);
  assert.equal(app.DB.getSettings().company_chop, "", "non-PNG/SVG is rejected");
  assert.ok($$("#toasts .app-toast.alert").some((t) => t.textContent.includes("PNG or SVG")));

  // Rejected: too large
  pickFile(new app.window.File([new Uint8Array(600 * 1024)], "big.png", { type: "image/png" }));
  await sleep(50);
  assert.equal(app.DB.getSettings().company_chop, "", "oversized chop is rejected");

  // Accepted: a small PNG (real magic bytes; FileReader is async)
  pickFile(new app.window.File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "chop.png", { type: "image/png" }));
  await sleep(100);
  assert.ok(app.DB.getSettings().company_chop.startsWith("data:image/png;base64"), "stored as a data URL");
  assert.ok($("#chop-preview img"), "preview shows the chop");
  assert.equal($("#btn-chop-remove").hidden, false);

  // A settings form auto-save afterwards must NOT wipe the chop
  setInput($("#set-company-tel"), "+852 9999 8888");
  await sleep(700); // event-driven settings auto-save (400ms debounce)
  assert.equal(app.DB.getSettings().company_tel, "+852 9999 8888", "form field saved");
  assert.ok(app.DB.getSettings().company_chop.startsWith("data:image/png;base64"), "chop survives the form save");

  // The chop is stamped on the printed/previewed document
  $(".app-tab[data-view='list']").click();
  await sleep(20);
  $("#invoice-tbody [data-action='print']").click();
  await sleep(20);
  assert.ok($("#preview-doc .sign-box .chop"), "chop stamped on the signature area");
  app.document.dispatchEvent(new app.window.KeyboardEvent("keydown", { key: "Escape" }));
  await sleep(10);

  // Remove works
  $(".app-tab[data-view='settings']").click();
  await sleep(10);
  $("#btn-chop-remove").click();
  await sleep(10);
  assert.equal(app.DB.getSettings().company_chop, "");
  assert.ok(!$("#chop-preview img"));
  assert.equal($("#btn-chop-remove").hidden, true);
});
