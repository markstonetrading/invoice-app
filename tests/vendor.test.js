"use strict";

/**
 * Guards for the vendored sql.js bundle (js/vendor/) and the CDN hardening:
 * the vendored engine must match the pinned npm devDependency byte-for-byte,
 * and CDN-loaded stylesheets must carry Subresource Integrity.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

test("vendored sql.js matches the pinned npm devDependency byte-for-byte", () => {
  const npmVersion = require("sql.js/package.json").version;
  for (const f of ["sql-wasm.js", "sql-wasm.wasm"]) {
    const vendored = fs.readFileSync(path.join(ROOT, "js/vendor", f));
    const fromNpm = fs.readFileSync(require.resolve(`sql.js/dist/${f}`));
    assert.ok(vendored.equals(fromNpm),
      `js/vendor/${f} differs from sql.js@${npmVersion} in node_modules — copy the dist file again (they must stay in sync)`);
  }
});

test("index.html loads sql.js from the vendored copy, not a CDN", () => {
  assert.ok(HTML.includes("js/vendor/sql-wasm.js"), "should reference the vendored engine");
  assert.ok(!HTML.includes("cdn.jsdelivr.net/npm/sql.js"), "sql.js CDN reference must be gone");
  assert.ok(!HTML.includes("cdnjs.cloudflare.com/ajax/libs/sql.js"), "sql.js CDN reference must be gone");
});

test("CDN stylesheets carry Subresource Integrity (regression)", () => {
  const cdnLinks = HTML.match(/<link[^>]+rel="stylesheet"[^>]+https:\/\/cdn[^>]*>/g) || [];
  assert.ok(cdnLinks.length >= 2, "expected the Bootstrap + Font Awesome CDN links");
  for (const tag of cdnLinks) {
    assert.ok(/integrity="sha384-[A-Za-z0-9+/=]+"/.test(tag), `CDN link missing SRI: ${tag}`);
    assert.ok(/crossorigin="anonymous"/.test(tag), `CDN link missing crossorigin: ${tag}`);
  }
});

test("no inline event handlers remain in the page", () => {
  assert.ok(!/onclick=|onchange=|onsubmit=/.test(HTML), "all handlers should be bound in app.js");
});
