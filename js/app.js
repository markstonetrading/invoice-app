"use strict";

/* global DB */

/**
 * Component Invoice Manager — UI layer.
 * Vanilla JS on top of Foundation CSS. Views: list / edit / settings,
 * plus a hidden print document rendered as an A4 invoice for window.print().
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const CCY_NAMES = {
  USD: "US Dollars", HKD: "Hong Kong Dollars", CNY: "Renminbi", EUR: "Euros",
  GBP: "Pounds Sterling", JPY: "Japanese Yen", SGD: "Singapore Dollars",
  TWD: "New Taiwan Dollars", KRW: "Korean Won", AUD: "Australian Dollars",
};

const STATUSES = ["Draft", "Issued", "Paid", "Cancelled"];

let invoicesCache = [];
let currentView = "list";
let editingId = null;      // null = creating a new invoice
let numberTouched = false; // user manually edited the invoice number

/* Auto-save state */
const DRAFT_KEY = "cim_editor_draft";
const AUTOSAVE_DEBOUNCE_MS = 400;   // save shortly after a change is detected
const AUTOSAVE_WATCHDOG_MS = 30000; // safety net: retries saves events can't see
let lastDraftJson = null;  // last form snapshot written as a draft
let lastSavedJson = null;  // form snapshot as last saved to the database (dirty check)
let dirtyTimer = null;
let autosaveTimer = null;
let lastSettingsJson = null; // settings form snapshot at last save (auto-save check)

/* ============================ helpers ============================ */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
const nl2br = (s) => esc(s).replace(/\r\n|\n|\r/g, "<br>");

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function todayISO() {
  // Local calendar date, NOT toISOString() (which is UTC): before 08:00 in
  // UTC+8 the UTC date is still "yesterday", which used to give new invoices
  // the wrong default date — and a PREFIX-YYMMDD-# number for the wrong day.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtMoney(n, ccy) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: ccy || "USD", currencyDisplay: "code" })
      .format(num(n));
  } catch {
    return `${ccy || ""} ${num(n).toFixed(2)}`.trim();
  }
}

function fmtPlain2(n) {
  return num(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtQty(n) {
  const v = num(n);
  return v.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function fmtUnitPrice(n) {
  const v = num(n);
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");

/* -------- amount in words -------- */
const ONES = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function intToWords(n) {
  n = Math.floor(Math.abs(n));
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
  if (n < 1000) return ONES[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + intToWords(n % 100) : "");
  if (n < 1e6) return intToWords(Math.floor(n / 1000)) + " Thousand" + (n % 1000 ? " " + intToWords(n % 1000) : "");
  if (n < 1e9) return intToWords(Math.floor(n / 1e6)) + " Million" + (n % 1e6 ? " " + intToWords(n % 1e6) : "");
  return intToWords(Math.floor(n / 1e9)) + " Billion" + (n % 1e9 ? " " + intToWords(n % 1e9) : "");
}

function amountInWords(total, ccy) {
  const unit = CCY_NAMES[ccy] || ccy || "";
  // Round to the printed precision (2dp) BEFORE splitting, so the words
  // always match the numeric total — 9.999 prints as "10.00" and must read
  // "Ten", never "Nine … and Cents One Hundred".
  let cents = Math.round(num(total) * 100);
  const sign = cents < 0 ? "Minus " : "";
  cents = Math.abs(cents);
  const ints = Math.floor(cents / 100);
  const rem = cents % 100;
  let s = `${sign}${unit} ${intToWords(ints)}`;
  if (rem > 0) s += ` and Cents ${intToWords(rem)}`;
  return s + " Only";
}

/* ============================ toast & modal ============================ */

/* -------- modal focus handling (shared by the confirm dialog & preview) -------- */

let trappedRoot = null;   // element confining focus while a modal is open
let focusReturnEl = null; // element focus should return to when the modal closes

/** Open a modal: confine Tab to `root`, move focus to `initialFocus`, remember where to return. */
function trapFocus(root, initialFocus) {
  focusReturnEl = document.activeElement;
  trappedRoot = root;
  if (initialFocus) initialFocus.focus();
}

/** Close a modal: stop confining focus and restore it to where it was before. */
function releaseFocus() {
  trappedRoot = null;
  const el = focusReturnEl;
  focusReturnEl = null;
  if (el && el.isConnected) el.focus();
}

/** Keep Tab (and Shift+Tab) cycling inside the open modal; pull stray focus back in. */
function focusTrapKeydown(e) {
  if (e.key !== "Tab" || !trappedRoot) return;
  const focusables = $$("button, select, input, textarea, a[href]", trappedRoot).filter((el) => !el.disabled);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!trappedRoot.contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function toast(msg, type = "success") {
  const icons = { success: "fa-circle-check", alert: "fa-triangle-exclamation", info: "fa-circle-info" };
  const box = document.createElement("div");
  box.className = `app-toast ${type}`;
  box.innerHTML = `<i class="fa-solid ${icons[type] || icons.info}"></i><span>${esc(msg)}</span>`;
  $("#toasts").appendChild(box);
  requestAnimationFrame(() => box.classList.add("show"));
  setTimeout(() => {
    box.classList.remove("show");
    setTimeout(() => box.remove(), 300);
  }, 3400);
}

function confirmDialog(message, { title = "Please Confirm", okLabel = "Confirm", okClass = "btn-danger" } = {}) {
  return new Promise((resolve) => {
    const overlay = $("#modal-confirm");
    const ok = $("#confirm-ok");
    const cancel = $("#confirm-cancel");
    $("#confirm-title").textContent = title;
    $("#confirm-msg").textContent = message;
    ok.textContent = okLabel;
    ok.className = `btn ${okClass}`;
    overlay.hidden = false;
    trapFocus(overlay, cancel); // start on the safe choice; focus returns on close

    const done = (val) => {
      overlay.hidden = true;
      ok.onclick = null; cancel.onclick = null; overlay.onclick = null;
      document.removeEventListener("keydown", onKey);
      releaseFocus();
      resolve(val);
    };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    overlay.onclick = (e) => { if (e.target === overlay) done(false); };
    document.addEventListener("keydown", onKey);
  });
}

/* ============================ views ============================ */

function showView(name) {
  // Leaving Settings: flush any pending settings auto-save first
  if (currentView === "settings" && name !== "settings") saveSettingsIfChanged();
  currentView = name;
  ["list", "edit", "settings"].forEach((v) => { $(`#view-${v}`).hidden = v !== name; });
  $$(".app-tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  if (name === "list") renderList();
  if (name === "settings") loadSettingsView();
  window.scrollTo(0, 0);
}

/**
 * Leave the editor for another view. Unsaved edits ask for confirmation
 * first — the same guard the Back button uses, so the nav tabs (and the
 * "Edit company profile" shortcut) cannot bypass it. Pending auto-saves are
 * flushed beforehand so the "kept as a draft" promise is true immediately.
 */
async function leaveEditorTo(view) {
  if (currentView === "edit") {
    clearTimeout(autosaveTimer);
    autosaveTick(); // flush the restorable draft before asking to leave
    if (isDirty()) {
      const ok = await confirmDialog(
        "This invoice is incomplete, so it is not saved yet. Leave the editor? Your edits are kept as a draft you can restore from the invoice list.",
        { title: "Unsaved Changes", okLabel: "Leave" }
      );
      if (!ok) return;
    }
  }
  showView(view);
}

/* ============================ invoice list ============================ */

function renderList() {
  invoicesCache = DB.listInvoices();
  refreshDatalists();
  updateFooter();
  showDraftBanner();
  const badge = $("#tab-count");
  badge.textContent = invoicesCache.length;
  badge.hidden = invoicesCache.length === 0;
  applyFilters();
}

function applyFilters() {
  const q = $("#inv-search").value.trim().toLowerCase();
  const type = $("#inv-filter-type").value;
  const status = $("#inv-filter-status").value;

  const filtered = invoicesCache.filter((r) => {
    if (type !== "All" && r.type !== type) return false;
    if (status !== "All" && (r.status || "Draft") !== status) return false;
    if (q) {
      const hay = `${r.invoice_no} ${r.buyer_company} ${r.customer_po} ${r.currency}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  $("#invoice-tbody").innerHTML = filtered.map(rowHTML).join("");
  $("#list-empty").hidden = filtered.length > 0;
  $("#list-summary").textContent = `${filtered.length} of ${invoicesCache.length} invoices`;

  const hasFilters = Boolean(q) || type !== "All" || status !== "All";
  $("#btn-clear-filters").hidden = !hasFilters;
}

function rowHTML(inv) {
  const st = inv.status || "Draft";
  return `<tr data-id="${inv.id}" class="row-click">
    <td class="c-no">
      <div class="no-cell"><span class="badge type-${esc(inv.type)}">${esc(inv.type)}</span><strong>${esc(inv.invoice_no)}</strong></div>
      ${inv.customer_po ? `<div class="muted" style="font-size:12px">PO: ${esc(inv.customer_po)}</div>` : ""}
    </td>
    <td class="c-date nowrap">${esc(fmtDate(inv.invoice_date))}</td>
    <td class="c-cust">${esc(inv.buyer_company || "—")}</td>
    <td class="c-total text-right nowrap">${esc(fmtMoney(inv.total, inv.currency))}</td>
    <td class="c-status">
      <select class="st-badge st-${slug(st)}" data-action="status" aria-label="Change status of ${esc(inv.invoice_no)}">
        ${STATUSES.map((s) => `<option${s === st ? " selected" : ""}>${s}</option>`).join("")}
      </select>
    </td>
    <td class="c-act" style="text-align:right">
      <button type="button" class="icon-btn" data-action="edit" title="Edit"><i class="fa-solid fa-pen"></i></button>
      <button type="button" class="icon-btn" data-action="duplicate" title="Duplicate"><i class="fa-regular fa-clone"></i></button>
      ${inv.type === "PI" ? `<button type="button" class="icon-btn" data-action="make-ci" title="Create Commercial Invoice from this PI"><i class="fa-solid fa-arrow-right-long"></i></button>` : ""}
      <button type="button" class="icon-btn" data-action="print" title="Preview / Save as PDF"><i class="fa-solid fa-print"></i></button>
      <button type="button" class="icon-btn danger" data-action="delete" title="Delete"><i class="fa-regular fa-trash-can"></i></button>
    </td>
  </tr>`;
}

/* ============================ editor ============================ */

const blankItem = () => ({
  description: "", qty: "", unit_price: "",
});

function openEditor(id) {
  editingId = id || null;
  numberTouched = false;
  const inv = id ? DB.getInvoice(id) : null;
  if (id && !inv) { toast("Invoice not found", "alert"); return; }
  fillEditor(inv, DB.getSettings());
  showView("edit");
  resetDraftBaseline();
  resetSavedBaseline();
}

function fillEditor(inv, settings) {
  const type = inv ? inv.type : "PI";
  $("#ed-type-pi").checked = type === "PI";
  $("#ed-type-ci").checked = type === "CI";
  $("#ed-no").value = inv ? inv.invoice_no : DB.nextInvoiceNo(type, todayISO());
  $("#ed-date").value = (inv && inv.invoice_date) || todayISO();
  $("#ed-status").value = (inv && inv.status) || "Draft";
  $("#ed-currency").value = (inv && inv.currency) || settings.default_currency || "USD";
  $("#ed-po").value = inv?.customer_po || "";
  $("#ed-related").value = inv?.related_invoice_no || "";
  $("#ed-validity").value = inv?.validity || "";
  $("#ed-bill-company").value = inv?.buyer_company || "";
  $("#ed-bill-attn").value = inv?.buyer_attn || "";
  $("#ed-bill-address").value = inv?.buyer_address || "";
  $("#ed-bill-tel").value = inv?.buyer_tel || "";
  $("#ed-bill-email").value = inv?.buyer_email || "";
  $("#ed-ship-same").checked = inv ? !!inv.ship_same_as_bill : true;
  $("#ed-ship-company").value = inv?.ship_company || "";
  $("#ed-ship-address").value = inv?.ship_address || "";
  $("#ed-payment-terms").value = inv?.payment_terms || "";
  $("#ed-gross").value = inv?.gross_weight || "";
  $("#ed-net").value = inv?.net_weight || "";
  $("#ed-cartons").value = inv?.cartons || "";
  $("#ed-marks").value = inv?.shipping_marks || "";
  $("#ed-freight").value = inv ? num(inv.freight) : 0;
  $("#ed-remarks").value = inv?.remarks || "";

  renderItems(inv && inv.items.length ? inv.items : [blankItem()]);
  renderSellerPreview();
  toggleShipBlock();
  updateTypeVisibility(type);
  updateEditorTitle();
  recalcTotals();
}

function updateEditorTitle() {
  if (editingId) {
    $("#editor-title").textContent = `Edit Invoice — ${$("#ed-no").value || "…"}`;
  } else {
    const type = $("input[name='ed-type']:checked").value;
    $("#editor-title").textContent = `New ${type === "PI" ? "Proforma" : "Commercial"} Invoice`;
  }
}

function updateTypeVisibility(type) {
  $$("[data-show-for]").forEach((el) => { el.hidden = el.dataset.showFor !== type; });
}

function toggleShipBlock() {
  const same = $("#ed-ship-same").checked;
  $("#ed-ship-company").disabled = same;
  $("#ed-ship-address").disabled = same;
  $("#ship-block").classList.toggle("dimmed", same);
}

function renderSellerPreview() {
  const s = DB.getSettings();
  const box = $("#ed-seller");
  if (s.company_name || s.company_address) {
    box.innerHTML = `
      <div class="pp-name">${esc(s.company_name || "—")}</div>
      ${s.company_address ? `<div class="pp-line">${nl2br(s.company_address)}</div>` : ""}
      ${s.company_tel ? `<div class="pp-line">Tel: ${esc(s.company_tel)}</div>` : ""}
      ${s.company_email ? `<div class="pp-line">${esc(s.company_email)}${s.company_website ? " · " + esc(s.company_website) : ""}</div>` : (s.company_website ? `<div class="pp-line">${esc(s.company_website)}</div>` : "")}
      ${s.company_br ? `<div class="pp-line">BR No.: ${esc(s.company_br)}</div>` : ""}`;
  } else {
    box.innerHTML = `<div class="pp-hint">No company profile yet — click below to add your company details, bank information will also be printed on invoices.</div>`;
  }
}

function itemRowHTML(it, idx) {
  return `<tr>
    <td class="c-idx">${idx + 1}</td>
    <td class="f-desc" data-label="Description"><textarea class="it-desc form-control" rows="2" placeholder="Item description (line breaks are kept on the printed invoice)">${esc(it.description)}</textarea></td>
    <td class="f-qty" data-label="Qty"><input type="number" class="it-qty form-control" min="0" step="any" value="${esc(it.qty === 0 ? "" : it.qty)}" placeholder="0"></td>
    <td class="f-price" data-label="Unit Price"><input type="number" class="it-price form-control" min="0" step="any" value="${esc(it.unit_price === 0 ? "" : it.unit_price)}" placeholder="0.00"></td>
    <td class="it-amount f-amount" data-label="Amount">—</td>
    <td class="f-del"><button type="button" class="icon-btn danger it-del" title="Remove line"><i class="fa-solid fa-xmark"></i></button></td>
  </tr>`;
}

/* Auto-grow the description textareas to fit their content (min one line). */
function autoGrowItem(el) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
}

function autoGrowAllItems() {
  $$("#items-tbody .it-desc").forEach(autoGrowItem);
}

function renderItems(items) {
  $("#items-tbody").innerHTML = items.map((it, i) => itemRowHTML(it, i)).join("");
  autoGrowAllItems();
}

function renumberItems() {
  $$("#items-tbody tr").forEach((tr, i) => {
    $(".c-idx", tr).textContent = i + 1;
  });
}

function recalcTotals() {
  const ccy = $("#ed-currency").value;
  let subtotal = 0;
  $$("#items-tbody tr").forEach((tr) => {
    const qty = num($(".it-qty", tr).value);
    const price = num($(".it-price", tr).value);
    const amt = qty * price;
    subtotal += amt;
    $(".it-amount", tr).textContent = fmtMoney(amt, ccy);
  });
  const freight = num($("#ed-freight").value);
  $("#t-subtotal").textContent = fmtMoney(subtotal, ccy);
  $("#t-total").textContent = fmtMoney(subtotal + freight, ccy);
}

function collectInvoice() {
  const type = $("input[name='ed-type']:checked").value;
  const shipSame = $("#ed-ship-same").checked;
  const items = $$("#items-tbody tr").map((tr, i) => ({
    sort_order: i,
    description: $(".it-desc", tr).value.trim(),
    qty: num($(".it-qty", tr).value),
    unit_price: num($(".it-price", tr).value),
  })).filter((it) => it.description);

  return {
    id: editingId,
    invoice_no: $("#ed-no").value.trim(),
    type,
    invoice_date: $("#ed-date").value || todayISO(),
    status: $("#ed-status").value,
    currency: $("#ed-currency").value,
    customer_po: $("#ed-po").value.trim(),
    related_invoice_no: $("#ed-related").value.trim(),
    buyer_company: $("#ed-bill-company").value.trim(),
    buyer_attn: $("#ed-bill-attn").value.trim(),
    buyer_address: $("#ed-bill-address").value.trim(),
    buyer_tel: $("#ed-bill-tel").value.trim(),
    buyer_email: $("#ed-bill-email").value.trim(),
    ship_same_as_bill: shipSame ? 1 : 0,
    ship_company: shipSame ? "" : $("#ed-ship-company").value.trim(),
    ship_address: shipSame ? "" : $("#ed-ship-address").value.trim(),
    payment_terms: $("#ed-payment-terms").value.trim(),
    validity: $("#ed-validity").value.trim(),
    gross_weight: $("#ed-gross").value.trim(),
    net_weight: $("#ed-net").value.trim(),
    cartons: $("#ed-cartons").value.trim(),
    shipping_marks: $("#ed-marks").value.trim(),
    freight: num($("#ed-freight").value),
    remarks: $("#ed-remarks").value.trim(),
    items,
  };
}

/** Returns an error message when the invoice cannot be saved yet, else null. */
function validateInvoice(data) {
  if (!data.invoice_no) return "Invoice number is required.";
  if (!data.items.length) return "Add at least one line item (part no., manufacturer or description).";
  if (DB.findDuplicateNo(data.invoice_no, editingId)) {
    return `Invoice number "${data.invoice_no}" already exists.`;
  }
  return null;
}

/**
 * Write the editor form to the database (used by the automatic saves and the
 * Print button — there is no Save button anymore).
 */
function autoSaveInvoice(data) {
  editingId = DB.saveInvoice(data, data.items);
  clearDraft(); // the work is now saved in the database
  resetSavedBaseline();
  updateEditorTitle();
  refreshDatalists();
  updateFooter();
}

/** Print button: flush the pending save (if valid), print, return to the list. */
function doPrintFromEditor() {
  const data = collectInvoice();
  const err = validateInvoice(data);
  if (err) {
    toast(err, "alert");
    if (!data.invoice_no) $("#ed-no").focus();
    return;
  }
  if (!editingId || isDirty()) autoSaveInvoice(data);
  doPrint(editingId);
  showView("list");
}

function doDuplicate(id) {
  const res = DB.duplicateInvoice(id);
  if (!res) { toast("Invoice not found.", "alert"); return; }
  toast(`Duplicated as ${res.invoice_no} (Draft).`);
  updateFooter();
  if (currentView === "list") renderList();
}

/** One-click PI -> CI: creates the Draft CI and opens it for review. */
function doMakeCI(id) {
  const res = DB.convertToCI(id, todayISO());
  if (!res) { toast("Only a Proforma invoice can be turned into a Commercial one.", "alert"); return; }
  toast(`Commercial invoice ${res.invoice_no} created from the PI — review the shipment details and save.`, "info");
  updateFooter();
  refreshDatalists();
  openEditor(res.id);
}

/** Status quick-toggle from the list: update in place, don't re-sort the rows. */
function handleStatusChange(sel) {
  const tr = sel.closest("tr[data-id]");
  const id = parseInt(tr.dataset.id, 10);
  const status = sel.value;
  DB.setInvoiceStatus(id, status);
  const inv = invoicesCache.find((r) => r.id === id);
  if (inv) inv.status = status;
  sel.className = `st-badge st-${slug(status)}`; // recolour the pill in place
  toast(`Invoice ${inv ? inv.invoice_no : ""} marked ${status}.`);
  // No re-render: the list is sorted by updated_at, so re-rendering would
  // make the row jump to the top mid-review.
}

async function doDelete(id) {
  const inv = invoicesCache.find((r) => r.id === id) || DB.getInvoice(id);
  const no = inv ? inv.invoice_no : "";
  const ok = await confirmDialog(`Delete invoice ${no} and all of its line items? This cannot be undone.`, {
    title: "Delete Invoice", okLabel: "Delete",
  });
  if (!ok) return;
  DB.deleteInvoice(id);
  toast(`Invoice ${no} deleted.`);
  renderList();
}

/* ============================ print / PDF ============================ */

function doPrint(id) {
  const inv = DB.getInvoice(id);
  if (!inv) { toast("Invoice not found.", "alert"); return; }
  const s = DB.getSettings();
  $("#print-area").innerHTML = buildPrintDoc(inv, s);

  const prevTitle = document.title;
  document.title = `${inv.invoice_no} ${inv.type}`;
  const restore = () => { document.title = prevTitle; window.removeEventListener("afterprint", restore); };
  window.addEventListener("afterprint", restore);

  setTimeout(() => {
    window.print();
    setTimeout(restore, 800);
  }, 60);
}

/* ============================ print preview ============================ */

let previewHtml = null;
let previewZoom = 1;
let previewUserZoom = false; // true once the user zooms manually (disables auto re-fit)

/** Open the preview overlay. `inv` may come from the DB or from collectInvoice() (unsaved edits). */
function openPreview(inv, label) {
  if (!inv) return;
  previewHtml = buildPrintDoc(inv, DB.getSettings());
  $("#preview-doc").innerHTML = previewHtml;
  $("#preview-name").textContent = label || inv.invoice_no || "New Invoice";
  previewUserZoom = false;
  $("#preview-overlay").hidden = false;
  document.body.classList.add("preview-open");
  trapFocus($("#preview-overlay"), $("#btn-preview-close")); // keyboard users land on Close
  fitPreview();
}

function closePreview() {
  $("#preview-overlay").hidden = true;
  document.body.classList.remove("preview-open");
  previewHtml = null;
  releaseFocus(); // put focus back where it was before the preview opened
}

/** Scale the A4 paper to fit the available width (max 100%). */
function fitPreview() {
  const paper = $("#preview-paper");
  paper.style.zoom = "";
  const avail = $("#preview-scroll").clientWidth - 48;
  const natural = paper.offsetWidth || 794; // 210mm ≈ 794px
  previewZoom = Math.min(1, avail / natural);
  applyPreviewZoom();
}

function applyPreviewZoom() {
  previewZoom = Math.min(2, Math.max(0.3, previewZoom));
  $("#preview-paper").style.zoom = previewZoom;
  $("#preview-zoom-label").textContent = `${Math.round(previewZoom * 100)}%`;
}

function zoomPreviewBy(factor) {
  previewUserZoom = true;
  previewZoom *= factor;
  applyPreviewZoom();
}

/** Print the document currently shown in the preview. */
function printFromPreview() {
  if (!previewHtml) return;
  $("#print-area").innerHTML = previewHtml;
  const no = $("#preview-name").textContent;
  const prevTitle = document.title;
  document.title = no;
  const restore = () => { document.title = prevTitle; window.removeEventListener("afterprint", restore); };
  window.addEventListener("afterprint", restore);
  window.print();
  setTimeout(restore, 800);
}

function partyBody(inv) {
  const lines = [
    inv.buyer_attn ? `Attn: ${inv.buyer_attn}` : "",
    inv.buyer_address || "",
    inv.buyer_tel ? `Tel: ${inv.buyer_tel}` : "",
    inv.buyer_email || "",
  ].filter(Boolean);
  return lines.map(esc).join("<br>");
}

function shipBody(inv) {
  if (inv.ship_same_as_bill) return partyBody(inv);
  const lines = [inv.ship_company || inv.buyer_company || "", inv.ship_address || ""].filter(Boolean);
  return lines.map(esc).join("<br>");
}

function metaRows(inv, isPI) {
  const rows = [
    ["Currency", inv.currency],
    ["Payment Terms", inv.payment_terms],
  ];
  if (isPI) {
    rows.push(["Validity", inv.validity]);
  } else {
    rows.push(["Related PI No.", inv.related_invoice_no]);
    rows.push(["Gross / Net Wt.", [inv.gross_weight, inv.net_weight].filter(Boolean).join(" / ")]);
    rows.push(["Cartons", inv.cartons]);
  }
  return rows.filter(([, v]) => v).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("");
}

function buildPrintDoc(inv, s) {
  const isPI = inv.type === "PI";
  const items = inv.items || [];
  const ccy = inv.currency || "USD";

  const subtotal = items.reduce((a, it) => a + num(it.qty) * num(it.unit_price), 0);
  const freight = num(inv.freight);
  const total = subtotal + freight;

  const itemRows = items.map((it, i) => `<tr>
      <td class="c">${i + 1}</td>
      <td>${nl2br(it.description || "—")}</td>
      <td class="r">${esc(fmtQty(it.qty))}</td>
      <td class="r">${esc(fmtUnitPrice(it.unit_price))}</td>
      <td class="r">${esc(fmtPlain2(num(it.qty) * num(it.unit_price)))}</td>
    </tr>`).join("");

  const chargeRow = (label, v) => (Math.abs(v) > 0.000001
    ? `<tr><td>${esc(label)}</td><td>${esc(fmtPlain2(v))}</td></tr>` : "");

  const sellerLines = [
    esc(s.company_name || ""),
    nl2br(s.company_address || ""),
    s.company_tel ? `Tel: ${esc(s.company_tel)}` : "",
    [s.company_email, s.company_website].filter(Boolean).map(esc).join("&nbsp;&nbsp;"),
    s.company_br ? `BR No.: ${esc(s.company_br)}` : "",
  ].filter(Boolean).join("<br>");

  const bankRows = [
    ["Bank Name", s.bank_name],
    ["Bank Code / Branch Code", s.bank_code],
    ["Bank Address", s.bank_address],
    ["Account Name", s.account_name],
    ["Account No.", s.account_no],
    ["SWIFT / BIC", s.swift_code],
  ].filter(([, v]) => v)
    .map(([k, v]) => `<tr><td class="k">${esc(k)}:</td><td>${nl2br(v)}</td></tr>`).join("");

  return `
  <div class="doc">
    <div class="doc-head">
      <div class="doc-seller">
        <div class="doc-company">${esc(s.company_name || "Your Company Ltd.")}</div>
        <div class="doc-pre">${sellerLines}</div>
      </div>
      <div class="doc-title-block">
        <div class="doc-title">${isPI ? "PROFORMA INVOICE" : "COMMERCIAL INVOICE"}</div>
        <table class="doc-meta">
          <tr><th>Invoice No.</th><td><strong>${esc(inv.invoice_no)}</strong></td></tr>
          <tr><th>Date</th><td>${esc(fmtDate(inv.invoice_date))}</td></tr>
          <tr><th>Customer PO</th><td>${esc(inv.customer_po || "—")}</td></tr>
          ${!isPI && inv.related_invoice_no ? `<tr><th>PI No.</th><td>${esc(inv.related_invoice_no)}</td></tr>` : ""}
        </table>
      </div>
    </div>

    <div class="doc-parties">
      <div class="doc-party">
        <h6>Bill To</h6>
        <div class="party-name">${esc(inv.buyer_company || "—")}</div>
        <div class="party-body">${partyBody(inv)}</div>
      </div>
      <div class="doc-party">
        <h6>Ship To</h6>
        <div class="party-body">${shipBody(inv)}</div>
      </div>
      <div class="doc-party">
        <h6>${isPI ? "Terms" : "Terms &amp; Shipment"}</h6>
        <table class="doc-meta">
          ${metaRows(inv, isPI)}
        </table>
      </div>
    </div>

    <table class="doc-items">
      <thead>
        <tr>
          <th class="c" style="width:5%">No.</th>
          <th>Description</th>
          <th class="r" style="width:10%">Qty</th>
          <th class="r" style="width:14%">Unit Price (${esc(ccy)})</th>
          <th class="r" style="width:15%">Amount (${esc(ccy)})</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>

    <div class="doc-totals-wrap">
      <div class="doc-words">
        <h6>Amount in Words</h6>
        ${esc(amountInWords(total, ccy))}
      </div>
      <div class="doc-totals">
        <table>
          <tr><td>Subtotal</td><td>${esc(fmtPlain2(subtotal))}</td></tr>
          ${chargeRow("Freight & Handling", freight)}
          <tr class="grand"><td>Total ${esc(ccy)}</td><td>${esc(fmtPlain2(total))}</td></tr>
        </table>
      </div>
    </div>

    ${bankRows ? `
    <div class="doc-bank">
      <h6>Beneficiary Bank Details</h6>
      <table>${bankRows}</table>
    </div>` : ""}

    ${inv.remarks ? `<div class="doc-remarks"><h6>Remarks</h6>${nl2br(inv.remarks)}</div>` : ""}

    ${!isPI ? `<div class="doc-declare">We hereby certify that the information contained in this invoice is true and correct.</div>` : ""}

    <div class="doc-sign">
      <div class="sign-box">
        <div>For and on behalf of</div>
        <div class="sign-company">${esc(s.company_name || "—")}</div>
        <div class="sign-line"></div>
        ${s.company_chop ? `<img class="chop" src="${esc(s.company_chop)}" alt="Company chop">` : ""}
      </div>
    </div>

    <div class="doc-foot">Thank you for your business. This invoice is generated by ${esc(s.company_name || "our company")}.</div>
  </div>`;
}

/* ============================ settings ============================ */

/**
 * Settings form field IDs, derived from the DB's known settings keys so the
 * form and the storage layer can never drift apart again (the bug where
 * `set-swift` mapped to key `swift` instead of `swift_code`).
 */
function settingsFields() {
  return Object.keys(DB.getSettings()).map((k) => `set-${k.replace(/_/g, "-")}`);
}

function loadSettingsView() {
  const s = DB.getSettings();
  settingsFields().forEach((id) => {
    const key = id.replace(/^set-/, "").replace(/-/g, "_");
    const el = $(`#${id}`);
    if (el) el.value = s[key] ?? "";
  });
  renderChopPreview();
  const st = DB.stats();
  $("#storage-info").textContent =
    `Currently stored: ${st.invoices} invoices and ${st.items} line items — database size ≈ ${st.sizeKB} KB.`;
  lastSettingsJson = JSON.stringify(collectSettingsForm());
}

/** Collect the settings form into a plain object keyed by settings keys. */
function collectSettingsForm() {
  const obj = {};
  settingsFields().forEach((id) => {
    const key = id.replace(/^set-/, "").replace(/-/g, "_");
    const el = $(`#${id}`);
    if (el) obj[key] = el.value.trim();
  });
  return obj;
}

/** Auto-save the settings form if it changed since the last save. Returns true if it saved. */
function saveSettingsIfChanged() {
  if (currentView !== "settings" || lastSettingsJson === null) return false;
  const obj = collectSettingsForm();
  const json = JSON.stringify(obj);
  if (json === lastSettingsJson) return false;
  DB.saveSettings(obj);
  lastSettingsJson = json;
  renderSellerPreview();
  updateFooter();
  refreshDatalists();
  return true;
}

/* -------- company chop (stamped on the printed signature area) -------- */

const MAX_CHOP_BYTES = 500 * 1024; // base64 (+33%) still fits the localStorage budget comfortably

const readFileAsDataURL = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

/** Show the stored chop (or the empty hint) in the Settings panel. */
function renderChopPreview() {
  const chop = DB.getSettings().company_chop;
  const box = $("#chop-preview");
  if (chop) {
    box.innerHTML = `<img src="${esc(chop)}" alt="Company chop preview">`;
    $("#btn-chop-remove").hidden = false;
  } else {
    box.innerHTML = `<span>No chop uploaded.</span>`;
    $("#btn-chop-remove").hidden = true;
  }
}

async function uploadChop(file) {
  const isPng = file.type === "image/png" || /\.png$/i.test(file.name);
  const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
  if (!isPng && !isSvg) {
    toast("Please choose a PNG or SVG file for the company chop.", "alert");
    return;
  }
  if (file.size > MAX_CHOP_BYTES) {
    toast(`Chop file is too large (${Math.round(file.size / 102.4) / 10} KB) — keep it under ${MAX_CHOP_BYTES / 1024} KB.`, "alert");
    return;
  }
  try {
    const dataUrl = await readFileAsDataURL(file);
    DB.saveSettings({ company_chop: dataUrl });
    renderChopPreview();
    toast("Company chop saved — it is stamped on the printed signature area.");
  } catch (err) {
    console.error(err);
    toast("Could not read the chop file.", "alert");
  }
}

async function clearAllData() {
  const ok = await confirmDialog(
    "This permanently deletes ALL invoices, line items and settings stored in this browser. Export a backup first if you need one!",
    { title: "Clear All Local Data", okLabel: "Delete Everything" }
  );
  if (!ok) return;
  DB.wipe();
  editingId = null;
  lastSettingsJson = null;
  clearDraft();
  toast("All local data cleared.");
  updateFooter();
  showView("list");
}

/* ============================ import / export ============================ */

function exportDB() {
  const bytes = DB.exportBytes();
  const blob = new Blob([bytes], { type: "application/x-sqlite3" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `component-invoices-${todayISO().replace(/-/g, "")}.db`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`SQLite database exported (${Math.round(bytes.length / 102.4) / 10} KB).`);
}

async function importDB(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = DB.inspectDatabase(bytes); // throws if invalid
    const ok = await confirmDialog(
      `Import "${file.name}"? This will REPLACE all current data with the file's content ` +
      `(${info.invoices} invoices, ${info.items} line items).`,
      { title: "Import Database", okLabel: "Replace Data" }
    );
    if (!ok) return;
    DB.importBytes(bytes);
    editingId = null;
    lastSettingsJson = null;
    clearDraft();
    toast(`Imported ${info.invoices} invoices and ${info.items} line items.`);
    updateFooter();
    refreshDatalists();
    showView("list");
  } catch (err) {
    console.error(err);
    toast(`Import failed: ${err.message || "not a valid SQLite database file"}`, "alert");
  }
}

/* ============================ dirty-state indicator ============================ */

/** True if the editor form differs from the last saved state. */
function isDirty() {
  return currentView === "edit" && JSON.stringify(collectInvoice()) !== lastSavedJson;
}

function updateDirtyState() {
  if (currentView !== "edit") return;
  const sub = $("#editor-subtitle");
  // "Pending" = not in the database yet (new invoice), or changes waiting for the next auto-save
  const pending = !editingId || isDirty();
  if (!pending) {
    sub.textContent = "All changes are saved automatically.";
    sub.classList.remove("text-warn");
    return;
  }
  const err = validateInvoice(collectInvoice());
  sub.textContent = err
    ? `Not saved yet — ${err}`
    : "Unsaved changes — they save automatically in a moment.";
  sub.classList.add("text-warn");
}

/** Debounced dirty check for form input events. */
function scheduleDirty() {
  clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(updateDirtyState, 250);
}

/** Baseline the form against the database state. */
function resetSavedBaseline() {
  lastSavedJson = currentView === "edit" ? JSON.stringify(collectInvoice()) : null;
  updateDirtyState();
}

/* ============================ auto-save (on detected change) ============================ */

/**
 * Saves whatever changed:
 *  1. The SQLite database — a watchdog that writes to localStorage whenever
 *     the DB bytes differ from the last snapshot (also retries after
 *     transient storage failures).
 *  2. The invoice editor — once the form is valid (number + at least one line
 *     item + unique number) it is saved to the database automatically;
 *     not-yet-valid forms are kept as a restorable draft.
 *  3. The settings form.
 */
function autosaveTick() {
  let saved = false;

  if (DB.autosaveIfChanged()) saved = true;

  if (currentView === "edit") {
    const data = collectInvoice();
    const dataJson = JSON.stringify(data);
    if (dataJson !== lastSavedJson) {
      let stored = false;
      const err = validateInvoice(data);
      if (!err) {
        try {
          autoSaveInvoice(data);
          stored = true;
          saved = true;
        } catch (e) {
          console.error("Auto-save to the database failed", e);
        }
      }
      if (!stored && dataJson !== lastDraftJson) {
        try {
          localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: new Date().toISOString(), data: JSON.parse(dataJson) }));
          lastDraftJson = dataJson;
          saved = true;
        } catch (e) { /* storage unavailable — DB watchdog still runs */ }
      }
    }
    updateDirtyState();
  }

  if (currentView === "settings") {
    if (saveSettingsIfChanged()) saved = true;
  }

  if (saved) {
    $("#footer-autosave").textContent = `Autosaved ${new Date().toLocaleTimeString([], { hour12: false })}`;
  }
  checkStorageHealth(); // a failed persist anywhere in this tick must not stay silent
}

/**
 * Debounced auto-save trigger: runs the tick shortly after any change is
 * detected, so edits are saved almost immediately instead of on a fixed timer.
 */
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosaveTick, AUTOSAVE_DEBOUNCE_MS);
}

function startAutosave() {
  // Event-driven saves: any form input/change, or a click (adding/removing a
  // line item, etc.), schedules a debounced save.
  document.addEventListener("input", scheduleAutosave);
  document.addEventListener("change", scheduleAutosave);
  document.addEventListener("click", scheduleAutosave);
  // Safety-net watchdog: catches changes that produce no DOM event and
  // retries after transient storage failures.
  setInterval(autosaveTick, AUTOSAVE_WATCHDOG_MS);
  // Flush pending changes immediately when the tab is hidden or closed.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(autosaveTimer); autosaveTick(); }
  });
}

/** Baseline the form so unchanged data doesn't create a draft. */
function resetDraftBaseline() {
  lastDraftJson = currentView === "edit" ? JSON.stringify(collectInvoice()) : null;
}

/** Remove the stored draft (after saving, importing, or wiping data). */
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* noop */ }
  resetDraftBaseline();
  hideDraftBanner();
}

function readDraft() {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) return null;
  try {
    const wrapper = JSON.parse(raw);
    return wrapper && wrapper.data ? wrapper : null;
  } catch {
    return null;
  }
}

function showDraftBanner() {
  const wrapper = readDraft();
  const banner = $("#draft-banner");
  if (!wrapper) { banner.hidden = true; return; }
  const t = new Date(wrapper.savedAt);
  $("#draft-time").textContent = isNaN(t) ? "earlier" :
    t.toLocaleString([], { hour12: false, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  banner.hidden = false;
}

function hideDraftBanner() {
  $("#draft-banner").hidden = true;
}

function restoreDraft() {
  const wrapper = readDraft();
  if (!wrapper) { hideDraftBanner(); return; }
  const draft = wrapper.data;
  // If the underlying invoice was deleted meanwhile, restore as a new invoice.
  if (draft.id && !DB.getInvoice(draft.id)) draft.id = null;
  editingId = draft.id || null;
  numberTouched = true; // keep the draft's number even if it was auto-suggested
  fillEditor(draft, DB.getSettings());
  showView("edit");
  resetDraftBaseline();
  resetSavedBaseline();
  toast("Draft restored — click Save when finished.", "info");
}

function discardDraft() {
  clearDraft();
  toast("Draft discarded.");
}

/* ============================ storage health ============================ */

const STORAGE_WARN_KB = 3000; // raw DB bytes ≈ 4 MB as base64 vs a ~5 MB localStorage quota

/**
 * Pure decision for the storage-health alert. Returns "fail" when autosave
 * is failing, "quota" when the database nears the localStorage limit, else
 * null. The caller owns the shown-once state and re-arms "fail" after the
 * saves recover.
 */
function storageAlert(sizeKB, persistOk, failAlerted, quotaAlerted) {
  if (!persistOk) return failAlerted ? null : "fail";
  if (!quotaAlerted && sizeKB >= STORAGE_WARN_KB) return "quota";
  return null;
}

let storageFailAlerted = false;
let storageQuotaAlerted = false;

/**
 * Surface storage problems as a toast — without this, a save whose persist
 * to localStorage failed is completely silent (the in-memory DB still has
 * the invoice, but closing the tab would lose it).
 */
function checkStorageHealth() {
  if (DB.persistOk) storageFailAlerted = false; // re-arm after a recovery
  const kind = storageAlert(DB.stats().sizeKB, DB.persistOk, storageFailAlerted, storageQuotaAlerted);
  if (kind === "fail") {
    storageFailAlerted = true;
    toast("Autosave to browser storage is failing — use Export DB now to keep a backup.", "alert");
  } else if (kind === "quota") {
    storageQuotaAlerted = true;
    toast(`Browser storage is filling up (database ≈ ${DB.stats().sizeKB} KB of a ~5 MB limit). Export a backup and consider pruning old invoices.`, "alert");
  }
}

/* ============================ misc ============================ */

function refreshDatalists() {
  const invs = DB.listInvoices();
  $("#dl-pi-numbers").innerHTML = invs.filter((r) => r.type === "PI").map((r) => `<option value="${esc(r.invoice_no)}">`).join("");
  // Previous-buyer picker in the editor (details from each buyer's newest invoice)
  $("#ed-buyer-pick").innerHTML = `<option value="">— Copy a previous buyer —</option>` +
    DB.listBuyers().map((b) => `<option value="${esc(b.buyer_company)}">${esc(b.buyer_company)} (${b.invoice_count})</option>`).join("");
}

function updateFooter() {
  const st = DB.stats();
  $("#footer-status").textContent =
    `${st.invoices} invoices · ${st.items} line items · DB ≈ ${st.sizeKB} KB · autosaved to this browser — export regularly to back up.`;
  checkStorageHealth();
}

function handleInvoiceTableClick(e) {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  const id = parseInt(tr.dataset.id, 10);
  const btn = e.target.closest("[data-action]");
  if (!btn) { openEditor(id); return; }
  const action = btn.dataset.action;
  if (action === "edit") openEditor(id);
  else if (action === "duplicate") doDuplicate(id);
  else if (action === "make-ci") doMakeCI(id);
  else if (action === "print") openPreview(DB.getInvoice(id));
  else if (action === "delete") doDelete(id);
  // "status" is the quick-toggle select: clicks are left alone so the native
  // dropdown opens — its change event does the work.
}

/* ============================ event binding ============================ */

function bindEvents() {
  // Nav & global actions
  $$(".app-tab").forEach((t) => { t.addEventListener("click", () => leaveEditorTo(t.dataset.view)); });
  $("#btn-new").addEventListener("click", () => openEditor(null));
  $("#btn-empty-new").addEventListener("click", () => openEditor(null));
  $("#btn-export").addEventListener("click", exportDB);
  $("#btn-import").addEventListener("click", () => $("#file-import").click());
  $("#file-import").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) await importDB(file);
  });

  // List
  $("#inv-search").addEventListener("input", applyFilters);
  $("#inv-filter-type").addEventListener("change", applyFilters);
  $("#inv-filter-status").addEventListener("change", applyFilters);
  $("#btn-clear-filters").addEventListener("click", () => {
    $("#inv-search").value = "";
    $("#inv-filter-type").value = "All";
    $("#inv-filter-status").value = "All";
    applyFilters();
  });
  $("#invoice-tbody").addEventListener("click", handleInvoiceTableClick);
  // Status quick-toggle pills (a change, not a click)
  $("#invoice-tbody").addEventListener("change", (e) => {
    const sel = e.target.closest("select[data-action='status']");
    if (sel) handleStatusChange(sel);
  });

  // Editor top actions
  $("#btn-back").addEventListener("click", () => leaveEditorTo("list"));
  $("#btn-print").addEventListener("click", doPrintFromEditor);

  // Print preview (editor: previews the current form, including unsaved edits)
  $("#btn-preview").addEventListener("click", () => {
    if (currentView !== "edit") return;
    openPreview(collectInvoice(), $("#ed-no").value || "New Invoice");
  });
  $("#btn-preview-close").addEventListener("click", closePreview);
  $("#btn-preview-print").addEventListener("click", printFromPreview);
  $("#btn-zoom-in").addEventListener("click", () => zoomPreviewBy(1.15));
  $("#btn-zoom-out").addEventListener("click", () => zoomPreviewBy(1 / 1.15));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#preview-overlay").hidden) closePreview();
  });
  document.addEventListener("keydown", focusTrapKeydown); // Tab stays inside the open modal
  window.addEventListener("resize", () => {
    if (!$("#preview-overlay").hidden && !previewUserZoom) fitPreview();
  });

  // Dirty-state tracking (debounced form change detection)
  $("#invoice-form").addEventListener("input", scheduleDirty);
  $("#invoice-form").addEventListener("change", scheduleDirty);
  // The form is never actually submitted (all buttons are type=button), but
  // prevent it anyway — e.g. Enter inside a text input would trigger it.
  $("#invoice-form").addEventListener("submit", (e) => e.preventDefault());

  // Warn before closing the tab with unsaved changes (auto-save everything first)
  window.addEventListener("beforeunload", (e) => {
    autosaveTick();
    if (isDirty()) { e.preventDefault(); e.returnValue = ""; }
  });

  // Editor: type / number
  $$("input[name='ed-type']").forEach((r) => r.addEventListener("change", () => {
    const type = r.value;
    updateTypeVisibility(type);
    if (!editingId && !numberTouched) {
      $("#ed-no").value = DB.nextInvoiceNo(type, $("#ed-date").value || todayISO());
    }
    updateEditorTitle();
  }));
  $("#ed-no").addEventListener("input", () => {
    numberTouched = true;
    updateEditorTitle();
  });
  // A new invoice's number follows its invoice date (PREFIX-YYMMDD-#)
  $("#ed-date").addEventListener("change", () => {
    if (!editingId && !numberTouched) {
      $("#ed-no").value = DB.nextInvoiceNo($("input[name='ed-type']:checked").value, $("#ed-date").value || todayISO());
    }
  });
  $("#ed-currency").addEventListener("change", recalcTotals);

  // Editor: ship-to
  $("#ed-ship-same").addEventListener("change", toggleShipBlock);
  $("#btn-edit-company").addEventListener("click", () => leaveEditorTo("settings"));

  // Editor: copy all Bill To fields from a previous buyer
  $("#ed-buyer-pick").addEventListener("change", () => {
    const name = $("#ed-buyer-pick").value;
    if (!name) return;
    const b = DB.listBuyers().find((x) => x.buyer_company === name);
    $("#ed-buyer-pick").value = ""; // reset, so the same buyer can be picked again later
    if (!b) return;
    $("#ed-bill-company").value = b.buyer_company || "";
    $("#ed-bill-attn").value = b.buyer_attn || "";
    $("#ed-bill-address").value = b.buyer_address || "";
    $("#ed-bill-tel").value = b.buyer_tel || "";
    $("#ed-bill-email").value = b.buyer_email || "";
    scheduleDirty(); // programmatic value changes fire no input events
    toast(`Filled Bill To from previous buyer "${name}" — check the details before saving.`, "info");
  });

  // Editor: items
  $("#btn-add-item").addEventListener("click", () => {
    const count = $$("#items-tbody tr").length;
    $("#items-tbody").insertAdjacentHTML("beforeend", itemRowHTML(blankItem(), count));
    const rows = $$("#items-tbody tr");
    const last = rows[rows.length - 1];
    autoGrowItem($(".it-desc", last));
    $(".it-desc", last).focus();
    recalcTotals();
    scheduleDirty();
  });
  $("#items-tbody").addEventListener("input", (e) => {
    if (e.target.matches(".it-qty, .it-price")) recalcTotals();
    if (e.target.matches(".it-desc")) autoGrowItem(e.target);
  });
  $("#items-tbody").addEventListener("click", (e) => {
    const del = e.target.closest(".it-del");
    if (!del) return;
    del.closest("tr").remove();
    renumberItems();
    recalcTotals();
    scheduleDirty();
  });

  // Editor: charges
  $("#ed-freight").addEventListener("input", recalcTotals);

  // Settings
  $("#btn-clear-data").addEventListener("click", clearAllData);

  // Settings: company chop upload / remove (own save path, outside the form auto-save)
  $("#btn-chop-upload").addEventListener("click", () => $("#chop-file").click());
  $("#chop-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    try { e.target.value = ""; } catch (_) { /* some engines restrict clearing file inputs */ }
    if (file) await uploadChop(file);
  });
  $("#btn-chop-remove").addEventListener("click", () => {
    DB.saveSettings({ company_chop: "" });
    renderChopPreview();
    toast("Company chop removed.", "info");
  });

  // Draft banner (auto-saved editor form)
  $("#btn-draft-restore").addEventListener("click", restoreDraft);
  $("#btn-draft-discard").addEventListener("click", discardDraft);
}

/* ============================ boot ============================ */

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const { restored } = await DB.init();
    if (!DB.persistOk) {
      storageFailAlerted = true; // the toast below already covers it; don't double-toast via updateFooter
      toast("Browser storage autosave is not available — use Export DB to keep a backup.", "alert");
    } else if (restored) {
      toast("Your data was restored from this browser's autosave.", "info");
    }
  } catch (err) {
    console.error(err);
    $("#loading").innerHTML = `
      <div class="alert alert-danger">
        <h5>Could not load the SQLite engine</h5>
        <p>The database engine (SQLite WASM) is bundled with the app in <code>js/vendor/</code>, so this
        usually means the files are missing or the page was not loaded fully. Bootstrap CSS and Font
        Awesome icons do come from public CDNs and need a connection — the page may look unstyled
        offline, but your data does not depend on them. Please reload the page.</p>
        <p class="muted" style="font-size:12px; margin-bottom:0">${esc(err.message || "")}</p>
      </div>`;
    return;
  }

  $("#loading").hidden = true;
  bindEvents();
  refreshDatalists();
  updateFooter();
  showView("list");
  startAutosave();
});
