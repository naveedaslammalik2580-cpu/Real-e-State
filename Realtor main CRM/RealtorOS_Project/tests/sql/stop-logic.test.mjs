// Exercises the Phase 4E / 4E.2 SQL functions against the real migration
// chain (all files in supabase/migrations, in order) in PGlite. Calls run
// as service_role — the only role granted EXECUTE — so missing table
// grants would surface here as permission errors.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { migratedDb, seedWorld, one, rpc, SKIP_MESSAGE, MIGRATIONS_DIR } from "../helpers/pg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERIFY_SQL = path.join(here, "..", "..", "supabase", "tests", "phase_4e_2_verification.sql");
const MIGRATION_4E2 = "20260929041708_phase_4e_2_stop_logic_completion.sql";
const MIGRATION_T2C_POST = "20261007033030_phase_t2c_post_workspace_rpcs.sql";

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

const record = (args) => asService(() => rpc(db, "realtoros_record_contact_stop_event", args));
const stopOne = (args) => asService(() => rpc(db, "realtoros_stop_enrollment_on_event", args));
const guard = (args) => asService(() => rpc(db, "realtoros_presend_guard", args));

async function count(sql, params) {
  return Number((await one(db, sql, params)).n);
}

// ---------------------------------------------------------------- schema

sqlTest("verification file: every check passes after the migration", async () => {
  const res = await db.query(fs.readFileSync(VERIFY_SQL, "utf8"));
  const failed = res.rows.filter((r) => r.ok !== true);
  assert.deepEqual(failed, [], `failed checks: ${JSON.stringify(failed, null, 2)}`);
  assert.ok(res.rows.length >= 40, `expected a full check set, got ${res.rows.length}`);
});

sqlTest("migration is re-runnable (idempotent-safe) and verification still passes", async () => {
  // Re-runnability is a property of a chain POSITION, so replay each migration
  // where it actually sits: on a database built only up to T2c-post. Replaying
  // T2c-post onto the full chain instead makes its inline completeness guard
  // judge helpers introduced by later migrations (T3's
  // automation_internal.ensure_landing_workspace), which it cannot know about
  // and which applied migrations may never be edited to allow for.
  const { migrationFiles } = await import("../helpers/pg.mjs");
  const files = migrationFiles();
  const read = (f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
  const verify = fs.readFileSync(VERIFY_SQL, "utf8");
  const chain = await migratedDb((f) => f <= MIGRATION_T2C_POST);
  try {
    // Replay 4E.2..T2c-post: the chain ends in the state it started in.
    for (const f of files.filter((f) => f >= MIGRATION_4E2 && f <= MIGRATION_T2C_POST)) {
      await chain.exec(read(f));
    }
    let res = await chain.query(verify);
    assert.deepEqual(res.rows.filter((r) => r.ok !== true), [], "4E.2 verification failed after replay");
    // The rest of the chain (T2d, T3, ...) still applies onto the replayed one.
    for (const f of files.filter((f) => f > MIGRATION_T2C_POST)) {
      await chain.exec(read(f));
    }
    res = await chain.query(verify);
    assert.deepEqual(res.rows.filter((r) => r.ok !== true), [], "4E.2 verification failed after the later migrations");
  } finally {
    await chain.close();
  }
});

sqlTest("browser roles cannot execute any stop function", async () => {
  const w = await seedWorld(db);
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(
        db.query(`select public.realtoros_record_contact_stop_event($1, $2, 'reply', 'owner_manual', 'x')`, [w.userId, w.contactId]),
        /permission denied/,
      );
      await assert.rejects(
        db.query(`select public.realtoros_presend_guard($1, $2, $3)`, [w.userId, w.jobId, randomUUID()]),
        /permission denied/,
      );
    } finally {
      await db.exec("reset role");
    }
  }
});

// ------------------------------------------------ 4E hotfix: contacts trigger

sqlTest("regression: with only the 4E migration applied, any contact write fails (the bug 4E.2 fixes)", async () => {
  const { loadPGlite, migrationFiles } = await import("../helpers/pg.mjs");
  const PGlite = await loadPGlite();
  const pre = new PGlite();
  const prelude = (await import("../helpers/pg.mjs")).PLATFORM_PRELUDE;
  await pre.exec(prelude);
  for (const f of migrationFiles().filter((f) => f < MIGRATION_4E2)) {
    await pre.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
  }
  const uid = randomUUID();
  await pre.query(`insert into auth.users (id) values ($1)`, [uid]);
  await assert.rejects(
    pre.query(`insert into public.contacts (id, user_id, email) values ($1, $2, 'a@example.com')`, [`c-${uid}`, uid]),
    /missing FROM-clause entry for table "pg_catalog"/,
  );
  await pre.close();
});

sqlTest("fixed trigger: browser roles cannot set lifecycle markers; service_role can", async () => {
  const uid = randomUUID();
  const cid = `c-${uid}`;
  await db.query(`insert into auth.users (id) values ($1)`, [uid]);
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try {
    await db.query(
      `insert into public.contacts (id, user_id, email, reply_detected_at, unsubscribe_detected_at) values ($1, $2, 'b@example.com', now(), now())`,
      [cid, uid],
    );
    await db.query(`update public.contacts set reply_detected_at = now(), full_name = 'Edited' where id = $1`, [cid]);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
  let c = await one(db, `select full_name, reply_detected_at, unsubscribe_detected_at from public.contacts where id = $1`, [cid]);
  assert.deepEqual(c, { full_name: "Edited", reply_detected_at: null, unsubscribe_detected_at: null });
  await asService(() => db.query(`update public.contacts set reply_detected_at = '2026-09-01T00:00:00Z' where id = $1`, [cid]));
  c = await one(db, `select reply_detected_at from public.contacts where id = $1`, [cid]);
  assert.ok(c.reply_detected_at);
});

// ------------------------------------------------ stop one enrollment

sqlTest("stop_enrollment_on_event: stops, cancels pending only, idempotent, complaint allowed", async () => {
  const w = await seedWorld(db);
  const processingJob = randomUUID();
  await db.query(
    `insert into public.automation_jobs (id, user_id, enrollment_id, rule_id, contact_id, job_type, status, idempotency_key)
     values ($1, $2, $3, $4, $5, 'send_email', 'processing', $6)`,
    [processingJob, w.userId, w.enrollmentId, w.ruleId, w.contactId, `k-${processingJob}`],
  );
  const out = await stopOne({ p_user_id: w.userId, p_enrollment_id: w.enrollmentId, p_reason: "complaint", p_contact_id: w.contactId });
  assert.deepEqual(out, { enrollment_stopped: true, jobs_cancelled: 1, reason: "complaint" });
  const e = await one(db, `select status, stop_reason, unsubscribe_detected_at from public.automation_enrollments where id = $1`, [w.enrollmentId]);
  assert.equal(e.status, "stopped");
  assert.equal(e.stop_reason, "complaint");
  assert.ok(e.unsubscribe_detected_at);
  const pending = await one(db, `select status, cancelled_reason from public.automation_jobs where id = $1`, [w.jobId]);
  assert.deepEqual(pending, { status: "cancelled", cancelled_reason: "complaint" });
  const proc = await one(db, `select status from public.automation_jobs where id = $1`, [processingJob]);
  assert.equal(proc.status, "processing", "a claimed job is never cancelled behind the worker");

  const again = await stopOne({ p_user_id: w.userId, p_enrollment_id: w.enrollmentId, p_reason: "reply" });
  assert.equal(again.reason, "already_terminal");
  const e2 = await one(db, `select stop_reason from public.automation_enrollments where id = $1`, [w.enrollmentId]);
  assert.equal(e2.stop_reason, "complaint", "original stop reason preserved");
});

sqlTest("stop_enrollment_on_event: invalid reason and contact mismatch", async () => {
  const w = await seedWorld(db);
  await assert.rejects(stopOne({ p_user_id: w.userId, p_enrollment_id: w.enrollmentId, p_reason: "locked" }), /invalid stop reason/);
  const out = await stopOne({ p_user_id: w.userId, p_enrollment_id: w.enrollmentId, p_reason: "reply", p_contact_id: "someone-else" });
  assert.equal(out.reason, "contact_mismatch");
  const e = await one(db, `select status from public.automation_enrollments where id = $1`, [w.enrollmentId]);
  assert.equal(e.status, "active");
});

// ------------------------------------------------ record contact stop event

sqlTest("unsubscribe link: consent (real source), suppression, lifecycle, activity, stop, ledger", async () => {
  const w = await seedWorld(db);
  const out = await record({
    p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "unsubscribe",
    p_source: "unsubscribe_link", p_event_ref: `unsub:${randomUUID()}`,
  });
  assert.equal(out.outcome, "recorded");
  assert.equal(out.first_occurrence, true);
  assert.equal(out.suppression_added, true);
  assert.equal(out.enrollments_stopped, 1);
  assert.equal(out.jobs_cancelled, 1);

  const consent = await one(db, `select status, source from public.communication_consents where user_id = $1 and contact_id = $2`, [w.userId, w.contactId]);
  assert.deepEqual(consent, { status: "opted_out", source: "unsubscribe_link" });
  const sup = await one(db, `select reason, normalized_email, is_active from public.email_suppressions where user_id = $1`, [w.userId]);
  assert.deepEqual(sup, { reason: "unsubscribe", normalized_email: w.email.toLowerCase(), is_active: true });
  const c = await one(db, `select unsubscribe_detected_at, reply_detected_at from public.contacts where id = $1`, [w.contactId]);
  assert.ok(c.unsubscribe_detected_at);
  assert.equal(c.reply_detected_at, null);
  const act = await one(db, `select subject, notes, outcome from public.activities where id = $1`, [`automation-stop-unsubscribe-${w.contactId}`]);
  assert.equal(act.outcome, "Unsubscribed");
  assert.match(act.notes, /unsubscribe link/);
  assert.equal(await count(`select count(*) n from public.contact_stop_events where user_id = $1`, [w.userId]), 1);
});

sqlTest("duplicate event -> one stop, one activity, one suppression, one ledger row", async () => {
  const w = await seedWorld(db);
  const args = {
    p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "complaint",
    p_source: "provider_webhook", p_event_ref: `msg_${randomUUID()}`,
  };
  const first = await record(args);
  const second = await record(args);
  const third = await record(args);
  assert.equal(first.outcome, "recorded");
  assert.equal(second.outcome, "duplicate");
  assert.equal(third.outcome, "duplicate");
  assert.equal(second.enrollments_stopped, first.enrollments_stopped, "duplicate returns the original result");
  assert.equal(await count(`select count(*) n from public.email_suppressions where user_id = $1`, [w.userId]), 1);
  assert.equal(await count(`select count(*) n from public.activities where user_id = $1 and id like 'automation-stop-%'`, [w.userId]), 1);
  assert.equal(await count(`select count(*) n from public.contact_stop_events where user_id = $1`, [w.userId]), 1);
  const e = await one(db, `select status, stop_reason from public.automation_enrollments where id = $1`, [w.enrollmentId]);
  assert.deepEqual(e, { status: "stopped", stop_reason: "complaint" });
  const consent = await one(db, `select source from public.communication_consents where user_id = $1`, [w.userId]);
  assert.equal(consent.source, "provider_webhook");
});

sqlTest("a different event ref for the same contact changes nothing new (effects idempotent)", async () => {
  const w = await seedWorld(db);
  await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "unsubscribe", p_source: "owner_manual", p_event_ref: "manual:a" });
  const out = await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "unsubscribe", p_source: "unsubscribe_link", p_event_ref: "unsub:b" });
  assert.equal(out.outcome, "recorded");
  assert.equal(out.first_occurrence, false);
  assert.equal(out.suppression_added, false);
  const consent = await one(db, `select source from public.communication_consents where user_id = $1`, [w.userId]);
  assert.equal(consent.source, "owner_manual", "first opt-out's source is preserved");
  assert.equal(await count(`select count(*) n from public.email_suppressions where user_id = $1`, [w.userId]), 1);
});

sqlTest("reply + unsubscribe for the same contact: both applied, enrollment keeps the first stop reason", async () => {
  const w = await seedWorld(db);
  const [a, b] = await Promise.all([
    record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "reply", p_source: "inbound_email", p_event_ref: "in:1" }),
    record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "unsubscribe", p_source: "unsubscribe_link", p_event_ref: "unsub:1" }),
  ]);
  assert.equal(a.outcome, "recorded");
  assert.equal(b.outcome, "recorded");
  const c = await one(db, `select reply_detected_at, unsubscribe_detected_at from public.contacts where id = $1`, [w.contactId]);
  assert.ok(c.reply_detected_at && c.unsubscribe_detected_at);
  const e = await one(db, `select status, stop_reason from public.automation_enrollments where id = $1`, [w.enrollmentId]);
  assert.equal(e.status, "stopped");
  assert.ok(["reply", "unsubscribe"].includes(e.stop_reason));
  assert.equal(a.enrollments_stopped + b.enrollments_stopped, 1, "stopped exactly once");
  assert.equal(await count(`select count(*) n from public.activities where user_id = $1 and id like 'automation-stop-%'`, [w.userId]), 2);
  assert.equal(await count(`select count(*) n from public.email_suppressions where user_id = $1`, [w.userId]), 1);
});

sqlTest("stop_on_reply = true stops; = false records the reply and continues", async () => {
  const stops = await seedWorld(db, { stopOnReply: true });
  const out1 = await record({ p_user_id: stops.userId, p_contact_id: stops.contactId, p_event_type: "reply", p_source: "owner_manual", p_event_ref: "m1" });
  assert.equal(out1.enrollments_stopped, 1);
  const act = await one(db, `select notes from public.activities where id = $1`, [`automation-stop-reply-${stops.contactId}`]);
  assert.match(act.notes, /^You marked this contact as replied\./);

  const cont = await seedWorld(db, { stopOnReply: false });
  const out2 = await record({ p_user_id: cont.userId, p_contact_id: cont.contactId, p_event_type: "reply", p_source: "owner_manual", p_event_ref: "m2" });
  assert.equal(out2.enrollments_stopped, 0);
  assert.equal(out2.enrollments_continuing, 1);
  const e = await one(db, `select status from public.automation_enrollments where id = $1`, [cont.enrollmentId]);
  assert.equal(e.status, "active");
  const j = await one(db, `select status from public.automation_jobs where id = $1`, [cont.jobId]);
  assert.equal(j.status, "pending");
  assert.equal(await count(`select count(*) n from public.email_suppressions where user_id = $1`, [cont.userId]), 0, "a reply never blocks the address");
});

sqlTest("stop_on_unsubscribe = false: sequence continues but email is still blocked", async () => {
  const w = await seedWorld(db, { stopOnUnsubscribe: false });
  const out = await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "unsubscribe", p_source: "owner_manual", p_event_ref: "m3" });
  assert.equal(out.enrollments_stopped, 0);
  assert.equal(out.enrollments_continuing, 1);
  assert.equal(out.consent_revoked, true);
  assert.equal(out.suppression_added, true);
  const e = await one(db, `select status from public.automation_enrollments where id = $1`, [w.enrollmentId]);
  assert.equal(e.status, "active");
});

sqlTest("hard bounce: 'bounce' suppression only — no lifecycle, no consent, no enrollment stop", async () => {
  const w = await seedWorld(db);
  const out = await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "hard_bounce", p_source: "provider_webhook", p_event_ref: "svix_hb1" });
  assert.equal(out.outcome, "recorded");
  assert.equal(out.suppression_added, true);
  assert.equal(out.enrollments_stopped, 0);
  const sup = await one(db, `select reason from public.email_suppressions where user_id = $1`, [w.userId]);
  assert.equal(sup.reason, "bounce");
  const c = await one(db, `select reply_detected_at, unsubscribe_detected_at from public.contacts where id = $1`, [w.contactId]);
  assert.deepEqual(c, { reply_detected_at: null, unsubscribe_detected_at: null });
  assert.equal(await count(`select count(*) n from public.communication_consents where user_id = $1`, [w.userId]), 0);
  const e = await one(db, `select status from public.automation_enrollments where id = $1`, [w.enrollmentId]);
  assert.equal(e.status, "active");
});

sqlTest("existing active suppression is not duplicated (partial unique index ON CONFLICT)", async () => {
  const w = await seedWorld(db);
  await db.query(`insert into public.email_suppressions (user_id, normalized_email, reason) values ($1, $2, 'manual')`, [w.userId, w.email.toLowerCase()]);
  const out = await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "complaint", p_source: "provider_webhook", p_event_ref: "svix_c9" });
  assert.equal(out.suppression_added, false);
  const rows = (await db.query(`select reason from public.email_suppressions where user_id = $1`, [w.userId])).rows;
  assert.deepEqual(rows, [{ reason: "manual" }]);
});

sqlTest("suppression uses the address the message was sent to", async () => {
  const w = await seedWorld(db);
  const msg = randomUUID();
  await db.query(
    `insert into public.outbound_messages (id, user_id, contact_id, channel, provider, recipient, status, message_kind)
     values ($1, $2, $3, 'email', 'resend', 'Old.Address@Example.com', 'sent', 'automation')`,
    [msg, w.userId, w.contactId],
  );
  await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "hard_bounce", p_source: "provider_webhook", p_event_ref: "svix_hb2", p_outbound_message_id: msg });
  const sup = await one(db, `select normalized_email, source_message_id from public.email_suppressions where user_id = $1`, [w.userId]);
  assert.deepEqual(sup, { normalized_email: "old.address@example.com", source_message_id: msg });
});

sqlTest("message belonging to another contact is refused with no changes", async () => {
  const a = await seedWorld(db);
  const other = `c-${randomUUID()}`;
  await db.query(`insert into public.contacts (id, user_id, email) values ($1, $2, 'x@example.com')`, [other, a.userId]);
  const msg = randomUUID();
  await db.query(
    `insert into public.outbound_messages (id, user_id, contact_id, channel, provider, recipient, status, message_kind)
     values ($1, $2, $3, 'email', 'resend', 'x@example.com', 'sent', 'automation')`,
    [msg, a.userId, other],
  );
  const out = await record({ p_user_id: a.userId, p_contact_id: a.contactId, p_event_type: "unsubscribe", p_source: "unsubscribe_link", p_event_ref: "unsub:x", p_outbound_message_id: msg });
  assert.equal(out.outcome, "message_mismatch");
  assert.equal(await count(`select count(*) n from public.communication_consents where user_id = $1`, [a.userId]), 0);
  assert.equal(await count(`select count(*) n from public.email_suppressions where user_id = $1`, [a.userId]), 0);
});

sqlTest("earliest occurrence wins; a later event never moves the timestamp", async () => {
  const w = await seedWorld(db, { stopOnReply: false });
  const t2 = "2026-09-20T10:00:00Z", t1 = "2026-09-10T10:00:00Z", t3 = "2026-09-25T10:00:00Z";
  await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "reply", p_source: "inbound_email", p_event_ref: "r2", p_occurred_at: t2 });
  await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "reply", p_source: "inbound_email", p_event_ref: "r1", p_occurred_at: t1 });
  await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "reply", p_source: "inbound_email", p_event_ref: "r3", p_occurred_at: t3 });
  const c = await one(db, `select reply_detected_at from public.contacts where id = $1`, [w.contactId]);
  assert.equal(new Date(c.reply_detected_at).toISOString(), new Date(t1).toISOString());
});

sqlTest("invalid type/source combinations and refs are rejected", async () => {
  const w = await seedWorld(db);
  const base = { p_user_id: w.userId, p_contact_id: w.contactId };
  await assert.rejects(record({ ...base, p_event_type: "complaint", p_source: "owner_manual", p_event_ref: "a" }), /invalid contact stop event source/);
  await assert.rejects(record({ ...base, p_event_type: "hard_bounce", p_source: "unsubscribe_link", p_event_ref: "a" }), /invalid contact stop event source/);
  await assert.rejects(record({ ...base, p_event_type: "reply", p_source: "unsubscribe_link", p_event_ref: "a" }), /invalid contact stop event source/);
  await assert.rejects(record({ ...base, p_event_type: "bounce", p_source: "provider_webhook", p_event_ref: "a" }), /invalid contact stop event type/);
  await assert.rejects(record({ ...base, p_event_type: "reply", p_source: "webhook", p_event_ref: "a" }), /invalid contact stop event source/);
  await assert.rejects(record({ ...base, p_event_type: "reply", p_source: "owner_manual", p_event_ref: "" }), /invalid contact stop event reference/);
  await assert.rejects(record({ ...base, p_event_type: "reply", p_source: "owner_manual", p_event_ref: "a\nb" }), /invalid contact stop event reference/);
  const nf = await record({ ...base, p_contact_id: "nope", p_event_type: "reply", p_source: "owner_manual", p_event_ref: "a" });
  assert.equal(nf.outcome, "contact_not_found");
});

sqlTest("paused and archived rules plus stop events never resurrect jobs; retry refused for a stop-cancelled job", async () => {
  const w = await seedWorld(db, { enrollmentStatus: "paused" });
  await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "unsubscribe", p_source: "owner_manual", p_event_ref: "p1" });
  let e = await one(db, `select status from public.automation_enrollments where id = $1`, [w.enrollmentId]);
  assert.equal(e.status, "stopped", "a paused enrollment is stopped too");
  await asService(() => rpc(db, "realtoros_archive_rule", { p_user_id: w.userId, p_rule_id: w.ruleId }));
  e = await one(db, `select status, stop_reason from public.automation_enrollments where id = $1`, [w.enrollmentId]);
  assert.deepEqual(e, { status: "stopped", stop_reason: "unsubscribe" }, "archive does not overwrite the stop");
  const j = await one(db, `select status, cancelled_reason from public.automation_jobs where id = $1`, [w.jobId]);
  assert.deepEqual(j, { status: "cancelled", cancelled_reason: "unsubscribe" });
  const retry = await asService(() => rpc(db, "realtoros_retry_failed_job", { p_user_id: w.userId, p_job_id: w.jobId }));
  assert.equal(retry.outcome, "not_eligible");
  assert.equal((await one(db, `select status from public.automation_jobs where id = $1`, [w.jobId])).status, "cancelled");
});

// ------------------------------------------------ pre-send guard + skip

async function claimOnly(w) {
  // Claim exactly this world's job the way realtoros_claim_due_jobs does,
  // without claiming other tests' pending jobs.
  const token = randomUUID();
  await db.query(
    `update public.automation_jobs set status = 'processing', lock_token = $2, attempts = attempts + 1, locked_at = now() where id = $1`,
    [w.jobId, token],
  );
  await db.query(
    `insert into public.automation_runs (user_id, job_id, enrollment_id, attempt_number, status, started_at)
     select user_id, id, enrollment_id, attempts, 'processing', now() from public.automation_jobs where id = $1`,
    [w.jobId],
  );
  return token;
}

sqlTest("presend guard: none / abort (wrong token) / cancel (enrollment stopped while processing)", async () => {
  const w = await seedWorld(db);
  const token = await claimOnly(w);
  assert.equal((await guard({ p_user_id: w.userId, p_job_id: w.jobId, p_lock_token: token })).action, "none");
  assert.deepEqual(
    await guard({ p_user_id: w.userId, p_job_id: w.jobId, p_lock_token: randomUUID() }),
    { blocked: true, action: "abort", reason: "lock_lost" },
  );
  // A stop lands while the job is claimed: the job is NOT cancelled by
  // the stop, so the guard is what prevents the send.
  await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "reply", p_source: "owner_manual", p_event_ref: "g1" });
  assert.equal((await one(db, `select status from public.automation_jobs where id = $1`, [w.jobId])).status, "processing");
  const g = await guard({ p_user_id: w.userId, p_job_id: w.jobId, p_lock_token: token });
  assert.deepEqual(g, { blocked: true, action: "cancel", reason: "enrollment_inactive" });
});

sqlTest("presend guard: lifecycle stop when the enrollment is still active (-> stop)", async () => {
  const w = await seedWorld(db);
  const token = await claimOnly(w);
  // Marker set without the enrollment having been stopped (e.g. the stop
  // itself had to be retried): the guard still blocks the whole sequence.
  await db.query(`update public.contacts set reply_detected_at = now() where id = $1`, [w.contactId]);
  const g = await guard({ p_user_id: w.userId, p_job_id: w.jobId, p_lock_token: token });
  assert.deepEqual(g, { blocked: true, action: "stop", reason: "contact_replied", stop_reason: "reply" });
});

sqlTest("presend guard: stop_on_unsubscribe=false -> email skipped, task runs", async () => {
  const w = await seedWorld(db, { stopOnUnsubscribe: false });
  const token = await claimOnly(w);
  await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "unsubscribe", p_source: "owner_manual", p_event_ref: "g2" });
  const g = await guard({ p_user_id: w.userId, p_job_id: w.jobId, p_lock_token: token });
  assert.equal(g.action, "skip");
  assert.equal(g.reason, "suppressed");

  const t = await seedWorld(db, { stopOnUnsubscribe: false, jobType: "create_task" });
  const tt = await claimOnly(t);
  await record({ p_user_id: t.userId, p_contact_id: t.contactId, p_event_type: "unsubscribe", p_source: "owner_manual", p_event_ref: "g3" });
  assert.equal((await guard({ p_user_id: t.userId, p_job_id: t.jobId, p_lock_token: tt })).action, "none");
});

sqlTest("presend guard: hard bounce -> email skipped; consent-only opt-out -> skipped", async () => {
  const w = await seedWorld(db);
  const token = await claimOnly(w);
  await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "hard_bounce", p_source: "provider_webhook", p_event_ref: "g4" });
  assert.deepEqual(await guard({ p_user_id: w.userId, p_job_id: w.jobId, p_lock_token: token }), { blocked: true, action: "skip", reason: "suppressed" });

  const c = await seedWorld(db);
  const ct = await claimOnly(c);
  await db.query(`insert into public.communication_consents (user_id, contact_id, channel, status, source) values ($1, $2, 'email', 'opted_out', 'import')`, [c.userId, c.contactId]);
  assert.deepEqual(await guard({ p_user_id: c.userId, p_job_id: c.jobId, p_lock_token: ct }), { blocked: true, action: "skip", reason: "consent_revoked" });
});

sqlTest("skip_claimed_job: completes the step without sending, records why, closes the run", async () => {
  const w = await seedWorld(db);
  const token = await claimOnly(w);
  const out = await asService(() => rpc(db, "realtoros_skip_claimed_job", { p_user_id: w.userId, p_job_id: w.jobId, p_lock_token: token, p_reason: "suppressed" }));
  assert.equal(out.skipped_reason, "suppressed");
  assert.ok(["advanced", "enrollment_completed", "completed_no_advance"].includes(out.outcome), out.outcome);
  const j = await one(db, `select status, skipped_reason from public.automation_jobs where id = $1`, [w.jobId]);
  assert.deepEqual(j, { status: "completed", skipped_reason: "suppressed" });
  const run = await one(db, `select status from public.automation_runs where job_id = $1`, [w.jobId]);
  assert.equal(run.status, "completed");
  const again = await asService(() => rpc(db, "realtoros_skip_claimed_job", { p_user_id: w.userId, p_job_id: w.jobId, p_lock_token: token, p_reason: "suppressed" }));
  assert.equal(again.outcome, "not_processing");
  await assert.rejects(
    asService(() => rpc(db, "realtoros_skip_claimed_job", { p_user_id: w.userId, p_job_id: w.jobId, p_lock_token: token, p_reason: "whatever" })),
    /invalid skip reason/,
  );
});

sqlTest("rule_stop_summary lists stopped enrollments, cancelled and skipped jobs", async () => {
  const w = await seedWorld(db);
  const token = await claimOnly(w);
  await asService(() => rpc(db, "realtoros_skip_claimed_job", { p_user_id: w.userId, p_job_id: w.jobId, p_lock_token: token, p_reason: "consent_revoked" }));
  const s = await asService(() => rpc(db, "realtoros_rule_stop_summary", { p_user_id: w.userId, p_rule_id: w.ruleId }));
  assert.equal(s.found, true);
  assert.equal(s.skipped_jobs.length, 1);
  assert.equal(s.skipped_jobs[0].skipped_reason, "consent_revoked");
  assert.deepEqual(Object.keys(s).sort(), ["cancelled_jobs", "found", "skipped_jobs", "stopped_counts", "stopped_enrollments"]);
});

sqlTest("eligibility check (unchanged) still refuses suppressed / unsubscribed / replied contacts", async () => {
  const w = await seedWorld(db, { enrollmentStatus: "completed" });
  const elig = (rule) => asService(() => rpc(db, "realtoros_check_enrollment_eligibility", { p_user_id: w.userId, p_contact_id: w.contactId, p_rule_id: rule }));
  assert.equal((await elig(w.ruleId)).eligible, true);
  await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "reply", p_source: "owner_manual", p_event_ref: "e1" });
  assert.equal((await elig(w.ruleId)).block_reason, "contact_replied");
  await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "unsubscribe", p_source: "owner_manual", p_event_ref: "e2" });
  assert.equal((await elig(w.ruleId)).block_reason, "suppressed");
});
