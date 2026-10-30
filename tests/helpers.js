"use strict";

/**
 * Test helpers: load the app's (deliberately non-modular) browser scripts in
 * Node contexts, with the real sql.js engine and isolated storage.
 *
 * - loadDB()      -> js/db.js with a fresh in-memory localStorage
 * - loadAppPure() -> the pure helper functions from js/app.js (no DOM)
 * - createDomApp()-> the FULL app (real index.html + db.js + app.js + sql.js)
 *                    booted inside jsdom, with timers captured so tests can
 *                    fire the auto-save watchdog tick deterministically.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DB_SRC = fs.readFileSync(path.join(ROOT, "js/db.js"), "utf8");
const APP_SRC = fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

// Real sql.js — the same version the app loads from its CDN — with the wasm
// binary inlined so tests never touch the network.
const initSqlJsRaw = require("sql.js");
const wasmBinary = fs.readFileSync(require.resolve("sql.js/dist/sql-wasm.wasm"));
const initSqlJs = (cfg) => initSqlJsRaw({ ...cfg, wasmBinary });

/** In-memory localStorage stub, with a switch to simulate quota failures. */
function createStorage() {
  return {
    _data: {},
    fail: false,
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
    setItem(k, v) { if (this.fail) throw new Error("QuotaExceededError (simulated)"); this._data[k] = String(v); },
    removeItem(k) { delete this._data[k]; },
  };
}

/** Load js/db.js with an isolated storage. Returns { DB, storage }. */
function loadDB(storage = createStorage()) {
  const mod = { exports: {} };
  const fn = new Function("module", "exports", "initSqlJs", "localStorage",
    `${DB_SRC}\nmodule.exports = DB;`);
  fn(mod, mod.exports, initSqlJs, storage);
  return { DB: mod.exports, storage };
}

/**
 * Load the pure helper functions from js/app.js (no DOM required).
 * buildPrintDoc and friends only touch their arguments.
 */
function loadAppPure() {
  const prevDocument = globalThis.document;
  globalThis.document = { addEventListener() {} }; // app.js registers a boot listener at load
  try {
    const mod = { exports: {} };
    const fn = new Function("module", "exports", `${APP_SRC}
module.exports = { esc, nl2br, todayISO, fmtDate, fmtMoney, fmtQty, fmtUnitPrice, intToWords, amountInWords, slug, storageAlert, buildPrintDoc };`);
    fn(mod, mod.exports);
    return mod.exports;
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Set an input's value and fire the matching event (jsdom doesn't do this automatically). */
function setInput(el, value, eventName = "input") {
  el.value = value;
  el.dispatchEvent(new el.ownerDocument.defaultView.Event(eventName, { bubbles: true }));
}

/**
 * Boot the full app inside jsdom and return handles for testing:
 *   window/document/DOM  — the live page
 *   DB                   — the app's real DB instance (window.DB)
 *   fireAutosaveTick()   — run the captured auto-save watchdog callbacks
 *   printCalls()         — how many times window.print was called (stubbed)
 */
async function createDomApp() {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM(HTML, {
    url: "http://localhost:8000/",
    runScripts: "outside-only", // we evaluate the app's scripts ourselves
    pretendToBeVisual: true,    // provides requestAnimationFrame (toasts)
  });
  const { window } = dom;

  // Browser APIs jsdom lacks or that must not have side effects in tests
  window.initSqlJs = initSqlJs;
  window.scrollTo = () => {};
  window.print = () => { window.__printCalls = (window.__printCalls || 0) + 1; };
  window.URL.createObjectURL = () => "blob:test";
  window.URL.revokeObjectURL = () => {};

  // Isolated localStorage with a quota-failure switch (the same stub loadDB
  // uses). jsdom's real Storage silently ignores property overrides, so it
  // cannot be made to throw on demand — swap the window property instead.
  // The app resolves `localStorage` at call time, so this takes effect
  // before the scripts below run.
  Object.defineProperty(window, "localStorage", { value: createStorage(), configurable: true });

  // Capture interval callbacks instead of scheduling real timers, so the
  // Node process never hangs and the auto-save watchdog tick becomes deterministic.
  const tickFns = [];
  window.setInterval = (fn) => { tickFns.push(fn); return tickFns.length; };
  window.clearInterval = () => {};

  // Evaluate db.js and app.js in one IIFE chain so app.js can see db.js's
  // top-level `const DB` (equivalent to consecutive <script> tags in a page).
  window.eval(`
    (function () {
      ${DB_SRC}
      window.DB = DB;
    })();
    (function () {
      const DB = window.DB;
      ${APP_SRC}
    })();
  `);

  // jsdom does NOT fire its natural DOMContentLoaded inside the constructor —
  // it fires on a later tick. If parsing is still in progress at eval time,
  // the app's listener (registered above) will catch the natural event.
  if (window.document.readyState === "loading") {
    await Promise.race([
      new Promise((resolve) => window.document.addEventListener("DOMContentLoaded", resolve, { once: true })),
      sleep(3000),
    ]);
  }
  // The app's boot is async (sql.js init), so wait for it to complete — its
  // completion signal is the #loading card being hidden. Only if that never
  // happens (natural DOMContentLoaded missed or stalled) do we boot manually.
  const bootDeadline = Date.now() + 3000;
  while (Date.now() < bootDeadline && !window.document.getElementById("loading").hidden) {
    await sleep(25);
  }
  if (!window.document.getElementById("loading").hidden) {
    window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
    await sleep(150);
  }
  await sleep(50); // settle

  return {
    dom,
    window,
    document: window.document,
    DB: window.DB,
    fireAutosaveTick: async () => { tickFns.forEach((fn) => fn()); await sleep(20); },
    printCalls: () => window.__printCalls || 0,
    close: () => { try { window.close(); } catch (e) { /* noop */ } },
  };
}

module.exports = { loadDB, loadAppPure, createDomApp, createStorage, initSqlJs, sleep, setInput, ROOT };
