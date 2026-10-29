// Phase T4: who owns a lead, on the Contacts page.
//
// The assignment controls are additions to a page a single agent already
// uses every day, so the first thing checked is that a workspace which
// never turns team features on sees the page exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SKIP_DOM } from "../helpers/browser.mjs";
import { teamBrowser, settle, confirmOk, makeWorkspace, adminPermissions, permissions, plain } from "./team-helpers.mjs";

// The real derived/commission helpers rather than stubs: the Contacts list
// calls into them for every row, and a thin stub only hides breakage.
const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/commission.js",
  "assets/js/core/derived.js",
  "assets/js/app.js",
  "assets/js/pages/contacts.js"
];

function contact(over = {}) {
  return Object.assign({
    id: "ct-1", name: "Lead One", role: "Buyer", stage: "New Lead", temperature: "Warm",
    source: "Referral", phone: "555", email: "one@example.com",
    assignedAgent: "Self", assignedToId: null, nextFollowUp: null, lastContact: null,
    budget: 0, preferredArea: "", notes: "", createdAt: "2026-01-01T00:00:00Z"
  }, over);
}

function makeContactsStore(contacts, opts = {}) {
  const updates = [];
  const state = {
    contacts,
    settings: {
      contactStages: ["New Lead", "Working"],
      leadSources: ["Referral", "Website"],
      currency: "USD",
      customization: {}
    },
    teamMembers: opts.teamMembers || [
      { id: "tm-self", name: "Me Myself", active: true },
      { id: "tm-2", name: "Rosa Diaz", active: true },
      { id: "tm-old", name: "Gone Greg", active: false }
    ],
    properties: [], deals: [], activities: [], tasks: [], showings: [], referrals: []
  };
  return {
    updates,
    state,
    ensureLoaded: async () => {},
    getState: () => state,
    contacts: {
      update: async (id, patch) => {
        updates.push({ id, patch });
        if (opts.failUpdate) throw new Error("refused");
        // Lets a test refuse one row out of a batch, which is the case the
        // per-row assignment check actually produces.
        if (opts.onContactUpdate) opts.onContactUpdate(id, patch);
        const c = state.contacts.find((x) => x.id === id);
        if (c) Object.assign(c, patch);
        return c;
      }
    },
    customFields: {
      activeDefinitionsFor: () => [],
      valuesFor: async () => [],
      definitionsFor: () => []
    }
  };
}

async function open(opts = {}) {
  const store = makeContactsStore(opts.contacts || [contact()], opts);
  const b = await teamBrowser(SCRIPTS, {
    store,
    workspace: opts.workspace || makeWorkspace({ role: "admin", permissions: adminPermissions(), teamMemberId: "tm-self" }),
    teamMode: opts.teamMode === undefined ? true : opts.teamMode
  });
  if (!b) return null;
  const page = b.document.createElement("div");
  page.id = "page";
  b.document.getElementById("root").appendChild(page);
  await b.window.App.pages.contacts.renderList(page);
  await settle(b.window);
  return Object.assign(b, { page, store });
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

test("team features off: no owner column, no filter, no tick boxes", async (t) => {
  const b = await open({ teamMode: false });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.equal(b.document.querySelector("#cOwner"), null, "no All/My/Unassigned filter");
    assert.equal(b.document.querySelector(".c-pick"), null, "no selection boxes");
    assert.equal(b.document.querySelector("[data-claim]"), null, "no Claim button");
    assert.ok(!text(b.document.querySelector("thead")).includes("Belongs to"));
  } finally { b.close(); }
});

test("an agent who only sees their own leads gets no owner column either", async (t) => {
  const b = await open({
    workspace: makeWorkspace({ role: "agent", permissions: permissions(), teamMemberId: "tm-self" })
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.equal(b.document.querySelector("#cOwner"), null);
    assert.equal(b.document.querySelector(".c-pick"), null);
  } finally { b.close(); }
});

test("with team features on, the owner column names the person or says nobody", async (t) => {
  const b = await open({
    contacts: [
      contact({ id: "ct-1", name: "Unowned" }),
      contact({ id: "ct-2", name: "Mine", assignedToId: "tm-self" }),
      contact({ id: "ct-3", name: "Hers", assignedToId: "tm-2" }),
      contact({ id: "ct-4", name: "Ghost", assignedToId: "tm-missing" })
    ]
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const row = (id) => b.document.querySelector(`tr[data-id="${id}"]`);
    assert.match(text(row("ct-1")), /Nobody yet/);
    assert.match(text(row("ct-2")), /Me Myself/);
    assert.match(text(row("ct-2")), /You/);
    assert.match(text(row("ct-3")), /Rosa Diaz/);
    // A lead still pointing at somebody who has gone reads as that, rather
    // than as a blank cell.
    assert.match(text(row("ct-4")), /has left/i);
  } finally { b.close(); }
});

test("the All / My leads / Nobody owns filter picks the right rows", async (t) => {
  const b = await open({
    contacts: [
      contact({ id: "ct-1", name: "Unowned" }),
      contact({ id: "ct-2", name: "Mine", assignedToId: "tm-self" }),
      contact({ id: "ct-3", name: "Hers", assignedToId: "tm-2" })
    ]
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const ids = () => Array.from(b.document.querySelectorAll("tr[data-id]")).map((tr) => tr.getAttribute("data-id"));
    assert.deepEqual(ids().sort(), ["ct-1", "ct-2", "ct-3"]);

    const sel = b.document.querySelector("#cOwner");
    sel.value = "mine";
    sel.dispatchEvent(new b.window.Event("change"));
    await settle(b.window);
    assert.deepEqual(ids(), ["ct-2"]);

    sel.value = "unassigned";
    sel.dispatchEvent(new b.window.Event("change"));
    await settle(b.window);
    assert.deepEqual(ids(), ["ct-1"]);

    sel.value = "";
    sel.dispatchEvent(new b.window.Event("change"));
    await settle(b.window);
    assert.equal(ids().length, 3);
  } finally { b.close(); }
});

test("Claim appears only on leads nobody owns, and only for somebody allowed to claim", async (t) => {
  const claimer = makeWorkspace({
    role: "agent",
    teamMemberId: "tm-self",
    permissions: permissions({ unassigned_view: true, unassigned_claim: true })
  });
  const b = await open({
    workspace: claimer,
    contacts: [contact({ id: "ct-1" }), contact({ id: "ct-2", assignedToId: "tm-2" })]
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.ok(b.document.querySelector('[data-claim="ct-1"]'));
    assert.equal(b.document.querySelector('[data-claim="ct-2"]'), null, "an owned lead cannot be claimed");
    // Claiming without contacts_assign is allowed: it only ever assigns to
    // the claimer themselves.
    assert.equal(b.document.querySelector(".c-pick"), null, "and they get no bulk hand-over");

    b.document.querySelector('[data-claim="ct-1"]').click();
    await settle(b.window);
    assert.deepEqual(plain(b.store.updates), [{ id: "ct-1", patch: { assignedToId: "tm-self" } }]);
    assert.match(b.toasts.map((x) => x.message).join(" "), /this lead is yours/i);
  } finally { b.close(); }
});

test("a claim the server refuses says so and leaves the row alone", async (t) => {
  const b = await open({
    failUpdate: true,
    workspace: makeWorkspace({ role: "agent", teamMemberId: "tm-self", permissions: permissions({ unassigned_claim: true }) })
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    b.document.querySelector("[data-claim]").click();
    await settle(b.window);
    assert.match(b.toasts.map((x) => x.message).join(" "), /somebody else may have taken it/i);
  } finally { b.close(); }
});

test("bulk hand-over: hidden until rows are ticked, confirms, then assigns each row", async (t) => {
  const b = await open({
    contacts: [contact({ id: "ct-1" }), contact({ id: "ct-2" }), contact({ id: "ct-3" })]
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const bar = () => b.document.querySelector("[data-bulk-bar]");
    assert.equal(bar().style.display, "none", "nothing selected, nothing offered");

    const pick = (id) => {
      const cb = b.document.querySelector(`[data-pick="${id}"]`);
      cb.checked = true;
      cb.dispatchEvent(new b.window.Event("change"));
    };
    pick("ct-1");
    pick("ct-2");
    await settle(b.window);
    assert.equal(bar().style.display, "");
    assert.match(text(b.document.querySelector("[data-bulk-count]")), /2 selected/);

    // Nothing happens until a person is chosen.
    b.document.querySelector("#cBulkAssign").click();
    await settle(b.window);
    assert.deepEqual(b.store.updates, []);
    assert.match(b.toasts.map((x) => x.message).join(" "), /choose who/i);

    b.document.querySelector("#cBulkMember").value = "tm-2";
    b.document.querySelector("#cBulkAssign").click();
    await settle(b.window);
    assert.deepEqual(b.store.updates, [], "and not before it is confirmed");
    assert.match(text(b.document.querySelector(".modal")), /Hand over 2 leads/i);

    await confirmOk(b);
    assert.deepEqual(plain(b.store.updates), [
      { id: "ct-1", patch: { assignedToId: "tm-2" } },
      { id: "ct-2", patch: { assignedToId: "tm-2" } }
    ]);
    assert.match(b.toasts.map((x) => x.message).join(" "), /2 leads handed over/i);
  } finally { b.close(); }
});

test("select-all follows the filter, so a hand-over can only touch what is shown", async (t) => {
  const b = await open({
    contacts: [
      contact({ id: "ct-1" }),
      contact({ id: "ct-2", assignedToId: "tm-2" }),
      contact({ id: "ct-3" })
    ]
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const sel = b.document.querySelector("#cOwner");
    sel.value = "unassigned";
    sel.dispatchEvent(new b.window.Event("change"));
    await settle(b.window);

    const all = b.document.querySelector("#cSelectAll");
    all.checked = true;
    all.dispatchEvent(new b.window.Event("change"));
    await settle(b.window);
    assert.match(text(b.document.querySelector("[data-bulk-count]")), /2 selected/);

    b.document.querySelector("#cBulkMember").value = "tm-2";
    b.document.querySelector("#cBulkAssign").click();
    await settle(b.window);
    await confirmOk(b);
    assert.deepEqual(b.store.updates.map((u) => u.id), ["ct-1", "ct-3"], "the filtered-out row is untouched");
  } finally { b.close(); }
});

test("a part-refused hand-over reports honestly", async (t) => {
  const b = await open({
    contacts: [contact({ id: "ct-1" }), contact({ id: "ct-2" })],
    onContactUpdate: (id) => { if (id === "ct-2") throw new Error("refused"); }
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    ["ct-1", "ct-2"].forEach((id) => {
      const cb = b.document.querySelector(`[data-pick="${id}"]`);
      cb.checked = true;
      cb.dispatchEvent(new b.window.Event("change"));
    });
    await settle(b.window);
    b.document.querySelector("#cBulkMember").value = "tm-2";
    b.document.querySelector("#cBulkAssign").click();
    await settle(b.window);
    await confirmOk(b);
    assert.match(b.toasts.map((x) => x.message).join(" "), /1 handed over, 1 refused/i);
  } finally { b.close(); }
});

test("leads can be put back in the pool", async (t) => {
  const b = await open({ contacts: [contact({ id: "ct-1", assignedToId: "tm-2" })] });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const cb = b.document.querySelector('[data-pick="ct-1"]');
    cb.checked = true;
    cb.dispatchEvent(new b.window.Event("change"));
    await settle(b.window);
    b.document.querySelector("#cBulkMember").value = "__none__";
    b.document.querySelector("#cBulkAssign").click();
    await settle(b.window);
    assert.match(text(b.document.querySelector(".modal")), /back in the pool/i);
    await confirmOk(b);
    assert.deepEqual(plain(b.store.updates), [{ id: "ct-1", patch: { assignedToId: null } }]);
  } finally { b.close(); }
});

test("somebody who has left is never offered as a new owner", async (t) => {
  const b = await open();
  if (!b) return t.skip(SKIP_DOM);
  try {
    const cb = b.document.querySelector(".c-pick");
    cb.checked = true;
    cb.dispatchEvent(new b.window.Event("change"));
    await settle(b.window);
    const values = Array.from(b.document.querySelectorAll("#cBulkMember option")).map((o) => o.value);
    assert.ok(values.includes("tm-2"));
    assert.ok(!values.includes("tm-old"), "an inactive directory row is not a destination");
  } finally { b.close(); }
});
