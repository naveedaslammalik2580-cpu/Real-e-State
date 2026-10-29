// Phase 2E: a tag-aware audience, decided in one place.
//
// The thing worth proving hardest is that it is ONE place: the same tag
// filter has to govern an event trigger, a time trigger and a yearly
// trigger, because the whole point of putting it in rule_targets_contact
// was that no caller has to remember it.
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

sqlTest("tags_any decides the audience, case-insensitively", async () => {
  const w = await owner();
  const tagged = await contact(w, { tags: ["VIP", "Past Client"] });
  const lower = await contact(w, { tags: ["past client"] });
  const other = await contact(w, { tags: ["Open house"] });
  const none = await contact(w, { tags: [] });

  const r = await rule(w, "contact_created", { audienceFilter: { tags_any: ["Past client"] } });

  assert.equal(await targets(r, tagged), true, "different capitalisation is the same tag");
  assert.equal(await targets(r, lower), true);
  assert.equal(await targets(r, other), false, "a different tag is a different audience");
  assert.equal(await targets(r, none), false, "and no tags is not this audience");
});

sqlTest("any one of the tags is enough, and no filter means everybody", async () => {
  const w = await owner();
  const a = await contact(w, { tags: ["Open house"] });
  const b = await contact(w, { tags: ["Referral"] });
  const c = await contact(w, { tags: ["Nothing relevant"] });

  const either = await rule(w, "contact_created",
    { audienceFilter: { tags_any: ["Open house", "Referral"] } });
  assert.equal(await targets(either, a), true);
  assert.equal(await targets(either, b), true, "ANY of them, not all");
  assert.equal(await targets(either, c), false);

  // No filter at all reaches everybody the rule could otherwise reach.
  const open = await rule(w, "contact_created");
  for (const id of [a, b, c]) {
    assert.equal(await targets(open, id), true, "an absent filter is not an empty audience");
  }
});

sqlTest("visibility and tags are both required, not either", async () => {
  const w = await owner();
  const mate = randomUUID();
  await db.exec("reset role");
  await db.query(`insert into auth.users (id) values ($1)`, [mate]);
  const mateTm = "tm_" + mate.replace(/-/g, "").slice(0, 16);
  await svc(async () => {
    await db.query(
      `insert into public.team_members (id, user_id, workspace_id, auth_user_id, name, role, active)
       values ($1,$2,$3,$4,'Mate','Agent',true)`, [mateTm, w.id, w.ws, mate]);
    // role too: the membership was provisioned as the owner of its own
    // workspace, and one workspace allows one active owner.
    await db.query(
      `update public.workspace_members
          set workspace_id = $1, team_member_id = $2, role = 'agent'
        where user_id = $3 and status = 'active'`, [w.ws, mateTm, mate]);
  });

  // Right tag, but it belongs to the teammate.
  const theirs = await contact(w, { tags: ["Past client"], user_id: mate, assigned_to_id: mateTm });
  // Mine, but the wrong tag.
  const mineWrongTag = await contact(w, { tags: ["Open house"], assigned_to_id: w.tm });
  // Mine, right tag.
  const mineRight = await contact(w, { tags: ["Past client"], assigned_to_id: w.tm });

  const personal = await rule(w, "contact_created",
    { audienceFilter: { tags_any: ["Past client"] } });
  await svc(() => db.query(`update public.automation_rules set visibility = 'personal' where id = $1`, [personal]));

  assert.equal(await targets(personal, theirs), false, "the tag does not override visibility");
  assert.equal(await targets(personal, mineWrongTag), false, "and visibility does not override the tag");
  assert.equal(await targets(personal, mineRight), true, "both, or neither");
});

// ---------------------------------------------------------------- every path

sqlTest("the same tag filter governs an event trigger", async () => {
  const w = await owner();
  const inAudience = await contact(w, { tags: ["Open house"], status: "New Lead" });
  const outside = await contact(w, { tags: ["Website"], status: "New Lead" });
  const r = await rule(w, "contact_created", { audienceFilter: { tags_any: ["Open house"] } });

  const mk = async (contactId) => {
    const id = randomUUID();
    await svc(() => db.query(
      `insert into public.automation_trigger_events
         (id, user_id, workspace_id, contact_id, event_type, new_status)
       values ($1,$2,$3,$4,'contact_created','New Lead')`, [id, w.id, w.ws, contactId]));
    return (await one(db, `select public.realtoros_rules_for_event($1) as out`, [id])).out;
  };

  assert.deepEqual(await mk(inAudience), [r]);
  assert.deepEqual(await mk(outside), [], "the event path honours the tag without its own copy of the rule");
});

sqlTest("the same tag filter governs a time trigger", async () => {
  const w = await owner();
  const inAudience = await contact(w, { tags: ["Past client"], last_contact: "2026-01-01" });
  const outside = await contact(w, { tags: ["Website"], last_contact: "2026-01-01" });
  const r = await rule(w, "no_contact", {
    triggerConfig: { days: 30, fire_hour: 9, include_existing: true },
    audienceFilter: { tags_any: ["Past client"] }
  });

  await clearThrottle();
  await scan("2026-06-01T10:00:00Z");
  const got = (await events(w, r)).map((e) => e.contact_id);
  assert.deepEqual(got, [inAudience], "the detector honours the tag: " + JSON.stringify(got));
  assert.ok(!got.includes(outside));
});

sqlTest("the same tag filter governs a yearly trigger", async () => {
  const w = await owner();
  const inAudience = await contact(w, { tags: ["Past client"], birthday: "1988-06-10" });
  const outside = await contact(w, { tags: ["Website"], birthday: "1988-06-10" });
  const r = await rule(w, "birthday", {
    triggerConfig: { days_before: 0, fire_hour: 9 },
    audienceFilter: { tags_any: ["Past client"] }
  });

  await clearThrottle();
  await scan("2026-06-10T09:30:00Z");
  const got = (await events(w, r)).map((e) => e.contact_id);
  assert.deepEqual(got, [inAudience], "the yearly path honours it too: " + JSON.stringify(got));
  assert.ok(!got.includes(outside));
});

// ---------------------------------------------------------------- validator

sqlTest("the validator normalizes tags and refuses nonsense", async () => {
  assert.deepEqual(
    await validate("no_contact", { tags_any: ["  past client ", "PAST CLIENT", "Open House", ""] }),
    { ok: true, filter: { tags_any: ["Open House", "past client"] } },
    "trimmed, de-duplicated without regard to case keeping the first spelling, and sorted");

  // An empty list is no filter, never "match nobody".
  assert.deepEqual(await validate("no_contact", { tags_any: [] }), { ok: true, filter: {} });
  assert.deepEqual(await validate("no_contact", { tags_any: ["   "] }), { ok: true, filter: {} });

  // status_equals keeps its contract, including being required for the one
  // type that cannot work without it.
  assert.deepEqual(await validate("contact_status_changed", { status_equals: "Qualified" }),
    { ok: true, filter: { status_equals: "Qualified" } });
  assert.deepEqual(
    await validate("contact_status_changed", { status_equals: "Client", tags_any: ["VIP"] }),
    { ok: true, filter: { status_equals: "Client", tags_any: ["VIP"] } },
    "both together is fine");

  for (const bad of [
    { nope: 1 },
    { tags_any: "Past client" },
    { tags_any: [{}] },
    { status_equals: "Not A Status" },
  ]) {
    const r = await validate("no_contact", bad);
    assert.equal(r.ok, false, JSON.stringify(bad) + " must be rejected");
    assert.ok(String(r.code).startsWith("audience_filter"), r.code);
  }
  const missing = await validate("contact_status_changed", {});
  assert.equal(missing.ok, false, "a status-change rule needs its status");
  assert.equal(missing.code, "audience_filter_status_required");
});

sqlTest("a draft is normalized on write, so what is stored is what matches", async () => {
  const w = await owner();
  const r = await rule(w, "no_contact", {
    triggerConfig: { days: 30 },
    audienceFilter: { tags_any: ["  Past Client ", "past client", "VIP"] }
  });
  const stored = await one(db,
    `select audience_filter from public.automation_rules where id = $1`, [r]);
  assert.deepEqual(stored.audience_filter, { tags_any: ["Past Client", "VIP"] },
    "the trigger normalized it on the way in");

  // And a filter that could never be valid cannot be stored at all.
  await assert.rejects(
    rule(w, "no_contact", { triggerConfig: { days: 30 }, audienceFilter: { nope: 1 } }),
    /audience_filter_unknown_key/);
});

// ---------------------------------------------------------------- the rest

sqlTest("UTC is in the time zone picker, alongside the real zones", async () => {
  const zones = (await db.query(`select * from public.realtoros_timezone_names()`)).rows
    .map((r) => r.realtoros_timezone_names);
  assert.equal(zones[0], "UTC", "first, because it is the default and what people look for");
  assert.ok(zones.includes("Asia/Dubai"));
  assert.ok(zones.includes("Europe/London"));
  assert.equal(zones.filter((z) => z === "UTC").length, 1, "and only once");
  assert.ok(!zones.some((z) => String(z).startsWith("Etc/")), "no Etc/ clutter");
});

sqlTest("no matching path carries its own copy of the tag rule", async () => {
  // The whole reason for putting it in rule_targets_contact. If a future
  // change inlines it somewhere, this fails rather than the two quietly
  // disagreeing.
  const rows = (await db.query(
    `select p.proname, (p.prosrc like '%tags_any%') as has_copy,
            (p.prosrc like '%rule_targets_contact%') as delegates
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('realtoros_rules_for_event', 'realtoros_scan_time_triggers')
      order by p.proname`)).rows;
  assert.equal(rows.length, 2);
  rows.forEach((r) => {
    assert.equal(r.has_copy, false, r.proname + " should not mention tags_any itself");
    assert.equal(r.delegates, true, r.proname + " should go through the shared helper");
  });
});

sqlTest("the browser may validate a filter but not run the matcher", async () => {
  await db.exec("reset role");
  await db.exec("set role authenticated");
  await db.query(`select public.realtoros_validate_audience_filter('no_contact', '{}'::jsonb)`);
  await db.query(`select * from public.realtoros_timezone_names() limit 1`);
  await assert.rejects(
    db.query(`select automation_internal.rule_targets_contact($1, 'x')`, [randomUUID()]),
    /permission denied/);
  await assert.rejects(db.query(`select public.realtoros_rules_for_event($1)`, [randomUUID()]),
    /permission denied/);
  await db.exec("reset role");
});
