// import-lead-file: owner from the JWT only, server-side re-validation,
// limits, error mapping, and (through PGlite) real idempotency.
import { test, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { FakeDb } from "../helpers/fake-db.mjs";
import { WORKER_ENV } from "../helpers/automation-fixture.mjs";
import { migratedDb, rpc } from "../helpers/pg.mjs";

const OWNER = "44444444-4444-4444-8444-444444444444";
const TOKEN = "owner-jwt";
let handler;
let pg;

before(async () => { pg = await migratedDb(); });
after(async () => {
  if (!pg) return;
  await pg.close();
  assert.equal(pg.closed, true, "the shared PGlite database must close");
});
beforeEach(async () => {
  globalThis.__edge.setEnv({ ...WORKER_ENV, SUPABASE_ANON_KEY: "anon" });
  handler = await globalThis.__edge.load("import-lead-file");
});

function fakeDb(rpcImpl) {
  const db = new FakeDb();
  db.users.set(TOKEN, OWNER);
  db.rpc("realtoros_ingest_lead_file", rpcImpl ?? ((a) => ({
    outcome: "imported", batch_id: randomUUID(), source_row_count: a.p_rows.length,
    imported_count: a.p_rows.length, updated_count: 0, unchanged_count: 0, in_file_duplicate_count: 0,
    rejected_count: 0, problems: [],
  })));
  db.install();
  return db;
}

// Forwards the RPCs to the real SQL functions in PGlite, as service_role.
async function asServiceRole(fn) {
  await pg.exec("set role service_role");
  try { return await fn(); } finally { await pg.exec("reset role"); }
}
function pgBackedDb() {
  const db = fakeDb((a) => asServiceRole(() => rpc(pg, "realtoros_ingest_lead_file", { ...a, p_rows: JSON.stringify(a.p_rows) })));
  db.rpc("realtoros_file_import_quota", (a) => asServiceRole(() => rpc(pg, "realtoros_file_import_quota", a)));
  return db;
}

async function call(body, { token = TOKEN, raw } = {}) {
  const res = await handler(new Request("https://unit-test.supabase.co/functions/v1/import-lead-file", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw ?? JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json(), headers: res.headers };
}
const valid = (extra = {}) => ({ import_id: randomUUID(), file_name: "leads.csv", rows: [{ email: "a@example.com" }], ...extra });

test("owner comes from the JWT; a user id in the body is refused", async () => {
  const db = fakeDb();
  const r = await call(valid());
  assert.equal(r.status, 200);
  assert.equal(db.rpcCalls("realtoros_ingest_lead_file")[0].args.p_user_id, OWNER);
  assert.equal((await call({ ...valid(), user_id: randomUUID() })).status, 422);
  assert.equal((await call(valid(), { token: null })).status, 401);
  assert.equal((await call(valid(), { token: "forged" })).status, 401);
});

test("start_automation defaults to false and must be a boolean", async () => {
  const db = fakeDb();
  await call(valid());
  assert.equal(db.rpcCalls("realtoros_ingest_lead_file")[0].args.p_start_automation, false);
  await call(valid({ start_automation: true }));
  assert.equal(db.rpcCalls("realtoros_ingest_lead_file")[1].args.p_start_automation, true);
  assert.equal((await call(valid({ start_automation: "yes" }))).status, 422);
});

test("server-side re-validation and sanitizing of every field", async () => {
  const db = fakeDb();
  await call(valid({ rows: [
    { full_name: "  Ann\u0000\u0007  Lee ", email: " ANN@Example.COM ", phone: "(555) 100-2000", notes: "line1\nline2\u0001", tags: "buyer, hot ,buyer", budget: 450000, extra: "dropped" },
    { email: "not-an-email" },
    { phone: "12" },
    { full_name: "Nobody" },
    "a string",
    { email: "x".repeat(250) + "@example.com" },
  ] }));
  const rows = db.rpcCalls("realtoros_ingest_lead_file")[0].args.p_rows;
  assert.deepEqual(rows[0], {
    full_name: "Ann Lee", email: "ann@example.com", phone: "(555) 100-2000", source: "",
    notes: "line1\nline2", budget: "450000", preferred_area: "", tags: ["buyer", "hot"],
  });
  assert.deepEqual(rows.slice(1).map((r) => r._invalid), ["invalid_email", "invalid_phone", "missing_contact_channel", "row_not_object", "invalid_email"]);
});

test("limits: 500 rows per file in one request, request byte cap, bad ids / names", async () => {
  const db = fakeDb();
  const many = Array.from({ length: 501 }, (_, i) => ({ email: `m${i}@example.com` }));
  const r = await call(valid({ rows: many }));
  assert.equal(r.status, 422);
  assert.deepEqual(r.body, { error: "too_many_rows", max_rows: 500 });
  assert.equal(db.rpcCalls("realtoros_ingest_lead_file").length, 0);
  assert.equal((await call(valid({ rows: Array.from({ length: 500 }, (_, i) => ({ email: `m${i}@example.com` })) }))).status, 200);
  assert.equal((await call(valid({ chunk_index: 0 }))).status, 422, "no chunk fields any more");
  assert.equal((await call(valid({ rows: [] }))).body.error, "no_rows");
  const huge = JSON.stringify(valid({ rows: [{ notes: "x".repeat(3_100_000) }] }));
  assert.equal((await call(null, { raw: huge })).status, 413);
  assert.equal((await call(valid({ import_id: "not-a-uuid" }))).status, 422);
  assert.equal((await call(valid({ file_name: "\u0000\u0001" }))).status, 422);
  assert.equal((await call(null, { raw: "{not json" })).status, 400);
});

test("quota action: owner from the JWT only; returns only the four quota fields", async () => {
  const db = fakeDb();
  db.rpc("realtoros_file_import_quota", () => ({ limit: 200, used: 40, remaining: 160, resets_at: "2026-09-30T10:00:00+00:00", extra: "x" }));
  const r = await call({ action: "quota" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, quota: { limit: 200, used: 40, remaining: 160, resets_at: "2026-09-30T10:00:00+00:00" } });
  assert.equal(db.rpcCalls("realtoros_file_import_quota")[0].args.p_user_id, OWNER);
  assert.equal((await call({ action: "quota", user_id: randomUUID() })).status, 422);
  assert.equal((await call({ action: "other" })).status, 422);
  assert.equal((await call({ action: "quota" }, { token: null })).status, 401);
  assert.equal(db.rpcCalls("realtoros_ingest_lead_file").length, 0);
  db.failWhen((e) => e.kind === "rpc", { code: "XX000", message: "boom" });
  assert.deepEqual((await call({ action: "quota" })).body, { error: "try_again" });
});

test("any database error is a retryable 'try_again'", async () => {
  const db = fakeDb();
  db.failWhen((e) => e.kind === "rpc", { code: "55P03", message: "lock timeout" });
  const r = await call(valid());
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { error: "try_again" });
});

test("rate limited -> 429 with Retry-After", async () => {
  fakeDb(() => ({ outcome: "rate_limited", retry_after_seconds: 321 }));
  const r = await call(valid());
  assert.equal(r.status, 429);
  assert.deepEqual(r.body, { error: "rate_limited", retry_after_seconds: 321 });
  assert.equal(r.headers.get("retry-after"), "321");
});

test("end to end (real SQL): counts, plain-language reasons, and a retry of the same import id imports nothing twice", async (t) => {
  if (!pg) return t.skip("PGlite not installed");
  await pg.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [OWNER]);
  pgBackedDb();
  const body = valid({ file_name: "Open house.xlsx", rows: [
    { full_name: "Pat One", email: "pat@example.com" },
    { full_name: "Pat One", email: "PAT@example.com" },
    { full_name: "No Contact" },
    { email: "bad@" },
  ] });
  const first = await call(body);
  assert.equal(first.status, 200);
  assert.equal(first.body.replayed, false);
  assert.deepEqual({ i: first.body.imported, u: first.body.updated, s: first.body.skipped, r: first.body.rejected }, { i: 1, u: 0, s: 1, r: 2 });
  assert.deepEqual(first.body.rejected_rows, [
    { row_number: 3, reason: "Needs an email address or a phone number." },
    { row_number: 4, reason: "The email address doesn't look right." },
  ]);
  assert.deepEqual(first.body.skipped_rows, [{ row_number: 2, reason: "Same person as row 1 — skipped." }]);
  assert.doesNotMatch(JSON.stringify(first.body), /pat@example\.com/i, "no row contents echoed");

  const retry = await call(body);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.imported, 1);
  const n = (await pg.query(`select count(*)::int n from public.contacts where user_id = $1 and email = 'pat@example.com'`, [OWNER])).rows[0].n;
  assert.equal(n, 1);
  const batches = (await pg.query(`select count(*)::int n from public.lead_import_batches where user_id = $1 and file_name = 'Open house.xlsx'`, [OWNER])).rows[0].n;
  assert.equal(batches, 1);

  // Same file again with a NEW import id (the user uploads it twice):
  // nothing new is created; the person is recognised.
  const again = await call({ ...body, import_id: randomUUID() });
  assert.equal(again.body.imported, 0);
  assert.equal(again.body.skipped, 2);
});

test("end to end (real SQL): the daily limit of 200 new contacts, reported apart from other rejections, with the quota", async (t) => {
  if (!pg) return t.skip("PGlite not installed");
  const owner = randomUUID();
  await pg.query(`insert into auth.users (id) values ($1)`, [owner]);
  const db = pgBackedDb();
  db.users.set("quota-owner", owner);
  const before = await call({ action: "quota" }, { token: "quota-owner" });
  assert.deepEqual(before.body, { ok: true, quota: { limit: 200, used: 0, remaining: 200, resets_at: null } });

  const rows = Array.from({ length: 203 }, (_, i) => ({ email: `e2e${i + 1}@example.com` }));
  rows.push({ email: "bad@" }); // row 204
  const r = await call({ import_id: randomUUID(), file_name: "big.csv", rows }, { token: "quota-owner" });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.imported, r.body.daily_limit_skipped, r.body.rejected], [200, 3, 1]);
  assert.deepEqual(r.body.limited_rows, [201, 202, 203]);
  assert.deepEqual(r.body.rejected_rows, [{ row_number: 204, reason: "The email address doesn't look right." }]);
  assert.equal(r.body.quota.remaining, 0);
  assert.equal(r.body.quota.used, 200);
  assert.match(r.body.quota.resets_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(JSON.stringify(r.body), /e2e\d+@example\.com/, "no row contents echoed");

  const after = await call({ action: "quota" }, { token: "quota-owner" });
  assert.deepEqual(after.body.quota, r.body.quota);
});
