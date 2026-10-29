// Phase T4: Settings → Team & Access.
//
// The real page script in jsdom, with App.workspace / App.customization /
// App.store.team stubbed so every permission shape and every outcome the
// database functions can return is an input. What is checked throughout:
// that a refusal becomes words rather than a crash, that a destructive
// action asks first, and that the screen never claims something happened
// that the server did not do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SKIP_DOM } from "../helpers/browser.mjs";
import {
  teamBrowser, settle, confirmOk, makeStore, makeTeamStore, makeWorkspace, plain,
  permissions, member, invitation, inDays
} from "./team-helpers.mjs";

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/app.js",
  "assets/js/pages/team-management.js"
];

async function open(opts = {}) {
  const team = opts.team || makeTeamStore(opts.answers || {});
  const store = makeStore({ team, settings: opts.settings, teamMembers: opts.teamMembers });
  const b = await teamBrowser(SCRIPTS, {
    store,
    workspace: opts.workspace || makeWorkspace(opts.workspaceOpts || {}),
    teamMode: opts.teamMode === undefined ? true : opts.teamMode
  });
  if (!b) return null;
  const pane = b.document.createElement("div");
  b.document.getElementById("root").appendChild(pane);
  await b.window.App.pages.teamManagement.render(pane);
  await settle(b.window);
  return Object.assign(b, { pane, team, store });
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

test("without permission: the page says so and asks the server for nothing", async (t) => {
  const b = await open({ workspaceOpts: { role: "agent", permissions: permissions() } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.match(text(b.pane), /cannot manage this team/i);
    // The roster call would be refused server-side, so it is never made.
    assert.deepEqual(b.team.calls, []);
    // An agent can still get themselves out.
    assert.ok(b.pane.querySelector("#leaveTeamBtn"), "leaving is still offered");
  } finally { b.close(); }
});

test("team features off: only the toggle, and turning it on saves", async (t) => {
  const b = await open({ teamMode: false });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.ok(b.pane.querySelector("#teamModeToggle"), "the toggle is there");
    assert.equal(b.pane.querySelector('[data-card="members"]'), null, "no roster while off");
    assert.deepEqual(b.team.calls, [], "and nothing is asked of the server");

    const cb = b.pane.querySelector("#teamModeToggle");
    cb.checked = true;
    cb.dispatchEvent(new b.window.Event("change"));
    await settle(b.window);
    assert.deepEqual(b.store.saved, [{ teamMode: true }]);
    assert.ok(b.refreshedNav > 0, "the sidebar is told to re-read itself");
  } finally { b.close(); }
});

test("the roster renders, and marks you without offering you actions", async (t) => {
  const b = await open({
    answers: {
      listMembers: {
        outcome: "ok", can_manage: true,
        members: [
          member({ member_id: "wm-own", name: "Owner Olive", email: "olive@example.com", role: "owner", is_self: true }),
          member({ member_id: "wm-2", name: "Rosa Diaz", email: "rosa@example.com", role: "admin" }),
          member({ member_id: "wm-3", name: "", email: "noname@example.com", role: "agent" })
        ]
      }
    }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const rows = b.pane.querySelectorAll("[data-member-row]");
    assert.equal(rows.length, 3);
    const self = b.pane.querySelector('[data-member-row="wm-own"]');
    assert.match(text(self), /You/);
    assert.equal(self.querySelector("[data-remove]"), null, "you cannot remove yourself here");
    assert.equal(self.querySelector(".member-role"), null, "nor change your own role");
    // A row with no display name still reads as somebody.
    assert.match(text(b.pane.querySelector('[data-member-row="wm-3"]')), /noname@example\.com/);
    // Only the owner may hand the workspace over, and never to themselves.
    assert.ok(b.pane.querySelector('[data-member-row="wm-2"] [data-transfer]'));
    assert.equal(self.querySelector("[data-transfer]"), null);
  } finally { b.close(); }
});

test("an admin who is not the owner cannot offer to hand the workspace over", async (t) => {
  const b = await open({
    workspaceOpts: { role: "admin" },
    answers: {
      listMembers: { outcome: "ok", can_manage: true, members: [member({ member_id: "wm-2" })] }
    }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.equal(b.pane.querySelector("[data-transfer]"), null);
    assert.ok(b.pane.querySelector("[data-remove]"), "but they may still remove people");
  } finally { b.close(); }
});

test("former members are listed separately and read-only", async (t) => {
  const b = await open({
    answers: {
      listMembers: {
        outcome: "ok", can_manage: true,
        members: [
          member({ member_id: "wm-1", is_self: true, role: "owner" }),
          member({ member_id: "wm-8", name: "Gone Greg", status: "removed" }),
          member({ member_id: "wm-9", name: "Paused Pat", status: "suspended" })
        ]
      }
    }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const card = b.pane.querySelector('[data-card="former"]');
    assert.ok(card, "the section appears when there is somebody in it");
    assert.match(text(card), /Gone Greg/);
    assert.match(text(card), /Paused Pat/);
    assert.equal(card.querySelector("[data-remove]"), null, "nothing to act on");
    assert.equal(b.pane.querySelectorAll("[data-member-row]").length, 1, "and they are not in the live list");
  } finally { b.close(); }
});

test("nobody else here yet: the empty state points at the invite form", async (t) => {
  const b = await open({
    answers: { listMembers: { outcome: "ok", can_manage: true, members: [member({ is_self: true, role: "owner" })] } }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    // One active member is the caller alone, so the roster card still lists
    // them; the invite card is what the screen leads with.
    assert.ok(b.pane.querySelector('[data-card="invite"]'));
    assert.match(text(b.pane.querySelector('[data-card="invitations"]')), /No invites yet/i);
  } finally { b.close(); }
});

test("inviting shows the link exactly once, and copying it works", async (t) => {
  const token = "a".repeat(64);
  const b = await open({
    answers: {
      invite: { outcome: "invited", invitation_id: "inv-7", token, email: "new@example.com", role: "agent", expires_at: inDays(7) }
    }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const copied = [];
    b.window.navigator.clipboard = { writeText: async (t2) => { copied.push(t2); } };

    b.pane.querySelector("#inviteEmail").value = "New@Example.com";
    b.pane.querySelector("#inviteRole").value = "agent";
    b.pane.querySelector("#inviteBtn").click();
    await settle(b.window);

    const call = b.team.calls.find((c) => c.name === "invite");
    assert.deepEqual(call.args, ["New@Example.com", "agent"]);

    const panel = b.pane.querySelector('[data-panel="invite-link"]');
    assert.ok(panel, "the link panel is shown");
    const link = b.pane.querySelector("#inviteLink").value;
    assert.ok(link.includes("#/join?token=" + token), "the link carries the token in the hash");
    // Shown once, and the panel has to say so.
    assert.match(text(panel), /only time the link is shown/i);
    assert.match(text(panel), /new@example\.com/);
    // The token appears in the field and nowhere else twice over.
    assert.equal(b.pane.innerHTML.split(token).length - 1, 1);

    b.pane.querySelector("#copyInviteLink").click();
    await settle(b.window);
    assert.deepEqual(copied, [link]);
    assert.match(text(b.pane.querySelector("#copyState")), /copied/i);

    b.pane.querySelector("#dismissInviteLink").click();
    await settle(b.window);
    assert.equal(b.pane.querySelector('[data-panel="invite-link"]'), null, "dismissing is deliberate");
  } finally { b.close(); }
});

test("copying falls back when the clipboard is unavailable, and still says what happened", async (t) => {
  const b = await open();
  if (!b) return t.skip(SKIP_DOM);
  try {
    b.window.navigator.clipboard = { writeText: async () => { throw new Error("blocked"); } };
    b.document.execCommand = () => false;
    b.pane.querySelector("#inviteEmail").value = "new@example.com";
    b.pane.querySelector("#inviteBtn").click();
    await settle(b.window);
    b.pane.querySelector("#copyInviteLink").click();
    await settle(b.window);
    assert.match(text(b.pane.querySelector("#copyState")), /copy it by hand/i);
  } finally { b.close(); }
});

test("every invite refusal becomes a message, and the address is kept", async (t) => {
  const cases = [
    ["invalid_email", /does not look like an email address/i],
    ["already_a_member", /already in this workspace/i],
    ["already_invited", /already have an invite waiting/i]
  ];
  for (const [outcome, pattern] of cases) {
    const b = await open({ answers: { invite: { outcome } } });
    if (!b) return t.skip(SKIP_DOM);
    try {
      b.pane.querySelector("#inviteEmail").value = "someone@example.com";
      b.pane.querySelector("#inviteBtn").click();
      await settle(b.window);
      const err = b.pane.querySelector("#inviteError");
      assert.equal(err.hidden, false, outcome + " is reported");
      assert.match(text(err), pattern);
      assert.equal(b.pane.querySelector("#inviteEmail").value, "someone@example.com",
        "the address they typed is still there");
      assert.equal(b.pane.querySelector('[data-panel="invite-link"]'), null, "and no link is shown");
    } finally { b.close(); }
  }
});

test("a thrown invite is reported as a refusal, not as a crash", async (t) => {
  const b = await open({ answers: { invite: new Error("team_manage permission required") } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    b.pane.querySelector("#inviteEmail").value = "x@example.com";
    b.pane.querySelector("#inviteBtn").click();
    await settle(b.window);
    assert.match(text(b.pane.querySelector("#inviteError")), /only an owner or admin can invite/i);
  } finally { b.close(); }
});

test("invitations list: expiry in plain words, revoke only where it applies", async (t) => {
  const b = await open({
    answers: {
      listInvitations: {
        outcome: "ok",
        invitations: [
          invitation({ id: "inv-p", status: "pending", expires_at: inDays(5) }),
          invitation({ id: "inv-e", status: "pending", expires_at: inDays(-1) }),
          invitation({ id: "inv-a", status: "accepted", email: "joined@example.com" }),
          invitation({ id: "inv-r", status: "revoked", email: "cancelled@example.com" })
        ]
      }
    }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const card = b.pane.querySelector('[data-card="invitations"]');
    assert.match(text(card), /Expires in 5 days/);
    assert.ok(b.pane.querySelector('[data-revoke="inv-p"]'), "a waiting invite can be cancelled");
    // A pending row past its date is reported as expired by the server's own
    // status, and still offers a way to clear it.
    assert.ok(b.pane.querySelector('[data-revoke="inv-e"]'));
    assert.equal(b.pane.querySelector('[data-revoke="inv-a"]'), null, "an accepted one is history");
    assert.equal(b.pane.querySelector('[data-revoke="inv-r"]'), null);
    assert.match(text(card), /Joined/);
  } finally { b.close(); }
});

test("revoking an invitation that was already accepted points at the roster instead", async (t) => {
  const b = await open({
    answers: {
      listInvitations: { outcome: "ok", invitations: [invitation({ id: "inv-1" })] },
      revokeInvitation: { outcome: "already_accepted" }
    }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    b.pane.querySelector('[data-revoke="inv-1"]').click();
    await settle(b.window);
    assert.match(b.toasts.map((x) => x.message).join(" "), /already joined/i);
  } finally { b.close(); }
});

test("changing a role: the refusal says which permission blocked it, and puts the list back", async (t) => {
  const b = await open({
    answers: {
      listMembers: { outcome: "ok", can_manage: true, members: [member({ member_id: "wm-2", role: "agent" })] },
      changeRole: { outcome: "exceeds_your_permissions", role: "admin", reason: "finance.view" }
    }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const sel = b.pane.querySelector(".member-role");
    sel.value = "admin";
    sel.dispatchEvent(new b.window.Event("change"));
    await settle(b.window);
    const said = b.toasts.map((x) => x.message).join(" ");
    assert.match(said, /cannot give somebody more than you have/i);
    assert.match(said, /finance\.view/, "the server's reason is passed through");
    assert.equal(b.pane.querySelector(".member-role").value, "agent", "the list shows what the server did");
  } finally { b.close(); }
});

test("removing a member asks first, and only then calls the server", async (t) => {
  const b = await open({
    answers: { listMembers: { outcome: "ok", can_manage: true, members: [member({ member_id: "wm-2", name: "Rosa Diaz" })] } }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    b.pane.querySelector("[data-remove]").click();
    await settle(b.window);
    assert.equal(b.team.calls.filter((c) => c.name === "remove").length, 0, "nothing happens on the click alone");
    const dialog = b.document.querySelector(".modal");
    assert.match(text(dialog), /Remove Rosa Diaz/);
    assert.match(text(dialog), /become unassigned/i, "the confirmation says what happens to their work");

    await confirmOk(b);
    const call = b.team.calls.find((c) => c.name === "remove");
    assert.deepEqual(call.args, ["wm-2"]);
    assert.ok(b.team.calls.filter((c) => c.name === "listMembers").length >= 2, "and the list is read again");
  } finally { b.close(); }
});

test("handing the workspace over says the caller becomes an admin", async (t) => {
  const b = await open({
    answers: { listMembers: { outcome: "ok", can_manage: true, members: [member({ member_id: "wm-2", name: "Rosa Diaz" })] } }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    b.pane.querySelector("[data-transfer]").click();
    await settle(b.window);
    assert.match(text(b.document.querySelector(".modal")), /you become an admin/i);
    await confirmOk(b);
    assert.deepEqual(b.team.calls.find((c) => c.name === "transferOwnership").args, ["wm-2"]);
    assert.match(b.toasts.map((x) => x.message).join(" "), /now the owner/i);
  } finally { b.close(); }
});

test("leaving spells out the consequences, then lands you in your own workspace", async (t) => {
  const b = await open({ workspaceOpts: { role: "admin" } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    b.pane.querySelector("#leaveTeamBtn").click();
    await settle(b.window);
    const dialog = text(b.document.querySelector(".modal"));
    assert.match(dialog, /become unassigned/i);
    assert.match(dialog, /goes to the owner/i);
    assert.match(dialog, /cannot undo this yourself/i);

    await confirmOk(b);
    assert.equal(b.team.calls.filter((c) => c.name === "leave").length, 1);
    assert.deepEqual(b.navigations, ["/dashboard"]);
  } finally { b.close(); }
});

test("the owner is not offered Leave at all", async (t) => {
  const b = await open({ workspaceOpts: { role: "owner" } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.equal(b.pane.querySelector("#leaveTeamBtn"), null);
    assert.ok(b.pane.querySelector("#deleteTeamBtn"), "they get the delete path instead");
  } finally { b.close(); }
});

test("deleting the team needs the name typed, and never fills it in for you", async (t) => {
  const b = await open({ answers: { deleteTeam: { outcome: "name_mismatch", expected_name: "Diaz Realty" } } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    b.pane.querySelector("#deleteTeamBtn").click();
    await settle(b.window);

    // Empty: nothing is sent at all.
    b.document.querySelector('.modal [data-role="ok"]').click();
    await settle(b.window);
    assert.deepEqual(b.team.calls.filter((c) => c.name === "deleteTeam"), []);
    assert.match(text(b.document.querySelector("#deleteError")), /type the workspace name/i);

    b.document.querySelector("#deleteConfirmName").value = "diaz realty";
    b.document.querySelector('.modal [data-role="ok"]').click();
    await settle(b.window);
    assert.deepEqual(b.team.calls.find((c) => c.name === "deleteTeam").args, ["diaz realty"]);
    assert.match(text(b.document.querySelector("#deleteError")), /did not match/i);
    // The expected name is never shown or pre-filled: the typing is the guard.
    assert.ok(!b.document.querySelector(".modal").innerHTML.includes("Diaz Realty"));
    assert.equal(b.document.querySelector("#deleteConfirmName").value, "diaz realty");
  } finally { b.close(); }
});

test("deleting with other people still in the team says how many to remove", async (t) => {
  const b = await open({ answers: { deleteTeam: { outcome: "other_members_present", active_members: 2 } } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    b.pane.querySelector("#deleteTeamBtn").click();
    await settle(b.window);
    b.document.querySelector("#deleteConfirmName").value = "Anything";
    b.document.querySelector('.modal [data-role="ok"]').click();
    await settle(b.window);
    assert.match(text(b.document.querySelector("#deleteError")), /remove the other 2 people first/i);
  } finally { b.close(); }
});

test("a successful delete leaves for the dashboard", async (t) => {
  const b = await open();
  if (!b) return t.skip(SKIP_DOM);
  try {
    b.pane.querySelector("#deleteTeamBtn").click();
    await settle(b.window);
    b.document.querySelector("#deleteConfirmName").value = "Diaz Realty";
    b.document.querySelector('.modal [data-role="ok"]').click();
    await settle(b.window);
    assert.deepEqual(b.navigations, ["/dashboard"]);
  } finally { b.close(); }
});

test("a roster that will not load offers a retry rather than half a list", async (t) => {
  const b = await open({ answers: { listMembers: new Error("network") } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.equal(b.pane.querySelector("[data-member-row]"), null);
    const retry = b.pane.querySelector('[data-role="route-retry"]');
    assert.ok(retry, "a retry is offered");
    retry.click();
    await settle(b.window);
    assert.ok(b.team.calls.filter((c) => c.name === "listMembers").length >= 2, "and it tries again");
  } finally { b.close(); }
});

test("a left-over restricted view can be cleared from here", async (t) => {
  const b = await open({
    settings: { currentTeamMemberId: "tm-7" },
    teamMembers: [{ id: "tm-7", name: "Old View", active: true }]
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const card = b.pane.querySelector('[data-card="viewing-as"]');
    assert.ok(card, "the row shows only because the value is set");
    assert.match(text(card), /Old View/);
    b.pane.querySelector("#clearViewingAs").click();
    await settle(b.window);
    // Values made inside the jsdom realm are never reference-equal to ours.
    assert.deepEqual(plain(b.store.saved[0]), { settings: { currentTeamMemberId: null } });
  } finally { b.close(); }
});

test("no restricted view set: the row is absent entirely", async (t) => {
  const b = await open();
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.equal(b.pane.querySelector('[data-card="viewing-as"]'), null);
  } finally { b.close(); }
});

// ------------------------------------- T4 follow-ups

test("a member with exceptions is badged, and one without is not", async (t) => {
  const b = await open({
    answers: {
      listMembers: {
        outcome: "ok", can_manage: true,
        members: [
          member({ member_id: "wm-1", is_self: true, role: "owner", permission_overrides: {} }),
          member({ member_id: "wm-2", name: "Rosa Diaz", permission_overrides: { imports_file: false } }),
          member({ member_id: "wm-3", name: "Plain Pete", permission_overrides: {} })
        ]
      }
    }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.match(text(b.pane.querySelector('[data-member-row="wm-2"]')), /Custom permissions/);
    assert.ok(!/Custom permissions/.test(text(b.pane.querySelector('[data-member-row="wm-3"]'))));
  } finally { b.close(); }
});

test("a roster without the overrides field badges nobody", async (t) => {
  // An agent's roster leaves the field out entirely, which must read as
  // "not my business" rather than as "everybody is on their role".
  const b = await open({
    answers: {
      listMembers: { outcome: "ok", can_manage: false, members: [member({ member_id: "wm-2" })] }
    }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.ok(!/Custom permissions/.test(text(b.pane)));
    const { hasOverrides } = b.window.App.pages.teamManagement;
    assert.equal(hasOverrides({}), false);
    assert.equal(hasOverrides({ permission_overrides: {} }), false);
    assert.equal(hasOverrides({ permission_overrides: { a: 1 } }), true);
  } finally { b.close(); }
});

test("the server's refusal to switch team mode off is put in plain words", async (t) => {
  const b = await open();
  if (!b) return t.skip(SKIP_DOM);
  try {
    const { teamModeError } = b.window.App.pages.teamManagement;
    assert.match(teamModeError(new Error("team_mode_has_members")),
      /remove other members before turning team mode off/i);
    assert.match(teamModeError({ code: "team_mode_has_members" }),
      /remove other members/i);
    // Anything else still says what went wrong rather than guessing.
    assert.match(teamModeError(new Error("network down")), /network down/);
  } finally { b.close(); }
});

test("turning team mode off against a refusal leaves the switch on", async (t) => {
  const store = makeStore({ team: makeTeamStore() });
  store.settings.setTeamMode = async () => { throw new Error("team_mode_has_members"); };
  const b = await teamBrowser(SCRIPTS, { store, workspace: makeWorkspace({ role: "owner" }), teamMode: true });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const pane = b.document.createElement("div");
    b.document.getElementById("root").appendChild(pane);
    await b.window.App.pages.teamManagement.render(pane);
    await settle(b.window);

    const cb = pane.querySelector("#teamModeToggle");
    cb.checked = false;
    cb.dispatchEvent(new b.window.Event("change"));
    await settle(b.window);

    assert.equal(cb.checked, true, "the switch shows what the server did, which is nothing");
    assert.equal(cb.disabled, false, "and it can be tried again");
    assert.match(b.toasts.map((x) => x.message).join(" "), /remove other members/i);
  } finally { b.close(); }
});

test("manager areas reuse workflows and use effective assignment permissions", async t => {
  for (const assign of [false, true]) {
    const b = await open({ workspaceOpts: { role: "agent", permissions: permissions({ team_manage: true, contacts_assign: assign }) } });
    assert.ok(b);
    try {
      assert.deepEqual(Array.from(b.pane.querySelectorAll("section[aria-label]"), el => el.getAttribute("aria-label")),
        ["Members", "Invitations", "Assignments", "Permissions"]);
      assert.equal(b.pane.querySelectorAll("[data-go-permissions]").length, 1);
      assert.equal(b.pane.querySelectorAll("#inviteBtn").length, 1);
      assert.equal(!!b.pane.querySelector("[data-go-assignments]"), assign);
      b.pane.querySelector("[data-go-workload]").click();
      assert.equal(b.navigations.at(-1), "/team");
      b.pane.querySelector("[data-go-permissions]").click();
      assert.equal(b.navigations.at(-1), "/settings/team-permissions");
      if (assign) {
        b.pane.querySelector("[data-go-assignments]").click();
        assert.equal(b.navigations.at(-1), "/contacts");
      }
    } finally { b.close(); }
  }
});

test("solo and non-manager screens omit manager areas while preserving setup and leave", async t => {
  const solo = await open({ teamMode: false });
  assert.ok(solo);
  try {
    assert.equal(solo.pane.querySelector("section[aria-label]"), null);
    assert.ok(solo.pane.querySelector("#teamModeToggle"));
    assert.deepEqual(solo.team.calls, []);
  } finally { solo.close(); }
  const memberView = await open({ workspaceOpts: { role: "admin", permissions: permissions() } });
  assert.ok(memberView);
  try {
    assert.equal(memberView.pane.querySelector("section[aria-label]"), null);
    assert.equal(memberView.pane.querySelector("[data-go-permissions]"), null);
    assert.equal(memberView.pane.querySelector("#inviteBtn"), null);
    assert.ok(memberView.pane.querySelector("#leaveTeamBtn"));
    assert.deepEqual(memberView.team.calls, []);
  } finally { memberView.close(); }
});
