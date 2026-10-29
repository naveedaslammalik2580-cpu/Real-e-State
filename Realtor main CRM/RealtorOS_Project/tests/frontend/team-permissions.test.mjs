// Phase T4: Settings → What people can do.
//
// The rule this screen exists to keep visible is "nobody can grant what
// they do not hold". The server enforces it; these tests check the screen
// never offers what the server would refuse, and that when it is refused
// anyway the reason reaches the person.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SKIP_DOM } from "../helpers/browser.mjs";
import {
  teamBrowser, settle, confirmOk, makeStore, makeTeamStore, makeWorkspace,
  adminPermissions, permissions, member, plain
} from "./team-helpers.mjs";

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/app.js",
  "assets/js/pages/team-permissions.js"
];

async function open(opts = {}) {
  const team = opts.team || makeTeamStore(opts.answers || {});
  const store = makeStore({ team });
  const b = await teamBrowser(SCRIPTS, {
    store,
    workspace: opts.workspace || makeWorkspace(opts.workspaceOpts || {}),
    teamMode: opts.teamMode === undefined ? true : opts.teamMode
  });
  if (!b) return null;
  const pane = b.document.createElement("div");
  b.document.getElementById("root").appendChild(pane);
  await b.window.App.pages.teamPermissions.render(pane, opts.memberId);
  await settle(b.window);
  return Object.assign(b, { pane, team, store });
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

test("without permission: nothing is offered and nothing is read", async (t) => {
  const b = await open({ workspaceOpts: { role: "agent", permissions: permissions() } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.match(text(b.pane), /cannot change what people can do/i);
    assert.deepEqual(b.team.calls, []);
  } finally { b.close(); }
});

test("team features off: pointed at the toggle instead", async (t) => {
  const b = await open({ teamMode: false });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.match(text(b.pane), /team features are off/i);
    assert.deepEqual(b.team.calls, []);
    b.pane.querySelector("#goTeamAccess").click();
    await settle(b.window);
    assert.deepEqual(b.navigations, ["/settings/team-access"]);
  } finally { b.close(); }
});

test("both role editors render, and say whether a role is still on its default", async (t) => {
  const b = await open({ answers: { rolePermissions: {} } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.ok(b.pane.querySelector('[data-card="role-admin"]'));
    assert.ok(b.pane.querySelector('[data-card="role-agent"]'));
    assert.match(text(b.pane.querySelector('[data-card="role-agent"] .card-title')), /Default/);
  } finally { b.close(); }
});

test("a stored template is shown as changed, and its own values are loaded", async (t) => {
  const stored = {
    agent: Object.assign(permissions(), {
      contacts: { view: "all", edit: "own", delete: "none", create: true },
      imports_file: false
    })
  };
  const b = await open({ answers: { rolePermissions: stored } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.match(text(b.pane.querySelector('[data-card="role-agent"] .card-title')), /Changed/);
    const sel = b.pane.querySelector('[data-perm-scope="role-agent"][data-area="contacts"][data-action="view"]');
    assert.equal(sel.value, "all", "the stored value is what the editor starts from");
    const imports = b.pane.querySelector('[data-perm-flag="role-agent"][data-flag="imports_file"]');
    assert.equal(imports.checked, false);
  } finally { b.close(); }
});

test("saving a role sends exactly what the editor shows", async (t) => {
  const b = await open();
  if (!b) return t.skip(SKIP_DOM);
  try {
    const sel = b.pane.querySelector('[data-perm-scope="role-agent"][data-area="deals"][data-action="view"]');
    sel.value = "all";
    const flag = b.pane.querySelector('[data-perm-flag="role-agent"][data-flag="contacts_assign"]');
    flag.checked = true;
    b.pane.querySelector('[data-save-role="agent"]').click();
    await settle(b.window);

    const call = b.team.calls.find((c) => c.name === "setRolePermissions");
    assert.equal(call.args[0], "agent");
    const sent = plain(call.args[1]);
    assert.equal(sent.deals.view, "all");
    assert.equal(sent.contacts_assign, true);
    // The whole shape travels, not just what changed: the server stores a
    // complete template.
    assert.deepEqual(Object.keys(sent).filter((k) => k === "settings"), ["settings"]);
    assert.ok(sent.properties, "every area is included");
  } finally { b.close(); }
});

test("an admin cannot offer more than they hold themselves", async (t) => {
  // This admin can only see their own finance rows and cannot manage
  // integrations, so neither may be handed to anybody else.
  const mine = adminPermissions({
    finance: { view: "own", edit: "none", delete: "none", create: false },
    integrations_manage: false
  });
  const b = await open({ workspaceOpts: { role: "admin", permissions: mine } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const opts = Array.from(b.pane.querySelectorAll('[data-perm-scope="role-agent"][data-area="finance"][data-action="view"] option'));
    const byValue = {};
    opts.forEach((o) => { byValue[o.value] = o; });
    assert.equal(byValue.none.disabled, false);
    assert.equal(byValue.own.disabled, false);
    assert.equal(byValue.all.disabled, true, "above their own level");
    assert.match(byValue.all.textContent, /above your level/i);

    const flag = b.pane.querySelector('[data-perm-flag="role-agent"][data-flag="integrations_manage"]');
    assert.equal(flag.disabled, true);
    // And the screen says why, rather than leaving a dead control.
    assert.match(text(b.pane), /only give away what you have/i);
  } finally { b.close(); }
});

test("the owner is never capped", async (t) => {
  const b = await open({ workspaceOpts: { role: "owner", permissions: adminPermissions({ settings: "view" }) } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const all = Array.from(b.pane.querySelectorAll("option")).filter((o) => o.disabled);
    assert.deepEqual(all, [], "nothing is greyed out for an owner");
    assert.equal(b.pane.querySelector("[data-perm-flag]").disabled, false);
  } finally { b.close(); }
});

test("a refused save shows the permission the server named", async (t) => {
  const b = await open({
    answers: { setRolePermissions: new Error("cannot raise your own permissions: finance.view") }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    b.pane.querySelector('[data-save-role="admin"]').click();
    await settle(b.window);
    const err = b.pane.querySelector('[data-role-error="admin"]');
    assert.equal(err.hidden, false);
    assert.match(text(err), /cannot give away more than you have: finance\.view/i);
  } finally { b.close(); }
});

test("putting a role back to default asks first, then sends the shipped preset", async (t) => {
  const b = await open();
  if (!b) return t.skip(SKIP_DOM);
  try {
    b.pane.querySelector('[data-default-role="agent"]').click();
    await settle(b.window);
    assert.deepEqual(b.team.calls.filter((c) => c.name === "setRolePermissions"), [], "not until confirmed");
    await confirmOk(b);
    const sent = plain(b.team.calls.find((c) => c.name === "setRolePermissions").args[1]);
    const preset = plain(b.window.App.pages.teamPermissions.preset("agent"));
    assert.deepEqual(sent, preset);
  } finally { b.close(); }
});

test("one person with no exceptions starts from their role template", async (t) => {
  const b = await open({
    memberId: "wm-2",
    answers: {
      listMembers: { outcome: "ok", can_manage: true, members: [member({ member_id: "wm-2", name: "Rosa Diaz", role: "agent" })] },
      rolePermissions: { agent: Object.assign(permissions(), { imports_file: false }) }
    }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const card = b.pane.querySelector('[data-card="person"]');
    assert.ok(card);
    assert.match(text(card), /Just for Rosa Diaz/);
    assert.match(text(card), /starts from what that role can do/i);
    // Starts from the role template, including its stored values.
    assert.equal(b.pane.querySelector('[data-perm-flag="member"][data-flag="imports_file"]').checked, false);

    b.pane.querySelector('[data-perm-flag="member"][data-flag="imports_file"]').checked = true;
    b.pane.querySelector("#savePerson").click();
    await settle(b.window);
    const call = b.team.calls.find((c) => c.name === "setMemberPermissions");
    assert.equal(call.args[0], "wm-2");
    assert.equal(plain(call.args[1]).imports_file, true);
    assert.deepEqual(b.navigations, ["/settings/team-access"]);
  } finally { b.close(); }
});

test("putting a person back on their role asks first, then clears their exceptions", async (t) => {
  const b = await open({
    memberId: "wm-2",
    answers: { listMembers: { outcome: "ok", can_manage: true, members: [member({ member_id: "wm-2" })] } }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    b.pane.querySelector("#resetPerson").click();
    await settle(b.window);
    assert.deepEqual(b.team.calls.filter((c) => c.name === "resetMemberPermissions"), []);
    await confirmOk(b);
    assert.deepEqual(b.team.calls.find((c) => c.name === "resetMemberPermissions").args, ["wm-2"]);
  } finally { b.close(); }
});

test("with no person chosen, the owner and the caller are not offered for exceptions", async (t) => {
  const b = await open({
    answers: {
      listMembers: {
        outcome: "ok", can_manage: true,
        members: [
          member({ member_id: "wm-own", role: "owner", name: "Olive", is_self: true }),
          member({ member_id: "wm-2", name: "Rosa Diaz" })
        ]
      }
    }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const opts = Array.from(b.pane.querySelectorAll("#personPick option")).map((o) => o.value);
    assert.deepEqual(opts, ["wm-2"]);
    b.pane.querySelector("#personPickBtn").click();
    await settle(b.window);
    assert.deepEqual(b.navigations, ["/settings/team-permissions?member=wm-2"]);
  } finally { b.close(); }
});

// ------------------------------------- T4 follow-ups

test("the exceptions editor starts from what the person actually has today", async (t) => {
  const b = await open({
    memberId: "wm-2",
    answers: {
      listMembers: {
        outcome: "ok", can_manage: true,
        members: [member({
          member_id: "wm-2", name: "Rosa Diaz", role: "agent",
          // Their role lets them import files and see only their own deals;
          // their exceptions turn imports off and widen deals to everything.
          permission_overrides: { imports_file: false, deals: { view: "all" } }
        })]
      },
      rolePermissions: { agent: permissions({ imports_file: true }) }
    }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.equal(b.pane.querySelector('[data-perm-flag="member"][data-flag="imports_file"]').checked, false,
      "the exception wins over the role");
    assert.equal(b.pane.querySelector('[data-perm-scope="member"][data-area="deals"][data-action="view"]').value, "all");
    // An area named by an exception keeps the role's other actions: the
    // override said nothing about editing deals.
    assert.equal(b.pane.querySelector('[data-perm-scope="member"][data-area="deals"][data-action="edit"]').value, "own");
    // And an area the exception never mentioned is untouched.
    assert.equal(b.pane.querySelector('[data-perm-scope="member"][data-area="goals"][data-action="view"]').value, "own");

    const card = b.pane.querySelector('[data-card="person"]');
    assert.match(text(card), /what they can do today/i);
    assert.match(text(card), /Custom permissions/);
  } finally { b.close(); }
});

test("saving an exception set sends the merged picture, so nothing is dropped by accident", async (t) => {
  const b = await open({
    memberId: "wm-2",
    answers: {
      listMembers: {
        outcome: "ok", can_manage: true,
        members: [member({ member_id: "wm-2", role: "agent", permission_overrides: { imports_file: false } })]
      },
      rolePermissions: { agent: permissions() }
    }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    // Change one unrelated thing and save: the exception that was already
    // there has to survive, because the server replaces the whole set.
    b.pane.querySelector('[data-perm-flag="member"][data-flag="templates_create_personal"]').checked = false;
    b.pane.querySelector("#savePerson").click();
    await settle(b.window);

    const sent = plain(b.team.calls.find((c) => c.name === "setMemberPermissions").args[1]);
    assert.equal(sent.imports_file, false, "the existing exception is still in the set");
    assert.equal(sent.templates_create_personal, false, "and the new change is too");
  } finally { b.close(); }
});

test("a person on their plain role says so, with no custom badge", async (t) => {
  const b = await open({
    memberId: "wm-2",
    answers: {
      listMembers: { outcome: "ok", can_manage: true, members: [member({ member_id: "wm-2", permission_overrides: {} })] }
    }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const card = b.pane.querySelector('[data-card="person"]');
    assert.match(text(card), /starts from what that role can do/i);
    assert.ok(!/Custom permissions/.test(text(card)));
  } finally { b.close(); }
});

test("merging lays exceptions over a template without losing the rest", async (t) => {
  const b = await open();
  if (!b) return t.skip(SKIP_DOM);
  try {
    const { mergeOverrides } = b.window.App.pages.teamPermissions;
    const template = { contacts: { view: "own", edit: "own", create: true }, imports_file: true, settings: "none" };
    const merged = plain(mergeOverrides(template, { contacts: { view: "all" }, settings: "view" }));
    assert.deepEqual(merged, {
      contacts: { view: "all", edit: "own", create: true },
      imports_file: true,
      settings: "view"
    });
    // Nothing to lay over is the template itself.
    assert.deepEqual(plain(mergeOverrides(template, {})), plain(template));
    assert.deepEqual(plain(mergeOverrides(template, null)), plain(template));
  } finally { b.close(); }
});
