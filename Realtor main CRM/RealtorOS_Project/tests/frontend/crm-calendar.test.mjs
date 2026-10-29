// Calendar: one month, everything dated in it, and the day an agent
// clicks on.
//
// The calendar invents nothing - it is a view over showings, tasks,
// closings and milestones that already exist. So what is worth pinning
// is that each of those four reaches the grid, on the right day, and
// that a month with nothing in it says so instead of rendering blank.
import { test } from "node:test";
import assert from "node:assert/strict";
import { page, domTest, settle } from "./crm-helpers.mjs";

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/commission.js",
  "assets/js/core/derived.js",
  "assets/js/core/customization.js",
  "assets/js/app.js",
  "assets/js/pages/calendar.js",
];

const TODAY = "2026-10-15";

async function cal(seed) {
  const p = await page(SCRIPTS, Object.assign({ today: TODAY }, seed));
  if (!p) return null;
  await p.window.App.pages.calendar.render(p.pane);
  await settle(p.window);
  return p;
}

const dom = (name, fn) => domTest(test, SCRIPTS, name, fn);

dom("an empty month is a month with no events, and the agenda says so", async () => {
  const p = await cal({ showings: [], tasks: [], deals: [], milestones: [] });
  // The grid is still a grid - a calendar with nothing on it is a
  // calendar, not an error - but it carries no events.
  assert.match(p.text(), /October 2026/i);
  assert.equal(p.pane.querySelectorAll(".cal-event").length, 0);
  // The agenda is the view that has something to say about emptiness.
  p.pane.querySelector("#calAgenda").click();
  await settle(p.window);
  assert.match(p.text(), /Nothing this month/i, p.text());
});

dom("a showing lands on its own day, with the contact it belongs to", async () => {
  const p = await cal({
    contacts: [{ id: "ct_1", name: "Sarah Khan", role: "Buyer", stage: "Client" }],
    properties: [{ id: "pr_1", address: "12 Elm Road", status: "Active" }],
    showings: [{
      id: "sh_1", contactId: "ct_1", propertyId: "pr_1",
      date: "2026-10-20", time: "14:00", status: "Scheduled", notes: "",
    }],
  });
  assert.match(p.text(), /Sarah Khan|12 Elm Road/,
    "the showing is on the calendar: " + p.text().slice(0, 300));
  assert.match(p.text(), /October 2026/i, "in the month it belongs to");
});

dom("tasks, closings and milestones all reach the same grid", async () => {
  const p = await cal({
    contacts: [{ id: "ct_1", name: "Sarah Khan", role: "Buyer", stage: "Client" }],
    tasks: [{ id: "tk_1", title: "Call the surveyor", dueDate: "2026-10-18",
              status: "To Do", priority: "High" }],
    deals: [{ id: "dl_1", name: "Khan — 12 Elm Road", contactId: "ct_1", stage: "Under Contract",
              salePrice: 500000, commissionRate: 3, closeDate: "2026-10-28", probability: 85 }],
    // A milestone's label is `name` - calendar.js reads m.name, and a
    // fixture calling it `title` is how this test first went green on a
    // chip that said "undefined".
    milestones: [{ id: "ms_1", dealId: "dl_1", name: "Survey booked",
                   dueDate: "2026-10-22", status: "Pending", order: 1 }],
  });
  const shown = p.text();
  assert.match(shown, /Call the surveyor/, "a task");
  assert.match(shown, /Clos/i, "a closing");
  assert.match(shown, /Survey booked/, "and a milestone");
  assert.equal(p.pane.querySelectorAll(".cal-event").length, 3,
    "three events, each on its own day: " + shown);
  assert.ok(!/undefined/.test(shown), "and every chip has a label");
});

dom("the month moves, and Today comes back to this one", async () => {
  const p = await cal({
    tasks: [
      { id: "tk_oct", title: "October task", dueDate: "2026-10-18", status: "To Do", priority: "High" },
      { id: "tk_nov", title: "November task", dueDate: "2026-11-05", status: "To Do", priority: "High" },
    ],
  });
  assert.match(p.text(), /October task/);
  assert.ok(!/November task/.test(p.text()), "next month's work is not in this month");

  p.pane.querySelector("#calNext").click();
  await settle(p.window);
  assert.match(p.text(), /November 2026/i);
  assert.match(p.text(), /November task/);
  assert.ok(!/October task/.test(p.text()));

  p.pane.querySelector("#calPrev").click();
  await settle(p.window);
  assert.match(p.text(), /October 2026/i);

  p.pane.querySelector("#calNext").click();
  await settle(p.window);
  p.pane.querySelector("#calToday").click();
  await settle(p.window);
  assert.match(p.text(), /October 2026/i, "Today is one press, from wherever you wandered to");
});

dom("what somebody typed into a showing is escaped", async () => {
  const p = await cal({
    contacts: [{ id: "ct_1", name: '<img src=x onerror="window.__pwned=1">', role: "Buyer", stage: "Client" }],
    showings: [{ id: "sh_1", contactId: "ct_1", propertyId: null,
                 date: "2026-10-20", time: "14:00", status: "Scheduled", notes: "" }],
  });
  assert.equal(p.pane.querySelectorAll("img").length, 0);
  assert.equal(p.window.__pwned, undefined);
});
