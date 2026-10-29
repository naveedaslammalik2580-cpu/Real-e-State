// Phase 2C: response tracking, reminders, team accountability.
//
// The things that would be expensive to get wrong: a first-touch time that
// moves (which makes every response-time figure a lie), a sequence that
// stops starting for a teammate's lead, a reminder sent twice, and a
// reminder sent to somebody about work they cannot see.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedDb, one, SKIP_MESSAGE } from "../helpers/pg.mjs";

let db;
before(async () => { db = await migratedDb(); });
after(async () => {
  if (!db) return;
  await db.close();
  assert.equal(db.closed, true, "the shared PGlite database must close");
});

function sqlTest(name, fn) {
  test(name, async (t) => {
    if (!db) return t.skip(SKIP_MESSAGE);
    await fn(db);
  });
}

const svc = async (fn) => {
  await db.exec("set role service_role");
  try { return await fn(); } finally { await db.exec("reset role"); }
};

/** An owner with their own workspace (the T2b2 provisioning trigger). */
async function owner() {
  await db.exec("reset role");
  const id = randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`,
    [id, `o.${id.slice(0, 8)}@example.com`]);
  const r = await one(db,
    `select workspace_id, team_member_id from public.workspace_members
      where user_id = $1 and status = 'active'`, [id]);
  return { id, ws: r.workspace_id, tm: r.team_member_id };
}

/** A second person moved into an existing workspace as an active member. */
async function teammate(w, role = "agent", perms = null) {
  await db.exec("reset role");
  const id = randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`,
    [id, `t.${id.slice(0, 8)}@example.com`]);
  const tm = "tm_" + id.replace(/-/g, "").slice(0, 16);
  await svc(async () => {
    await db.query(
      `insert into public.team_members (id, user_id, workspace_id, auth_user_id, name, role, active)
       values ($1, $2, $3, $4, $5, 'Agent', true)`,
      [tm, w.id, w.ws, id, "Mate " + id.slice(0, 4)]);
    // Their auto-provisioned membership is MOVED, because
    // workspace_members_one_active_per_user allows only one active row.
    await db.query(
      `update public.workspace_members
          set workspace_id = $1, role = $2, team_member_id = $3,
              permission_overrides = coalesce($4::jsonb, '{}'::jsonb)
        where user_id = $5 and status = 'active'`,
      [w.ws, role, tm, perms ? JSON.stringify(perms) : null, id]);
  });
  return { id, tm, ws: w.ws };
}

async function contact(w, fields = {}) {
  const id = "ct_" + randomUUID().replace(/-/g, "").slice(0, 16);
  // `fields` may override user_id (a teammate's lead), so the defaults are
  // merged rather than prepended - naming a column twice is a SQL error.
  const cols = Object.assign(
    { user_id: w.id, workspace_id: w.ws, full_name: "Lead " + id.slice(3, 8), status: "New Lead" },
    fields);
  const keys = ["id"].concat(Object.keys(cols));
  await svc(() => db.query(
    `insert into public.contacts (${keys.join(",")}) values (${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
    [id].concat(Object.keys(cols).map((k) => cols[k]))));
  return id;
}

async function activity(w, contactId, at) {
  const id = "ac_" + randomUUID().replace(/-/g, "").slice(0, 16);
  await svc(() => db.query(
    `insert into public.activities (id, user_id, workspace_id, contact_id, type, subject, date${at ? ", created_at" : ""})
     values ($1,$2,$3,$4,'Call','Rang them', now()${at ? ", $5" : ""})`,
    at ? [id, w.id, w.ws, contactId, at] : [id, w.id, w.ws, contactId]));
  return id;
}

async function rule(w, triggerType, opts = {}) {
  const id = randomUUID();
  await svc(() => db.query(
    `insert into public.automation_rules
       (id, user_id, workspace_id, name, trigger_type, status, timezone, visibility,
        activated_at, audience_filter, trigger_config)
     values ($1,$2,$3,$4,$5,'active','UTC',$6,'2026-01-01T00:00:00Z',$7::jsonb,'{}'::jsonb)`,
    [id, opts.ownerId || w.id, w.ws, "Rule " + id.slice(0, 8), triggerType,
     opts.visibility || "shared", JSON.stringify(opts.audienceFilter || {})]));
  return id;
}

async function event(w, contactId, type, extra = {}) {
  const id = randomUUID();
  await svc(() => db.query(
    `insert into public.automation_trigger_events
       (id, user_id, workspace_id, contact_id, event_type, old_status, new_status, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [id, extra.userId || w.id, w.ws, contactId, type,
     extra.oldStatus || null, extra.newStatus || null,
     JSON.stringify(extra.payload || {})]));
  return id;
}

const rulesFor = async (eventId) => (await one(db,
  `select public.realtoros_rules_for_event($1) as out`, [eventId])).out;

const firstTouch = async (id) => (await one(db,
  `select first_touched_at from public.contacts where id = $1`, [id])).first_touched_at;

const reminders = (now) => svc(async () => (await one(db,
  `select public.realtoros_scan_follow_up_reminders($1::timestamptz) as out`, [now])).out);

const notes = async (userId) => (await db.query(
  `select type, title, dedupe_key, contact_id, metadata from public.notifications
    where user_id = $1 order by dedupe_key`, [userId])).rows;

const setHours = (w, hours) => svc(() => db.query(
  `insert into public.workspace_settings (id, user_id, workspace_id, settings_data)
   values ($1,$2,$3, jsonb_build_object('followUpReminderHours', $4::integer))
   on conflict (workspace_id) do update
     set settings_data = public.workspace_settings.settings_data
                         || jsonb_build_object('followUpReminderHours', $4::integer)`,
  ["ws_" + randomUUID().slice(0, 8), w.id, w.ws, hours]));

// ---------------------------------------------------------------- first touch

sqlTest("an activity sets first_touched_at, and a later one never moves it", async () => {
  const w = await owner();
  const c = await contact(w);
  assert.equal(await firstTouch(c), null, "a new contact has not been touched");

  await activity(w, c, "2026-03-01T10:00:00Z");
  const first = await firstTouch(c);
  assert.ok(first, "the first activity stamps it");
  assert.equal(new Date(first).toISOString(), "2026-03-01T10:00:00.000Z");

  await activity(w, c, "2026-04-01T10:00:00Z");
  assert.deepEqual(await firstTouch(c), first, "a second activity must not move the first touch");
});

sqlTest("setting last_contact for the first time also counts as the first touch", async () => {
  const w = await owner();
  const c = await contact(w);
  await svc(() => db.query(`update public.contacts set last_contact = '2026-03-02' where id = $1`, [c]));
  const first = await firstTouch(c);
  assert.ok(first, "last_contact going from empty to a date is a touch");

  // Changing it again changes nothing.
  await svc(() => db.query(`update public.contacts set last_contact = '2026-05-05' where id = $1`, [c]));
  assert.deepEqual(await firstTouch(c), first);
});

sqlTest("whichever happens first wins, in either order", async () => {
  const w = await owner();

  // Activity first, then last_contact.
  const a = await contact(w);
  await activity(w, a, "2026-03-01T08:00:00Z");
  const viaActivity = await firstTouch(a);
  await svc(() => db.query(`update public.contacts set last_contact = '2026-03-09' where id = $1`, [a]));
  assert.deepEqual(await firstTouch(a), viaActivity, "the activity got there first");

  // last_contact first, then an activity.
  const b = await contact(w);
  await svc(() => db.query(`update public.contacts set last_contact = '2026-03-03' where id = $1`, [b]));
  const viaContact = await firstTouch(b);
  await activity(w, b, "2026-03-20T08:00:00Z");
  assert.deepEqual(await firstTouch(b), viaContact, "the last_contact date got there first");
});

sqlTest("a browser cannot write first_touched_at, but can honestly cause one", async () => {
  const w = await owner();
  const c = await contact(w);

  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claims', $1, false)`,
    [JSON.stringify({ sub: w.id, role: "authenticated" })]);
  await db.exec("set role authenticated");

  // A forged value is discarded.
  await db.query(
    `update public.contacts set first_touched_at = '2020-01-01T00:00:00Z' where id = $1`, [c]);
  await db.exec("reset role");
  assert.equal(await firstTouch(c), null, "a browser cannot invent a first touch");

  // Recording a contact, which it may do, produces an honest one.
  await db.exec("set role authenticated");
  await db.query(`update public.contacts set last_contact = '2026-03-04' where id = $1`, [c]);
  await db.exec("reset role");
  const honest = await firstTouch(c);
  assert.ok(honest, "but recording contact does stamp it");
  assert.ok(new Date(honest).getTime() > new Date("2025-01-01").getTime(),
    "and with the real time, not the forged one");
  await db.query(`select set_config('request.jwt.claims', '', false)`);
});

sqlTest("an activity logged from the browser still stamps the first touch", async () => {
  // The stamping trigger is SECURITY DEFINER for exactly this case: as
  // SECURITY INVOKER the lifecycle guard would discard its write.
  const w = await owner();
  const c = await contact(w);
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claims', $1, false)`,
    [JSON.stringify({ sub: w.id, role: "authenticated" })]);
  await db.exec("set role authenticated");
  await db.query(
    `insert into public.activities (id, user_id, workspace_id, contact_id, type, subject, date)
     values ($1,$2,$3,$4,'Call','Rang them', now())`,
    ["ac_" + randomUUID().replace(/-/g, "").slice(0, 16), w.id, w.ws, c]);
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  assert.ok(await firstTouch(c), "a browser-logged activity must still stamp it");
});

sqlTest("the backfill stamped the touched and left the untouched alone", async () => {
  // Proven on the chain as applied: the migration's own verify block refuses
  // to finish if a never-touched contact was stamped, and this checks the
  // other half - that having been touched DID produce a value.
  const w = await owner();
  const untouched = await contact(w);
  const touched = await contact(w, { last_contact: "2026-02-02" });
  assert.equal(await firstTouch(untouched), null);
  assert.ok(await firstTouch(touched), "inserting with last_contact already set counts as touched");
});

// ---------------------------------------------------------------- matching

sqlTest("a shared rule starts for any contact in its workspace, including a teammate's", async () => {
  const w = await owner();
  const mate = await teammate(w);
  const r = await rule(w, "contact_created", { visibility: "shared" });

  // A contact created by the teammate and assigned to them.
  const theirs = await contact(w, { user_id: mate.id, assigned_to_id: mate.tm });
  const e = await event(w, theirs, "contact_created", { newStatus: "New Lead" });
  assert.deepEqual(await rulesFor(e), [r],
    "a shared rule reaches the whole workspace - the Phase 2C fix");
});

sqlTest("a personal rule starts only for its creator's own contacts", async () => {
  const w = await owner();
  const mate = await teammate(w);
  const personal = await rule(w, "contact_created", { visibility: "personal" });

  const mine = await contact(w, { assigned_to_id: w.tm });
  const unassignedMine = await contact(w);
  const theirs = await contact(w, { user_id: mate.id, assigned_to_id: mate.tm });

  assert.deepEqual(await rulesFor(await event(w, mine, "contact_created", { newStatus: "New Lead" })),
    [personal], "assigned to the creator");
  assert.deepEqual(await rulesFor(await event(w, unassignedMine, "contact_created", { newStatus: "New Lead" })),
    [personal], "unassigned and created by the creator");
  assert.deepEqual(await rulesFor(await event(w, theirs, "contact_created", { newStatus: "New Lead" })),
    [], "a teammate's own lead is not a personal rule's business");
});

sqlTest("a solo workspace is unaffected: every rule still starts for every contact", async () => {
  const w = await owner();
  const shared = await rule(w, "contact_created", { visibility: "shared" });
  const personal = await rule(w, "contact_created", { visibility: "personal" });
  const c = await contact(w);
  const got = await rulesFor(await event(w, c, "contact_created", { newStatus: "New Lead" }));
  assert.equal(got.length, 2, "one member means one candidate set, so both match");
  assert.deepEqual(got.slice().sort(), [shared, personal].sort());
});

sqlTest("new_lead, status changes and workspace isolation all still hold", async () => {
  const w = await owner();
  const other = await owner();
  const newLead = await rule(w, "new_lead");
  const onStatus = await rule(w, "contact_status_changed", { audienceFilter: { status_equals: "Qualified" } });
  await rule(other, "contact_created");   // another workspace entirely

  const c = await contact(w);
  // new_lead only fires for the New Lead status.
  assert.deepEqual(await rulesFor(await event(w, c, "contact_created", { newStatus: "New Lead" })), [newLead]);
  assert.deepEqual(await rulesFor(await event(w, c, "contact_created", { newStatus: "Qualified" })), []);

  // A status change matches only the status the rule names.
  assert.deepEqual(
    await rulesFor(await event(w, c, "contact_status_changed", { oldStatus: "New Lead", newStatus: "Qualified" })),
    [onStatus]);
  assert.deepEqual(
    await rulesFor(await event(w, c, "contact_status_changed", { oldStatus: "New Lead", newStatus: "Client" })),
    [], "a different status is a different rule's job");
  assert.deepEqual(
    await rulesFor(await event(w, c, "contact_status_changed", { oldStatus: "Qualified", newStatus: "Qualified" })),
    [], "a status that did not change is not a change");

  // Nothing from the other workspace ever appears.
  const theirContact = await contact(other);
  const theirEvent = await event(other, theirContact, "contact_created", { newStatus: "New Lead" });
  const theirRules = await rulesFor(theirEvent);
  assert.ok(!theirRules.includes(newLead) && !theirRules.includes(onStatus));
});

// ---------------------------------------------------------------- reminders

sqlTest("an untouched lead nudges its owner once, after the workspace's own delay", async () => {
  const w = await owner();
  await setHours(w, 4);
  const c = await contact(w, { full_name: "Quiet Lead" });
  await svc(() => db.query(
    `update public.contacts set created_at = '2026-03-01T00:00:00Z' where id = $1`, [c]));

  // Three hours later: still inside the workspace's patience.
  let out = await reminders("2026-03-01T03:00:00Z");
  assert.equal(Number(out.untouched_notified), 0);
  assert.deepEqual(await notes(w.id), []);

  out = await reminders("2026-03-01T05:00:00Z");
  assert.equal(Number(out.untouched_notified), 1);
  const got = await notes(w.id);
  assert.equal(got.length, 1);
  assert.equal(got[0].type, "contact_untouched");
  assert.equal(got[0].dedupe_key, "untouched:" + c + ":l1");
  assert.equal(got[0].contact_id, c);

  // Running again, repeatedly, adds nothing.
  await reminders("2026-03-01T06:00:00Z");
  await reminders("2026-03-01T09:00:00Z");
  assert.equal((await notes(w.id)).length, 1, "one nudge per contact per person, ever");
});

sqlTest("the nudge goes to the assigned agent rather than the creator", async () => {
  const w = await owner();
  const mate = await teammate(w);
  await setHours(w, 1);
  const c = await contact(w, { assigned_to_id: mate.tm });
  await svc(() => db.query(
    `update public.contacts set created_at = '2026-03-01T00:00:00Z' where id = $1`, [c]));

  await reminders("2026-03-01T02:00:00Z");
  assert.equal((await notes(mate.id)).filter((n) => n.dedupe_key.endsWith(":l1")).length, 1,
    "the person whose lead it is hears about it");
  assert.equal((await notes(w.id)).filter((n) => n.dedupe_key.endsWith(":l1")).length, 0,
    "and the creator does not, because it is not theirs any more");
});

sqlTest("escalation reaches managers after a day, and only in a real team", async () => {
  // Solo first: no second member, so no escalation however long it sits.
  const solo = await owner();
  await setHours(solo, 1);
  const lonely = await contact(solo);
  await svc(() => db.query(
    `update public.contacts set created_at = '2026-03-01T00:00:00Z' where id = $1`, [lonely]));
  await reminders("2026-03-05T00:00:00Z");
  assert.equal((await notes(solo.id)).filter((n) => n.dedupe_key.endsWith(":l2")).length, 0,
    "a solo agent does not need telling twice");

  // Now a team, with the lead assigned to the agent.
  const w = await owner();
  const mate = await teammate(w);
  await setHours(w, 1);
  const c = await contact(w, { assigned_to_id: mate.tm });
  await svc(() => db.query(
    `update public.contacts set created_at = '2026-03-01T00:00:00Z' where id = $1`, [c]));

  // Two hours in: the agent only.
  await reminders("2026-03-01T02:00:00Z");
  assert.equal((await notes(w.id)).filter((n) => n.dedupe_key.endsWith(":l2")).length, 0,
    "not yet - it has not been a day");

  // A day and a bit later: the owner holds team_manage.
  await reminders("2026-03-02T05:00:00Z");
  const escalations = (await notes(w.id)).filter((n) => n.dedupe_key.endsWith(":l2"));
  assert.equal(escalations.length, 1, "whoever manages the team is told");
  assert.equal(escalations[0].dedupe_key, "untouched:" + c + ":l2");
  assert.equal(Number(escalations[0].metadata.level), 2);
  assert.equal((await notes(mate.id)).filter((n) => n.dedupe_key.endsWith(":l2")).length, 0,
    "an agent without team_manage is not a manager");

  // And not twice.
  await reminders("2026-03-03T05:00:00Z");
  assert.equal((await notes(w.id)).filter((n) => n.dedupe_key.endsWith(":l2")).length, 1);
});

sqlTest("a touched lead is never nudged, and a lost one is left alone", async () => {
  const w = await owner();
  await setHours(w, 1);
  const touched = await contact(w);
  const lost = await contact(w, { status: "Lost" });
  await svc(() => db.query(
    `update public.contacts set created_at = '2026-03-01T00:00:00Z' where id in ($1, $2)`, [touched, lost]));
  await activity(w, touched, "2026-03-01T00:30:00Z");

  await reminders("2026-03-01T06:00:00Z");
  const got = await notes(w.id);
  assert.deepEqual(got.filter((n) => n.contact_id === touched), [], "somebody dealt with it");
  assert.deepEqual(got.filter((n) => n.contact_id === lost), [], "a lost lead is not waiting on anybody");
});

sqlTest("the overdue summary arrives once a day, counts only what you can act on, and skips zero", async () => {
  const w = await owner();
  // An agent who may only see their OWN contacts.
  const mate = await teammate(w, "agent", {
    contacts: { view: "own", edit: "own", delete: "none", create: true }
  });

  // Two overdue: one theirs, one the owner's.
  await contact(w, { next_follow_up: "2026-03-01", assigned_to_id: mate.tm });
  await contact(w, { next_follow_up: "2026-03-01", assigned_to_id: w.tm });

  const out = await reminders("2026-03-10T09:00:00Z");
  assert.ok(Number(out.summaries) >= 1);

  const ownerSummary = (await notes(w.id)).filter((n) => n.type === "overdue_followups");
  const mateSummary = (await notes(mate.id)).filter((n) => n.type === "overdue_followups");
  assert.equal(ownerSummary.length, 1);
  assert.equal(Number(ownerSummary[0].metadata.count), 2, "the owner sees the whole workspace");
  assert.equal(mateSummary.length, 1);
  assert.equal(Number(mateSummary[0].metadata.count), 1, "the agent is only told about their own");
  assert.match(ownerSummary[0].title, /2 overdue follow-ups/);
  assert.match(mateSummary[0].title, /1 overdue follow-up$/, "and the wording is singular for one");

  // Same day again: nothing new. A later day: one more.
  await reminders("2026-03-10T18:00:00Z");
  assert.equal((await notes(w.id)).filter((n) => n.type === "overdue_followups").length, 1);
  await reminders("2026-03-11T09:00:00Z");
  assert.equal((await notes(w.id)).filter((n) => n.type === "overdue_followups").length, 2,
    "a new day is a new summary");

  // A workspace with nothing overdue is told nothing at all.
  const quiet = await owner();
  await contact(quiet, { next_follow_up: "2026-12-31" });
  await reminders("2026-03-12T09:00:00Z");
  assert.deepEqual((await notes(quiet.id)).filter((n) => n.type === "overdue_followups"), [],
    "no news is no notification");
});

sqlTest("reminders never cross a workspace boundary", async () => {
  const a = await owner();
  const b = await owner();
  await setHours(a, 1);
  const theirs = await contact(b);
  await svc(() => db.query(
    `update public.contacts set created_at = '2026-03-01T00:00:00Z' where id = $1`, [theirs]));

  await reminders("2026-03-01T06:00:00Z");
  const aNotes = await notes(a.id);
  assert.deepEqual(aNotes.filter((n) => n.contact_id === theirs), [],
    "one workspace is never told about another's leads");
});

sqlTest("the scan reports counts and nothing identifying", async () => {
  const w = await owner();
  await setHours(w, 1);
  const c = await contact(w, { full_name: "Very Private Person", email: "private@example.com" });
  await svc(() => db.query(
    `update public.contacts set created_at = '2026-03-01T00:00:00Z' where id = $1`, [c]));
  const out = await reminders("2026-03-01T06:00:00Z");
  assert.deepEqual(Object.keys(out).sort(), ["escalated", "summaries", "untouched_notified"]);
  const text = JSON.stringify(out);
  assert.ok(!text.includes("Private") && !text.includes("private@example.com") && !text.includes(c),
    "counts only: " + text);
});

sqlTest("a browser can neither call the scans nor read the matcher", async () => {
  await db.exec("reset role");
  await db.exec("set role authenticated");
  await assert.rejects(db.query(`select public.realtoros_scan_follow_up_reminders()`),
    /permission denied/);
  await assert.rejects(db.query(`select public.realtoros_rules_for_event($1)`, [randomUUID()]),
    /permission denied/);
  await assert.rejects(db.query(`select automation_internal.rule_targets_contact($1, 'x')`, [randomUUID()]),
    /permission denied/);
  await db.exec("reset role");
});
