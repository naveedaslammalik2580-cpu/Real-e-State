// Phase 4E.4: file lead import + the shared ingestion core. Real migration
// chain in PGlite with real pgcrypto. Calls run as service_role.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { migratedDb, one, rpc, SKIP_MESSAGE } from "../helpers/pg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERIFY_4E4 = path.join(here, "..", "..", "supabase", "tests", "phase_4e_4_verification.sql");
const MIGRATION_4E4 = "20260929095530_phase_4e_4_file_lead_import.sql";
// Phase T2c redefines the three import functions (workspace-scoped quota,
// lock and de-duplication) and replaces 4E.4's user-scoped uniqueness.
// Re-running 4E.4 alone therefore UNDOES T2c, so the re-runnability test
// below replays T2c after it and checks the chain converges.
const MIGRATION_T2C = "20261006132041_phase_t2c_workspace_backend.sql";
const MIGRATIONS = path.join(here, "..", "..", "supabase", "migrations");

let db;
let before4e4;
before(async () => {
  db = await migratedDb();
  before4e4 = await migratedDb((f) => f < MIGRATION_4E4);
});

function sqlTest(name, fn) {
  test(name, async (t) => {
    if (!db) return t.skip(SKIP_MESSAGE);
    await fn();
  });
}
async function asService(d, fn) {
  await d.exec("set role service_role");
  try { return await fn(); } finally { await d.exec("reset role"); }
}
const count = async (d, sql, params) => Number((await one(d, sql, params)).n);

async function newOwner(d, userId = randomUUID()) {
  await d.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [userId]);
  return userId;
}
const fileImport = (d, args) => asService(d, () => rpc(d, "realtoros_ingest_lead_file", {
  p_file_name: "leads.csv", p_start_automation: false, p_import_id: randomUUID(), ...args,
}));
const quota = (d, userId) => asService(d, () => rpc(d, "realtoros_file_import_quota", { p_user_id: userId }));
const emails = (n, tag) => Array.from({ length: n }, (_, i) => ({ email: `${tag}${i + 1}@example.com` }));
const LIMIT_MESSAGE = "Not imported — daily limit of 200 new contacts reached. Upload this file again 24 hours after this import to add the rest.";
// Moves an owner's counted file rows (and their batches) back in time.
async function age(d, userId, interval) {
  await d.query(`update public.lead_import_rows set created_at = created_at - $2::interval where user_id = $1 and source_type = 'file_upload'`, [userId, interval]);
  await d.query(`update public.lead_import_batches set created_at = created_at - $2::interval where user_id = $1 and source_type = 'file_upload'`, [userId, interval]);
}

// ---------------------------------------------------------------- schema

sqlTest("verification query: every check passes", async () => {
  const rows = (await db.query(fs.readFileSync(VERIFY_4E4, "utf8"))).rows;
  assert.deepEqual(rows.filter((r) => r.ok !== true), []);
  assert.ok(rows.length >= 25);
});

sqlTest("migration is re-runnable, and replaying it then T2c converges", async () => {
  // 4E.4 on its own is idempotent...
  await db.exec(fs.readFileSync(path.join(MIGRATIONS, MIGRATION_4E4), "utf8"));
  // ...but it recreates the per-user import functions and uniqueness that
  // T2c superseded, so the chain is only back to its real final state once
  // T2c is replayed on top. Both migrations being idempotent is what makes
  // that safe, and the verification below is the proof.
  await db.exec(fs.readFileSync(path.join(MIGRATIONS, MIGRATION_T2C), "utf8"));
  const rows = (await db.query(fs.readFileSync(VERIFY_4E4, "utf8"))).rows;
  assert.deepEqual(rows.filter((r) => r.ok !== true), []);
});

sqlTest("batch source check constraint", async () => {
  const u = await newOwner(db);
  const conn = randomUUID();
  await db.query(`insert into public.lead_source_connections (id, user_id, spreadsheet_id, status) values ($1, $2, 'sheet-x', 'active')`, [conn, u]);
  const ins = (cols, vals) => db.query(`insert into public.lead_import_batches (user_id, source_event_id, ${cols}) values ($1, $2, ${vals})`, [u, `ev-${randomUUID()}`]);
  await assert.rejects(ins("source_type", "'google_sheet'"), /lead_import_batches_source_shape_check/, "sheet without connection");
  await assert.rejects(ins("source_type, connection_id, file_name", `'file_upload', '${conn}', 'a.csv'`), /source_shape_check/, "file with connection");
  await assert.rejects(ins("source_type", "'file_upload'"), /source_shape_check/, "file without file name");
  await assert.rejects(ins("source_type, connection_id, file_name", `'google_sheet', '${conn}', 'a.csv'`), /source_shape_check/, "sheet with file name");
  await assert.rejects(ins("source_type, file_name", `'email', 'a.csv'`), /source_type_check|source_shape_check/);
  await ins("connection_id", `'${conn}'`); // default source_type google_sheet: valid, as for every existing row
  await ins("source_type, file_name", `'file_upload', 'ok.xlsx'`);
});

sqlTest("grants: only service_role can run the import functions; browser roles cannot reach the core", async () => {
  const u = await newOwner(db);
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(
        db.query(`select public.realtoros_ingest_lead_file($1, $2, 'x.csv', '[{"email":"a@b.co"}]'::jsonb, true)`, [u, randomUUID()]),
        /permission denied/,
      );
      await assert.rejects(
        db.query(`select public.realtoros_file_import_quota($1)`, [u]),
        /permission denied/,
      );
      await assert.rejects(
        db.query(`select automation_internal.ingest_lead_rows($1, null, $2, '[]'::jsonb, 'file_upload', true, 200, 'x')`, [u, randomUUID()]),
        /permission denied/,
      );
      await assert.rejects(
        db.query(`select public.realtoros_ingest_lead_batch($1, 'event-12345', null, '[]'::jsonb)`, [randomUUID()]),
        /permission denied/,
      );
    } finally {
      await db.exec("reset role");
    }
  }
});

// ---------------------------------------------------------------- automation control

sqlTest("start_automation = false: new contacts create NO pending trigger event (cancelled with a reason)", async () => {
  const u = await newOwner(db);
  const out = await fileImport(db, { p_user_id: u, p_start_automation: false, p_rows: JSON.stringify([
    { full_name: "Ann One", email: "ann@example.com" },
    { full_name: "Bob Two", phone: "(555) 010-2000" },
  ]) });
  assert.equal(out.outcome, "imported");
  assert.equal(out.imported_count, 2);
  assert.equal(await count(db, `select count(*) n from public.automation_trigger_events where user_id = $1 and status = 'pending'`, [u]), 0);
  const ev = (await db.query(`select status, last_error from public.automation_trigger_events where user_id = $1`, [u])).rows;
  assert.equal(ev.length, 2);
  assert.ok(ev.every((e) => e.status === "cancelled" && /without automated follow-up/.test(e.last_error)));
});

sqlTest("start_automation = true: new contacts create pending trigger events as normal", async () => {
  const u = await newOwner(db);
  await fileImport(db, { p_user_id: u, p_start_automation: true, p_rows: JSON.stringify([
    { email: "c1@example.com" }, { email: "c2@example.com" }, { email: "c3@example.com" },
  ]) });
  assert.equal(await count(db, `select count(*) n from public.automation_trigger_events where user_id = $1 and status = 'pending' and event_type = 'contact_created'`, [u]), 3);
});

sqlTest("browser cannot suppress or un-suppress automation: no setting exists, events table not writable", async () => {
  const u = await newOwner(db);
  const cid = `c-${randomUUID()}`;
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${u}', false); select set_config('realtoros.suppress_automation', 'on', false);`);
  try {
    await db.query(`insert into public.contacts (id, user_id, email) values ($1, $2, 'self@example.com')`, [cid, u]);
    await assert.rejects(
      db.query(`update public.automation_trigger_events set status = 'cancelled' where contact_id = $1`, [cid]),
      /permission denied/,
    );
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); select set_config('realtoros.suppress_automation', '', false);`);
  }
  const ev = await one(db, `select status from public.automation_trigger_events where contact_id = $1`, [cid]);
  assert.equal(ev.status, "pending", "a browser-created contact always gets its normal automation event");
});

sqlTest("the same session setting set by a service caller does not suppress anything either", async () => {
  const u = await newOwner(db);
  await db.exec(`select set_config('realtoros.suppress_automation', 'on', false)`);
  try {
    await fileImport(db, { p_user_id: u, p_start_automation: true, p_rows: JSON.stringify([{ email: "set@example.com" }]) });
  } finally {
    await db.exec(`select set_config('realtoros.suppress_automation', '', false)`);
  }
  assert.equal(await count(db, `select count(*) n from public.automation_trigger_events where user_id = $1 and status = 'pending'`, [u]), 1);
});

// ---------------------------------------------------------------- idempotency, dedup, validation

sqlTest("retrying the same import id imports nothing twice", async () => {
  const u = await newOwner(db);
  const importId = randomUUID();
  const rows = JSON.stringify([{ email: "r1@example.com" }, { email: "bad" }]);
  const first = await fileImport(db, { p_user_id: u, p_import_id: importId, p_rows: rows });
  const second = await fileImport(db, { p_user_id: u, p_import_id: importId, p_rows: rows });
  const third = await fileImport(db, { p_user_id: u, p_import_id: importId, p_rows: JSON.stringify([{ email: "different@example.com" }]) });
  assert.equal(first.outcome, "imported");
  assert.equal(second.outcome, "replayed");
  assert.equal(third.outcome, "replayed", "same import id -> original result, whatever the body");
  assert.equal(second.imported_count, 1);
  assert.equal(second.rejected_count, 1);
  assert.deepEqual(second.problems, first.problems);
  assert.equal(await count(db, `select count(*) n from public.contacts where user_id = $1`, [u]), 1);
  assert.equal(await count(db, `select count(*) n from public.lead_import_batches where user_id = $1`, [u]), 1);
});

sqlTest("duplicates: within the file (skipped) and of existing contacts (updated vs unchanged)", async () => {
  const u = await newOwner(db);
  await db.query(`insert into public.contacts (id, user_id, full_name, email, phone, notes) values ($1, $2, 'Existing Full', 'full@example.com', '555-111-2222', 'keep')`, [`c-${randomUUID()}`, u]);
  await db.query(`insert into public.contacts (id, user_id, full_name, email) values ($1, $2, '', 'sparse@example.com')`, [`c-${randomUUID()}`, u]);
  // Both contacts were typed in by hand: no identity keys exist yet, so the
  // file import matches them on their stored email.

  const out = await fileImport(db, { p_user_id: u, p_rows: JSON.stringify([
    { full_name: "New Person", email: "new@example.com" },     // 1 new
    { full_name: "New Person", email: "NEW@example.com " },    // 2 same person as row 1
    { full_name: "Other Name", email: "full@example.com" },    // 3 existing, nothing empty to fill -> unchanged
    { full_name: "Now Named", email: "sparse@example.com", phone: "555 333 4444" }, // 4 existing, fills blanks -> updated
    { full_name: "No Contact Info" },                          // 5 rejected
  ]) });
  assert.equal(out.imported_count, 1);
  assert.equal(out.in_file_duplicate_count, 1);
  assert.equal(out.unchanged_count, 1);
  assert.equal(out.updated_count, 1);
  assert.equal(out.rejected_count, 1);
  const byRow = Object.fromEntries(out.problems.map((p) => [p.row_number, p]));
  assert.equal(byRow[2].code, "duplicate_in_file");
  assert.equal(byRow[2].message, "Same person as row 1 — skipped.");
  assert.equal(byRow[5].message, "Needs an email address or a phone number.");
  const sparse = await one(db, `select full_name, phone from public.contacts where user_id = $1 and email = 'sparse@example.com'`, [u]);
  assert.deepEqual(sparse, { full_name: "Now Named", phone: "555 333 4444" });
  const full = await one(db, `select full_name, notes from public.contacts where user_id = $1 and email = 'full@example.com'`, [u]);
  assert.deepEqual(full, { full_name: "Existing Full", notes: "keep" }, "existing values are never overwritten");
  assert.equal(await count(db, `select count(*) n from public.contacts where user_id = $1 and email = 'new@example.com'`, [u]), 1);
});

sqlTest("validation: email or phone required; bad email / phone rejected; server-side reasons passed through", async () => {
  const u = await newOwner(db);
  const out = await fileImport(db, { p_user_id: u, p_rows: JSON.stringify([
    { email: "ok@example.com" },
    { phone: "555-123-4567" },
    { email: "not-an-email" },
    { phone: "12" },
    { full_name: "Nobody" },
    { _invalid: "invalid_email" },
    "not an object",
    { email: "", phone: "" },
  ]) });
  assert.equal(out.imported_count, 2);
  assert.equal(out.rejected_count, 6);
  const codes = out.problems.map((p) => [p.row_number, p.code]);
  assert.deepEqual(codes, [[3, "invalid_email"], [4, "invalid_phone"], [5, "missing_contact_channel"], [6, "invalid_email"], [7, "row_not_object"], [8, "missing_contact_channel"]]);
  assert.ok(out.problems.every((p) => !/_|null/.test(p.message)), "plain-language messages");
  const b = await one(db, `select status, source_type, connection_id, file_name, rejected_count from public.lead_import_batches where id = $1`, [out.batch_id]);
  assert.deepEqual(b, { status: "partial", source_type: "file_upload", connection_id: null, file_name: "leads.csv", rejected_count: 6 });
  assert.equal(await count(db, `select count(*) n from public.lead_import_rows where batch_id = $1 and source_type = 'file_upload' and connection_id is null`, [out.batch_id]), 8);
});

sqlTest("tags, budget and area are stored for new contacts; file name control characters removed", async () => {
  const u = await newOwner(db);
  const out = await fileImport(db, { p_user_id: u, p_file_name: "My\u0007 Leads.xlsx", p_rows: JSON.stringify([
    { full_name: "Tag Person", email: "tag@example.com", tags: ["buyer", " hot ", "buyer", ""], budget: "$450,000", preferred_area: "Downtown", notes: "Met at open house", source: "Open House" },
  ]) });
  const c = await one(db, `select tags, budget::text as budget, preferred_area, notes, source from public.contacts where user_id = $1`, [u]);
  assert.deepEqual(c, { tags: ["buyer", "hot"], budget: "450000", preferred_area: "Downtown", notes: "Met at open house", source: "Open House" });
  const b = await one(db, `select file_name from public.lead_import_batches where id = $1`, [out.batch_id]);
  assert.equal(b.file_name, "My Leads.xlsx");
});

sqlTest("row limit: 1..500 rows per file, in one call", async () => {
  const u = await newOwner(db);
  await assert.rejects(fileImport(db, { p_user_id: u, p_rows: JSON.stringify(emails(501, "lim")) }), /row_count_must_be_between_1_and_500/);
  await assert.rejects(fileImport(db, { p_user_id: u, p_rows: "[]" }), /row_count_must_be_between_1_and_500/);
  const out = await fileImport(db, { p_user_id: u, p_rows: JSON.stringify(emails(500, "lim")) });
  assert.equal(out.source_row_count, 500);
  assert.equal(out.imported_count + out.daily_limit_skipped_count, 500);
  assert.equal(await count(db, `select count(*) n from public.lead_import_batches where user_id = $1`, [u]), 1, "refused calls create nothing");
});

// ---------------------------------------------------------------- daily allowance of new contacts

sqlTest("quota read: a new owner has 200 left and no reset time", async () => {
  const u = await newOwner(db);
  assert.deepEqual(await quota(db, u), { limit: 200, used: 0, remaining: 200, resets_at: null });
  await assert.rejects(quota(db, null), /user_required/);
});

sqlTest("quota: 200 new contacts are added; later new rows get daily_limit_reached; matches, updates and in-file duplicates still process and don't count", async () => {
  const u = await newOwner(db);
  await db.query(`insert into public.contacts (id, user_id, full_name, email) values ($1, $2, '', 'sparse@example.com')`, [`c-${randomUUID()}`, u]);
  await db.query(`insert into public.contacts (id, user_id, full_name, email, phone) values ($1, $2, 'Full', 'full@example.com', '555-100-1000')`, [`c-${randomUUID()}`, u]);
  const rows = [
    ...emails(200, "q"),                                    // rows 1-200: new -> imported
    { email: "new201@example.com" },                        // 201: new -> daily limit
    { full_name: "Now Named", email: "sparse@example.com" }, // 202: existing, fills blank -> updated
    { email: "Q5@example.com" },                            // 203: same person as row 5 -> in-file duplicate
    { email: "full@example.com" },                          // 204: existing, nothing to fill -> unchanged
    { email: "broken" },                                    // 205: invalid
    { phone: "555-200-2000" },                              // 206: new -> daily limit
  ];
  const importId = randomUUID();
  const started = Date.now();
  const out = await fileImport(db, { p_user_id: u, p_import_id: importId, p_rows: JSON.stringify(rows) });
  assert.deepEqual(
    [out.imported_count, out.updated_count, out.unchanged_count, out.in_file_duplicate_count, out.daily_limit_skipped_count, out.rejected_count],
    [200, 1, 1, 1, 2, 3],
  );
  const byRow = Object.fromEntries(out.problems.map((p) => [p.row_number, p]));
  assert.deepEqual(Object.keys(byRow).map(Number), [201, 203, 205, 206]);
  assert.equal(byRow[201].code, "daily_limit_reached");
  assert.equal(byRow[201].message, LIMIT_MESSAGE);
  assert.equal(byRow[206].code, "daily_limit_reached");
  assert.equal(byRow[203].code, "duplicate_in_file");
  assert.equal(byRow[205].code, "invalid_email");

  assert.equal(out.quota.limit, 200);
  assert.equal(out.quota.used, 200);
  assert.equal(out.quota.remaining, 0);
  const resets = Date.parse(out.quota.resets_at);
  assert.ok(resets >= started + 23.9 * 3600e3 && resets <= Date.now() + 24 * 3600e3 + 1000, "resets 24 h after the oldest counted row");

  assert.equal(await count(db, `select count(*) n from public.contacts where user_id = $1`, [u]), 202, "no contact for the limited rows");
  assert.equal(await count(db, `select count(*) n from public.contacts where user_id = $1 and email = 'new201@example.com'`, [u]), 0);
  const stored = await one(db, `select status, error_code, error_message from public.lead_import_rows where user_id = $1 and source_row_number = 201`, [u]);
  assert.equal(stored.status, "rejected");
  assert.equal(stored.error_code, "daily_limit_reached");
  assert.equal(stored.error_message, LIMIT_MESSAGE, "Import History shows the plain reason");
  const batch = await one(db, `select status, rejected_count, metadata->>'daily_limit_skipped_count' as limited from public.lead_import_batches where user_id = $1`, [u]);
  assert.deepEqual(batch, { status: "partial", rejected_count: 3, limited: "2" });

  // A replay of the same import id returns the same result and uses nothing.
  const replay = await fileImport(db, { p_user_id: u, p_import_id: importId, p_rows: JSON.stringify(rows) });
  assert.equal(replay.outcome, "replayed");
  assert.equal(replay.daily_limit_skipped_count, 2);
  assert.deepEqual(replay.problems, out.problems);
  assert.equal(replay.quota.used, 200);

  // At 0 remaining, a file of only matches still updates; nothing new is created.
  const later = await fileImport(db, { p_user_id: u, p_rows: JSON.stringify([
    { email: "full@example.com", notes: "fill me" }, { email: "brand-new@example.com" },
  ]) });
  assert.deepEqual([later.updated_count, later.imported_count, later.daily_limit_skipped_count], [1, 0, 1]);
  assert.equal((await quota(db, u)).used, 200);
});

sqlTest("quota: two uploads in a row share it; rows older than 24 h stop counting; re-uploading the same file adds the rest", async () => {
  const u = await newOwner(db);
  const first = await fileImport(db, { p_user_id: u, p_rows: JSON.stringify(emails(150, "a")) });
  assert.deepEqual([first.imported_count, first.quota.remaining], [150, 50]);
  const fileB = JSON.stringify(emails(80, "b"));
  const second = await fileImport(db, { p_user_id: u, p_rows: fileB });
  assert.deepEqual([second.imported_count, second.daily_limit_skipped_count, second.quota.remaining], [50, 30, 0]);
  assert.deepEqual(second.problems.map((p) => p.row_number), Array.from({ length: 30 }, (_, i) => 51 + i), "file order: the first 50 new rows are added");

  // 25 hours later everything above has left the window.
  await age(db, u, "25 hours");
  assert.deepEqual(await quota(db, u), { limit: 200, used: 0, remaining: 200, resets_at: null });
  const again = await fileImport(db, { p_user_id: u, p_rows: fileB });
  assert.deepEqual([again.imported_count, again.unchanged_count, again.daily_limit_skipped_count], [30, 50, 0]);
  assert.equal(again.quota.used, 30);
  assert.equal(await count(db, `select count(*) n from public.contacts where user_id = $1`, [u]), 230);

  // Partly aged: only rows inside the window count, and resets_at follows the oldest of them.
  await db.query(`update public.lead_import_rows set created_at = now() - interval '23 hours'
                  where user_id = $1 and status = 'imported' and created_at > now() - interval '1 hour'
                    and source_row_number <= 60`, [u]); // rows 51-60 of the re-upload
  const q = await quota(db, u);
  assert.equal(q.used, 30);
  const hoursLeft = (Date.parse(q.resets_at) - Date.now()) / 3600e3;
  assert.ok(hoursLeft > 0.9 && hoursLeft < 1.1, `resets in about an hour, got ${hoursLeft}`);
});

sqlTest("quota: Google Sheet imports are not limited and not counted", async () => {
  const u = await newOwner(db);
  await fileImport(db, { p_user_id: u, p_rows: JSON.stringify(emails(200, "full")) });
  assert.equal((await quota(db, u)).remaining, 0);
  const conn = randomUUID();
  await db.query(`insert into public.lead_source_connections (id, user_id, spreadsheet_id, status) values ($1, $2, 'sheet-quota', 'active')`, [conn, u]);
  const sheet = await asService(db, () => rpc(db, "realtoros_ingest_lead_batch", {
    p_connection_id: conn, p_source_event_id: "event-quota-1", p_sheet_revision: null,
    p_rows: JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ lead_id: `S${i}`, full_name: `Sheet ${i}`, email: `sheet${i}@example.com` }))),
  }));
  assert.equal(sheet.imported_count, 5, "all Sheet leads imported with the file allowance used up");
  assert.equal(sheet.daily_limit_skipped_count, undefined, "Sheet result shape unchanged");
  assert.equal((await quota(db, u)).used, 200, "Sheet contacts are not counted");
});

sqlTest("upload count: at most 20 file uploads per 24 hours (and 10 per 15 minutes)", async () => {
  const u = await newOwner(db);
  for (let i = 0; i < 20; i++) {
    if (i === 10) await age(db, u, "1 hour"); // clear the 15-minute window
    const out = await fileImport(db, { p_user_id: u, p_rows: JSON.stringify([{ email: `up${i}@example.com` }]) });
    assert.equal(out.outcome, "imported", `upload ${i + 1}`);
  }
  await age(db, u, "1 hour");
  const limited = await fileImport(db, { p_user_id: u, p_rows: JSON.stringify([{ email: "up21@example.com" }]) });
  assert.equal(limited.outcome, "rate_limited");
  assert.ok(limited.retry_after_seconds > 20 * 3600 && limited.retry_after_seconds <= 24 * 3600);
});

// ---------------------------------------------------------------- index use

sqlTest("fallback lookups and the allowance count use their indexes (EXPLAIN, generic plan, 3,000 contacts)", async () => {
  const u = await newOwner(db);
  const other = await newOwner(db);
  for (const owner of [u, other]) {
    await db.query(`insert into public.contacts (id, user_id, full_name, email, phone)
                    select 'ix-' || $1::text || '-' || g, $1::uuid, 'Person ' || g,
                           case when g % 3 = 0 then '' else 'Person' || g || '@Example.com ' end,
                           case when g % 2 = 0 then '' else '+1 (555) ' || lpad(g::text, 7, '0') end
                    from generate_series(1, 3000) g`, [owner]);
  }
  await db.exec("analyze public.contacts");
  // T2c's lookups key on the workspace, so the plans are checked with the
  // workspace ids rather than the user ids.
  const wsOf = async (uid) => (await one(db,
    `select workspace_id from public.workspace_members
      where user_id = $1 and status = 'active'`, [uid])).workspace_id;
  const uWs = await wsOf(u);
  const otherWs = await wsOf(other);

  // The lookups inside ingest_lead_rows, verbatim (only the variables
  // differ). T2c scoped them to the workspace, so the indexes they must use
  // are the workspace-scoped pair it added alongside.
  const fnSrc = (await one(db, `select pg_get_functiondef('automation_internal.ingest_lead_rows(uuid,uuid,uuid,uuid,jsonb,text,boolean,integer,text)'::regprocedure) src`)).src;
  const EMAIL_WHERE = "where workspace_id = p_workspace_id and email <> '' and lower(btrim(email)) = v_email";
  const PHONE_WHERE = "where workspace_id = p_workspace_id and phone <> ''\n          and regexp_replace(phone, '[^0-9]+', '', 'g') = v_phone_normalized";
  assert.ok(fnSrc.includes(EMAIL_WHERE), "email lookup text");
  assert.ok(fnSrc.includes(PHONE_WHERE), "phone lookup text");

  // PL/pgSQL runs these as prepared statements; force the generic plan it
  // may cache, so the check holds whatever the parameter values are.
  await db.exec(`
    set plan_cache_mode = force_generic_plan;
    prepare ix_email(uuid, text) as
      select id from public.contacts
      where workspace_id = $1 and email <> '' and lower(btrim(email)) = $2
      order by created_at, id limit 1;
    prepare ix_phone(uuid, text) as
      select id from public.contacts
      where workspace_id = $1 and phone <> ''
        and regexp_replace(phone, '[^0-9]+', '', 'g') = $2
      order by created_at, id limit 1;`);
  try {
    const plan = async (sql, params) => (await db.query(sql, params)).rows.map((r) => r["QUERY PLAN"]).join("\n");
    const emailPlan = await plan(`explain execute ix_email('${uWs}', 'person10@example.com')`);
    const phonePlan = await plan(`explain execute ix_phone('${uWs}', '15550000011')`);
    assert.match(emailPlan, /contacts_ws_email_norm_idx/, emailPlan);
    assert.match(phonePlan, /contacts_ws_phone_norm_idx/, phonePlan);
    assert.doesNotMatch(emailPlan + phonePlan, /Seq Scan/);
    const found = await one(db, `execute ix_email('${uWs}', 'person10@example.com')`);
    assert.equal(found.id, `ix-${u}-10`);
    const byPhone = await one(db, `execute ix_phone('${uWs}', '15550000011')`);
    assert.equal(byPhone.id, `ix-${u}-11`);
  } finally {
    await db.exec("deallocate ix_email; deallocate ix_phone; reset plan_cache_mode;");
  }

  // The daily-allowance count uses its partial index. Realistic history for
  // the owner: an older import plus rejected rows (not in the index).
  // Sequential scans are off because the test table is tiny; the choice
  // between the plain user_id index and the partial one is still on cost.
  await fileImport(db, { p_user_id: other, p_rows: JSON.stringify(emails(200, "ixq")) });
  await fileImport(db, { p_user_id: other, p_rows: JSON.stringify(Array.from({ length: 500 }, () => ({ email: "bad" }))) });
  await fileImport(db, { p_user_id: other, p_rows: JSON.stringify(Array.from({ length: 500 }, () => ({ phone: "1" }))) });
  await age(db, other, "30 days");
  await db.exec("analyze public.lead_import_rows");
  const quotaSrc = (await one(db, `select pg_get_functiondef('public.realtoros_file_import_quota(uuid)'::regprocedure) src`)).src;
  assert.ok(quotaSrc.includes("where workspace_id = v_workspace"), "quota counts per workspace");
  assert.ok(quotaSrc.includes("and source_type = 'file_upload'\n     and status = 'imported'"), "quota count text");
  await db.exec(`
    set plan_cache_mode = force_generic_plan;
    set enable_seqscan = off;
    prepare ix_quota(uuid) as
      select count(*)::integer, min(created_at) from public.lead_import_rows
      where workspace_id = $1 and source_type = 'file_upload' and status = 'imported'
        and created_at > now() - interval '24 hours';`);
  try {
    const quotaPlan = (await db.query(`explain execute ix_quota('${otherWs}')`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
    assert.match(quotaPlan, /lead_import_rows_ws_file_new_idx/, quotaPlan);
  } finally {
    await db.exec("deallocate ix_quota; reset plan_cache_mode; reset enable_seqscan;");
  }

  // And a real file import against these contacts matches on both.
  const out = await fileImport(db, { p_user_id: u, p_rows: JSON.stringify([
    { email: "PERSON10@example.com" }, { phone: "+1 555 000 0011", full_name: "x" },
  ]) });
  assert.equal(out.imported_count, 0);
  assert.equal(out.updated_count + out.unchanged_count, 2);
});

sqlTest("per-owner rate limit: 10 file imports per 15 minutes; a retry of an earlier import still replays", async () => {
  const u = await newOwner(db);
  const firstId = randomUUID();
  for (let i = 0; i < 10; i++) {
    const out = await fileImport(db, { p_user_id: u, p_import_id: i === 0 ? firstId : randomUUID(), p_rows: JSON.stringify([{ email: `rl${i}@example.com` }]) });
    assert.equal(out.outcome, "imported");
  }
  const limited = await fileImport(db, { p_user_id: u, p_rows: JSON.stringify([{ email: "rl-extra@example.com" }]) });
  assert.equal(limited.outcome, "rate_limited");
  assert.ok(limited.retry_after_seconds > 0 && limited.retry_after_seconds <= 900);
  const replay = await fileImport(db, { p_user_id: u, p_import_id: firstId, p_rows: "[{}]" });
  assert.equal(replay.outcome, "replayed");
  const other = await newOwner(db);
  assert.equal((await fileImport(db, { p_user_id: other, p_rows: JSON.stringify([{ email: "x@example.com" }]) })).outcome, "imported", "limit is per owner");
});

sqlTest("hand-entered contact matched by phone digits; email and phone pointing at two people is rejected", async () => {
  const u = await newOwner(db);
  await db.query(`insert into public.contacts (id, user_id, full_name, phone) values ($1, $2, 'Phone Only', '+1 (555) 222-3333')`, [`c-${randomUUID()}`, u]);
  await db.query(`insert into public.contacts (id, user_id, full_name, email) values ($1, $2, 'Email Only', 'solo@example.com')`, [`c-${randomUUID()}`, u]);
  const out = await fileImport(db, { p_user_id: u, p_rows: JSON.stringify([
    { email: "phoneonly@example.com", phone: "15552223333" },
    { email: "solo@example.com", phone: "1-555-222-3333" },
  ]) });
  assert.equal(out.imported_count, 0);
  assert.equal(out.updated_count, 1, "row 1 fills the phone-only contact's email");
  assert.equal(out.rejected_count, 1);
  assert.equal(out.problems[0].code, "identity_conflict");
  assert.equal(await count(db, `select count(*) n from public.contacts where user_id = $1`, [u]), 2);
});

sqlTest("file and Sheet imports share dedup: a Sheet-imported contact is matched by a file row", async () => {
  const u = await newOwner(db);
  const conn = randomUUID();
  await db.query(`insert into public.lead_source_connections (id, user_id, spreadsheet_id, status) values ($1, $2, 'sheet-shared', 'active')`, [conn, u]);
  await asService(db, () => rpc(db, "realtoros_ingest_lead_batch", {
    p_connection_id: conn, p_source_event_id: "event-shared-1", p_sheet_revision: null,
    p_rows: JSON.stringify([{ lead_id: "L1", full_name: "Sheet Person", email: "shared@example.com" }]),
  }));
  const out = await fileImport(db, { p_user_id: u, p_rows: JSON.stringify([{ email: "SHARED@example.com", phone: "555-777-8888" }]) });
  assert.equal(out.imported_count, 0);
  assert.equal(out.updated_count, 1);
  assert.equal(await count(db, `select count(*) n from public.contacts where user_id = $1`, [u]), 1);
});

// ---------------------------------------------------------------- Sheet regression

// Runs one scripted Sheet scenario against a database and returns a
// normalized snapshot: every row and return value, with generated ids and
// timestamps replaced by stable labels.
async function sheetScenario(d) {
  const u = "22222222-2222-4222-8222-222222222222";
  const conn = "33333333-3333-4333-8333-333333333333";
  await d.query(`insert into auth.users (id) values ($1)`, [u]);
  await d.query(`insert into public.lead_source_connections (id, user_id, spreadsheet_id, status) values ($1, $2, 'sheet-reg', 'active')`, [conn, u]);
  // A manual contact that a Sheet row will match by email (fill-blanks path).
  await d.query(`insert into public.contacts (id, user_id, full_name, email, source) values ('manual-1', $1, '', 'manual@example.com', 'Other')`, [u]);
  await d.query(`insert into public.contact_identity_keys (user_id, contact_id, identity_type, identity_hash, source)
                 values ($1, 'manual-1', 'email', encode(extensions.digest(convert_to('manual@example.com','UTF8'),'sha256'),'hex'), 'manual')`, [u]);
  await d.query(`insert into public.contacts (id, user_id, full_name, phone) values ('manual-2', $1, 'Phone Owner', '555-999-0000')`, [u]);
  await d.query(`insert into public.contact_identity_keys (user_id, contact_id, identity_type, identity_hash, source)
                 values ($1, 'manual-2', 'phone', encode(extensions.digest(convert_to('5559990000','UTF8'),'sha256'),'hex'), 'manual')`, [u]);

  const call = (event, rows) => asService(d, () => rpc(d, "realtoros_ingest_lead_batch", {
    p_connection_id: conn, p_source_event_id: event, p_sheet_revision: "rev-1", p_rows: JSON.stringify(rows),
  }));
  const results = [];
  results.push(await call("event-0001", [
    { lead_id: "L1", full_name: "Ann Lead", email: "Ann@Example.com", phone: "(555) 100-2000", budget: "$300,000", type: "Seller", status: "Qualified", source: "Zillow", temperature: "Hot", preferred_area: "North", notes: "n1" },
    { lead_id: "L2", full_name: "Manual Match", email: "manual@example.com", preferred_area: "South" },
    { lead_id: "", full_name: "No Id", email: "x@example.com" },
    { lead_id: "L4", full_name: "", email: "y@example.com" },
    { lead_id: "L5", full_name: "No Channel" },
    { lead_id: "L6", full_name: "Conflict", email: "manual@example.com", phone: "555-999-0000" },
    "not-an-object",
    { lead_id: "L8", full_name: "Budget Bad", email: "b@example.com", budget: "lots" },
  ]));
  // Re-sync: L1 changed (source-link overwrite), L5 fixed, new L9.
  results.push(await call("event-0002", [
    { lead_id: "L1", full_name: "Ann Renamed", email: "ann@example.com", phone: "5551002000", status: "Client", notes: "n2" },
    { lead_id: "L5", full_name: "No Channel", phone: "555-500-5000" },
    { lead_id: "L9", full_name: "Nine", email: "nine@example.com" },
  ]));
  results.push(await call("event-0002", [{ lead_id: "ignored", full_name: "Replay", email: "r@example.com" }])); // replay
  await assert.rejects(call("short", [{ lead_id: "a", full_name: "a", email: "a@a.co" }]), /invalid_source_event_id/);
  await assert.rejects(call("event-0003", []), /row_count_must_be_between_1_and_500/);
  await assert.rejects(call("event-0004", Array.from({ length: 501 }, () => ({}))), /row_count_must_be_between_1_and_500/);

  const contacts = (await d.query(`select * from public.contacts where user_id = $1`, [u])).rows;
  const idLabel = new Map();
  [...contacts].sort((a, b) => (a.email + a.phone + a.full_name).localeCompare(b.email + b.phone + b.full_name))
    .forEach((c, i) => idLabel.set(c.id, c.id.startsWith("manual") ? c.id : `contact#${i}`));
  const batches = (await d.query(`select * from public.lead_import_batches where user_id = $1 order by source_event_id`, [u])).rows;
  const batchLabel = new Map(batches.map((b) => [b.id, `batch:${b.source_event_id}`]));
  const strip = (row, drop) => Object.fromEntries(Object.entries(row).filter(([k]) => !drop.includes(k)).map(([k, v]) => [k, v instanceof Date ? "<ts>" : v]));
  const mapIds = (row) => ({ ...row,
    ...(row.contact_id !== undefined ? { contact_id: row.contact_id === null ? null : idLabel.get(row.contact_id) } : {}),
    ...(row.batch_id !== undefined ? { batch_id: batchLabel.get(row.batch_id) } : {}),
  });
  const TS = ["created_at", "updated_at", "started_at", "completed_at", "first_seen_at", "last_seen_at", "processed_at", "available_at", "last_synced_at"];
 
  // Columns added by migrations LATER than 4E.4 — stripped from the
  // "after" rows so the pre-4E.4 comparison still lines up. 4E.4 itself
  // added source_type / file_name; T2a (workspace foundation) added
  // workspace_id to every business table and assigned_to_id to contacts.
  const NEW_COLUMNS = ["source_type", "file_name", "workspace_id", "assigned_to_id"];

  // Additional contact fields introduced after the regression baseline.
  const NEW_CONTACT_COLUMNS = [
    "birthday",
    "first_touched_at",
    "home_purchase_date",
    "status_changed_at"
  ];

  return {
    results: results.map((r) => ({
      ...r,
      batch_id: batchLabel.get(r.batch_id)
    })),

    contacts: contacts
      .map((c) =>
        strip(
          { ...c, id: idLabel.get(c.id) },
          [...TS, ...NEW_COLUMNS, ...NEW_CONTACT_COLUMNS]
        )
      )
      .sort((a, b) => a.id.localeCompare(b.id)),

    identity: (await d.query(`select * from public.contact_identity_keys where user_id = $1`, [u])).rows
      .map((r) => strip(mapIds(r), ["id", ...TS, ...NEW_COLUMNS]))
      .sort((a, b) => (a.identity_type + a.identity_hash).localeCompare(b.identity_type + b.identity_hash)),

    rows: (await d.query(`select * from public.lead_import_rows where user_id = $1`, [u])).rows
      .map((r) => strip(mapIds(r), ["id", ...TS, ...NEW_COLUMNS]))
      .sort((a, b) => a.source_row_key.localeCompare(b.source_row_key)),

    batches: batches.map((b) =>
      strip({ ...b, id: batchLabel.get(b.id) }, [...TS, ...NEW_COLUMNS])
    ),

    connection: strip(
      await one(d, `select * from public.lead_source_connections where id = $1`, [conn]),
      [...TS, ...NEW_COLUMNS]
    ),

    events: (await d.query(`select event_type, status, contact_id, new_status, old_status from public.automation_trigger_events where user_id = $1`, [u])).rows
      .map((e) => ({ ...e, contact_id: idLabel.get(e.contact_id) }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

sqlTest("regression: the Google Sheet import behaves exactly as before 4E.4 (same writes, same results)", async () => {
  const before = await sheetScenario(before4e4);
  const after = await sheetScenario(db);
  assert.deepEqual(after.results, before.results);
  assert.deepEqual(after.contacts, before.contacts);
  assert.deepEqual(after.identity, before.identity);
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(after.batches, before.batches);
  assert.deepEqual(after.connection, before.connection);
  assert.deepEqual(after.events, before.events);
  // Sanity: the scenario really exercised every path.
  assert.deepEqual(before.results.map((r) => [r.imported_count, r.duplicate_count, r.rejected_count, r.replayed]),
    [[2, 1, 5, false], [2, 1, 0, false], [2, 1, 0, true]]);
  const rowStatus = Object.fromEntries(after.rows.map((r) => [r.source_row_key, r.status]));
  assert.equal(rowStatus.L1, "duplicate");
  assert.equal(rowStatus.L6, "rejected");
  const sheetRows = (await db.query(`select distinct source_type from public.lead_import_rows where connection_id = '33333333-3333-4333-8333-333333333333'`)).rows;
  assert.deepEqual(sheetRows, [{ source_type: "google_sheet" }]);
});
