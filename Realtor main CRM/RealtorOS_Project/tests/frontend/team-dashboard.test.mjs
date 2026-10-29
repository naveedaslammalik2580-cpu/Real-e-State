// Phase T4: the Team page.
//
// One row per person, counted from the records this account can see. The
// counting is the whole point of the page, so that is what is checked -
// along with the page staying out of the way when team features are off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SKIP_DOM } from "../helpers/browser.mjs";
import {
  teamBrowser, settle, makeStore, makeTeamStore, makeWorkspace,
  adminPermissions, permissions, member
} from "./team-helpers.mjs";

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/app.js",
  "assets/js/pages/team-dashboard.js"
];

const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

async function open(opts = {}) {
  const team = opts.team || makeTeamStore(opts.answers || {});
  const store = makeStore({
    team,
    contacts: opts.contacts || [],
    deals: opts.deals || [],
    tasks: opts.tasks || []
  });
  const b = await teamBrowser(SCRIPTS, {
    store,
    workspace: opts.workspace || makeWorkspace({ role: "owner", permissions: adminPermissions(), teamMemberId: "tm-1" }),
    teamMode: opts.teamMode === undefined ? true : opts.teamMode
  });
  if (!b) return null;
  const page = b.document.createElement("div");
  b.document.getElementById("root").appendChild(page);
  await b.window.App.pages.teamDashboard.render(page);
  await settle(b.window);
  return Object.assign(b, { page, team, store });
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
const cells = (row) => Array.from(row.querySelectorAll("td")).map((td) => text(td));

test("team features off: the page explains and points at the setting", async (t) => {
  const b = await open({ teamMode: false });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.match(text(b.page), /team features are off/i);
    assert.deepEqual(b.team.calls, [], "and the roster is never asked for");
    b.page.querySelector("#teamGoSettings").click();
    await settle(b.window);
    assert.deepEqual(b.navigations, ["/settings/team-access"]);
  } finally { b.close(); }
});

test("each person's load is counted from the records on hand", async (t) => {
  const b = await open({
    answers: {
      listMembers: {
        outcome: "ok", can_manage: true,
        members: [
          member({ member_id: "wm-1", team_member_id: "tm-1", name: "Olive Owner", role: "owner", is_self: true }),
          member({ member_id: "wm-2", team_member_id: "tm-2", name: "Rosa Diaz", role: "agent" })
        ]
      }
    },
    contacts: [
      { id: "ct-1", assignedToId: "tm-1" },
      { id: "ct-2", assignedToId: "tm-2" },
      { id: "ct-3", assignedToId: "tm-2" },
      { id: "ct-4", assignedToId: null }
    ],
    tasks: [
      { id: "tk-1", assignedToId: "tm-2", status: "To Do", dueDate: iso(-2) },
      { id: "tk-2", assignedToId: "tm-2", status: "To Do", dueDate: iso(3) },
      { id: "tk-3", assignedToId: "tm-2", status: "Completed", dueDate: iso(-5) },
      { id: "tk-4", assignedToId: "tm-1", status: "To Do", dueDate: null }
    ],
    deals: [
      { id: "dl-1", assignedToId: "tm-2", stage: "Active" },
      { id: "dl-2", assignedToId: "tm-2", stage: "Won" },
      { id: "dl-3", assignedToId: "tm-1", stage: "Offer" }
    ]
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const rows = Array.from(b.page.querySelectorAll("tbody tr"));
    assert.equal(rows.length, 2);

    const olive = cells(rows[0]);
    assert.match(olive[0], /Olive Owner/);
    assert.match(olive[0], /You/);
    assert.deepEqual(olive.slice(1), ["1", "1", "0", "1"]);

    const rosa = cells(rows[1]);
    assert.match(rosa[0], /Rosa Diaz/);
    // 2 leads; 2 open tasks (the completed one does not count); 1 of them
    // late; 1 deal still in progress (Won does not count).
    assert.deepEqual(rosa.slice(1), ["2", "2", "1", "1"]);
  } finally { b.close(); }
});

test("leads nobody owns are surfaced, with a way into them", async (t) => {
  const b = await open({
    answers: { listMembers: { outcome: "ok", can_manage: true, members: [member({ team_member_id: "tm-1" })] } },
    contacts: [{ id: "ct-1", assignedToId: null }, { id: "ct-2", assignedToId: null }, { id: "ct-3", assignedToId: "tm-1" }]
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.match(text(b.page), /2 leads nobody owns/i);
    b.page.querySelector("#teamGoUnassigned").click();
    await settle(b.window);
    assert.deepEqual(b.navigations, ["/contacts"]);
  } finally { b.close(); }
});

test("nothing unowned: that card is absent rather than showing a zero", async (t) => {
  const b = await open({
    answers: { listMembers: { outcome: "ok", can_manage: true, members: [member({ team_member_id: "tm-1" })] } },
    contacts: [{ id: "ct-1", assignedToId: "tm-1" }]
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.equal(b.page.querySelector("#teamGoUnassigned"), null);
    assert.ok(!/nobody owns/i.test(text(b.page)));
  } finally { b.close(); }
});

test("a member with no directory row counts as carrying nothing, not as a crash", async (t) => {
  const b = await open({
    answers: {
      listMembers: { outcome: "ok", can_manage: true, members: [member({ team_member_id: null, name: "Pending Pat" })] }
    },
    contacts: [{ id: "ct-1", assignedToId: "tm-1" }]
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const row = b.page.querySelector("tbody tr");
    assert.match(text(row), /Pending Pat/);
    assert.deepEqual(cells(row).slice(1), ["0", "0", "0", "0"]);
  } finally { b.close(); }
});

test("somebody without team_manage still sees the page, without the manage button", async (t) => {
  const b = await open({
    workspace: makeWorkspace({ role: "agent", teamMemberId: "tm-1", permissions: permissions({ unassigned_view: true }) }),
    answers: { listMembers: { outcome: "ok", can_manage: false, members: [member({ team_member_id: "tm-1" })] } }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.ok(b.page.querySelector("tbody tr"), "the roster still renders");
    assert.equal(b.page.querySelector("#teamManageBtn"), null);
  } finally { b.close(); }
});

test("a roster that will not load offers a retry", async (t) => {
  const b = await open({ answers: { listMembers: new Error("network") } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.equal(b.page.querySelector("tbody tr"), null);
    const retry = b.page.querySelector('[data-role="route-retry"]');
    assert.ok(retry);
    retry.click();
    await settle(b.window);
    assert.ok(b.team.calls.filter((c) => c.name === "listMembers").length >= 2);
  } finally { b.close(); }
});

test("an empty roster says so plainly", async (t) => {
  const b = await open({ answers: { listMembers: { outcome: "ok", can_manage: true, members: [] } } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.match(text(b.page), /nobody to show yet/i);
  } finally { b.close(); }
});
