// Phase 4H: in-app notifications. Real migration chain in PGlite; writers
// run as service_role (as in production), the browser as authenticated.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { migratedDb, seedWorld, one, rpc, SKIP_MESSAGE, MIGRATIONS_DIR } from "../helpers/pg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(here, "..", "..", "supabase", "tests", "phase_4h_verification.sql");
const MIGRATION_4H = "20260929150944_phase_4h_in_app_notifications.sql";

let db;
before(async () => { db = await migratedDb(); });

function sqlTest(name, fn) {
  test(name, async (t) => {
    if (!db) return t.skip(SKIP_MESSAGE);
    await fn();
  });
}
async function asService(fn) {
  await db.exec("set role service_role");
  try { return await fn(); } finally { await db.exec("reset role"); }
}
async function asBrowser(userId, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  await db.exec("set role authenticated");
  try { return await fn(); } finally {
    await db.exec("reset role");
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}
const record = (args) => asService(() => rpc(db, "realtoros_record_contact_stop_event", args));
const markHot = (args) => asService(() => rpc(db, "realtoros_mark_reply_hot", args));
const fileImport = (args) => asService(() => rpc(db, "realtoros_ingest_lead_file", {
  p_file_name: "leads.csv", p_start_automation: false, p_import_id: randomUUID(), ...args,
}));
const notes = async (userId) => (await db.query(
  `select type, title, body, contact_id, link_route, dedupe_key, metadata, read_at from public.notifications
   where user_id = $1 order by created_at, dedupe_key`, [userId])).rows;
const EMAIL_SHAPE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

async function sheetConnection(userId, name = "Website leads") {
  const conn = randomUUID();
  await db.query(`insert into public.lead_source_connections (id, user_id, name, spreadsheet_id, status) values ($1, $2, $3, $4, 'active')`,
    [conn, userId, name, `sheet-${conn.slice(0, 8)}`]);
  return conn;
}
const sheetSync = (conn, event, rows) => asService(() => rpc(db, "realtoros_ingest_lead_batch", {
  p_connection_id: conn, p_source_event_id: event, p_sheet_revision: null, p_rows: JSON.stringify(rows),
}));

// ---------------------------------------------------------------- schema

sqlTest("verification query: every check passes", async () => {
  const rows = (await db.query(fs.readFileSync(VERIFY, "utf8"))).rows;
  assert.deepEqual(rows.filter((r) => r.ok !== true), []);
  assert.ok(rows.length >= 45, `got ${rows.length} checks`);
});

sqlTest("migration is re-runnable", async () => {
  await db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_4H), "utf8"));
  const rows = (await db.query(fs.readFileSync(VERIFY, "utf8"))).rows;
  assert.deepEqual(rows.filter((r) => r.ok !== true), []);
});

// ---------------------------------------------------------------- stop events

sqlTest("a detected reply makes one lead_replied notification; a replayed event makes none extra", async () => {
  const w = await seedWorld(db);
  const args = { p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "reply", p_source: "inbound_email", p_event_ref: "inbound:em_1" };
  assert.equal((await record(args)).outcome, "recorded");
  assert.equal((await record(args)).outcome, "duplicate");
  const n = await notes(w.userId);
  assert.equal(n.length, 1);
  assert.equal(n[0].type, "lead_replied");
  assert.equal(n[0].title, "Test Person replied to your follow-up");
  assert.equal(n[0].contact_id, w.contactId);
  assert.equal(n[0].link_route, `/contacts/${w.contactId}`);
  assert.match(n[0].dedupe_key, /^stop:[0-9a-f-]{36}$/);
  assert.deepEqual(n[0].metadata, { event_type: "reply", source: "inbound_email" });
  assert.equal(n[0].read_at, null);
  assert.doesNotMatch(JSON.stringify(n[0]), EMAIL_SHAPE, "no email address anywhere");
});

sqlTest("unsubscribe (link / reply), spam report and bounce: the right type and wording", async () => {
  const w = await seedWorld(db);
  const base = { p_user_id: w.userId, p_contact_id: w.contactId };
  await record({ ...base, p_event_type: "unsubscribe", p_source: "unsubscribe_link", p_event_ref: "unsub:1" });
  await record({ ...base, p_event_type: "unsubscribe", p_source: "inbound_email", p_event_ref: "inbound:2" });
  await record({ ...base, p_event_type: "complaint", p_source: "provider_webhook", p_event_ref: "evt:3" });
  await record({ ...base, p_event_type: "hard_bounce", p_source: "provider_webhook", p_event_ref: "evt:4" });
  const byRef = Object.fromEntries((await notes(w.userId)).map((n) => [n.metadata.source + "/" + n.metadata.event_type, n]));
  assert.equal(byRef["unsubscribe_link/unsubscribe"].type, "unsubscribed");
  assert.match(byRef["unsubscribe_link/unsubscribe"].body, /^They used the unsubscribe link/);
  assert.match(byRef["inbound_email/unsubscribe"].body, /^They replied asking to be unsubscribed\./);
  assert.equal(byRef["inbound_email/unsubscribe"].title, "Test Person unsubscribed from your follow-up emails");
  assert.equal(byRef["provider_webhook/complaint"].type, "spam_report");
  assert.equal(byRef["provider_webhook/complaint"].title, "Test Person reported a follow-up email as spam");
  assert.equal(byRef["provider_webhook/hard_bounce"].type, "email_bounced");
  assert.equal(byRef["provider_webhook/hard_bounce"].title, "A follow-up email to Test Person bounced");
  assert.equal(Object.keys(byRef).length, 4);
});

sqlTest("replies and unsubscribes the owner marked themselves make no notification", async () => {
  const w = await seedWorld(db);
  const base = { p_user_id: w.userId, p_contact_id: w.contactId, p_source: "owner_manual" };
  assert.equal((await record({ ...base, p_event_type: "reply", p_event_ref: "manual:1" })).outcome, "recorded");
  assert.equal((await record({ ...base, p_event_type: "unsubscribe", p_event_ref: "manual:2" })).outcome, "recorded");
  assert.deepEqual(await notes(w.userId), []);
});

sqlTest("no name, or a 'name' that is an email address -> 'A contact'; never an address", async () => {
  const w = await seedWorld(db);
  await db.query(`update public.contacts set full_name = 'pat@example.com' where id = $1`, [w.contactId]);
  await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "reply", p_source: "inbound_email", p_event_ref: "inbound:x" });
  await db.query(`update public.contacts set full_name = '' where id = $1`, [w.contactId]);
  await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "hard_bounce", p_source: "provider_webhook", p_event_ref: "evt:x" });
  const n = await notes(w.userId);
  assert.deepEqual(n.map((x) => x.title).sort(), ["A contact replied to your follow-up", "A follow-up email to a contact bounced"]);
});

// ---------------------------------------------------------------- imports

sqlTest("file upload: exactly one notification per batch, counts only where non-zero; a replay adds none", async () => {
  const w = await seedWorld(db);
  const importId = randomUUID();
  const rows = JSON.stringify([
    { full_name: "New One", email: "n1@example.com" }, { email: "n2@example.com" }, { email: "n3@example.com" },
    { email: "broken" },
    { email: w.email.toLowerCase(), notes: "fills a blank" },
  ]);
  await fileImport({ p_user_id: w.userId, p_import_id: importId, p_file_name: "Open house.xlsx", p_rows: rows });
  await fileImport({ p_user_id: w.userId, p_import_id: importId, p_file_name: "Open house.xlsx", p_rows: rows });
  const n = (await notes(w.userId)).filter((x) => x.type === "import_finished");
  assert.equal(n.length, 1);
  assert.equal(n[0].title, "File upload finished: 3 added, 1 updated, 1 needs fixing");
  assert.equal(n[0].body, 'From "Open house.xlsx". Open Import History for the details.');
  assert.equal(n[0].link_route, "/settings/sheet-imports");
  assert.equal(n[0].contact_id, null);
  assert.equal(n[0].metadata.source_type, "file_upload");
  assert.deepEqual([n[0].metadata.imported, n[0].metadata.need_fixing, n[0].metadata.held_back], [3, 1, 0]);
});

sqlTest("file upload: held back by the daily limit is reported; nothing new says so", async () => {
  const w = await seedWorld(db);
  const many = JSON.stringify(Array.from({ length: 203 }, (_, i) => ({ email: `lim${i}@example.com` })));
  await fileImport({ p_user_id: w.userId, p_rows: many, p_file_name: "big@list.csv" });
  await fileImport({ p_user_id: w.userId, p_rows: JSON.stringify([{ email: "lim0@example.com" }]) });
  const titles = (await notes(w.userId)).filter((x) => x.type === "import_finished").map((x) => x.title);
  assert.deepEqual(titles, ["File upload finished: 200 added, 3 held back by today's limit", "File upload finished: no new contacts"]);
  const first = (await notes(w.userId)).find((x) => x.type === "import_finished");
  assert.doesNotMatch(first.body, /@/, "an address-shaped file name is not repeated");
});

sqlTest("Google Sheets: new leads notify; a quiet sync does not; syncs within an hour update one unread notification", async () => {
  const w = await seedWorld(db);
  const conn = await sheetConnection(w.userId);
  await sheetSync(conn, "event-q-0001", [{ lead_id: "A", full_name: "Alpha", email: "a@example.com" }, { lead_id: "B", full_name: "Beta", email: "b@example.com" }]);
  let n = (await notes(w.userId)).filter((x) => x.type === "import_finished");
  assert.equal(n.length, 1);
  assert.equal(n[0].title, "Google Sheets sync: 2 new leads");
  assert.equal(n[0].body, 'From "Website leads". Open Import History for the details.');
  const firstCreated = (await one(db, `select created_at from public.notifications where user_id = $1 and type = 'import_finished'`, [w.userId])).created_at;

  // Quiet: the same leads again (duplicates only).
  await sheetSync(conn, "event-q-0002", [{ lead_id: "A", full_name: "Alpha", email: "a@example.com" }]);
  assert.equal((await notes(w.userId)).filter((x) => x.type === "import_finished").length, 1);
  assert.equal((await notes(w.userId)).find((x) => x.type === "import_finished").title, "Google Sheets sync: 2 new leads");

  // Another sync with news, within the hour: same notification, counts added.
  await sheetSync(conn, "event-q-0003", [{ lead_id: "C", full_name: "Gamma", email: "c@example.com" }, { lead_id: "D", full_name: "" }]);
  n = (await notes(w.userId)).filter((x) => x.type === "import_finished");
  assert.equal(n.length, 1, "grouped");
  assert.equal(n[0].title, "Google Sheets sync: 3 new leads, 1 needs fixing");
  assert.equal(n[0].body, 'From "Website leads", 2 syncs in the last hour. Open Import History for the details.');
  const refreshed = (await one(db, `select created_at from public.notifications where user_id = $1 and type = 'import_finished'`, [w.userId])).created_at;
  assert.ok(refreshed >= firstCreated);

  // Once read, the next sync starts a new notification.
  await db.query(`update public.notifications set read_at = now() where user_id = $1`, [w.userId]);
  await sheetSync(conn, "event-q-0004", [{ lead_id: "E", full_name: "Epsilon", email: "e@example.com" }]);
  n = (await notes(w.userId)).filter((x) => x.type === "import_finished");
  assert.equal(n.length, 2);
  assert.equal(n.filter((x) => x.read_at === null)[0].title, "Google Sheets sync: 1 new lead");

  // An unread one older than an hour is not reused.
  await db.query(`update public.notifications set created_at = created_at - interval '61 minutes' where user_id = $1`, [w.userId]);
  await sheetSync(conn, "event-q-0005", [{ lead_id: "F", full_name: "Phi", email: "f@example.com" }]);
  assert.equal((await notes(w.userId)).filter((x) => x.type === "import_finished").length, 3);

  // A different connection is never grouped with this one.
  const other = await sheetConnection(w.userId, "Open house sheet");
  await sheetSync(other, "event-q-0006", [{ lead_id: "G", full_name: "Gee", email: "g@example.com" }]);
  assert.equal((await notes(w.userId)).filter((x) => x.type === "import_finished").length, 4);
});

// ---------------------------------------------------------------- jobs

sqlTest("a job that fails for good makes one notification; a retrying job none; a manual retry that fails again, one more", async () => {
  const w = await seedWorld(db);
  const setJob = (sql) => asService(() => db.query(`update public.automation_jobs set ${sql} where id = $1`, [w.jobId]));
  await setJob("status = 'processing'");
  await setJob("status = 'pending', attempts = 1");          // retry scheduled
  assert.deepEqual(await notes(w.userId), []);
  await setJob("status = 'processing'");
  await setJob("status = 'failed', attempts = 3");           // terminal
  await setJob("last_error = 'x'");                          // later edits of a failed job: nothing
  let n = await notes(w.userId);
  assert.equal(n.length, 1);
  assert.equal(n[0].type, "followup_failed");
  assert.equal(n[0].title, "A follow-up email to Test Person couldn't be sent");
  assert.equal(n[0].link_route, "/automation");
  assert.equal(n[0].dedupe_key, `job_failed:${w.jobId}:0`);
  await setJob("status = 'pending', manual_retry_count = 1, max_attempts = 4");
  await setJob("status = 'failed'");
  n = await notes(w.userId);
  assert.equal(n.length, 2);
  assert.equal(n[1].dedupe_key, `job_failed:${w.jobId}:1`);
});

sqlTest("a failed task step is worded as an automation step", async () => {
  const w = await seedWorld(db, { jobType: "create_task" });
  await asService(() => db.query(`update public.automation_jobs set status = 'failed' where id = $1`, [w.jobId]));
  assert.equal((await notes(w.userId))[0].title, "An automation step for Test Person couldn't be completed");
});

// ---------------------------------------------------------------- never break the source

sqlTest("a failure inside the notification writer never breaks the stop event, import or job", async () => {
  const w = await seedWorld(db);
  const conn = await sheetConnection(w.userId);
  await db.exec(`create or replace function automation_internal.notify(
      p_user_id uuid, p_type text, p_title text, p_body text, p_contact_id text,
      p_link_route text, p_dedupe_key text, p_metadata jsonb default '{}'::jsonb)
    returns uuid language plpgsql security invoker set search_path = '' as $$
    begin raise exception 'forced notification failure'; end; $$`);
  try {
    const r = await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "reply", p_source: "inbound_email", p_event_ref: "inbound:ff" });
    assert.equal(r.outcome, "recorded");
    assert.equal(Number((await one(db, `select count(*) n from public.contact_stop_events where user_id = $1`, [w.userId])).n), 1);
    const f = await fileImport({ p_user_id: w.userId, p_rows: JSON.stringify([{ email: "ff1@example.com" }]) });
    assert.equal(f.imported_count, 1);
    assert.equal((await one(db, `select status from public.lead_import_batches where id = $1`, [f.batch_id])).status, "completed");
    const s = await sheetSync(conn, "event-ff-0001", [{ lead_id: "Z", full_name: "Zed", email: "zed@example.com" }]);
    assert.equal(s.status, "completed");
    await asService(() => db.query(`update public.automation_jobs set status = 'failed' where id = $1`, [w.jobId]));
    assert.equal((await one(db, `select status from public.automation_jobs where id = $1`, [w.jobId])).status, "failed");
    assert.deepEqual(await notes(w.userId), [], "nothing written, nothing broken");
  } finally {
    await db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_4H), "utf8"));
  }
  // And the real writer is back.
  await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "hard_bounce", p_source: "provider_webhook", p_event_ref: "evt:after" });
  assert.equal((await notes(w.userId)).length, 1);
});

sqlTest("a contact id that is not route-safe links to the contact list", async () => {
  const w = await seedWorld(db);
  const odd = "odd id/with slash";
  await db.query(`insert into public.contacts (id, user_id, full_name) values ($1, $2, 'Odd Id')`, [odd, w.userId]);
  await record({ p_user_id: w.userId, p_contact_id: odd, p_event_type: "reply", p_source: "inbound_email", p_event_ref: "inbound:odd" });
  const n = await notes(w.userId);
  assert.equal(n[0].link_route, "/contacts");
});

// ---------------------------------------------------------------- hot replies

sqlTest("mark reply hot: the reply's own notification becomes hot_reply (one row); idempotent; read state kept", async () => {
  const w = await seedWorld(db);
  await db.query(`update public.contacts set full_name = 'Sarah Ahmed' where id = $1`, [w.contactId]);
  await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "reply", p_source: "inbound_email", p_event_ref: "inbound:hot1" });
  const r = await markHot({ p_user_id: w.userId, p_event_ref: "inbound:hot1", p_reason: "viewing" });
  assert.equal(r.outcome, "marked");
  await db.query(`update public.notifications set read_at = now() where user_id = $1`, [w.userId]);
  await markHot({ p_user_id: w.userId, p_event_ref: "inbound:hot1", p_reason: "viewing" });
  const n = await notes(w.userId);
  assert.equal(n.length, 1);
  assert.equal(n[0].type, "hot_reply");
  assert.equal(n[0].title, "🔥 Sarah Ahmed replied — asked about a viewing");
  assert.equal(n[0].metadata.hot_reason, "viewing");
  assert.notEqual(n[0].read_at, null, "a duplicate delivery does not mark it unread again");
});

sqlTest("mark reply hot: every reason has plain wording; bad input is refused; no reply event -> nothing", async () => {
  const w = await seedWorld(db);
  const labels = {
    viewing: "asked about a viewing", offer: "mentioned making an offer", ready: "said they're ready to move",
    financing: "said their financing is ready", call_request: "asked you to call",
    availability: "asked if it's still available", price: "asked about the price",
  };
  for (const [reason, label] of Object.entries(labels)) {
    await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "reply", p_source: "inbound_email", p_event_ref: `inbound:${reason}` });
    await markHot({ p_user_id: w.userId, p_event_ref: `inbound:${reason}`, p_reason: reason });
    const t = (await one(db, `select title from public.notifications where user_id = $1 and metadata ->> 'hot_reason' = $2`, [w.userId, reason])).title;
    assert.equal(t, `🔥 Test Person replied — ${label}`);
  }
  await assert.rejects(markHot({ p_user_id: w.userId, p_event_ref: "inbound:viewing", p_reason: "urgent!!" }), /invalid hot reply reason/);
  assert.equal((await markHot({ p_user_id: w.userId, p_event_ref: "inbound:nope", p_reason: "offer" })).outcome, "no_reply_event");
  assert.equal((await notes(w.userId)).length, 7);
});

sqlTest("mark reply hot: if the reply's notification is missing, it is created as hot_reply under the same key", async () => {
  const w = await seedWorld(db);
  await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "reply", p_source: "inbound_email", p_event_ref: "inbound:gone" });
  await db.query(`delete from public.notifications where user_id = $1`, [w.userId]);
  await markHot({ p_user_id: w.userId, p_event_ref: "inbound:gone", p_reason: "offer" });
  await markHot({ p_user_id: w.userId, p_event_ref: "inbound:gone", p_reason: "offer" });
  const n = await notes(w.userId);
  assert.equal(n.length, 1);
  assert.equal(n[0].type, "hot_reply");
});

// ---------------------------------------------------------------- browser access

sqlTest("RLS: an owner sees only their own notifications", async () => {
  const a = await seedWorld(db);
  const b = await seedWorld(db);
  for (const w of [a, b]) {
    await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "hard_bounce", p_source: "provider_webhook", p_event_ref: "evt:rls" });
  }
  const seen = await asBrowser(a.userId, async () => (await db.query(`select user_id from public.notifications`)).rows);
  assert.deepEqual(seen.map((r) => r.user_id), [a.userId]);
  const none = await asBrowser(randomUUID(), async () => (await db.query(`select count(*)::int n from public.notifications`)).rows[0].n);
  assert.equal(none, 0);
});

sqlTest("RLS: the browser can set read_at on its own rows and nothing else", async () => {
  const a = await seedWorld(db);
  const b = await seedWorld(db);
  for (const w of [a, b]) {
    await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "hard_bounce", p_source: "provider_webhook", p_event_ref: "evt:rw" });
  }
  await asBrowser(a.userId, async () => {
    const own = await db.query(`update public.notifications set read_at = now() where read_at is null returning id`);
    assert.equal(own.rows.length, 1, "mark all read touches only own rows");
    const other = await db.query(`update public.notifications set read_at = now() where user_id = $1 returning id`, [b.userId]);
    assert.equal(other.rows.length, 0, "cannot touch another owner's row");
    await assert.rejects(db.query(`update public.notifications set title = 'hacked'`), /permission denied/);
    await assert.rejects(db.query(`update public.notifications set type = 'hot_reply'`), /permission denied/);
    await assert.rejects(db.query(`update public.notifications set user_id = $1`, [b.userId]), /permission denied/);
    await assert.rejects(db.query(`update public.notifications set link_route = '/automation'`), /permission denied/);
    await assert.rejects(db.query(`delete from public.notifications`), /permission denied/);
    await assert.rejects(
      db.query(`insert into public.notifications (user_id, type, title, dedupe_key) values ($1, 'lead_replied', 'x', 'k')`, [a.userId]),
      /permission denied/,
    );
    await assert.rejects(db.query(`select automation_internal.notify($1, 'lead_replied', 'x', '', null, null, 'k2')`, [a.userId]), /permission denied/);
    await assert.rejects(db.query(`select public.realtoros_mark_reply_hot($1, 'inbound:x', 'offer')`, [a.userId]), /permission denied/);
  });
  const bRow = await one(db, `select read_at from public.notifications where user_id = $1`, [b.userId]);
  assert.equal(bRow.read_at, null);
  await db.exec("set role anon");
  try {
    await assert.rejects(db.query(`select * from public.notifications`), /permission denied/);
  } finally {
    await db.exec("reset role");
  }
});

sqlTest("link_route allow-list: internal routes only", async () => {
  const w = await seedWorld(db);
  const ins = (route, key) => asService(() => db.query(
    `insert into public.notifications (user_id, type, title, link_route, dedupe_key) values ($1, 'import_finished', 'x', $2, $3)`,
    [w.userId, route, key]));
  for (const ok of ["/contacts", "/contacts/ct_abc-123", "/settings/sheet-imports", "/automation", "/notifications", null]) {
    await ins(ok, `ok:${ok}`);
  }
  for (const bad of ["https://evil.example.com", "//evil.example.com", "/contacts/../settings", "/settings/team", "javascript:alert(1)",
    "/automation?x=1", "/contacts/a b", "/Contacts", ""]) {
    await assert.rejects(ins(bad, `bad:${bad}`), /notifications_link_route_check/, bad);
  }
});

sqlTest("titles and bodies: plain text only, no email addresses, bounded length", async () => {
  const w = await seedWorld(db);
  const ins = (title, body = "") => asService(() => db.query(
    `insert into public.notifications (user_id, type, title, body, dedupe_key) values ($1, 'import_finished', $2, $3, $4)`,
    [w.userId, title, body, randomUUID()]));
  await assert.rejects(ins("Reply from pat@example.com"), /notifications_title_check/);
  await assert.rejects(ins("ok", "write to pat@example.com"), /notifications_body_check/);
  await assert.rejects(ins("line\nbreak"), /notifications_title_check/);
  await assert.rejects(ins("x".repeat(201)), /notifications_title_check/);
  await ins("🔥 Fine title — with punctuation's", "Fine body.");
});
