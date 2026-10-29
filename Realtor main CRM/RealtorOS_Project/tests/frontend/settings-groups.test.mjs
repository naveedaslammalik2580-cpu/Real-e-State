import { test } from "node:test";
import assert from "node:assert/strict";
import { page, domTest, setField, settle } from "./crm-helpers.mjs";

const SCRIPTS = ["assets/js/core/utils.js", "assets/js/core/commission.js",
  "assets/js/core/derived.js", "assets/js/core/customization.js",
  "assets/js/app.js", "assets/js/pages/release.js"];
const dom = (name, fn) => domTest(test, SCRIPTS, name, fn);
async function settings({ team = false, manage = false } = {}) {
  const p = await page(SCRIPTS, {});
  p.window.App.customization.isTeamMode = () => team;
  p.window.App.workspace = { can: key => key === "team_manage" && manage };
  await p.window.App.pages.release.renderSettings(p.pane);
  return p;
}

dom("Settings groups essentials and keeps advanced options discoverable without writes", async () => {
  const p = await settings();
  assert.deepEqual(Array.from(p.pane.querySelectorAll(".settings-nav-section-title"), e => e.textContent),
    ["Profile", "Workspace", "Integrations", "Features", "Advanced"]);
  const advanced = p.pane.querySelector(".settings-nav details");
  assert.equal(advanced.open, false);
  assert.deepEqual(Array.from(advanced.querySelectorAll("[data-settings-cat]"), e => e.dataset.settingsCat),
    ["data-safety", "custom-fields"]);
  const card = p.pane.querySelector('[data-overview-cat="data-safety"]');
  assert.equal(card.closest("details").open, false);
  assert.equal(p.pane.querySelector('[data-overview-cat="business-profile"]').closest("details"), null);
  assert.deepEqual(p.writes, []);
  p.pane.querySelector('[data-settings-cat="pipeline"]').click();
  assert.deepEqual(p.navigated, ["/settings/pipeline"]);
  card.click();
  assert.deepEqual(p.navigated, ["/settings/pipeline", "/settings/data-safety"]);
});

dom("Advanced deep links open their group and preserve existing category renderers", async () => {
  const p = await settings();
  let calls = 0;
  p.window.App.pages.customFieldsSettings = { render: async pane => { calls++; pane.textContent = "Existing custom fields"; } };
  await p.window.App.pages.release.renderSettings(p.pane, "custom-fields");
  assert.equal(calls, 1);
  assert.equal(p.pane.querySelector(".settings-nav details").open, true);
  assert.equal(p.pane.querySelector('[data-settings-cat="custom-fields"]').getAttribute("aria-current"), "page");
  assert.match(p.pane.querySelector("#settingsContent").textContent, /Existing custom fields/);
  assert.deepEqual(p.writes, []);
});

dom("Team permission links require team mode and management; membership stays reachable", async () => {
  for (const [team, manage] of [[false, false], [false, true], [true, false], [true, true]]) {
    const p = await settings({ team, manage });
    assert.equal(!!p.pane.querySelector('[data-settings-cat="team-permissions"]'), team && manage);
    const membership = p.pane.querySelector('[data-settings-cat="team-access"]');
    assert.ok(membership);
    assert.match(membership.textContent, manage ? /Team & Access/ : /Workspace membership/);
    let member;
    p.window.App.pages.teamPermissions = { render: async (pane, id) => { member = id; } };
    await p.window.App.pages.release.renderSettings(p.pane, "team-permissions?member=wm%252F1");
    assert.equal(member, "wm%2F1", "existing pane owns authorization and receives its unchanged query");
    assert.deepEqual(p.writes, []);
  }
});

dom("Business Profile still saves and reloads through the existing settings API", async () => {
  const p = await settings();
  p.store.settings.updateBusinessProfile = async () => ({ ok: true });
  await p.window.App.pages.release.renderSettings(p.pane, "business-profile");
  setField(p.document, "#setAgent", "Solo Agent");
  setField(p.document, "#setCurrency", "GBP");
  setField(p.document, "#setReminderHours", "24");
  setField(p.document, "#setTimezone", "UTC");
  p.pane.querySelector("#saveAllBP").click();
  await settle(p.window);
  assert.equal(p.state.settings.agentName, "Solo Agent");
  assert.equal(p.state.settings.currency, "GBP");
  assert.equal(p.state.settings.followUpReminderHours, 24);
  await p.window.App.pages.release.renderSettings(p.pane);
  await p.window.App.pages.release.renderSettings(p.pane, "business-profile");
  assert.equal(p.pane.querySelector("#setAgent").value, "Solo Agent");
  assert.equal(p.pane.querySelector("#setCurrency").value, "GBP");
  assert.equal(p.pane.querySelector("#setReminderHours").value, "24");
});
