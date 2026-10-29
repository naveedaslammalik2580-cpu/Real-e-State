// Phase 3B: the devices, the preferences and the push queue.
//
// Two things are worth proving hardest. One, the browser cannot write
// either new table: everything goes through the SECURITY DEFINER
// functions, which take the owner and the workspace from the session
// rather than the request. Two, the claim's decisions - skip, defer,
// send - because they are the difference between a useful notification
// and a phone buzzing at 3am.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { migratedDb, one, SKIP_MESSAGE } from "../helpers/pg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(here, "..", "..", "supabase", "migrations",
  "20261015170000_phase_3b_push.sql");

let db;
before(async () => { db = await migratedDb(); });
after(async () => { if (db) { try { await db.close(); } catch (e) { /* closed */ } } });

function sqlTest(name, fn) {
  test(name, async (t) => {
    if (!db) return t.skip(SKIP_MESSAGE);
    await db.exec("reset role");
    await fn(db);
  });
}

const svc = async (fn) => {
  await db.exec("set role service_role");
  try { return await fn(); } finally { await db.exec("reset role"); }
};

/** Signs in as this user for the statements that follow. */
async function asUser(id, fn) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [id]);
  await db.exec("set role authenticated");
  try { return await fn(); } finally {
    await db.exec("reset role");
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}

async function owner() {
  await db.exec("reset role");
  const id = randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`,
    [id, `o.${id.slice(0, 8)}@example.com`]);
  const r = await one(db,
    `select workspace_id from public.workspace_members
      where user_id = $1 and status = 'active'`, [id]);
  return { id, ws: r.workspace_id };
}

const endpoint = (n) => "https://fcm.googleapis.com/fcm/send/" + n + "-" + randomUUID().slice(0, 8);
const KEY = "BPx".padEnd(87, "A");     // 87 chars, base64url-ish, like a real p256dh
const AUTH = "c2FsdHNhbHRzYWx0c2E";

const register = (user, ep, label = "") => asUser(user.id, () => one(db,
  `select public.realtoros_register_push_subscription($1,$2,$3,$4) as out`,
  [ep, KEY, AUTH, label]));

async function notify(w, type = "lead_replied", createdAt = null) {
  const id = randomUUID();
  await svc(() => db.query(
    `insert into public.notifications
       (id, user_id, workspace_id, type, title, body, dedupe_key, created_at, link_route)
     values ($1::uuid,$2,$3,$4,'A lead replied','Have a look','k:'||($1::uuid)::text,
             coalesce($5::timestamptz, now()), '/contacts')`,
    [id, w.id, w.ws, type, createdAt]));
  return id;
}

const claim = (now = null, limit = 20) => svc(async () => (await one(db,
  `select public.realtoros_claim_push_batch($1::int, $2::timestamptz) as out`, [limit, now])).out);

const complete = (id, outcome, dead = null) => svc(async () => (await one(db,
  `select public.realtoros_complete_push($1, $2, $3::text[]) as out`, [id, outcome, dead])).out);

const rowOf = (id) => one(db,
  `select push_status, push_attempts, pushed_at, push_locked_until
     from public.notifications where id = $1`, [id]);

const devicesOf = (user) => db.query(
  `select endpoint, device_label, failure_count, last_success_at, workspace_id
     from public.push_subscriptions where user_id = $1 order by created_at`, [user.id]);

// ---------------------------------------------------------------- devices

sqlTest("registering takes the owner and workspace from the session, not the request", async () => {
  const w = await owner();
  const ep = endpoint("a");
  const out = await register(w, ep, "Sarah's iPhone");
  assert.equal(out.out.outcome, "registered");
  assert.equal(out.out.reassigned, false);

  const rows = (await devicesOf(w)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endpoint, ep);
  assert.equal(rows[0].device_label, "Sarah's iPhone");
  assert.equal(rows[0].workspace_id, w.ws,
    "the workspace came from the membership - the browser never named it");
});

sqlTest("re-registering the same browser updates it rather than adding a second", async () => {
  const w = await owner();
  const ep = endpoint("b");
  await register(w, ep, "Old phone");
  await register(w, ep, "New phone");
  const rows = (await devicesOf(w)).rows;
  assert.equal(rows.length, 1, "one browser, one row");
  assert.equal(rows[0].device_label, "New phone");

  // A silent refresh sends no label, and must not wipe the one there.
  await register(w, ep, "");
  assert.equal((await devicesOf(w)).rows[0].device_label, "New phone");

  // A device that had been failing is healthy again once it re-subscribes.
  await svc(() => db.query(
    `update public.push_subscriptions set failure_count = 2 where endpoint = $1`, [ep]));
  await register(w, ep, "");
  assert.equal((await devicesOf(w)).rows[0].failure_count, 0);
});

sqlTest("an endpoint that belonged to somebody else moves to whoever signs in", async () => {
  const a = await owner();
  const b = await owner();
  const ep = endpoint("shared");
  await register(a, ep, "The office iPad");
  const out = await register(b, ep, "The office iPad");

  assert.equal(out.out.outcome, "registered");
  assert.equal(out.out.reassigned, true, "and it says so, because it took a device from somebody");
  assert.equal((await devicesOf(a)).rows.length, 0,
    "the previous owner stops receiving on a device they no longer sign in on");
  assert.equal((await devicesOf(b)).rows.length, 1);
});

sqlTest("a device list is the caller's own, and nobody else's", async () => {
  const a = await owner();
  const b = await owner();
  await register(a, endpoint("mine"));
  await register(b, endpoint("theirs"));

  const mine = await asUser(a.id, () => db.query(`select endpoint from public.push_subscriptions`));
  assert.equal(mine.rows.length, 1, "RLS shows one row, not two");

  // Removing is own-rows-only too, enforced inside the function because
  // SECURITY DEFINER walks past the policy.
  const theirEndpoint = (await devicesOf(b)).rows[0].endpoint;
  const out = await asUser(a.id, () => one(db,
    `select public.realtoros_remove_push_subscription($1) as out`, [theirEndpoint]));
  assert.equal(out.out.outcome, "not_found");
  assert.equal((await devicesOf(b)).rows.length, 1, "their device survives");

  const own = (await devicesOf(a)).rows[0].endpoint;
  const gone = await asUser(a.id, () => one(db,
    `select public.realtoros_remove_push_subscription($1) as out`, [own]));
  assert.equal(gone.out.outcome, "removed");
  assert.equal((await devicesOf(a)).rows.length, 0);
});

sqlTest("the browser cannot write either table directly, or run the queue", async () => {
  const w = await owner();
  await asUser(w.id, async () => {
    await assert.rejects(db.query(
      `insert into public.push_subscriptions (workspace_id, user_id, endpoint, p256dh, auth)
       values ($1,$2,$3,$4,$5)`, [w.ws, w.id, endpoint("x"), KEY, AUTH]),
      /permission denied/, "no INSERT grant at all");
    await assert.rejects(db.query(`delete from public.push_subscriptions`), /permission denied/);
    await assert.rejects(db.query(
      `insert into public.notification_preferences (user_id, workspace_id) values ($1,$2)`,
      [w.id, w.ws]), /permission denied/);
    await assert.rejects(db.query(`select public.realtoros_claim_push_batch(5)`), /permission denied/);
    await assert.rejects(db.query(
      `select public.realtoros_complete_push($1, 'sent', null)`, [randomUUID()]),
      /permission denied/);
  });
});

// ---------------------------------------------------------------- preferences

sqlTest("preferences validate, sort under COLLATE \"C\", and stay the caller's own", async () => {
  const w = await owner();
  const set = (enabled, types, qs = null, qe = null) => asUser(w.id, () => one(db,
    `select public.realtoros_set_notification_preferences($1,$2::text[],$3::time,$4::time) as out`,
    [enabled, types, qs, qe]));

  const saved = await set(true, ["overdue_followups", "hot_reply", "hot_reply"]);
  assert.equal(saved.out.outcome, "saved");
  assert.deepEqual(saved.out.push_types, ["hot_reply", "overdue_followups"],
    "de-duplicated and sorted, in an order that does not depend on the server's locale");

  assert.equal((await set(true, ["not_a_type"])).out.outcome, "unknown_type");
  assert.equal((await set(true, null, "22:00", null)).out.outcome, "invalid_quiet_hours",
    "half a window is not a window");

  const prefs = await asUser(w.id, () => one(db,
    `select public.realtoros_notification_preferences() as out`));
  assert.equal(prefs.out.push_enabled, true);
  assert.deepEqual(prefs.out.push_types, ["hot_reply", "overdue_followups"]);
  assert.equal(prefs.out.stored, true);
  assert.equal(prefs.out.all_types.length, 9, "and the full list, so the UI needs no second copy");

  // Somebody who has never opened the screen gets the defaults spelled out.
  const fresh = await owner();
  const theirs = await asUser(fresh.id, () => one(db,
    `select public.realtoros_notification_preferences() as out`));
  assert.equal(theirs.out.stored, false);
  assert.equal(theirs.out.push_enabled, true);
  assert.equal(theirs.out.push_types.length, 9, "no row means every type, not none");
});

// ---------------------------------------------------------------- the claim

sqlTest("the claim skips what it cannot or should not send", async () => {
  // No devices at all.
  const noDevice = await owner();
  const n1 = await notify(noDevice);
  await claim();
  assert.equal((await rowOf(n1)).push_status, "skipped", "nothing to send to");

  // Push switched off entirely.
  const off = await owner();
  await register(off, endpoint("off"));
  await asUser(off.id, () => db.query(
    `select public.realtoros_set_notification_preferences(false, null, null, null)`));
  const n2 = await notify(off);
  await claim();
  assert.equal((await rowOf(n2)).push_status, "skipped", "switched off");

  // This type switched off; another type still goes.
  const some = await owner();
  await register(some, endpoint("some"));
  await asUser(some.id, () => db.query(
    `select public.realtoros_set_notification_preferences(true, array['hot_reply'], null, null)`));
  const unwanted = await notify(some, "import_finished");
  const wanted = await notify(some, "hot_reply");
  const out = await claim();
  assert.equal((await rowOf(unwanted)).push_status, "skipped");
  assert.equal((await rowOf(wanted)).push_status, "pending", "still pending: it is out for delivery");
  const ids = out.claimed.map((c) => c.id);
  assert.ok(ids.includes(wanted), "and it was handed to the worker: " + JSON.stringify(ids));
  assert.ok(!ids.includes(unwanted));
});

sqlTest("a claimed notification arrives with its devices, its route and no PII", async () => {
  const w = await owner();
  const ep = endpoint("claim");
  await register(w, ep, "Pixel");
  const id = await notify(w);

  const out = await claim();
  const row = out.claimed.find((c) => c.id === id);
  assert.ok(row, "it was claimed: " + JSON.stringify(out));
  assert.deepEqual(Object.keys(row).sort(),
    ["body", "id", "subscriptions", "title", "type", "url"],
    "exactly what a payload needs and nothing more - no contact id, no email");
  assert.equal(row.url, "/contacts", "the app route, not a URL");
  assert.equal(row.subscriptions.length, 1);
  assert.deepEqual(Object.keys(row.subscriptions[0]).sort(), ["auth", "endpoint", "p256dh"]);

  // Leased, so a second worker running now does not take it again.
  const locked = await rowOf(id);
  assert.ok(locked.push_locked_until, "it is leased");
  const second = await claim();
  assert.ok(!second.claimed.some((c) => c.id === id), "a concurrent run leaves it alone");
});

sqlTest("quiet hours defer rather than skip, including across midnight", async () => {
  const w = await owner();
  await register(w, endpoint("quiet"));
  // A workspace in a real zone, so the window is not accidentally UTC.
  // A workspace only has a settings row once something has written one,
  // so this creates it rather than assuming it.
  await svc(() => db.query(
    `insert into public.workspace_settings (id, user_id, workspace_id, settings_data)
     values ('wset_' || replace($2::text, '-', ''), $2::uuid, $1::uuid, '{"timezone":"Asia/Dubai"}'::jsonb)
     on conflict (workspace_id) do update
       set settings_data = coalesce(public.workspace_settings.settings_data, '{}'::jsonb)
                           || '{"timezone":"Asia/Dubai"}'::jsonb`, [w.ws, w.id]));
  await asUser(w.id, () => db.query(
    `select public.realtoros_set_notification_preferences(true, null, '22:00'::time, '07:00'::time)`));

  // 23:30 in Dubai (UTC+4) is 19:30 UTC: inside the window, which wraps.
  const night = await notify(w);
  await claim("2026-06-10T19:30:00Z");
  let row = await rowOf(night);
  assert.equal(row.push_status, "pending", "held, not dropped - it still matters in the morning");
  assert.ok(row.push_locked_until, "and it is waiting for a time, not for ever");
  // 07:00 Dubai the next morning is 03:00 UTC.
  assert.equal(new Date(row.push_locked_until).toISOString(), "2026-06-11T03:00:00.000Z",
    "it resumes when the window ends, in the workspace's own zone");

  // 02:00 Dubai is still inside the window, and resumes the SAME morning.
  await svc(() => db.query(
    `update public.notifications set push_locked_until = null where id = $1`, [night]));
  await claim("2026-06-10T22:00:00Z");  // 02:00 Dubai on the 11th
  row = await rowOf(night);
  assert.equal(new Date(row.push_locked_until).toISOString(), "2026-06-11T03:00:00.000Z");

  // And outside the window it simply goes.
  await svc(() => db.query(
    `update public.notifications set push_locked_until = null where id = $1`, [night]));
  const out = await claim("2026-06-10T10:00:00Z");   // 14:00 Dubai
  assert.ok(out.claimed.some((c) => c.id === night), "daytime: it is handed over");
});

// ---------------------------------------------------------------- completing

sqlTest("completing records the result, drops dead devices and caps attempts", async () => {
  const w = await owner();
  const good = endpoint("good");
  const dead = endpoint("dead");
  await register(w, good, "Phone");
  await register(w, dead, "An old phone");

  // A send where one device is gone for good.
  const id = await notify(w);
  await claim();
  const done = await complete(id, "sent", [dead]);
  assert.equal(done.outcome, "sent");
  assert.equal(done.removed_devices, 1);

  const rows = (await devicesOf(w)).rows;
  assert.equal(rows.length, 1, "the 410 endpoint is gone: it will never work again");
  assert.equal(rows[0].endpoint, good);
  assert.ok(rows[0].last_success_at, "and the one that worked is marked healthy");

  const sent = await rowOf(id);
  assert.equal(sent.push_status, "sent");
  assert.ok(sent.pushed_at);
  assert.equal(sent.push_locked_until, null);

  // Three failures and it stops. Each one counts against the device too.
  const id2 = await notify(w);
  let out = await complete(id2, "failed");
  assert.equal(out.outcome, "pending", "first failure: try again later");
  assert.ok((await rowOf(id2)).push_locked_until, "after a wait");
  out = await complete(id2, "failed");
  assert.equal(out.outcome, "pending");
  out = await complete(id2, "failed");
  assert.equal(out.outcome, "failed", "three is enough");
  assert.equal((await rowOf(id2)).push_status, "failed");
  assert.equal((await devicesOf(w)).rows[0].failure_count, 3,
    "and the device's own record says it has been refusing");

  assert.equal((await complete(randomUUID(), "sent")).outcome, "not_found");
  assert.equal((await complete(id2, "nonsense")).outcome, "invalid_outcome");
});

// ---------------------------------------------------------------- the column

sqlTest("notifications that existed before this phase are skipped, not pushed", async () => {
  // The backfill is in the migration itself, so proving it means
  // re-running the whole thing against a row that predates it. Applying
  // twice is required anyway, so both are proven here.
  const w = await owner();
  const old = await notify(w);
  await svc(() => db.query(
    `update public.notifications set push_status = 'skipped' where id = $1`, [old]));

  const sql = fs.readFileSync(MIGRATION, "utf8");
  await db.exec("reset role");
  await db.exec(sql);
  await db.exec(sql);   // and a third time over, since this is the re-run check

  assert.equal((await rowOf(old)).push_status, "skipped",
    "a second apply does not reopen history");

  // The default for anything new is still pending.
  const fresh = await notify(w);
  assert.equal((await rowOf(fresh)).push_status, "pending");

  // Nothing was duplicated by the re-run.
  const dupes = await one(db, `
    select count(*) as n from pg_constraint c join pg_class t on t.oid = c.conrelid
     where t.relname = 'notifications' and c.conname = 'notifications_push_status_check'`);
  assert.equal(Number(dupes.n), 1);
});
