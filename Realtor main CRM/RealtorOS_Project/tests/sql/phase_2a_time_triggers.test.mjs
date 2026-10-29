// Phase 2A: time-based and deal-based automation triggers.
//
// The things worth pinning here are the ones that would be expensive to get
// wrong in production: an occurrence firing twice, a rule enrolling a
// two-year backlog the moment it is switched on, a timer firing in the
// wrong timezone, and a browser being able to forge any of it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedDb, one, SKIP_MESSAGE } from "../helpers/pg.mjs";

let db;
before(async () => { db = await migratedDb(); });
after(async () => { if (db) { try { await db.close(); } catch (e) { /* closed */ } } });

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

/** An owner with a workspace (the T2b2 provisioning trigger makes it). */
async function owner() {
  await db.exec("reset role");
  const id = randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`,
    [id, `o.${id.slice(0, 8)}@example.com`]);
  const ws = (await one(db,
    `select workspace_id from public.workspace_members
      where user_id = $1 and status = 'active'`, [id])).workspace_id;
  return { id, ws };
}

async function contact(w, fields = {}) {
  const id = "ct_" + randomUUID().replace(/-/g, "").slice(0, 16);
  const cols = Object.assign({
    full_name: "Lead " + id.slice(3, 8), email: id.slice(3, 10) + "@example.com",
    status: "New Lead",
  }, fields);
  const keys = ["id", "user_id", "workspace_id"].concat(Object.keys(cols));
  const vals = [id, w.id, w.ws].concat(Object.keys(cols).map(k => cols[k]));
  await svc(() => db.query(
    `insert into public.contacts (${keys.join(",")}) values (${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
    vals));
  return id;
}

/** An ACTIVE rule of a given trigger type. Activation is simulated here -
 *  manage-automation is an Edge Function and has its own tests. */
async function rule(w, triggerType, triggerConfig, opts = {}) {
  const id = randomUUID();
  await svc(() => db.query(
    `insert into public.automation_rules
       (id, user_id, workspace_id, name, trigger_type, trigger_config, status,
        timezone, visibility, activated_at, daily_enrollment_limit, audience_filter)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb)`,
    [id, w.id, w.ws, opts.name || ("Rule " + id.slice(0, 8)), triggerType,
     JSON.stringify(triggerConfig || {}), opts.status || "active",
     opts.timezone || "UTC", opts.visibility || "shared",
     opts.activatedAt === undefined ? "2026-01-01T00:00:00Z" : opts.activatedAt,
     opts.dailyLimit || 100, JSON.stringify(opts.audienceFilter || {})]));
  return id;
}

const scan = (now, limit) => svc(async () => (await one(db,
  `select public.realtoros_scan_time_triggers($1::timestamptz, $2::integer) as out`,
  [now, limit || 500])).out);

const events = async (w, ruleId) => (await db.query(
  `select contact_id, event_type, event_key, available_at, rule_id
     from public.automation_trigger_events
    where workspace_id = $1 ${ruleId ? "and rule_id = $2" : ""}
    order by event_key`, ruleId ? [w.ws, ruleId] : [w.ws])).rows;

/** The throttle remembers the last scan; most tests want a fresh look. */
const clearThrottle = () => svc(() => db.query(`delete from public.automation_scan_state`));

const validate = async (type, config) => (await one(db,
  `select public.realtoros_validate_trigger_config($1, $2::jsonb) as out`,
  [type, JSON.stringify(config)])).out;

// ---------------------------------------------------------------- validator

sqlTest("the validator fills in defaults and normalizes", async () => {
  assert.deepEqual(await validate("no_contact", { days: 30 }),
    { ok: true, config: { days: 30, fire_hour: 8, include_existing: false } });
  assert.deepEqual(await validate("follow_up_due", {}),
    { ok: true, config: { fire_hour: 8, include_existing: false } });
  // statuses come back sorted and de-duplicated, so two configs meaning the
  // same thing are the same value.
  const stale = await validate("status_stale", { days: 5, statuses: ["Nurturing", "Client", "Nurturing"] });
  assert.deepEqual(stale.config.statuses, ["Client", "Nurturing"]);
  // The pre-2A types carry nothing at all.
  assert.deepEqual(await validate("manual", {}), { ok: true, config: {} });
  assert.deepEqual(await validate("new_lead", { include_existing: true }), { ok: true, config: {} });
});

sqlTest("the validator rejects unknown keys, bad ranges and wrong types", async () => {
  const bad = async (type, config, hint) => {
    const r = await validate(type, config);
    assert.equal(r.ok, false, hint + " must be rejected");
    assert.ok(typeof r.code === "string" && r.code.startsWith("trigger_config"), hint + " -> " + r.code);
  };
  await bad("no_contact", { day: 30 }, "a misspelled key");
  await bad("no_contact", {}, "no_contact without days");
  await bad("no_contact", { days: 0 }, "days below 1");
  await bad("no_contact", { days: 366 }, "days above 365");
  await bad("no_contact", { days: 1.5 }, "fractional days");
  await bad("no_contact", { days: "30" }, "days as a string");
  await bad("follow_up_due", { fire_hour: 24 }, "hour above 23");
  await bad("follow_up_due", { fire_hour: -1 }, "hour below 0");
  await bad("follow_up_due", { include_existing: "yes" }, "include_existing as a string");
  await bad("status_stale", { days: 5, statuses: [] }, "an empty status list");
  await bad("status_stale", { days: 5, statuses: ["Nope"] }, "an unknown status");
  await bad("status_stale", { days: 5, statuses: "Client" }, "statuses not an array");
  await bad("deal_stage_changed", { side: "Both" }, "an unknown deal side");
  await bad("deal_stage_changed", { to_stage: "" }, "an empty stage");
  await bad("manual", { days: 3 }, "settings on a type that takes none");
});

sqlTest("a draft cannot even be stored with a config that could never activate", async () => {
  const w = await owner();
  await assert.rejects(rule(w, "no_contact", { days: 999 }, { status: "draft" }),
    /trigger_config_days_out_of_range/);
  // And a valid one is normalized on the way in.
  const id = await rule(w, "no_contact", { days: 30 }, { status: "draft" });
  const row = await one(db, `select trigger_config from public.automation_rules where id = $1`, [id]);
  assert.deepEqual(row.trigger_config, { days: 30, fire_hour: 8, include_existing: false });
});

// ---------------------------------------------------------------- one event per occurrence

sqlTest("follow_up_due: one event per date, and re-scanning creates nothing new", async () => {
  const w = await owner();
  const c = await contact(w, { next_follow_up: "2026-03-10" });
  const r = await rule(w, "follow_up_due", { fire_hour: 8 });

  // 07:00 UTC on the day: not yet 08:00, so nothing.
  await clearThrottle();
  await scan("2026-03-10T07:00:00Z");
  assert.equal((await events(w, r)).length, 0, "before fire_hour nothing is due");

  await clearThrottle();
  const first = await scan("2026-03-10T09:00:00Z");
  assert.equal(Number(first.events_created), 1);
  const rows = await events(w, r);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contact_id, c);
  assert.equal(rows[0].event_type, "follow_up_due");
  assert.equal(rows[0].event_key, `fud:${r}:${c}:2026-03-10`);

  // Scan again, twice, including far later: still exactly one.
  await clearThrottle();
  await scan("2026-03-10T10:00:00Z");
  await clearThrottle();
  await scan("2026-03-25T10:00:00Z");
  assert.equal((await events(w, r)).length, 1, "the same occurrence is never recorded twice");

  // A NEW follow-up date is a new occurrence.
  await svc(() => db.query(`update public.contacts set next_follow_up = '2026-04-01' where id = $1`, [c]));
  await clearThrottle();
  await scan("2026-04-01T09:00:00Z");
  const after = await events(w, r);
  assert.equal(after.length, 2, "a new date is a new occurrence");
  assert.ok(after.some(e => e.event_key.endsWith(":2026-04-01")));
});

sqlTest("two concurrent scans of the same moment still produce one event each", async () => {
  const w = await owner();
  await contact(w, { next_follow_up: "2026-03-10" });
  const r = await rule(w, "follow_up_due", {});
  await clearThrottle();
  // Sequential calls at the same instant stand in for two workers: the
  // throttle is cleared between them so both really do scan, and only the
  // unique event_key can be what stops the duplicate.
  await scan("2026-03-10T09:00:00Z");
  await clearThrottle();
  await scan("2026-03-10T09:00:00Z");
  assert.equal((await events(w, r)).length, 1);
});

sqlTest("fire_hour and the rule's timezone decide when an occurrence is due", async () => {
  const w = await owner();
  await contact(w, { next_follow_up: "2026-03-10" });
  // 09:00 in Asia/Dubai is 05:00 UTC.
  const r = await rule(w, "follow_up_due", { fire_hour: 9 }, { timezone: "Asia/Dubai" });

  await clearThrottle();
  await scan("2026-03-10T04:30:00Z");
  assert.equal((await events(w, r)).length, 0, "08:30 Dubai is too early");

  await clearThrottle();
  await scan("2026-03-10T05:30:00Z");
  assert.equal((await events(w, r)).length, 1, "09:30 Dubai is due");
});

// ---------------------------------------------------------------- no_contact / status_stale

sqlTest("no_contact counts from last_contact, or from created_at when there is none", async () => {
  const w = await owner();
  const withDate = await contact(w, { last_contact: "2026-02-01" });
  const r = await rule(w, "no_contact", { days: 10 });

  await clearThrottle();
  await scan("2026-02-08T12:00:00Z");
  assert.equal((await events(w, r)).length, 0, "only 7 days of silence");

  await clearThrottle();
  await scan("2026-02-12T12:00:00Z");
  const rows = await events(w, r);
  assert.equal(rows.length, 1, "11 days of silence is due");
  assert.equal(rows[0].event_key, `nc:${r}:${withDate}:2026-02-01`);

  // Contact them, and the clock restarts as a different occurrence.
  await svc(() => db.query(`update public.contacts set last_contact = '2026-02-12' where id = $1`, [withDate]));
  await clearThrottle();
  await scan("2026-02-13T12:00:00Z");
  assert.equal((await events(w, r)).length, 1, "the new silence has not matured yet");
  await clearThrottle();
  await scan("2026-02-25T12:00:00Z");
  const after = await events(w, r);
  assert.equal(after.length, 2, "a later last_contact is a new occurrence");
  assert.ok(after.some(e => e.event_key.endsWith(":2026-02-12")));
});

sqlTest("status_stale uses status_changed_at, and can be limited to chosen statuses", async () => {
  const w = await owner();
  const c = await contact(w, { status: "Nurturing" });
  await svc(() => db.query(
    `update public.contacts set status_changed_at = '2026-02-01T00:00:00Z' where id = $1`, [c]));
  const any = await rule(w, "status_stale", { days: 10 });
  const only = await rule(w, "status_stale", { days: 10, statuses: ["Client"] });

  await clearThrottle();
  await scan("2026-02-15T12:00:00Z");
  assert.equal((await events(w, any)).length, 1, "any-status rule matches");
  assert.equal((await events(w, only)).length, 0, "the Client-only rule does not");

  // A real status change restarts the clock AND is a new occurrence.
  await db.exec("reset role");
  await svc(() => db.query(`update public.contacts set status = 'Client' where id = $1`, [c]));
  const stamped = await one(db, `select status, status_changed_at from public.contacts where id = $1`, [c]);
  assert.equal(stamped.status, "Client");
  assert.ok(new Date(stamped.status_changed_at).getTime() > new Date("2026-02-01").getTime(),
    "the stamp moved when the status really changed");
});

sqlTest("an edit that does not change the status leaves status_changed_at alone", async () => {
  const w = await owner();
  const c = await contact(w, { status: "Qualified" });
  const before = (await one(db, `select status_changed_at from public.contacts where id = $1`, [c])).status_changed_at;
  await svc(() => db.query(`update public.contacts set full_name = 'Renamed' where id = $1`, [c]));
  const after = (await one(db, `select status_changed_at from public.contacts where id = $1`, [c])).status_changed_at;
  assert.deepEqual(after, before, "renaming a contact is not a status change");
});

// ---------------------------------------------------------------- the mass-send guard

sqlTest("activating a rule does not enrol a backlog, unless it asks to", async () => {
  const w = await owner();
  // Silent since long before the rule existed.
  await contact(w, { last_contact: "2025-01-01" });
  const guarded = await rule(w, "no_contact", { days: 30 },
    { activatedAt: "2026-03-01T00:00:00Z" });

  await clearThrottle();
  await scan("2026-03-05T12:00:00Z");
  assert.equal((await events(w, guarded)).length, 0,
    "the silence matured in 2025, long before this rule was switched on");

  const opted = await rule(w, "no_contact", { days: 30, include_existing: true },
    { activatedAt: "2026-03-01T00:00:00Z" });
  await clearThrottle();
  await scan("2026-03-05T12:00:00Z");
  assert.equal((await events(w, opted)).length, 1,
    "include_existing deliberately takes the backlog");
});

sqlTest("an occurrence that matures AFTER activation is picked up normally", async () => {
  const w = await owner();
  await contact(w, { last_contact: "2026-03-02" });
  const r = await rule(w, "no_contact", { days: 10 }, { activatedAt: "2026-03-01T00:00:00Z" });
  await clearThrottle();
  await scan("2026-03-13T12:00:00Z");
  assert.equal((await events(w, r)).length, 1);
});

// ---------------------------------------------------------------- rule state and scope

sqlTest("draft, paused and archived rules detect nothing", async () => {
  const w = await owner();
  await contact(w, { next_follow_up: "2026-03-10" });
  const ids = [];
  for (const status of ["draft", "paused", "archived"]) {
    ids.push(await rule(w, "follow_up_due", {}, { status }));
  }
  await clearThrottle();
  await scan("2026-03-10T09:00:00Z");
  for (const id of ids) {
    assert.equal((await events(w, id)).length, 0, "a non-active rule must detect nothing");
  }
});

sqlTest("a suppressed or opted-out contact is skipped before an event is even made", async () => {
  const w = await owner();
  const suppressed = await contact(w, { next_follow_up: "2026-03-10", email: "blocked@example.com" });
  const optedOut = await contact(w, { next_follow_up: "2026-03-10", email: "out@example.com" });
  const fine = await contact(w, { next_follow_up: "2026-03-10", email: "fine@example.com" });
  await svc(() => db.query(
    `insert into public.email_suppressions (user_id, workspace_id, normalized_email, reason, is_active)
     values ($1, $2, 'blocked@example.com', 'manual', true)`, [w.id, w.ws]));
  await svc(() => db.query(
    `insert into public.communication_consents (user_id, workspace_id, contact_id, channel, status)
     values ($1, $2, $3, 'email', 'opted_out')`, [w.id, w.ws, optedOut]));

  const r = await rule(w, "follow_up_due", {});
  await clearThrottle();
  await scan("2026-03-10T09:00:00Z");
  const got = (await events(w, r)).map(e => e.contact_id);
  assert.deepEqual(got, [fine], "only the contact who has not said no");
  assert.ok(!got.includes(suppressed) && !got.includes(optedOut));
});

sqlTest("a contact already running in this rule gets no second occurrence", async () => {
  const w = await owner();
  const c = await contact(w, { next_follow_up: "2026-03-10" });
  const r = await rule(w, "follow_up_due", {});
  await svc(() => db.query(
    `insert into public.automation_enrollments
       (user_id, workspace_id, rule_id, contact_id, status)
     values ($1,$2,$3,$4,'active')`, [w.id, w.ws, r, c]));
  await clearThrottle();
  await scan("2026-03-10T09:00:00Z");
  assert.equal((await events(w, r)).length, 0);
});

sqlTest("workspaces are isolated, and a personal rule only sees its owner's contacts", async () => {
  const mine = await owner();
  const theirs = await owner();
  await contact(mine, { next_follow_up: "2026-03-10" });
  await contact(theirs, { next_follow_up: "2026-03-10" });
  const myRule = await rule(mine, "follow_up_due", {});
  await clearThrottle();
  await scan("2026-03-10T09:00:00Z");
  const rows = await events(mine, myRule);
  assert.equal(rows.length, 1, "my rule sees exactly my one contact");
  assert.equal((await events(theirs)).filter(e => e.rule_id === myRule).length, 0,
    "and nothing of mine lands in their workspace");

  // A personal rule whose owner has no directory row owns no assigned
  // contacts, so it sees only the unassigned ones it created itself.
  const personal = await rule(mine, "follow_up_due", {}, { visibility: "personal" });
  const assignedElsewhere = await contact(mine, { next_follow_up: "2026-03-11" });
  await svc(() => db.query(
    `insert into public.team_members (id, user_id, workspace_id, name, role, active)
     values ($1,$2,$3,'Someone Else','Agent',true)`, ["tm_other", mine.id, mine.ws]));
  await svc(() => db.query(
    `update public.contacts set assigned_to_id = 'tm_other' where id = $1`, [assignedElsewhere]));
  await clearThrottle();
  await scan("2026-03-11T09:00:00Z");
  const personalRows = await events(mine, personal);
  assert.ok(!personalRows.some(e => e.contact_id === assignedElsewhere),
    "a personal rule must not reach a contact assigned to somebody else");
});

// ---------------------------------------------------------------- deal stage

sqlTest("a deal fires one event per real stage change, and only with a contact", async () => {
  const w = await owner();
  const c = await contact(w);
  const mk = async (fields) => {
    const id = "dl_" + randomUUID().replace(/-/g, "").slice(0, 16);
    const cols = Object.assign({ title: "Deal", stage: "New", side: "Buyer" }, fields);
    const keys = ["id", "user_id", "workspace_id"].concat(Object.keys(cols));
    await svc(() => db.query(
      `insert into public.deals (${keys.join(",")}) values (${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
      [id, w.id, w.ws].concat(Object.keys(cols).map(k => cols[k]))));
    return id;
  };

  const linked = await mk({ contact_id: c });
  let rows = (await events(w)).filter(e => e.event_type === "deal_stage_changed");
  assert.equal(rows.length, 1, "a deal created into a stage has reached it");

  // A non-stage edit writes nothing.
  await svc(() => db.query(`update public.deals set value = 500000 where id = $1`, [linked]));
  rows = (await events(w)).filter(e => e.event_type === "deal_stage_changed");
  assert.equal(rows.length, 1, "editing the value is not a stage change");

  // A real stage change does.
  await svc(() => db.query(`update public.deals set stage = 'Under Contract' where id = $1`, [linked]));
  rows = (await events(w)).filter(e => e.event_type === "deal_stage_changed");
  assert.equal(rows.length, 2);
  const latest = rows.find(e => e.event_key.includes(":Under Contract:"));
  assert.ok(latest, "the key names the stage reached");
  assert.equal(latest.rule_id, null, "a real-world event names no rule");

  // A deal with nobody attached has nobody to enrol.
  await mk({ contact_id: null, stage: "Offer" });
  rows = (await events(w)).filter(e => e.event_type === "deal_stage_changed");
  assert.equal(rows.length, 2, "a deal with no contact starts nothing");
});

// ---------------------------------------------------------------- the browser's reach

sqlTest("a browser role cannot forge a stamp, an event or a scan", async () => {
  const w = await owner();
  const c = await contact(w, { status: "Qualified" });
  const real = (await one(db, `select status_changed_at from public.contacts where id = $1`, [c])).status_changed_at;

  // SESSION-level, not `set local`: each statement here is its own
  // transaction, so a local setting would be gone before the next one and
  // the trigger's current_user check would never see 'authenticated'.
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claims', $1, false)`,
    [JSON.stringify({ sub: w.id, role: "authenticated" })]);
  await db.exec(`set role authenticated`);

  // The write is allowed (it is their own contact) but the forged value is
  // thrown away by the protect trigger.
  await db.query(
    `update public.contacts set status_changed_at = '2020-01-01T00:00:00Z' where id = $1`, [c]);
  await db.exec("reset role");
  const after = (await one(db, `select status_changed_at from public.contacts where id = $1`, [c])).status_changed_at;
  assert.deepEqual(after, real, "a browser cannot backdate status_changed_at");

  // The runtime table and the scan are out of reach entirely.
  await db.exec(`set role authenticated`);
  await assert.rejects(
    db.query(`insert into public.automation_trigger_events
                (user_id, workspace_id, contact_id, event_type, rule_id, event_key)
              values ($1,$2,$3,'follow_up_due',null,'forged')`, [w.id, w.ws, c]),
    /permission denied|violates/, "no browser write to the event outbox");
  await assert.rejects(
    db.query(`select public.realtoros_scan_time_triggers()`),
    /permission denied/, "no browser call to the scan");
  await assert.rejects(
    db.query(`select * from public.automation_scan_state`),
    /permission denied/, "no browser read of the scan bookkeeping");
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claims', '', false)`);
});

sqlTest("the scan respects its limit and its per-workspace throttle", async () => {
  const w = await owner();
  for (let i = 0; i < 4; i++) await contact(w, { next_follow_up: "2026-03-10" });
  const r = await rule(w, "follow_up_due", {});

  await clearThrottle();
  const first = await scan("2026-03-10T09:00:00Z", 2);
  assert.equal(Number(first.events_created), 2, "the limit caps one run");

  // Immediately again: the throttle means this workspace is not re-scanned.
  const throttled = await scan("2026-03-10T09:01:00Z", 2);
  assert.equal(Number(throttled.events_created), 0);
  assert.ok(Number(throttled.skipped_workspaces) >= 1);

  // Once the throttle has passed, the rest are picked up.
  await clearThrottle();
  await scan("2026-03-10T10:00:00Z", 10);
  assert.equal((await events(w, r)).length, 4, "the remainder arrives on a later run");
});

sqlTest("the scan reports counts and nothing identifying", async () => {
  const w = await owner();
  await contact(w, { next_follow_up: "2026-03-10", email: "private@example.com" });
  await rule(w, "follow_up_due", {}, { name: "A Secret Rule Name" });
  await clearThrottle();
  const out = await scan("2026-03-10T09:00:00Z");
  assert.deepEqual(Object.keys(out).sort(),
    ["events_created", "scanned_rules", "scanned_workspaces", "skipped_workspaces"]);
  const text = JSON.stringify(out);
  assert.ok(!text.includes("private@example.com") && !text.includes("Secret"),
    "the summary is counts only");
});
