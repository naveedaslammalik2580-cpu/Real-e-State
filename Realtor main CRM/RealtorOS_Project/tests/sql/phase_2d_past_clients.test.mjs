// Phase 2D: birthdays, home anniversaries, the won-deal bookkeeping and the
// workspace time zone.
//
// The expensive mistakes here are all about dates: a greeting sent twice, a
// leap-day birthday skipped for three years out of four, an "anniversary" on
// the day of purchase, and a daily summary landing on the wrong calendar day
// for anybody not living in UTC.
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

async function contact(w, fields = {}) {
  const id = "ct_" + randomUUID().replace(/-/g, "").slice(0, 16);
  const cols = Object.assign(
    { user_id: w.id, workspace_id: w.ws, full_name: "Lead " + id.slice(3, 8), status: "Client" },
    fields);
  const keys = ["id"].concat(Object.keys(cols));
  await svc(() => db.query(
    `insert into public.contacts (${keys.join(",")}) values (${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
    [id].concat(Object.keys(cols).map((k) => cols[k]))));
  return id;
}

async function rule(w, triggerType, config, opts = {}) {
  const id = randomUUID();
  await svc(() => db.query(
    `insert into public.automation_rules
       (id, user_id, workspace_id, name, trigger_type, trigger_config, status,
        timezone, visibility, activated_at, audience_filter)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'shared',$9,'{}'::jsonb)`,
    [id, w.id, w.ws, "Rule " + id.slice(0, 8), triggerType,
     JSON.stringify(config || {}), opts.status || "active", opts.timezone || "UTC",
     opts.activatedAt === undefined ? "2020-01-01T00:00:00Z" : opts.activatedAt]));
  return id;
}

const scan = (now, limit) => svc(async () => (await one(db,
  `select public.realtoros_scan_time_triggers($1::timestamptz, $2::integer) as out`,
  [now, limit || 500])).out);

const events = async (w, ruleId) => (await db.query(
  `select contact_id, event_type, event_key, available_at, payload
     from public.automation_trigger_events
    where workspace_id = $1 and rule_id = $2 order by event_key`, [w.ws, ruleId])).rows;

const clearThrottle = () => svc(() => db.query(`delete from public.automation_scan_state`));

const setSettings = (w, bag) => svc(() => db.query(
  `insert into public.workspace_settings (id, user_id, workspace_id, settings_data)
   values ($1,$2,$3,$4::jsonb)
   on conflict (workspace_id) do update
     set settings_data = public.workspace_settings.settings_data || $4::jsonb`,
  ["ws_" + randomUUID().slice(0, 8), w.id, w.ws, JSON.stringify(bag)]));

// ---------------------------------------------------------------- yearly dates

sqlTest("a leap-day birthday falls on 28 February in a non-leap year", async () => {
  const r = await one(db, `
    select automation_internal.yearly_date('2000-02-29'::date, 2027)::text as non_leap,
           automation_internal.yearly_date('2000-02-29'::date, 2028)::text as leap,
           automation_internal.yearly_date('1988-07-04'::date, 2026)::text as ordinary,
           automation_internal.yearly_date(null::date, 2026) as missing,
           automation_internal.yearly_date('2000-02-29'::date, 2100)::text as century`);
  assert.equal(r.non_leap, "2027-02-28", "the person still has a birthday");
  assert.equal(r.leap, "2028-02-29");
  assert.equal(r.ordinary, "2026-07-04");
  assert.equal(r.missing, null);
  // 2100 is divisible by 4 but not a leap year.
  assert.equal(r.century, "2100-02-28");
});

// ---------------------------------------------------------------- birthday

sqlTest("a birthday fires once a year, at the rule's local hour", async () => {
  const w = await owner();
  const c = await contact(w, { birthday: "1988-06-10" });
  const r = await rule(w, "birthday", { days_before: 0, fire_hour: 9 });

  // 08:00 UTC on the day: not yet 09:00.
  await clearThrottle();
  await scan("2026-06-10T08:00:00Z");
  assert.equal((await events(w, r)).length, 0, "before the send hour, nothing");

  await clearThrottle();
  await scan("2026-06-10T09:30:00Z");
  const got = await events(w, r);
  assert.equal(got.length, 1);
  assert.equal(got[0].contact_id, c);
  assert.equal(got[0].event_type, "birthday");
  assert.equal(got[0].event_key, `bd:${r}:${c}:2026`);
  assert.equal(Number(got[0].payload.year), 2026);

  // Scanning again, repeatedly and much later in the year, adds nothing.
  await clearThrottle();
  await scan("2026-06-11T09:30:00Z");
  await clearThrottle();
  await scan("2026-11-01T09:30:00Z");
  assert.equal((await events(w, r)).length, 1, "one greeting per person per year");

  // Next year is a new occurrence.
  await clearThrottle();
  await scan("2027-06-10T09:30:00Z");
  const next = await events(w, r);
  assert.equal(next.length, 2);
  assert.ok(next.some((e) => e.event_key.endsWith(":2027")));
});

sqlTest("the rule's timezone decides when the greeting is due", async () => {
  const w = await owner();
  await contact(w, { birthday: "1990-06-10" });
  // 09:00 in Asia/Dubai is 05:00 UTC.
  const r = await rule(w, "birthday", { days_before: 0, fire_hour: 9 }, { timezone: "Asia/Dubai" });

  await clearThrottle();
  await scan("2026-06-10T04:30:00Z");
  assert.equal((await events(w, r)).length, 0, "08:30 in Dubai is too early");
  await clearThrottle();
  await scan("2026-06-10T05:30:00Z");
  assert.equal((await events(w, r)).length, 1, "09:30 in Dubai is due");
});

sqlTest("days_before sends early, including across the new year", async () => {
  const w = await owner();
  const c = await contact(w, { birthday: "1990-01-05" });
  const r = await rule(w, "birthday", { days_before: 10, fire_hour: 9 });

  // Due 26 December of the PREVIOUS year: days_before shifts earlier, and
  // the scan has to look at last year's occurrence to see it.
  await clearThrottle();
  await scan("2025-12-25T09:30:00Z");
  assert.equal((await events(w, r)).length, 0, "not yet");

  await clearThrottle();
  await scan("2025-12-26T09:30:00Z");
  const got = await events(w, r);
  assert.equal(got.length, 1, "ten days before a 5 January birthday is 26 December");
  assert.equal(got[0].event_key, `bd:${r}:${c}:2026`,
    "and it is keyed to the birthday's year, not the year it was sent in");
});

sqlTest("a leap-day birthday is greeted every year", async () => {
  const w = await owner();
  const c = await contact(w, { birthday: "1992-02-29" });
  const r = await rule(w, "birthday", { days_before: 0, fire_hour: 9 });

  await clearThrottle();
  await scan("2027-02-28T09:30:00Z");   // not a leap year
  let got = await events(w, r);
  assert.equal(got.length, 1, "28 February in a non-leap year");
  assert.equal(got[0].event_key, `bd:${r}:${c}:2027`);

  await clearThrottle();
  await scan("2028-02-29T09:30:00Z");   // leap year
  got = await events(w, r);
  assert.equal(got.length, 2, "and the 29th when there is one");
  assert.ok(got.some((e) => e.event_key.endsWith(":2028")));
});

// ---------------------------------------------------------------- anniversary

sqlTest("a home anniversary skips the purchase year and counts from the first", async () => {
  const w = await owner();
  const c = await contact(w, { home_purchase_date: "2024-06-10" });
  const r = await rule(w, "home_anniversary", { days_before: 0, fire_hour: 9 });

  // The purchase day itself is not an anniversary of anything.
  await clearThrottle();
  await scan("2024-06-10T09:30:00Z");
  assert.equal((await events(w, r)).length, 0, "year zero is the purchase, not an anniversary");

  await clearThrottle();
  await scan("2025-06-10T09:30:00Z");
  const got = await events(w, r);
  assert.equal(got.length, 1, "the first anniversary is a year later");
  assert.equal(got[0].event_key, `ha:${r}:${c}:2025`);
  assert.equal(got[0].event_type, "home_anniversary");

  await clearThrottle();
  await scan("2026-06-10T09:30:00Z");
  assert.equal((await events(w, r)).length, 2, "and once a year after that");
});

sqlTest("a contact with no date, or a rule not yet switched on, produces nothing", async () => {
  const w = await owner();
  await contact(w, { full_name: "No Dates" });                      // neither date
  await contact(w, { birthday: "1990-06-10" });
  const notYet = await rule(w, "birthday", { days_before: 0, fire_hour: 9 },
    { activatedAt: "2026-07-01T00:00:00Z" });
  const draft = await rule(w, "birthday", { days_before: 0, fire_hour: 9 }, { status: "draft" });

  await clearThrottle();
  await scan("2026-06-10T09:30:00Z");
  assert.equal((await events(w, notYet)).length, 0,
    "a birthday that passed before the rule was switched on stays passed - a late greeting is worse than none");
  assert.equal((await events(w, draft)).length, 0, "and a draft sends nothing at all");
});

sqlTest("the new types are treated as detected: one named rule, nothing else", async () => {
  const w = await owner();
  const c = await contact(w, { birthday: "1990-06-10" });
  const mine = await rule(w, "birthday", { days_before: 0, fire_hour: 9 });
  const other = await rule(w, "birthday", { days_before: 3, fire_hour: 9 });

  await clearThrottle();
  await scan("2026-06-10T09:30:00Z");
  const ev = (await events(w, mine))[0];
  assert.ok(ev, "my rule detected it");
  const row = await one(db,
    `select id from public.automation_trigger_events where event_key = $1`, [ev.event_key]);
  const matched = (await one(db,
    `select public.realtoros_rules_for_event($1) as out`, [row.id])).out;
  assert.deepEqual(matched, [mine],
    "an occurrence belongs to the rule whose own settings produced it");
  assert.ok(!matched.includes(other));
  assert.equal(c, ev.contact_id);
});

// ---------------------------------------------------------------- won deals

sqlTest("a deal marked won sets the purchase date and tags the contact, once", async () => {
  const w = await owner();
  const c = await contact(w, { status: "Client" });
  const dealId = "dl_" + randomUUID().replace(/-/g, "").slice(0, 16);
  await svc(() => db.query(
    `insert into public.deals (id, user_id, workspace_id, title, contact_id, stage, status, expected_close)
     values ($1,$2,$3,'12 Oak Street',$4,'Under Contract','active','2026-05-20')`,
    [dealId, w.id, w.ws, c]));

  let row = await one(db, `select home_purchase_date, tags from public.contacts where id = $1`, [c]);
  assert.equal(row.home_purchase_date, null, "an active deal changes nothing");

  await svc(() => db.query(`update public.deals set stage = 'Closed', status = 'won' where id = $1`, [dealId]));
  row = await one(db, `select home_purchase_date::text as d, tags from public.contacts where id = $1`, [c]);
  assert.equal(row.d, "2026-05-20", "the deal's own close date");
  assert.ok(row.tags.includes("Past client"));

  // Flipping out and back does not duplicate the tag or move the date.
  await svc(() => db.query(`update public.deals set status = 'active' where id = $1`, [dealId]));
  await svc(() => db.query(`update public.deals set status = 'won' where id = $1`, [dealId]));
  row = await one(db, `select home_purchase_date::text as d, tags from public.contacts where id = $1`, [c]);
  assert.equal(row.d, "2026-05-20", "the date is not overwritten");
  assert.equal(row.tags.filter((t) => t === "Past client").length, 1, "and the tag appears once");
});

sqlTest("a won deal with no close date uses today, and leaves an existing date alone", async () => {
  const w = await owner();
  const already = await contact(w, { home_purchase_date: "2019-01-01" });
  const blank = await contact(w);

  const mk = async (contactId) => {
    const id = "dl_" + randomUUID().replace(/-/g, "").slice(0, 16);
    await svc(() => db.query(
      `insert into public.deals (id, user_id, workspace_id, title, contact_id, stage, status)
       values ($1,$2,$3,'Deal',$4,'Closed','won')`, [id, w.id, w.ws, contactId]));
    return id;
  };
  await mk(already);
  await mk(blank);

  const a = await one(db, `select home_purchase_date::text as d from public.contacts where id = $1`, [already]);
  assert.equal(a.d, "2019-01-01", "a date the agent already recorded is never overwritten");
  const b = await one(db, `select home_purchase_date from public.contacts where id = $1`, [blank]);
  assert.ok(b.home_purchase_date, "and a blank one gets today");
});

sqlTest("a won deal with nobody attached changes nothing", async () => {
  const w = await owner();
  const before = Number((await one(db,
    `select count(*)::int as n from public.contacts where workspace_id = $1 and home_purchase_date is not null`,
    [w.ws])).n);
  await svc(() => db.query(
    `insert into public.deals (id, user_id, workspace_id, title, contact_id, stage, status)
     values ($1,$2,$3,'Unlinked',null,'Closed','won')`,
    ["dl_" + randomUUID().replace(/-/g, "").slice(0, 16), w.id, w.ws]));
  const after = Number((await one(db,
    `select count(*)::int as n from public.contacts where workspace_id = $1 and home_purchase_date is not null`,
    [w.ws])).n);
  assert.equal(after, before, "there is nobody to mark as a past client");
});

// ---------------------------------------------------------------- timezone

sqlTest("the workspace timezone is validated, and falls back to UTC", async () => {
  const w = await owner();
  const zone = async () => (await one(db,
    `select automation_internal.workspace_timezone($1) as tz`, [w.ws])).tz;

  await setSettings(w, {});
  assert.equal(await zone(), "UTC", "no zone set reads as UTC");

  await setSettings(w, { timezone: "Asia/Dubai" });
  assert.equal(await zone(), "Asia/Dubai");

  // A value Postgres does not know must not reach `at time zone`, which
  // would raise and take the whole scan down.
  await setSettings(w, { timezone: "Mars/Olympus_Mons" });
  assert.equal(await zone(), "UTC", "nonsense falls back rather than raising");

  const list = (await db.query(`select * from public.realtoros_timezone_names() limit 5`)).rows;
  assert.ok(list.length === 5, "the browser can read the zone list");
});

sqlTest("the daily summary lands on the workspace's own calendar day", async () => {
  const w = await owner();
  // Overdue relative to 20 June, but not to 19 June.
  await contact(w, { next_follow_up: "2026-06-19", status: "Client" });

  const summaries = async () => (await db.query(
    `select dedupe_key, metadata from public.notifications
      where user_id = $1 and type = 'overdue_followups' order by dedupe_key`, [w.id])).rows;

  // 2026-06-19 23:30 UTC is already the 20th in Dubai (+04), so the
  // follow-up is overdue there and not yet overdue in UTC.
  await setSettings(w, { timezone: "Asia/Dubai" });
  await svc(() => db.query(`select public.realtoros_scan_follow_up_reminders($1::timestamptz)`,
    ["2026-06-19T23:30:00Z"]));
  let got = await summaries();
  assert.equal(got.length, 1, "Dubai has already reached the 20th");
  assert.equal(got[0].dedupe_key, "overdue:2026-06-20",
    "and the once-a-day key is the day the agent is living in");

  // The same instant in a UTC workspace is still the 19th, so nothing is
  // overdue yet.
  const utc = await owner();
  await contact(utc, { next_follow_up: "2026-06-19", status: "Client" });
  await setSettings(utc, { timezone: "UTC" });
  await svc(() => db.query(`select public.realtoros_scan_follow_up_reminders($1::timestamptz)`,
    ["2026-06-19T23:30:00Z"]));
  const utcGot = (await db.query(
    `select dedupe_key from public.notifications where user_id = $1 and type = 'overdue_followups'`,
    [utc.id])).rows;
  assert.deepEqual(utcGot, [], "in UTC it is still the 19th, so nothing is overdue");
});

// ---------------------------------------------------------------- guards

sqlTest("the validator knows the yearly types and refuses the wrong settings", async () => {
  const check = async (type, config) => (await one(db,
    `select public.realtoros_validate_trigger_config($1, $2::jsonb) as out`,
    [type, JSON.stringify(config)])).out;

  assert.deepEqual(await check("birthday", {}),
    { ok: true, config: { days_before: 0, fire_hour: 9 } });
  assert.deepEqual(await check("home_anniversary", { days_before: 7, fire_hour: 10 }),
    { ok: true, config: { days_before: 7, fire_hour: 10 } });
  // include_existing is accepted and dropped: it means nothing yearly.
  assert.deepEqual(await check("birthday", { include_existing: true }),
    { ok: true, config: { days_before: 0, fire_hour: 9 } });

  for (const bad of [{ days_before: 31 }, { days_before: -1 }, { days_before: 1.5 },
                     { days: 30 }, { statuses: ["Client"] }, { fire_hour: 24 }]) {
    const r = await check("birthday", bad);
    assert.equal(r.ok, false, JSON.stringify(bad) + " must be rejected");
    assert.ok(String(r.code).startsWith("trigger_config"), r.code);
  }
});

sqlTest("a browser cannot reach the detector or forge a yearly occurrence", async () => {
  await db.exec("reset role");
  await db.exec("set role authenticated");
  await assert.rejects(db.query(`select public.realtoros_scan_time_triggers()`), /permission denied/);
  // Everything in automation_internal is out of reach: the browser has no
  // USAGE on that schema, so these are denied at the schema, not the
  // function. The Today screen does its own date arithmetic in JS for
  // exactly this reason.
  await assert.rejects(
    db.query(`select automation_internal.workspace_timezone($1)`, [randomUUID()]),
    /permission denied/);
  await assert.rejects(
    db.query(`select automation_internal.yearly_date('1992-02-29'::date, 2027)`),
    /permission denied/);
  // The browser-facing half is reachable.
  await db.query(`select * from public.realtoros_timezone_names() limit 1`);
  await db.exec("reset role");
});

sqlTest("a yearly greeting is skipped rather than sent late", async () => {
  const w = await owner();
  await contact(w, { birthday: "1990-06-10" });
  const r = await rule(w, "birthday", { days_before: 0, fire_hour: 9 });

  // The scan did not run on the day - the worker was down for a week.
  await clearThrottle();
  await scan("2026-06-18T09:30:00Z");
  assert.equal((await events(w, r)).length, 0,
    "a week late is not a birthday greeting, it is an apology");

  // And the following year still works normally, so nothing is stuck.
  await clearThrottle();
  await scan("2027-06-10T09:30:00Z");
  assert.equal((await events(w, r)).length, 1);
});
