// Frontend: contact "Follow-up emails" card + confirmation dialogs, and
// the automation activity panel's stop / skip wording. Real page scripts,
// real index.html markup, jsdom, stubbed App.store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { browser, settle, SKIP_DOM } from "../helpers/browser.mjs";

const BANNED = /\b(resend|webhook|enrollments?|jobs?|upsert|suppress(ed|ion)?|batch|send_email|create_task|advance_enrollment|consent_revoked|contact_unsubscribed)\b/i;

function contactStore(statusRef, calls, opts = {}) {
  const contact = { id: "c-1", name: opts.name ?? "Pat Lee", role: "Buyer", stage: "New Lead", temperature: "Warm", email: "pat@example.com" };
  return {
    ensureLoaded: async () => {},
    getState: () => ({ contacts: [contact], properties: [], deals: [], activities: [], tasks: [], showings: [], referrals: [], settings: { currency: "USD" } }),
    automationRuntime: {
      contactEmailStatus: async (id) => { calls.push(["status", id]); return statusRef.value; },
      markReplied: async (id) => {
        calls.push(["markReplied", id]);
        if (opts.failWith) { const e = new Error(opts.failWith); e.code = opts.failWith; throw e; }
        statusRef.value = { ...statusRef.value, replyDetectedAt: "2026-09-28T10:00:00Z" };
        return { ok: true };
      },
      markUnsubscribed: async (id) => {
        calls.push(["markUnsubscribed", id]);
        statusRef.value = { ...statusRef.value, unsubscribeDetectedAt: "2026-09-28T10:00:00Z", emailOptedOut: true, emailBlocked: true, blockedReason: "unsubscribe" };
        return { ok: true };
      },
    },
  };
}

async function contactPage(status, opts = {}) {
  const statusRef = { value: status };
  const calls = [];
  const b = await browser(["assets/js/core/utils.js", "assets/js/app.js", "assets/js/pages/contacts.js"], {
    store: contactStore(statusRef, calls, opts),
    derived: { contactFollowUpStatus: () => ({ status: "none" }) },
  });
  if (!b) return null;
  const container = b.document.createElement("div");
  b.document.body.appendChild(container);
  await b.window.App.pages.contacts.renderDetail(container, "c-1");
  await settle(b.window);
  const card = () => b.document.getElementById("contactEmailStatusCard");
  return { ...b, container, card, calls, statusRef };
}

const EMPTY = { replyDetectedAt: null, unsubscribeDetectedAt: null, emailOptedOut: false, emailBlocked: false, blockedReason: null };

test("contact card: nothing detected -> 'can be sent' + both actions", async (t) => {
  const p = await contactPage(EMPTY);
  if (!p) return t.skip(SKIP_DOM);
  const text = p.card().textContent;
  assert.match(text, /Follow-up emails can be sent to this contact\./);
  assert.ok(p.card().querySelector('[data-role="mark-replied"]'));
  assert.ok(p.card().querySelector('[data-role="mark-unsubscribed"]'));
  assert.doesNotMatch(text, BANNED);
  p.close();
});

test("contact card: replied, unsubscribed and blocked shown in plain language; actions hidden once done", async (t) => {
  const p = await contactPage({ replyDetectedAt: "2026-09-20T10:00:00Z", unsubscribeDetectedAt: "2026-09-21T10:00:00Z", emailOptedOut: true, emailBlocked: true, blockedReason: "bounce" });
  if (!p) return t.skip(SKIP_DOM);
  const text = p.card().textContent.replace(/\s+/g, " ");
  assert.match(text, /Contact replied on Sep 20, 2026/);
  assert.match(text, /Contact unsubscribed on Sep 21, 2026/);
  assert.match(text, /Email blocked because the address could not receive email\./);
  assert.equal(p.card().querySelector('[data-role="mark-replied"]'), null);
  assert.equal(p.card().querySelector('[data-role="mark-unsubscribed"]'), null);
  assert.doesNotMatch(text, BANNED);
  p.close();
});

test("contact card: unknown block reason from the server is never rendered raw", async (t) => {
  const p = await contactPage({ ...EMPTY, emailBlocked: true, blockedReason: "<img src=x onerror=alert(1)>" });
  if (!p) return t.skip(SKIP_DOM);
  assert.equal(p.card().querySelector("img"), null);
  assert.match(p.card().textContent, /email to this address was blocked/);
  p.close();
});

test("contact name with markup is escaped on the detail page", async (t) => {
  const p = await contactPage(EMPTY, { name: '<img src=x onerror="alert(1)">' });
  if (!p) return t.skip(SKIP_DOM);
  assert.equal(p.container.querySelector("img"), null);
  assert.match(p.container.textContent, /<img src=x onerror="alert\(1\)">/);
  p.close();
});

test("'Mark as replied': accessible confirm dialog; Escape closes without acting", async (t) => {
  const p = await contactPage(EMPTY);
  if (!p) return t.skip(SKIP_DOM);
  const { document, window } = p;
  const button = p.card().querySelector('[data-role="mark-replied"]');
  button.focus();
  button.click();
  await settle(window);
  const dialog = document.querySelector("#modalRoot .modal");
  assert.ok(dialog, "dialog opened");
  assert.equal(dialog.getAttribute("role"), "alertdialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  const labelledBy = dialog.getAttribute("aria-labelledby");
  assert.equal(document.getElementById(labelledBy).textContent, "Mark as replied?");
  assert.ok(dialog.contains(document.activeElement), "focus moved into the dialog");
  assert.doesNotMatch(dialog.textContent, BANNED);

  // Tab / Shift+Tab never move focus out of the dialog.
  for (const shiftKey of [false, true, false]) {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true }));
    assert.ok(dialog.contains(document.activeElement), "focus trapped");
  }

  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle(window, 60);
  await new Promise((r) => window.setTimeout(r, 200));
  assert.equal(document.querySelector("#modalRoot .modal"), null, "Escape closed it");
  assert.equal(p.calls.filter((c) => c[0] === "markReplied").length, 0, "nothing was marked");
  assert.equal(document.activeElement, button, "focus returned to the button");
  p.close();
});

test("'Mark as replied' confirmed -> one server call through the store, card refreshes", async (t) => {
  const p = await contactPage(EMPTY);
  if (!p) return t.skip(SKIP_DOM);
  p.card().querySelector('[data-role="mark-replied"]').click();
  await settle(p.window);
  p.document.querySelector('#modalRoot [data-role="ok"]').click();
  await settle(p.window, 10);
  assert.deepEqual(p.calls.filter((c) => c[0] === "markReplied"), [["markReplied", "c-1"]]);
  assert.equal(p.toasts.at(-1).message, "Marked as replied.");
  await settle(p.window, 10);
  assert.match(p.card().textContent, /Contact replied on/);
  assert.equal(p.card().querySelector('[data-role="mark-replied"]'), null);
  p.close();
});

test("'Mark as unsubscribed' confirmed -> email shown as blocked", async (t) => {
  const p = await contactPage(EMPTY);
  if (!p) return t.skip(SKIP_DOM);
  p.card().querySelector('[data-role="mark-unsubscribed"]').click();
  await settle(p.window);
  const dialog = p.document.querySelector("#modalRoot .modal");
  assert.match(dialog.textContent, /won't receive any more follow-up emails/);
  dialog.querySelector('[data-role="ok"]').click();
  await settle(p.window, 20);
  assert.deepEqual(p.calls.filter((c) => c[0] === "markUnsubscribed"), [["markUnsubscribed", "c-1"]]);
  const text = p.card().textContent.replace(/\s+/g, " ");
  assert.match(text, /Contact unsubscribed on/);
  assert.match(text, /Email blocked because the contact unsubscribed\./);
  p.close();
});

test("server busy -> friendly message, button usable again", async (t) => {
  const p = await contactPage(EMPTY, { failWith: "try_again" });
  if (!p) return t.skip(SKIP_DOM);
  const btn = p.card().querySelector('[data-role="mark-replied"]');
  btn.click();
  await settle(p.window);
  p.document.querySelector('#modalRoot [data-role="ok"]').click();
  await settle(p.window, 10);
  assert.equal(p.toasts.at(-1).kind, "danger");
  assert.equal(p.toasts.at(-1).message, "Something went wrong. Please try again.");
  assert.equal(btn.disabled, false);
  p.close();
});

test("contact card: says HOW the contact unsubscribed, in plain words", async (t) => {
  const cases = [
    ["inbound_email", /Contact unsubscribed by replying to an email on Sep 29, 2026/],
    ["unsubscribe_link", /Contact unsubscribed using the unsubscribe link on Sep 29, 2026/],
    ["owner_manual", /Contact unsubscribed \(marked by you\) on Sep 29, 2026/],
    ["provider_webhook", /Contact unsubscribed after reporting an email as spam on Sep 29, 2026/],
    ["something_new", /Contact unsubscribed on Sep 29, 2026/],
  ];
  for (const [source, re] of cases) {
    const p = await contactPage({ ...EMPTY, unsubscribeDetectedAt: "2026-09-29T10:00:00Z", emailOptedOut: true, emailBlocked: true, blockedReason: "unsubscribe", optOutSource: source });
    if (!p) return t.skip(SKIP_DOM);
    const text = p.card().textContent.replace(/\s+/g, " ");
    assert.match(text, re, source);
    assert.match(text, /Email blocked because the contact unsubscribed\./);
    assert.doesNotMatch(text, BANNED);
    assert.doesNotMatch(text, /inbound|source|_/);
    p.close();
  }
});

// ------------------------------------------------------------ automation page

for (const entry of ["render", "renderActivity"]) test("automation activity panel (" + entry + "): plain-language stop and skip reasons, escaped names, no jargon", async (t) => {
  const rule = { id: "11111111-1111-4111-8111-111111111111", name: "Welcome", trigger_type: "manual", status: "active", timezone: "UTC", audience_filter: {}, stop_on_reply: true, stop_on_unsubscribe: false, daily_enrollment_limit: 100 };
  const b = await browser(["assets/js/core/utils.js", "assets/js/app.js", "assets/js/pages/automation.js"], {
    store: {
      getState: () => ({ contacts: [{ id: "c-1", name: "<b>Pat</b>" }, { id: "c-2", name: "Sam" }] }),
      automationRules: { list: async () => [rule] },
      messageTemplates: { list: async () => [] },
      automationRuntime: {
        listEnrollments: async () => [{ id: "e1", contact_id: "c-1", status: "stopped", stop_reason: "reply", current_step_order: 1, started_at: "2026-09-20T10:00:00Z", stopped_at: "2026-09-28T10:00:00Z", reply_detected_at: "2026-09-28T09:00:00Z" }],
        listFailures: async () => [],
        listJobs: async () => [{ id: "j1", job_type: "send_email", status: "completed", skipped_reason: "suppressed", attempts: 1, max_attempts: 3 }],
        stopSummary: async () => ({
          stoppedCounts: { reply: 1 },
          stoppedEnrollments: [],
          cancelledJobs: [{ job_type: "create_task", cancelled_reason: "reply", cancelled_at: "2026-09-28T10:00:00Z" }],
          skippedJobs: [{ contact_id: "c-2", skipped_reason: "contact_unsubscribed", completed_at: "2026-09-27T10:00:00Z" }],
        }),
      },
    },
  });
  if (!b) return t.skip(SKIP_DOM);
  const pane = b.document.createElement("div");
  b.document.body.appendChild(pane);
  await b.window.App.pages.automation[entry](pane);
  await settle(b.window);
  pane.querySelector("[data-view-activity]").click();
  await settle(b.window, 10);
  const panel = pane.querySelector("[data-activity-panel-for]");
  const text = panel.textContent.replace(/\s+/g, " ");
  assert.match(text, /Stopped follow-ups/);
  assert.match(text, /Stopped — contact replied on Sep 28/);
  assert.match(text, /Skipped emails/);
  assert.match(text, /Emails paused — contact unsubscribed/);
  assert.match(text, /Email: Skipped/);
  assert.match(text, /Email blocked for this address/);
  assert.match(text, /Task · Contact replied/);
  assert.equal(panel.querySelector("b"), null, "contact name escaped");
  assert.doesNotMatch(text, BANNED);
  b.close();
});
