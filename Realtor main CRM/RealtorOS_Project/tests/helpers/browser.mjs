// Loads the real RealtorOS page scripts into jsdom, with App.store /
// App.derived replaced by test stubs. No network: no <script> or <link>
// from index.html is ever loaded; only the files passed to browser() run,
// via window.eval.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reportSkipReason } from "./skip-reason.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(here, "..", "..", "app");

export async function loadJsdom() {
  try {
    return (await import("jsdom")).JSDOM;
  } catch (err) {
    // The exact condition behind every SKIP_DOM skip, printed once.
    reportSkipReason("jsdom", err);
    return null;
  }
}

export const SKIP_DOM = "jsdom not installed — run `npm install` in tests/ to enable frontend tests";

// The shell elements app.js normally builds at boot and pages write into.
const SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>RealtorOS</title></head><body>
  <div id="root"><header><nav id="breadcrumbs"></nav><span class="topbar-brand-sep"></span><div id="topActions"></div></header></div>
  <div id="modalRoot"></div><div id="toastRoot"></div>
</body></html>`;

export async function browser(scripts, { store, derived } = {}) {
  const JSDOM = await loadJsdom();
  if (!JSDOM) return null;
  const dom = new JSDOM(SHELL, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://app.example.test/" });
  const { window } = dom;
  const toasts = [];
  window.eval("window.App = window.App || {}; App.pages = App.pages || {};");
  for (const rel of scripts) {
    window.eval(fs.readFileSync(path.join(APP_DIR, rel), "utf8"));
  }
  if (store) window.App.store = store;
  if (derived) window.App.derived = derived;
  const realToast = window.App.app && window.App.app.toast;
  if (window.App.app) {
    // opts carries the Phase 2F toast actions, so it is recorded and
    // passed on rather than dropped.
    window.App.app.toast = (message, kind, opts) => {
      toasts.push({ message, kind, opts });
      if (realToast) realToast(message, kind, opts);
    };
  }
  return { window, document: window.document, toasts, close: () => window.close() };
}

// Lets pending promises, timers and animation frames settle.
export async function settle(window, ms = 0) {
  for (let i = 0; i < 5; i++) await new Promise((r) => window.setTimeout(r, ms));
}
