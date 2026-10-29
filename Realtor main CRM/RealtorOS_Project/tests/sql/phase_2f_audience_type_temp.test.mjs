// Phase 2F: an audience by contact type and temperature, decided in the
// same one place as the tag audience.
//
// The thing worth proving hardest is the same as in 2E: it is ONE place.
// The same type filter has to govern an event trigger, a time trigger and
// a yearly trigger, because the point of putting it in
// rule_targets_contact was that no caller has to remember it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { migratedDb, one, SKIP_MESSAGE } from "../helpers/pg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(here, "..", "..", "supabase", "migrations",
  "20261015160000_phase_2f_audience_type_temp.sql");

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
    { user_id: w.id, workspace_id: w.ws, full_name: "Lead " + id.slice(3, 8),
      status: "Client", type: "Buyer", temperature: "Warm" },
    fields);
  const keys = ["id"].concat(Object.keys(cols));
  await svc(() => db.query(
    `insert into public.contacts (${keys.join(",")}) values (${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
    [id].concat(Object.keys(cols).map((k) => cols[k]))));
  return id;
}

async function rule(w, triggerType, opts = {}) {
  const id = randomUUID();
  await svc(() => db.query(
    `insert into public.automation_rules
       (id, user_id, workspace_id, name, trigger_type, trigger_config, status,
        timezone, visibility, activated_at, audience_filter)
     values ($1,$2,$3,$4,$5,$6::jsonb,'active','UTC','shared',$7,$8::jsonb)`,
    [id, w.id, w.ws, "Rule " + id.slice(0, 8), triggerType,
     JSON.stringify(opts.triggerConfig || {}),
     opts.activatedAt === undefined ? "2020-01-01T00:00:00Z" : opts.activatedAt,
     JSON.stringify(opts.audienceFilter || {})]));
  return id;
}

const targets = async (ruleId, contactId) => (await one(db,
  `select automation_internal.rule_targets_contact($1, $2) as ok`, [ruleId, contactId])).ok;

const scan = (now) => svc(async () => (await one(db,
  `select public.realtoros_scan_time_triggers($1::timestamptz, 500) as out`, [now])).out);

const events = async (w, ruleId) => (await db.query(
  `select contact_id, event_type from public.automation_trigger_events
    where workspace_id = $1 and rule_id = $2`, [w.ws, ruleId])).rows;

const clearThrottle = () => svc(() => db.query(`delete from public.automation_scan_state`));

const validate = async (type, filter) => (await one(db,
  `select public.realtoros_validate_audience_filter($1, $2::jsonb) as out`,
  [type, JSON.stringify(filter)])).out;

// ---------------------------------------------------------------- the helper

sqlTest("type_in and temperature_in decide the audience, case-insensitively", async () => {
  const w = await owner();
  const buyer = await contact(w, { type: "Buyer", temperature: "Hot" });
  const lowerBuyer = await contact(w, { type: "buyer", temperature: "Cold" });
  const seller = await contact(w, { type: "Seller", temperature: "Cold" });

  const buyers = await rule(w, "contact_created", { audienceFilter: { type_in: ["buyer"] } });
  assert.equal(await targets(buyers, buyer), true, "capitalisation is not a different type");
  assert.equal(await targets(buyers, lowerBuyer), true);
  assert.equal(await targets(buyers, seller), false, "a seller is a different audience");

  const cold = await rule(w, "contact_created", { audienceFilter: { temperature_in: ["COLD"] } });
  assert.equal(await targets(cold, lowerBuyer), true);
  assert.equal(await targets(cold, seller), true);
  assert.equal(await targets(cold, buyer), false,
    "a temperature the rule did not ask for is not quietly in the audience");

  // Any one of the values, and no filter at all means everybody.
  const either = await rule(w, "contact_created",
    { audienceFilter: { type_in: ["Buyer", "Investor"] } });
  assert.equal(await targets(either, buyer), true);
  assert.equal(await targets(either, seller), false, "ANY of them, not any type at all");
  const open = await rule(w, "contact_created");
  for (const id of [buyer, seller, lowerBuyer]) {
    assert.equal(await targets(open, id), true, "an absent filter is not an empty audience");
  }
});

sqlTest("the three lists narrow together rather than widening each other", async () => {
  const w = await owner();
  const both = await contact(w, { type: "Buyer", temperature: "Cold", tags: ["VIP"] });
  const wrongType = await contact(w, { type: "Seller", temperature: "Cold", tags: ["VIP"] });
  const wrongTemp = await contact(w, { type: "Buyer", temperature: "Hot", tags: ["VIP"] });
  const wrongTag = await contact(w, { type: "Buyer", temperature: "Cold", tags: ["Website"] });

  const r = await rule(w, "contact_created", {
    audienceFilter: { type_in: ["Buyer"], temperature_in: ["Cold"], tags_any: ["VIP"] }
  });
  assert.equal(await targets(r, both), true);
  assert.equal(await targets(r, wrongType), false, "all three, or none");
  assert.equal(await targets(r, wrongTemp), false);
  assert.equal(await targets(r, wrongTag), false, "the 2E tag audience still applies");
});

// ---------------------------------------------------------------- every path

sqlTest("the same type filter governs an event trigger", async () => {
  const w = await owner();
  const inAudience = await contact(w, { type: "Buyer", status: "New Lead" });
  const outside = await contact(w, { type: "Seller", status: "New Lead" });
  const r = await rule(w, "contact_created", { audienceFilter: { type_in: ["Buyer"] } });

  const mk = async (contactId) => {
    const id = randomUUID();
    await svc(() => db.query(
      `insert into public.automation_trigger_events
         (id, user_id, workspace_id, contact_id, event_type, new_status)
       values ($1,$2,$3,$4,'contact_created','New Lead')`, [id, w.id, w.ws, contactId]));
    return (await one(db, `select public.realtoros_rules_for_event($1) as out`, [id])).out;
  };

  assert.deepEqual(await mk(inAudience), [r]);
  assert.deepEqual(await mk(outside), [],
    "the event path honours the type without its own copy of the rule");
});

sqlTest("the same temperature filter governs a time trigger", async () => {
  const w = await owner();
  const inAudience = await contact(w, { temperature: "Cold", last_contact: "2026-01-01" });
  const outside = await contact(w, { temperature: "Hot", last_contact: "2026-01-01" });
  const r = await rule(w, "no_contact", {
    triggerConfig: { days: 30, fire_hour: 9, include_existing: true },
    audienceFilter: { temperature_in: ["Cold"] }
  });

  await clearThrottle();
  await scan("2026-06-01T10:00:00Z");
  const got = (await events(w, r)).map((e) => e.contact_id);
  assert.deepEqual(got, [inAudience], "the detector honours it: " + JSON.stringify(got));
  assert.ok(!got.includes(outside));
});

sqlTest("the same type filter governs a yearly trigger", async () => {
  const w = await owner();
  const inAudience = await contact(w, { type: "Seller", birthday: "1988-06-10" });
  const outside = await contact(w, { type: "Buyer", birthday: "1988-06-10" });
  const r = await rule(w, "birthday", {
    triggerConfig: { days_before: 0, fire_hour: 9 },
    audienceFilter: { type_in: ["Seller"] }
  });

  await clearThrottle();
  await scan("2026-06-10T09:30:00Z");
  const got = (await events(w, r)).map((e) => e.contact_id);
  assert.deepEqual(got, [inAudience], "the yearly path honours it too: " + JSON.stringify(got));
  assert.ok(!got.includes(outside));
});

// ---------------------------------------------------------------- validator

sqlTest("the validator normalizes the new lists and refuses nonsense", async () => {
  assert.deepEqual(
    await validate("contact_created", { type_in: ["  buyer ", "BUYER", "Investor", ""] }),
    { ok: true, filter: { type_in: ["Investor", "buyer"] } },
    "trimmed, de-duplicated without regard to case keeping the first spelling, and sorted");

  // An empty list is no filter, never "match nobody".
  assert.deepEqual(await validate("no_contact", { type_in: [], temperature_in: ["  "] }),
    { ok: true, filter: {} });

  // All three together, with status_equals, is a legal audience.
  assert.deepEqual(
    await validate("contact_status_changed",
      { status_equals: "Client", tags_any: ["VIP"], type_in: ["Seller"], temperature_in: ["Hot"] }),
    { ok: true, filter: { status_equals: "Client", tags_any: ["VIP"], type_in: ["Seller"], temperature_in: ["Hot"] } });

  for (const bad of [
    { type_in: "Buyer" },
    { temperature_in: { any: "Cold" } },
    { type_in: [1] },
    { temperature_in: ["C".repeat(51)] },
    { nope: 1 },
  ]) {
    const r = await validate("no_contact", bad);
    assert.equal(r.ok, false, JSON.stringify(bad) + " must be rejected");
    assert.ok(String(r.code).startsWith("audience_filter"), r.code);
  }

  // A draft is normalized on write, so what is stored is what matches.
  const w = await owner();
  const id = await rule(w, "no_contact", {
    triggerConfig: { days: 30 },
    audienceFilter: { type_in: ["  Buyer ", "buyer"], temperature_in: ["Cold"] }
  });
  const stored = await one(db,
    `select audience_filter from public.automation_rules where id = $1`, [id]);
  assert.deepEqual(stored.audience_filter, { type_in: ["Buyer"], temperature_in: ["Cold"] });

  await assert.rejects(
    rule(w, "no_contact", { triggerConfig: { days: 30 }, audienceFilter: { type_in: [{}] } }),
    /audience_filter_type_in_not_strings/);
});

// ---------------------------------------------------------------- re-running

sqlTest("applying the migration a second time changes nothing and breaks nothing", async () => {
  const sql = fs.readFileSync(MIGRATION, "utf8");
  const before = (await db.query(
    `select p.proname, md5(p.prosrc) as body
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'automation_internal'
        and p.proname in ('rule_targets_contact', 'audience_list_matches',
                          'normalize_audience_list', 'validate_audience_filter')
      order by 1`)).rows;

  await db.exec("reset role");
  await db.exec(sql);   // the re-run the 2C/2D wrappers could not survive

  const after = (await db.query(
    `select p.proname, md5(p.prosrc) as body
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'automation_internal'
        and p.proname in ('rule_targets_contact', 'audience_list_matches',
                          'normalize_audience_list', 'validate_audience_filter')
      order by 1`)).rows;
  assert.deepEqual(after, before, "same four functions, same bodies, no duplicates");

  // And it still matches, which is the only thing a second run could
  // plausibly have broken.
  const w = await owner();
  const buyer = await contact(w, { type: "Buyer" });
  const seller = await contact(w, { type: "Seller" });
  const r = await rule(w, "contact_created", { audienceFilter: { type_in: ["Buyer"] } });
  assert.equal(await targets(r, buyer), true);
  assert.equal(await targets(r, seller), false);
});

sqlTest("the browser may validate an audience but not run the matcher", async () => {
  await db.exec("reset role");
  await db.exec("set role authenticated");
  await db.query(
    `select public.realtoros_validate_audience_filter('no_contact', '{"type_in":["Buyer"]}'::jsonb)`);
  await assert.rejects(
    db.query(`select automation_internal.audience_list_matches('{}'::jsonb, 'type_in', array['Buyer'])`),
    /permission denied/);
  await assert.rejects(
    db.query(`select automation_internal.rule_targets_contact($1, 'x')`, [randomUUID()]),
    /permission denied/);
  await db.exec("reset role");
});

// ---------------------------------------------------------------- collation
//
// The wrapper failed on live at the verify block - "type_in is not
// trimmed, de-duplicated and sorted as expected" - and passed here, which
// is the only interesting kind of test failure: the two databases do not
// sort the same way. Live Supabase is en_US.UTF-8, where
// ['Investor', 'buyer'] sorts as {buyer, Investor}; PGlite's default
// collation sorts like "C", where it is {Investor, buyer}. The stored
// value of an audience therefore depended on the server's locale.
//
// So every sort in normalize_audience_list now says COLLATE "C", and
// these two tests are what stop that coming back: the first proves the
// orders really do differ in this database too, so the pin is not
// decoration, and the second proves the pin is still in the function -
// which is the part a behavioural test alone cannot catch here, because
// PGlite's default already agrees with "C".

sqlTest("audience lists sort the same way whatever the server's locale", async () => {
  // Mixed case is where a locale sort and a "C" sort visibly disagree.
  // und-x-icu is PGlite's locale-aware collation and orders these the way
  // live's en_US.UTF-8 does.
  const orders = await one(db, `
    select string_agg(v, ',' order by v collate "C")         as c_order,
           string_agg(v, ',' order by v collate "und-x-icu") as locale_order
      from (values ('zulu'), ('Alpha'), ('beta'), ('Bravo')) as e(v)`);
  assert.equal(orders.c_order, "Alpha,Bravo,beta,zulu");
  assert.equal(orders.locale_order, "Alpha,beta,Bravo,zulu",
    "if these two ever agree, this test has stopped proving anything");
  assert.notEqual(orders.c_order, orders.locale_order);

  // The validator gives the "C" order, which is also what the browser's
  // own normalizer in data-service.js produces (JavaScript sorts by code
  // unit), so a draft saved from the browser and the same draft
  // normalized by the database are byte-identical.
  assert.deepEqual(
    await validate("contact_created", { tags_any: ["zulu", "Alpha", "beta", "Bravo"] }),
    { ok: true, filter: { tags_any: ["Alpha", "Bravo", "beta", "zulu"] } });
  assert.deepEqual(
    await validate("contact_created", { type_in: ["  buyer ", "BUYER", "Investor", ""] }),
    { ok: true, filter: { type_in: ["Investor", "buyer"] } },
    "the exact value the live verify block rejected");
});

sqlTest("the sort collation is pinned in the function, not inherited", async () => {
  // PGlite's default collation already sorts like "C", so dropping the
  // COLLATE would pass every behavioural test above and fail again on
  // live. This is the one check that would have caught the original bug.
  const fn = await one(db, `
    select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal' and p.proname = 'normalize_audience_list'`);
  const sorts = fn.prosrc.split("\n")
    .filter((l) => !l.trim().startsWith("--"))   // the comments say "ORDER BY" too
    .filter((l) => /order by|distinct on/i.test(l));
  assert.ok(sorts.length >= 3,
    "both sorts and the DISTINCT ON are still there: " + JSON.stringify(sorts));
  sorts.forEach((line) => {
    assert.match(line, /collate "C"/,
      "every ordering has to pin its collation, including: " + line.trim());
  });
});
