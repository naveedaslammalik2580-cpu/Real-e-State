// Phase T4: the /join screen.
//
// Every answer the accept function can give has to arrive as words the
// invited person can act on. None of them is an error state - "this link
// expired" is an ordinary thing to be told.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SKIP_DOM } from "../helpers/browser.mjs";
import { teamBrowser, settle, makeStore, makeTeamStore } from "./team-helpers.mjs";

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/app.js",
  "assets/js/pages/team-join.js"
];

async function open(opts = {}) {
  const team = opts.team || makeTeamStore(opts.answers || {});
  const store = makeStore({ team });
  const b = await teamBrowser(SCRIPTS, { store, user: opts.user });
  if (!b) return null;
  const page = b.document.createElement("div");
  b.document.getElementById("root").appendChild(page);
  await b.window.App.pages.teamJoin.render(page, opts.token);
  await settle(b.window);
  const out = Object.assign(b, { page, team, store });
  // Most of these cases are about what the screen SAYS once the invited
  // person has pressed Accept, so the press is part of opening.
  if (opts.accept) {
    page.querySelector("#joinAcceptBtn").click();
    await settle(b.window);
  }
  return out;
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

test("the token is read out of the link, however the link arrives", async (t) => {
  const b = await open({ token: "tok" });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const { tokenFromPath } = b.window.App.pages.teamJoin;
    assert.equal(tokenFromPath("/join?token=abc123"), "abc123");
    assert.equal(tokenFromPath("/join?foo=1&token=abc123"), "abc123");
    assert.equal(tokenFromPath("/join?token=a%20b"), "a b");
    assert.equal(tokenFromPath("/join"), null, "no query at all");
    assert.equal(tokenFromPath("/join?token="), null, "an empty token is no token");
    assert.equal(tokenFromPath("/join?other=1"), null);
    assert.equal(tokenFromPath(""), null);
    assert.equal(tokenFromPath(undefined), null);
  } finally { b.close(); }
});

test("no token: a plain explanation, and nothing is sent", async (t) => {
  const b = await open({ token: null });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.match(text(b.page), /missing its invitation code/i);
    assert.deepEqual(b.team.calls, []);
    assert.equal(b.page.querySelector("#joinAcceptBtn"), null, "there is nothing to accept");
  } finally { b.close(); }
});

test("not signed in: asked to sign in with the invited address, token untouched", async (t) => {
  const b = await open({ token: "tok", user: null });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.match(text(b.page), /sign in to accept/i);
    assert.match(text(b.page), /only works for that address/i);
    assert.match(text(b.page), /link stays open/i);
    assert.deepEqual(b.team.calls, [], "accepting is not attempted for a signed-out visitor");
  } finally { b.close(); }
});

test("accepting works: the token goes through once and we land on the dashboard", async (t) => {
  const b = await open({ token: "tok-123" });
  if (!b) return t.skip(SKIP_DOM);
  try {
    b.page.querySelector("#joinAcceptBtn").click();
    await settle(b.window);
    const calls = b.team.calls.filter((c) => c.name === "acceptInvitation");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["tok-123"]);
    assert.deepEqual(b.navigations, ["/dashboard"]);
    assert.match(b.toasts.map((x) => x.message).join(" "), /joined the team/i);
  } finally { b.close(); }
});

test("the invited address is somebody else's: both addresses are named, with a way out", async (t) => {
  const b = await open({
    token: "tok",
    answers: { acceptInvitation: { outcome: "email_mismatch", invited_email: "rosa@example.com" } },
    accept: true
  });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const said = text(b.page.querySelector("#joinOutcome"));
    assert.match(said, /rosa@example\.com/, "the invited address");
    assert.match(said, /me@example\.com/, "and the one they are signed in as");
    assert.deepEqual(b.navigations, [], "nothing moves until they act");
    const out = b.page.querySelector("#joinSignOut");
    assert.ok(out, "signing out is offered");
    out.click();
    await settle(b.window);
    assert.equal(b.signedOut, true);
  } finally { b.close(); }
});

test("their own workspace has records in it: told why, and what to do", async (t) => {
  const b = await open({ token: "tok", accept: true, answers: { acceptInvitation: { outcome: "own_workspace_not_empty" } } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    const said = text(b.page.querySelector("#joinOutcome"));
    assert.match(said, /already has records of its own/i);
    assert.match(said, /different sign-in|clear this workspace/i);
    assert.deepEqual(b.navigations, []);
  } finally { b.close(); }
});

test("each remaining answer has its own words", async (t) => {
  const cases = [
    ["invalid_token", /not valid/i],
    ["expired", /has expired/i],
    ["revoked", /was cancelled/i],
    ["accepted", /already been used/i],
    ["no_workspace", /no longer points anywhere/i]
  ];
  for (const [outcome, pattern] of cases) {
    const b = await open({ token: "tok", accept: true, answers: { acceptInvitation: { outcome } } });
    if (!b) return t.skip(SKIP_DOM);
    try {
      assert.match(text(b.page.querySelector("#joinOutcome")), pattern, outcome);
      assert.deepEqual(b.navigations, [], outcome + " does not move us anywhere");
    } finally { b.close(); }
  }
});

test("already a member: said plainly, with a way into the workspace", async (t) => {
  const b = await open({ token: "tok", accept: true, answers: { acceptInvitation: { outcome: "already_a_member" } } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.match(text(b.page.querySelector("#joinOutcome")), /already in this team/i);
    b.page.querySelector('#joinOutcome [data-role="join-home"]').click();
    await settle(b.window);
    assert.deepEqual(b.navigations, ["/dashboard"]);
  } finally { b.close(); }
});

test("a thrown accept is a retryable message, and the button comes back", async (t) => {
  const b = await open({ token: "tok", accept: true, answers: { acceptInvitation: new Error("network down") } });
  if (!b) return t.skip(SKIP_DOM);
  try {
    assert.match(text(b.page.querySelector("#joinOutcome")), /could not accept/i);
    assert.equal(b.page.querySelector("#joinAcceptBtn").disabled, false, "they can try again");
  } finally { b.close(); }
});
