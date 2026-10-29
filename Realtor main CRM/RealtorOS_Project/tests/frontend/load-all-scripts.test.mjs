// Smoke test: load every <script src="..."> listed in app/index.html into
// jsdom in order, asserting none throw on evaluation. This catches syntax
// errors, missing globals at eval time, and any removal that leaves a
// dangling reference. External CDN scripts (http(s) URLs) are skipped.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsdom, SKIP_DOM } from "../helpers/browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(here, "..", "..", "app");

test("every <script src> in app/index.html loads without throwing", async (t) => {
  const JSDOM = await loadJsdom();
  if (!JSDOM) { t.skip(SKIP_DOM); return; }

  const html = fs.readFileSync(path.join(APP_DIR, "index.html"), "utf8");
  const srcs = [...html.matchAll(/<script\s+src=["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(srcs.length > 0, "no scripts found in index.html");

  const dom = new JSDOM(
    `<!doctype html><html><head></head><body><div id="root"></div></body></html>`,
    { url: "https://local.test/", runScripts: "outside-only", pretendToBeVisual: true },
  );
  // Fake the Supabase CDN global the app expects (it's loaded via a CDN
  // <script> at runtime — this smoke test skips URL-based scripts, so stub it).
  dom.window.supabase = { createClient: () => ({ auth: { onAuthStateChange: () => {} } }) };

  for (const src of srcs) {
    if (/^https?:\/\//.test(src)) continue; // CDN script — skipped
    const abs = path.join(APP_DIR, src.replace(/^\//, ""));
    const code = fs.readFileSync(abs, "utf8");
    try {
      dom.window.eval(code);
    } catch (e) {
      assert.fail(`script threw during load: ${src}\n${e.stack || e.message}`);
    }
  }

  // Sanity: after loading all modules the App namespace and a couple of
  // well-known attachments must exist.
  const App = dom.window.App;
  assert.ok(App, "App namespace not created");
  assert.ok(App.util, "App.util missing");
  assert.ok(App.app, "App.app missing");
  assert.ok(App.pages && App.pages.contacts, "App.pages.contacts missing");
  dom.window.close(); // release jsdom timers so the test runner can exit
});
