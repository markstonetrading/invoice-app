"use strict";

/** Unit tests for the pure helpers and print-document builder in js/app.js. */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadAppPure } = require("./helpers");

const {
  esc, nl2br, fmtDate, fmtMoney, fmtQty, fmtUnitPrice,
  intToWords, amountInWords, slug, buildPrintDoc,
} = loadAppPure();

/* ------------------------- formatting helpers ------------------------- */

test("esc: escapes HTML-significant characters", () => {
  assert.equal(esc(`<img src=x onerror="alert(1)"> & 'single'`), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;single&#39;");
  assert.equal(esc(null), "");
  assert.equal(esc(0), "0");
});

test("nl2br: escapes then converts line breaks", () => {
  assert.equal(nl2br("a\nb\r\nc"), "a<br>b<br>c");
  assert.equal(nl2br("<b>x</b>\ny"), "&lt;b&gt;x&lt;/b&gt;<br>y");
});

test("fmtDate: formats ISO dates as 'DD MMM YYYY', passes through invalid values", () => {
  assert.equal(fmtDate("2026-10-01"), "01 Oct 2026");
  assert.equal(fmtDate(""), "—");
  assert.equal(fmtDate("nonsense"), "nonsense");
});

test("fmtMoney: formats with the currency code", () => {
  assert.equal(fmtMoney(1234.5, "USD"), "USD\u00a01,234.50");
  assert.equal(fmtMoney(0, "HKD"), "HKD\u00a00.00");
});

test("fmtQty / fmtUnitPrice: sensible decimal handling", () => {
  assert.equal(fmtQty(1000), "1,000");
  assert.equal(fmtQty(0), "0");
  assert.equal(fmtUnitPrice(0.5), "0.50");
  assert.equal(fmtUnitPrice(0.0123), "0.0123");
});

test("intToWords / amountInWords", () => {
  assert.equal(intToWords(0), "Zero");
  assert.equal(intToWords(19), "Nineteen");
  assert.equal(intToWords(85), "Eighty-Five");
  assert.equal(intToWords(5123), "Five Thousand One Hundred Twenty-Three");
  assert.equal(intToWords(2000000), "Two Million");
  assert.equal(amountInWords(5123.45, "USD"), "US Dollars Five Thousand One Hundred Twenty-Three and Cents Forty-Five Only");
  assert.equal(amountInWords(0, "HKD"), "Hong Kong Dollars Zero Only");
});

test("todayISO: uses the local calendar date, not the UTC date (regression)", () => {
  const { todayISO } = loadAppPure();
  // Fixed instant: 2026-01-01T23:30Z is already Jan 2nd at UTC+8 (HK) and
  // still Dec 31st west of UTC. The old implementation used toISOString()
  // (UTC), so before 08:00 in Hong Kong every new invoice defaulted to
  // yesterday's date — and a PREFIX-YYMMDD-# number for the wrong day.
  const RealDate = globalThis.Date;
  const INSTANT = RealDate.parse("2026-01-01T23:30:00Z");
  class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [INSTANT])); }
    static now() { return INSTANT; }
  }
  globalThis.Date = FixedDate; // the app resolves Date at call time
  try {
    const d = new RealDate(INSTANT); // expected: the machine-local date
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const got = todayISO();
    assert.equal(got, expected, `local date is ${expected} but got ${got}`);
  } finally {
    globalThis.Date = RealDate;
  }
});

test("amountInWords: matches the printed 2dp total near round numbers, and handles negatives (regression)", () => {
  const { amountInWords } = loadAppPure();
  // Totals that round up to the next integer print as e.g. "10.00" — the
  // words must say Ten, never "… Nine and Cents One Hundred".
  assert.equal(amountInWords(9.999, "HKD"), "Hong Kong Dollars Ten Only");
  assert.equal(amountInWords(0.999, "USD"), "US Dollars One Only");
  // Stays consistent when rounding down: 19.994 prints as 19.99.
  assert.equal(amountInWords(19.994, "HKD"), "Hong Kong Dollars Nineteen and Cents Ninety-Nine Only");
  // Ordinary amounts are unchanged.
  assert.equal(amountInWords(5123.45, "USD"), "US Dollars Five Thousand One Hundred Twenty-Three and Cents Forty-Five Only");
  // Negative totals can't come from the UI anymore (freight is >= 0), but the
  // helper still guards against them — a negative total prints as -10.50, so
  // the words must say "Minus".
  assert.equal(amountInWords(-10, "USD"), "Minus US Dollars Ten Only");
  assert.equal(amountInWords(-10.5, "USD"), "Minus US Dollars Ten and Cents Fifty Only");
});

test("slug: lowercases and hyphenates status names", () => {
  assert.equal(slug("Draft"), "draft");
  assert.equal(slug("Some Status"), "some-status");
});

test("storageAlert: failure beats quota, each alert fires once, failure re-arms on recovery", () => {
  const { storageAlert } = loadAppPure();
  // Healthy, small database: nothing to say.
  assert.equal(storageAlert(10, true, false, false), null);
  // Autosave failing: alert once, then stay quiet until it recovers.
  assert.equal(storageAlert(10, false, false, false), "fail");
  assert.equal(storageAlert(10, false, true, false), null);
  // Recovered (the caller re-arms the fail flag when persistOk is true).
  assert.equal(storageAlert(10, true, true, false), null);
  // Near the localStorage limit (~3 MB raw DB ≈ 4 MB base64): alert once.
  assert.equal(storageAlert(3500, true, false, false), "quota");
  assert.equal(storageAlert(3500, true, false, true), null);
  // A failing persist outranks the quota warning.
  assert.equal(storageAlert(3500, false, false, true), "fail");
});

/* ------------------------- print document ------------------------- */

const settings = {
  company_name: "Chip Trading Co.", company_address: "Unit 12/F, Test Tower",
  company_tel: "+852 2345 6789", company_br: "12345678",
  bank_name: "HSBC", bank_code: "003 / 716", account_no: "123-456789-001", swift_code: "HSBCHKHH",
};

const piInvoice = {
  invoice_no: "PI-261001-1", type: "PI", invoice_date: "2026-10-01", currency: "USD",
  customer_po: "PO-88", buyer_company: "Acme Electronics Ltd.", buyer_attn: "Mr. Chan",
  buyer_address: "Rm 101", buyer_tel: "+86 755 1234", buyer_email: "chan@acme.cn",
  ship_same_as_bill: 1, payment_terms: "T/T 30 days", validity: "30 days",
  freight: 20, remarks: "Goods are brand new.",
  items: [
    { description: "MCU 32-bit ARM\nLQFP48 tray pack", qty: 1000, unit_price: 0.5 },
    { description: "MLCC 10uF 0402", qty: 500, unit_price: 0.02 },
  ],
};

const ciInvoice = {
  ...piInvoice,
  invoice_no: "CI-261001-1", type: "CI",
  ship_same_as_bill: 0, ship_company: "Acme Warehouse", ship_address: "Dongguan",
  related_invoice_no: "PI-261001-1", gross_weight: "12.5 kg", net_weight: "10.2 kg",
  cartons: "2 CTN", shipping_marks: "As per buyer", validity: undefined,
};

test("print doc: PI renders title, terms, items and totals", () => {
  const html = buildPrintDoc(piInvoice, settings);
  assert.ok(html.includes("PROFORMA INVOICE"));
  assert.ok(html.includes("PI-261001-1"));
  assert.ok(html.includes("Payment Terms"));
  assert.ok(html.includes("T/T 30 days"));
  assert.ok(html.includes("Validity") && html.includes("30 days"));
  assert.ok(html.includes(">Terms</h6>"), "PI block heading is just 'Terms'");
  assert.ok(!html.includes("Shipment"), "PI has no 'Shipment' heading (regression)");
  assert.ok(html.includes("MCU 32-bit ARM<br>LQFP48 tray pack")); // multi-line description
  assert.ok(html.includes("500.00")); // line amount
  assert.ok(html.includes("Freight &amp; Handling"));
  assert.ok(html.includes("Total USD"));
  assert.ok(html.includes("US Dollars Five Hundred Thirty"), // amount in words (510 + 20 = 530)
    `words were: ${html.match(/Amount in Words.*?Only/s)?.[0] || "(none)"}`);
});

test("print doc: CI renders shipment particulars and related PI", () => {
  const html = buildPrintDoc(ciInvoice, settings);
  assert.ok(html.includes("COMMERCIAL INVOICE"));
  assert.ok(html.includes("CI-261001-1"));
  assert.ok(html.includes("Related PI No.") && html.includes("PI-261001-1"));
  assert.ok(html.includes("12.5 kg / 10.2 kg"));
  assert.ok(html.includes("2 CTN"));
  assert.ok(html.includes("Acme Warehouse")); // ship-to differs from bill-to
  assert.ok(html.includes("hereby certify")); // CI declaration
});

test("print doc: beneficiary bank details include the bank code", () => {
  const html = buildPrintDoc(ciInvoice, settings);
  assert.ok(html.includes("Beneficiary Bank Details"));
  assert.ok(html.includes("Bank Code / Branch Code:</td><td>003 / 716"));
  assert.ok(html.includes("HSBCHKHH"));
});

test("print doc: removed fields never appear (regression)", () => {
  const html = buildPrintDoc(ciInvoice, settings);
  for (const gone of ["Incoterms", "Delivery Method", "Lead Time", "Ship Date", "Insurance", "Authorised Signature", "Company Chop", "Discount", "Less: Discount"]) {
    assert.ok(!html.includes(gone), `unexpected field in print doc: ${gone}`);
  }
});

test("print doc: signature line kept, caption removed", () => {
  const html = buildPrintDoc(piInvoice, settings);
  assert.ok(html.includes("sign-line"));
  assert.ok(html.includes("For and on behalf of"));
});

test("print doc: escapes buyer-provided content (XSS)", () => {
  const evil = {
    ...piInvoice,
    buyer_company: "<script>alert(1)</script>",
    items: [{ description: "<img onerror=alert(2)>", qty: 1, unit_price: 1 }],
  };
  const html = buildPrintDoc(evil, settings);
  assert.ok(!html.includes("<script>alert"));
  assert.ok(!html.includes("<img onerror"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("print doc: omits the bank block entirely when no bank details set", () => {
  const html = buildPrintDoc(piInvoice, { company_name: "No Bank Co." });
  assert.ok(!html.includes("Beneficiary Bank Details"));
});

test("print doc: company chop is stamped on the signature area when set", () => {
  const chop = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const html = buildPrintDoc(piInvoice, { ...settings, company_chop: chop });
  assert.ok(html.includes('class="chop"'), "chop image should be in the signature block");
  assert.ok(html.includes(`src="${chop}"`), "chop data URL should be the img src (escaped, base64 is safe)");

  const without = buildPrintDoc(piInvoice, settings);
  assert.ok(!without.includes('class="chop"'), "no chop element when none is stored");
});
