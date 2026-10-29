// Tasks: creating one, completing one, and what counts as overdue.
//
// Overdue is the only thing on this page with a rule rather than a
// value, and it is the one an agent trusts: a task that stops appearing
// in the overdue count is a task that silently stops being chased.
import { test } from "node:test";
import assert from "node:assert/strict";
import { page, domTest, setField, writesOf, plain, settle } from "./crm-helpers.mjs";

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/commission.js",
  "assets/js/core/derived.js",
  "assets/js/core/customization.js",
  "assets/js/ui/custom-fields-ui.js",
  "assets/js/app.js",
  "assets/js/pages/tasks.js",
];

const TODAY = "2026-10-15";

const task = (over = {}) => Object.assign({
  id: "tk_" + Math.random().toString(36).slice(2, 8),
  title: "Call Sarah back", status: "To Do", priority: "Medium",
  dueDate: TODAY, contactId: null, dealId: null, propertyId: null,
  assignedToId: null, notes: "", createdAt: "2026-10-01T00:00:00Z",
}, over);

async function board(tasks, contacts = []) {
  const p = await page(SCRIPTS, { tasks, contacts, today: TODAY });
  if (!p) return null;
  await p.window.App.pages.tasks.render(p.pane);
  await settle(p.window);
  return p;
}

const rows = (p) => Array.from(p.pane.querySelectorAll("[data-task-id]"));
const titles = (p) => rows(p).map((r) => r.textContent.replace(/\s+/g, " ").trim());
const dom = (name, fn) => domTest(test, SCRIPTS, name, fn);

dom("an empty list says so, and a full one lists every task", async () => {
  const empty = await board([]);
  assert.match(empty.text(), /No tasks|first task/i, empty.text());

  const p = await board([
    task({ id: "tk_1", title: "Call Sarah back" }),
    task({ id: "tk_2", title: "Send the Elm Road pack", dueDate: "2026-10-20" }),
  ]);
  assert.equal(rows(p).length, 2);
  assert.match(p.text(), /Call Sarah back/);
  assert.match(p.text(), /Send the Elm Road pack/);
});

dom("overdue is yesterday and unfinished, not merely old", async () => {
  const p = await board([
    task({ id: "late", title: "Late one", dueDate: "2026-10-01" }),
    task({ id: "today", title: "Due today", dueDate: TODAY }),
    task({ id: "soon", title: "Due soon", dueDate: "2026-10-20" }),
    task({ id: "done", title: "Late but finished", dueDate: "2026-09-01", status: "Completed" }),
    task({ id: "someday", title: "No date at all", dueDate: null }),
  ]);

  // The count at the top is the number an agent reads first.
  const overdueCard = Array.from(p.pane.querySelectorAll(".stat-card"))
    .find((c) => /Overdue/.test(c.textContent));
  assert.ok(overdueCard, "there is an overdue figure");
  assert.match(overdueCard.textContent, /1/,
    "one: finished does not count, and neither does today or no date at all");

  // And the filter agrees with the count.
  setField(p.document, "#tStatus", "overdue");
  await settle(p.window);
  assert.deepEqual(titles(p).map((t) => t.split(" ·")[0].replace(/ Overdue$/, "").trim()).filter(Boolean).length, 1);
  assert.match(p.text(), /Late one/);
  assert.ok(!/Late but finished/.test(p.text()), "a completed task is not overdue, however late");
  assert.ok(!/No date at all/.test(p.text()), "and a task with no date can never be late");
});

dom("creating a task saves the title, date and priority", async () => {
  const p = await board([]);
  p.pane.querySelector("#addTaskBtn").click();
  await settle(p.window);
  const m = p.modal();
  assert.ok(m, "the form opened");

  setField(m, "#tfTitle", "  Call Sarah back  ");
  setField(m, "#tfDue", "2026-10-20");
  setField(m, "#tfPri", "High");
  setField(m, "#tfNotes", "She asked about the garden.");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  const created = writesOf(p, "tasks.create");
  assert.equal(created.length, 1, JSON.stringify(p.writes));
  const model = plain(created[0][1]);
  assert.equal(model.title, "Call Sarah back", "trimmed");
  assert.equal(model.dueDate, "2026-10-20");
  assert.equal(model.priority, "High");
  assert.equal(model.notes, "She asked about the garden.");
});

dom("a task with no title is refused", async () => {
  const p = await board([]);
  p.pane.querySelector("#addTaskBtn").click();
  await settle(p.window);
  const m = p.modal();
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(writesOf(p, "tasks.create").length, 0, "nothing written without a title");
});

dom("ticking a task completes it, and ticking again puts it back", async () => {
  const p = await board([task({ id: "tk_1", title: "Call Sarah back", status: "To Do" })]);
  const toggle = p.pane.querySelector("[data-toggle]");
  assert.ok(toggle, "there is something to tick");

  toggle.click();
  await settle(p.window);
  let writes = p.writes.filter((w) => w[0] === "tasks.update" || w[0] === "tasks.complete");
  assert.equal(writes.length, 1, "one write: " + JSON.stringify(p.writes));
  assert.equal(p.state.tasks[0].status, "Completed");

  // The page re-renders itself through App.app.route() after a write;
  // here the render is driven directly, which is the same thing minus
  // the router.
  await p.window.App.pages.tasks.render(p.pane);
  await settle(p.window);
  p.pane.querySelector("[data-toggle]").click();
  await settle(p.window);
  assert.equal(p.state.tasks[0].status, "To Do", "a mis-tick is undoable");
});

dom("a task's own text is escaped on the way to the screen", async () => {
  const p = await board([task({ id: "tk_x", title: '<img src=x onerror="window.__pwned=1">' })]);
  assert.equal(p.pane.querySelectorAll("img").length, 0);
  assert.equal(p.window.__pwned, undefined);
  assert.ok(p.html().includes("&lt;img"), "escaped: " + p.html().slice(0, 200));
});
