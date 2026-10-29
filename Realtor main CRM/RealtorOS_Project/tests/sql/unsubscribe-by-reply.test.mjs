// Phase 4E.3: realtoros_record_contact_stop_event accepts an unsubscribe
// from inbound_email (a reply asking to be unsubscribed). Real migration
// chain in PGlite; calls run as service_role.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { migratedDb, seedWorld, one, rpc, SKIP_MESSAGE, MIGRATIONS_DIR } from "../helpers/pg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERIFY_4E3 = path.join(here, "..", "..", "supabase", "tests", "phase_4e_3_verification.sql");
const VERIFY_4E2 = path.join(here, "..", "..", "supabase", "tests", "phase_4e_2_verification.sql");
const MIGRATION_4E3 = "20260929051621_phase_4e_3_unsubscribe_by_reply.sql";

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
const count = async (sql, params) => Number((await one(db, sql, params)).n);

sqlTest("4E.3 and 4E.2 verification queries both pass", async () => {
  for (const f of [VERIFY_4E3, VERIFY_4E2]) {
    const rows = (await db.query(fs.readFileSync(f, "utf8"))).rows;
    assert.deepEqual(rows.filter((r) => r.ok !== true), [], path.basename(f));
  }
});

sqlTest("exactly one function signature; grants unchanged (service_role only)", async () => {
  const sigs = (await db.query(`
    select pg_get_function_identity_arguments(p.oid) as args, p.oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'realtoros_record_contact_stop_event'`)).rows;
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].args, "p_user_id uuid, p_contact_id text, p_event_type text, p_source text, p_event_ref text, p_outbound_message_id uuid, p_occurred_at timestamp with time zone");
  const g = await one(db, `select has_function_privilege('anon', $1::oid, 'execute') a,
    has_function_privilege('authenticated', $1::oid, 'execute') b,
    has_function_privilege('service_role', $1::oid, 'execute') c`, [sigs[0].oid]);
  assert.deepEqual(g, { a: false, b: false, c: true });
});

sqlTest("unsubscribe + inbound_email is accepted and does a full unsubscribe", async () => {
  const w = await seedWorld(db, { stopOnUnsubscribe: true });
  const args = {
    p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "unsubscribe",
    p_source: "inbound_email", p_event_ref: "inbound:in_email_1",
  };
  const out = await record(args);
  assert.equal(out.outcome, "recorded");
  assert.equal(out.consent_revoked, true);
  assert.equal(out.suppression_added, true);
  assert.equal(out.enrollments_stopped, 1);
  const c = await one(db, `select reply_detected_at, unsubscribe_detected_at from public.contacts where id = $1`, [w.contactId]);
  assert.ok(c.unsubscribe_detected_at);
  assert.equal(c.reply_detected_at, null, "not recorded as a reply");
  const consent = await one(db, `select status, source from public.communication_consents where user_id = $1`, [w.userId]);
  assert.deepEqual(consent, { status: "opted_out", source: "inbound_email" });
  const sup = await one(db, `select reason from public.email_suppressions where user_id = $1`, [w.userId]);
  assert.equal(sup.reason, "unsubscribe");
  const job = await one(db, `select status, cancelled_reason from public.automation_jobs where id = $1`, [w.jobId]);
  assert.deepEqual(job, { status: "cancelled", cancelled_reason: "unsubscribe" });
  const act = await one(db, `select notes from public.activities where id = $1`, [`automation-stop-unsubscribe-${w.contactId}`]);
  assert.equal(act.notes, "They replied asking to be unsubscribed. Email to this contact is now blocked.");
  assert.equal(await count(`select count(*) n from public.activities where id = $1`, [`automation-stop-reply-${w.contactId}`]), 0);

  const again = await record(args);
  assert.equal(again.outcome, "duplicate");
  assert.equal(await count(`select count(*) n from public.contact_stop_events where user_id = $1`, [w.userId]), 1);
  assert.equal(await count(`select count(*) n from public.email_suppressions where user_id = $1`, [w.userId]), 1);
});

sqlTest("stop_on_unsubscribe = false: sequence continues, email still blocked", async () => {
  const w = await seedWorld(db, { stopOnUnsubscribe: false });
  const out = await record({ p_user_id: w.userId, p_contact_id: w.contactId, p_event_type: "unsubscribe", p_source: "inbound_email", p_event_ref: "inbound:x2" });
  assert.equal(out.enrollments_stopped, 0);
  assert.equal(out.enrollments_continuing, 1);
  assert.equal(out.suppression_added, true);
});

sqlTest("every other invalid pair is still rejected; existing pairs still work", async () => {
  const w = await seedWorld(db);
  const base = { p_user_id: w.userId, p_contact_id: w.contactId };
  for (const [type, source] of [
    ["complaint", "inbound_email"], ["hard_bounce", "inbound_email"],
    ["complaint", "owner_manual"], ["hard_bounce", "unsubscribe_link"],
    ["reply", "unsubscribe_link"], ["complaint", "unsubscribe_link"],
  ]) {
    await assert.rejects(
      record({ ...base, p_event_ref: `r-${randomUUID()}`, p_event_type: type, p_source: source }),
      /invalid contact stop event source for this event type/,
      `${type}+${source}`,
    );
  }
  for (const [type, source] of [["reply", "inbound_email"], ["unsubscribe", "unsubscribe_link"], ["unsubscribe", "owner_manual"], ["complaint", "provider_webhook"]]) {
    const out = await record({ ...base, p_event_ref: `ok-${randomUUID()}`, p_event_type: type, p_source: source });
    assert.equal(out.outcome, "recorded", `${type}+${source}`);
  }
});

sqlTest("4E.3 migration is re-runnable; browser roles still cannot call the function", async () => {
  await db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_4E3), "utf8"));
  const rows = (await db.query(fs.readFileSync(VERIFY_4E3, "utf8"))).rows;
  assert.deepEqual(rows.filter((r) => r.ok !== true), []);
  const w = await seedWorld(db);
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(
        db.query(`select public.realtoros_record_contact_stop_event($1, $2, 'unsubscribe', 'inbound_email', 'x')`, [w.userId, w.contactId]),
        /permission denied/,
      );
    } finally {
      await db.exec("reset role");
    }
  }
});
