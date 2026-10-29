// Phase T2c-post: the automation and email-stop pipeline becomes
// team-aware.
//
// Every test here uses a lead, rule, enrollment and job created by the
// AGENT, and calls the RPC with the OWNER's user_id. That is the real
// shape of the bug: the Resend webhook and the unsubscribe endpoint
// authenticate one person, and the lead belongs to another. Before
// T2c-post the lookups resolved by creator, found nothing, and returned
// an early outcome without raising - so a reply or unsubscribe was
// silently dropped.
//
// Each pipeline stage gets its own test, plus the not-found contracts and
// cross-workspace isolation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedDb, one, SKIP_MESSAGE } from "../helpers/pg.mjs";

let db;
let applied = false;
const NOT_APPLIED = "T2c-post not in the migration chain";

before(async () => {
  db = await migratedDb();
  if (!db) return;
  // The marker: after T2c-post no RPC resolves a row by creator.
  const r = await db.query(
    `select count(*)::int as n from pg_proc p
       join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname in ('public','automation_internal')
        and p.prosrc ~ 'user_id[[:space:]]*=[[:space:]]*p_user_id'
        and p.proname not in ('member_permissions','workspace_of','notify',
                              'ensure_personal_workspace',
                              -- T3's landing helper. It matches the pattern
                              -- because it resolves the CALLER'S OWN removed
                              -- membership in a workspace they own
                              -- (workspace_members.user_id = p_user_id and
                              -- workspaces.owner_user_id = p_user_id) in
                              -- order to reactivate it: an ownership lookup,
                              -- not the creator-based row resolution this
                              -- marker watches for. While it was missing from
                              -- this list, every test in this file skipped.
                              'ensure_landing_workspace')`);
  applied = Number(r.rows[0].n) === 0;
});

after(async () => {
  if (!db) return;
  await db.close();
  assert.equal(db.closed, true, "the shared PGlite database must close");
});

function sqlTest(name, fn) {
  test(name, async (t) => {
    if (!db) return t.skip(SKIP_MESSAGE);
    if (!applied) return t.skip(NOT_APPLIED);
    await fn();
  });
}

async function asService(fn) {
  await db.exec("set role service_role");
  try { return await fn(); } finally { await db.exec("reset role"); }
}
const rpc = async (fn, args) => {
  const keys = Object.keys(args);
  const ph = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
  return asService(async () =>
    (await db.query(`select public.${fn}(${ph}) as out`, keys.map((k) => args[k]))).rows[0].out);
};
const count = async (sql, p = []) => Number((await db.query(sql, p)).rows[0].n);

/**
 * An owner plus an agent in one workspace. Everything else - the lead,
 * the rule, the enrollment, the job - is created BY THE AGENT, which is
 * what makes these tests meaningful. Also a stranger in their own
 * workspace, for the isolation checks.
 */
async function teamWorld(opts = {}) {
  await db.exec("reset role");
  const owner = randomUUID();
  const agent = randomUUID();
  const stranger = randomUUID();
  await db.query(`insert into auth.users (id) values ($1), ($2), ($3)`,
    [owner, agent, stranger]);

  await asService(async () => {
    await db.query(`select automation_internal.ensure_personal_workspace($1)`, [owner]);
    await db.query(`select automation_internal.ensure_personal_workspace($1)`, [stranger]);
  });
  const ws = (await db.query(
    `select workspace_id from public.workspace_members
      where user_id=$1 and status='active'`, [owner])).rows[0].workspace_id;
  const strangerWs = (await db.query(
    `select workspace_id from public.workspace_members
      where user_id=$1 and status='active'`, [stranger])).rows[0].workspace_id;

  const agentTm = `tm-agent-${agent.slice(0, 8)}`;
  await asService(async () => {
    await db.query(
      `update public.workspace_members set status='removed'
        where user_id=$1 and status='active'`, [agent]);
    const mid = (await db.query(
      `insert into public.workspace_members (workspace_id,user_id,role,status,team_member_id)
       values ($1,$2,'agent','active',null) returning id`, [ws, agent])).rows[0].id;
    await db.query(
      `insert into public.team_members (id,user_id,workspace_id,auth_user_id,name,role,email,phone,active)
       values ($1,$2,$3,$4,'Agent','Agent','','',true)`, [agentTm, owner, ws, agent]);
    await db.query(
      `update public.workspace_members set team_member_id=$1 where id=$2`, [agentTm, mid]);
  });

  // The AGENT's lead, rule, enrollment and job.
  const contactId = `c-${randomUUID()}`;
  const ruleId = randomUUID();
  const enrollmentId = randomUUID();
  const jobId = randomUUID();
  const email = `agent.lead.${contactId.slice(2, 10)}@example.com`;
  await asService(async () => {
    await db.query(
      `insert into public.contacts (id,user_id,workspace_id,full_name,email,status)
       values ($1,$2,$3,'Agent Lead',$4,'New Lead')`, [contactId, agent, ws, email]);
    await db.query(
      `insert into public.automation_rules
         (id,user_id,workspace_id,name,trigger_type,status,stop_on_reply,stop_on_unsubscribe,runtime_version)
       values ($1,$2,$3,$4,'manual',$5,$6,$7,gen_random_uuid())`,
      [ruleId, agent, ws, `Agent Rule ${ruleId.slice(0, 8)}`,
       opts.ruleStatus ?? "active", opts.stopOnReply ?? true, opts.stopOnUnsubscribe ?? true]);
    await db.query(
      `insert into public.automation_enrollments (id,user_id,workspace_id,rule_id,contact_id,status)
       values ($1,$2,$3,$4,$5,$6)`,
      [enrollmentId, agent, ws, ruleId, contactId, opts.enrollmentStatus ?? "active"]);
    await db.query(
      `insert into public.automation_jobs
         (id,user_id,workspace_id,enrollment_id,rule_id,contact_id,job_type,status,idempotency_key,payload)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [jobId, agent, ws, enrollmentId, ruleId, contactId,
       opts.jobType ?? "send_email", opts.jobStatus ?? "pending", `k-${jobId}`,
       JSON.stringify({ step_order: 1, action_type: opts.jobType ?? "send_email" })]);
  });

  return { owner, agent, stranger, ws, strangerWs, agentTm,
           contactId, ruleId, enrollmentId, jobId, email };
}

/** Record a stop event AS THE OWNER against the AGENT's lead. */
const stopEvent = (w, type, source, ref = null) =>
  rpc("realtoros_record_contact_stop_event", {
    p_user_id: w.owner,
    p_contact_id: w.contactId,
    p_event_type: type,
    p_source: source,
    p_event_ref: ref ?? `ev-${randomUUID()}`,
    p_outbound_message_id: null,
    p_occurred_at: new Date().toISOString(),
  });

// ------------------------------------------------- the conversion itself

sqlTest("no RPC resolves a row by creator any more", async () => {
  const left = await count(
    `select count(*)::int as n from pg_proc p
       join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname in ('public','automation_internal')
        and p.prosrc ~ 'user_id[[:space:]]*=[[:space:]]*p_user_id'
        and p.proname not in ('member_permissions','workspace_of','notify',
                              'ensure_personal_workspace',
                              -- T3's landing helper. It matches the pattern
                              -- because it resolves the CALLER'S OWN removed
                              -- membership in a workspace they own
                              -- (workspace_members.user_id = p_user_id and
                              -- workspaces.owner_user_id = p_user_id) in
                              -- order to reactivate it: an ownership lookup,
                              -- not the creator-based row resolution this
                              -- marker watches for. While it was missing from
                              -- this list, every test in this file skipped.
                              'ensure_landing_workspace')`);
  assert.equal(left, 0);
});

sqlTest("every signature is unchanged, so no Edge Function needs redeploying", async () => {
  const sigs = await db.query(
    `select p.proname, pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname='public' and p.proname in
        ('realtoros_record_contact_stop_event','realtoros_presend_guard',
         'realtoros_enroll_contact','realtoros_stop_enrollment')
      order by p.proname`);
  const byName = Object.fromEntries(sigs.rows.map((r) => [r.proname, r.args]));
  assert.ok(byName.realtoros_record_contact_stop_event.startsWith("p_user_id uuid, p_contact_id text"));
  assert.equal(byName.realtoros_presend_guard, "p_user_id uuid, p_job_id uuid, p_lock_token uuid");
  assert.equal(byName.realtoros_stop_enrollment,
    "p_user_id uuid, p_enrollment_id uuid, p_reason text");
});

// ------------------------------------------------- stage: stop events

sqlTest("stage 1 - REPLY on an agent's lead: recorded, marker, enrollment stopped, job cancelled, notification", async () => {
  const w = await teamWorld();
  const out = await stopEvent(w, "reply", "inbound_email");
  assert.equal(out.outcome, "recorded", JSON.stringify(out));

  const c = await one(db,
    `select reply_detected_at from public.contacts where id=$1`, [w.contactId]);
  assert.ok(c.reply_detected_at, "the lifecycle marker is set");

  const e = await one(db,
    `select status, stop_reason from public.automation_enrollments where id=$1`, [w.enrollmentId]);
  assert.equal(e.status, "stopped", "stop_on_reply stops the enrollment");

  const j = await one(db,
    `select status from public.automation_jobs where id=$1`, [w.jobId]);
  assert.equal(j.status, "cancelled", "its pending job is cancelled");

  assert.equal(await count(
    `select count(*)::int as n from public.contact_stop_events where contact_id=$1`,
    [w.contactId]), 1, "the stop event row exists");

  assert.ok(await count(
    `select count(*)::int as n from public.notifications where contact_id=$1`,
    [w.contactId]) >= 1, "somebody was notified");
});

sqlTest("stage 2 - UNSUBSCRIBE on an agent's lead: consent revoked and the address suppressed", async () => {
  const w = await teamWorld();
  const out = await stopEvent(w, "unsubscribe", "unsubscribe_link");
  assert.equal(out.outcome, "recorded", JSON.stringify(out));

  const c = await one(db,
    `select unsubscribe_detected_at from public.contacts where id=$1`, [w.contactId]);
  assert.ok(c.unsubscribe_detected_at);

  assert.equal(await count(
    `select count(*)::int as n from public.email_suppressions
      where workspace_id=$1 and normalized_email=lower($2)`, [w.ws, w.email]), 1,
    "the address is suppressed in the workspace");

  assert.ok(await count(
    `select count(*)::int as n from public.communication_consents where contact_id=$1`,
    [w.contactId]) >= 1, "a consent record was written");
});

sqlTest("stage 3 - COMPLAINT on an agent's lead suppresses and stops", async () => {
  const w = await teamWorld();
  const out = await stopEvent(w, "complaint", "provider_webhook");
  assert.equal(out.outcome, "recorded", JSON.stringify(out));
  assert.equal(await count(
    `select count(*)::int as n from public.email_suppressions
      where workspace_id=$1 and reason='complaint'`, [w.ws]), 1);
});

sqlTest("stage 4 - HARD BOUNCE on an agent's lead suppresses but sets no lifecycle marker", async () => {
  const w = await teamWorld();
  const out = await stopEvent(w, "hard_bounce", "provider_webhook");
  assert.equal(out.outcome, "recorded", JSON.stringify(out));
  assert.equal(await count(
    `select count(*)::int as n from public.email_suppressions
      where workspace_id=$1 and reason='bounce'`, [w.ws]), 1);
  const c = await one(db,
    `select reply_detected_at, unsubscribe_detected_at from public.contacts where id=$1`,
    [w.contactId]);
  assert.equal(c.reply_detected_at, null);
  assert.equal(c.unsubscribe_detected_at, null);
});

sqlTest("a replayed stop event on an agent's lead is still idempotent", async () => {
  const w = await teamWorld();
  const ref = `ev-${randomUUID()}`;
  const first = await stopEvent(w, "unsubscribe", "unsubscribe_link", ref);
  const second = await stopEvent(w, "unsubscribe", "unsubscribe_link", ref);
  assert.equal(first.outcome, "recorded");
  assert.equal(second.outcome, "duplicate", JSON.stringify(second));
  assert.equal(await count(
    `select count(*)::int as n from public.contact_stop_events where contact_id=$1`,
    [w.contactId]), 1);
});

// ------------------------------------------------- stage: the job pipeline

sqlTest("stage 5 - the PRESEND GUARD reads an agent's job", async () => {
  const w = await teamWorld();
  const token = randomUUID();
  await asService(() => db.query(
    `update public.automation_jobs set status='processing', lock_token=$1, locked_at=now()
      where id=$2`, [token, w.jobId]));

  const out = await rpc("realtoros_presend_guard", {
    p_user_id: w.owner, p_job_id: w.jobId, p_lock_token: token });
  assert.notEqual(out.reason, "job_not_found",
    `the guard found the agent's job: ${JSON.stringify(out)}`);
  assert.notEqual(out.reason, "contact_not_found");
});

sqlTest("stage 5b - the presend guard still blocks when the lead has unsubscribed", async () => {
  const w = await teamWorld();
  await stopEvent(w, "unsubscribe", "unsubscribe_link");
  // Re-open the enrollment so the block is attributable to the lifecycle,
  // not to the enrollment already being stopped.
  const token = randomUUID();
  await asService(async () => {
    await db.query(
      `update public.automation_enrollments set status='active', stopped_at=null,
              stop_reason=null where id=$1`, [w.enrollmentId]);
    await db.query(
      `update public.automation_jobs set status='processing', lock_token=$1, locked_at=now()
        where id=$2`, [token, w.jobId]);
  });
  const out = await rpc("realtoros_presend_guard", {
    p_user_id: w.owner, p_job_id: w.jobId, p_lock_token: token });
  assert.equal(out.blocked, true, JSON.stringify(out));
});

sqlTest("stage 6 - SKIP a claimed job on an agent's lead", async () => {
  const w = await teamWorld();
  const token = randomUUID();
  await asService(() => db.query(
    `update public.automation_jobs
        set status='processing', lock_token=$1, locked_at=now(), attempts=1
      where id=$2`, [token, w.jobId]));
  // attempt_number must be > 0, and a real claim increments attempts
  // before inserting the run, so mirror that here.
  await asService(() => db.query(
    `insert into public.automation_runs
       (id,user_id,workspace_id,job_id,enrollment_id,attempt_number,status,started_at)
     select gen_random_uuid(), j.user_id, j.workspace_id, j.id, j.enrollment_id,
            j.attempts, 'processing', now()
       from public.automation_jobs j where j.id=$1`, [w.jobId]));

  const out = await rpc("realtoros_skip_claimed_job", {
    p_user_id: w.owner, p_job_id: w.jobId, p_lock_token: token,
    p_reason: "suppressed" });
  assert.notEqual(out.outcome, "not_found", JSON.stringify(out));
});

sqlTest("stage 7 - CANCEL a claimed job on an agent's lead", async () => {
  const w = await teamWorld();
  const token = randomUUID();
  await asService(async () => {
    await db.query(
      `update public.automation_jobs
          set status='processing', lock_token=$1, locked_at=now(), attempts=1
        where id=$2`, [token, w.jobId]);
    await db.query(
      `insert into public.automation_runs
         (id,user_id,workspace_id,job_id,enrollment_id,attempt_number,status,started_at)
       select gen_random_uuid(), j.user_id, j.workspace_id, j.id, j.enrollment_id,
              j.attempts, 'processing', now()
         from public.automation_jobs j where j.id=$1`, [w.jobId]);
  });
  const out = await rpc("realtoros_cancel_claimed_job", {
    p_user_id: w.owner, p_job_id: w.jobId, p_lock_token: token });
  assert.equal(out.outcome, "cancelled", JSON.stringify(out));
});

// ------------------------------------------------- stage: enrollment

sqlTest("stage 8 - ELIGIBILITY for an agent's lead and rule", async () => {
  const w = await teamWorld();
  const out = await rpc("realtoros_check_enrollment_eligibility", {
    p_user_id: w.owner, p_contact_id: w.contactId, p_rule_id: w.ruleId });
  assert.notEqual(out.block_reason, "contact_not_found", JSON.stringify(out));
  assert.notEqual(out.block_reason, "rule_not_found");
});

sqlTest("stage 9 - ENROLL an agent's lead on an agent's rule", async () => {
  const w = await teamWorld();
  // Remove the seeded enrollment so this is a fresh enrolment.
  await asService(async () => {
    await db.query(`delete from public.automation_jobs where id=$1`, [w.jobId]);
    await db.query(`delete from public.automation_enrollments where id=$1`, [w.enrollmentId]);
    // enroll_contact reads its steps from the rule's runtime_snapshot,
    // not from automation_steps, so the snapshot is what has to be set.
    const tpl = randomUUID();
    await db.query(
      `insert into public.message_templates
         (id,user_id,workspace_id,name,subject,body_text,channel)
       values ($1,$2,$3,'Agent Template','Hi','Hello there','email')`,
      [tpl, w.agent, w.ws]);
    await db.query(
      `insert into public.automation_steps
         (id,user_id,workspace_id,rule_id,step_order,action_type,template_id,delay_minutes)
       values (gen_random_uuid(),$1,$2,$3,1,'send_email',$4,0)`,
      [w.agent, w.ws, w.ruleId, tpl]);
    await db.query(
      `update public.automation_rules
          set runtime_snapshot = jsonb_build_object('steps', jsonb_build_array(
                jsonb_build_object('step_order', 1, 'action_type', 'send_email',
                                   'delay_minutes', 0, 'template_id', $2::text)))
        where id = $1`, [w.ruleId, tpl]);
  });
  const out = await rpc("realtoros_enroll_contact", {
    p_user_id: w.owner, p_rule_id: w.ruleId, p_contact_id: w.contactId,
    p_trigger_event_id: null, p_trigger_event_key: null });
  assert.notEqual(out.outcome, "not_found", JSON.stringify(out));
  assert.equal(out.outcome, "enrolled", JSON.stringify(out));
});

sqlTest("stage 10 - the STOP SUMMARY finds an agent's rule", async () => {
  const w = await teamWorld();
  await stopEvent(w, "reply", "inbound_email");
  const out = await rpc("realtoros_rule_stop_summary", {
    p_user_id: w.owner, p_rule_id: w.ruleId, p_limit: 20 });
  assert.notEqual(out.found, false, JSON.stringify(out));
});

sqlTest("stage 11 - STOP an agent's enrollment directly", async () => {
  const w = await teamWorld();
  const out = await rpc("realtoros_stop_enrollment", {
    p_user_id: w.owner, p_enrollment_id: w.enrollmentId, p_reason: "manual" });
  assert.equal(out.outcome, "stopped", JSON.stringify(out));
  const e = await one(db,
    `select status from public.automation_enrollments where id=$1`, [w.enrollmentId]);
  assert.equal(e.status, "stopped");
});

sqlTest("the owner's OWN leads still flow through unchanged", async () => {
  const w = await teamWorld();
  // Same pipeline, but on a lead the owner created themselves.
  const cid = `c-${randomUUID()}`;
  await asService(() => db.query(
    `insert into public.contacts (id,user_id,workspace_id,full_name,email,status)
     values ($1,$2,$3,'Owner Lead',$4,'New Lead')`,
    [cid, w.owner, w.ws, `owner.lead.${cid.slice(2, 10)}@example.com`]));
  const out = await rpc("realtoros_record_contact_stop_event", {
    p_user_id: w.owner, p_contact_id: cid, p_event_type: "reply",
    p_source: "inbound_email", p_event_ref: `ev-${randomUUID()}`,
    p_outbound_message_id: null, p_occurred_at: new Date().toISOString() });
  assert.equal(out.outcome, "recorded", JSON.stringify(out));
});

// ------------------------------------------------- not-found contracts

sqlTest("not_found: stop_enrollment on an id that does not exist says so", async () => {
  const w = await teamWorld();
  const out = await rpc("realtoros_stop_enrollment", {
    p_user_id: w.owner, p_enrollment_id: randomUUID(), p_reason: "manual" });
  assert.equal(out.outcome, "not_found", JSON.stringify(out));
});

sqlTest("not_found: stop_enrollment stays idempotent for an already-stopped enrollment", async () => {
  const w = await teamWorld({ enrollmentStatus: "stopped" });
  const out = await rpc("realtoros_stop_enrollment", {
    p_user_id: w.owner, p_enrollment_id: w.enrollmentId, p_reason: "manual" });
  assert.equal(out.outcome, "stopped",
    "the row exists, so repeat calls still report stopped rather than not_found");
});

sqlTest("not_found: enroll_contact separates a missing rule from an inactive one", async () => {
  const w = await teamWorld();
  const missing = await rpc("realtoros_enroll_contact", {
    p_user_id: w.owner, p_rule_id: randomUUID(), p_contact_id: w.contactId,
    p_trigger_event_id: null, p_trigger_event_key: null });
  assert.equal(missing.outcome, "not_found", JSON.stringify(missing));
  assert.equal(missing.reason, "rule_not_found");

  const paused = await teamWorld({ ruleStatus: "paused" });
  const inactive = await rpc("realtoros_enroll_contact", {
    p_user_id: paused.owner, p_rule_id: paused.ruleId, p_contact_id: paused.contactId,
    p_trigger_event_id: null, p_trigger_event_key: null });
  assert.equal(inactive.outcome, "ineligible", JSON.stringify(inactive));
  assert.equal(inactive.reason, "rule_not_active");
});

sqlTest("not_found: a stop event for a contact that is not in the workspace says so", async () => {
  const w = await teamWorld();
  const out = await rpc("realtoros_record_contact_stop_event", {
    p_user_id: w.owner, p_contact_id: `c-${randomUUID()}`, p_event_type: "reply",
    p_source: "inbound_email", p_event_ref: `ev-${randomUUID()}`,
    p_outbound_message_id: null, p_occurred_at: new Date().toISOString() });
  assert.equal(out.outcome, "contact_not_found", JSON.stringify(out));
});

sqlTest("not_found: a user with no active membership gets a not-found answer, never a silent success", async () => {
  const w = await teamWorld();
  const orphan = randomUUID();
  await db.exec("reset role");
  await db.query(`insert into auth.users (id) values ($1)`, [orphan]);
  await asService(() => db.query(
    `update public.workspace_members set status='removed'
      where user_id=$1 and status='active'`, [orphan]));

  const out = await rpc("realtoros_record_contact_stop_event", {
    p_user_id: orphan, p_contact_id: w.contactId, p_event_type: "reply",
    p_source: "inbound_email", p_event_ref: `ev-${randomUUID()}`,
    p_outbound_message_id: null, p_occurred_at: new Date().toISOString() });
  assert.equal(out.outcome, "contact_not_found", JSON.stringify(out));
  assert.equal(await count(
    `select count(*)::int as n from public.contact_stop_events where contact_id=$1`,
    [w.contactId]), 0, "and nothing was recorded");
});

// ------------------------------------------------- cross-workspace

sqlTest("cross-workspace: a stranger cannot record a stop event on this workspace's lead", async () => {
  const w = await teamWorld();
  const out = await rpc("realtoros_record_contact_stop_event", {
    p_user_id: w.stranger, p_contact_id: w.contactId, p_event_type: "reply",
    p_source: "inbound_email", p_event_ref: `ev-${randomUUID()}`,
    p_outbound_message_id: null, p_occurred_at: new Date().toISOString() });
  assert.equal(out.outcome, "contact_not_found", JSON.stringify(out));
  assert.equal(await count(
    `select count(*)::int as n from public.contact_stop_events where contact_id=$1`,
    [w.contactId]), 0);
});

sqlTest("cross-workspace: a stranger cannot stop or enrol into this workspace", async () => {
  const w = await teamWorld();
  const stopped = await rpc("realtoros_stop_enrollment", {
    p_user_id: w.stranger, p_enrollment_id: w.enrollmentId, p_reason: "manual" });
  assert.equal(stopped.outcome, "not_found", JSON.stringify(stopped));

  const enrolled = await rpc("realtoros_enroll_contact", {
    p_user_id: w.stranger, p_rule_id: w.ruleId, p_contact_id: w.contactId,
    p_trigger_event_id: null, p_trigger_event_key: null });
  assert.equal(enrolled.outcome, "not_found", JSON.stringify(enrolled));

  const e = await one(db,
    `select status from public.automation_enrollments where id=$1`, [w.enrollmentId]);
  assert.equal(e.status, "active", "nothing was changed");
});

sqlTest("cross-workspace: a stranger cannot cancel this workspace's job", async () => {
  const w = await teamWorld();
  const token = randomUUID();
  await asService(() => db.query(
    `update public.automation_jobs set status='processing', lock_token=$1, locked_at=now()
      where id=$2`, [token, w.jobId]));
  const out = await rpc("realtoros_cancel_claimed_job", {
    p_user_id: w.stranger, p_job_id: w.jobId, p_lock_token: token });
  assert.equal(out.outcome, "not_found", JSON.stringify(out));
  const j = await one(db, `select status from public.automation_jobs where id=$1`, [w.jobId]);
  assert.equal(j.status, "processing", "the job is untouched");
});

// ------------------------------------------------- mixed ownership


sqlTest("no function joins two tables on matching CREATOR any more", async () => {
  // Detect creator-based cross-table equality anywhere in SQL functions.
  // One intentional exception exists: unassigned contacts may be targeted
  // by personal automation rules owned by the contact creator.

  const candidates = await db.query(
    `select n.nspname || '.' || p.proname as fn, p.prosrc as src
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'automation_internal')
        and p.prosrc ~ '[a-z]+[.]user_id[[:space:]]*=[[:space:]]*[a-z]+[.]user_id'
      order by 1`
  );

  const unexpected = candidates.rows.filter(({ fn, src }) => {
    if (fn !== "automation_internal.rule_targets_contact") {
      return true;
    }

    // Allow exactly the intentional c.user_id = r.user_id comparison,
    // not any additional creator-based joins in that helper.
    const matches = [
      ...src.matchAll(/[a-z]+\.user_id\s*=\s*[a-z]+\.user_id/gi)
    ];

    return (
      matches.length !== 1 ||
      !/^c\.user_id\s*=\s*r\.user_id$/i.test(matches[0][0])
    );
  });

  assert.deepEqual(
    unexpected.map(({ fn }) => ({ fn })),
    [],
    `these still match on creator: ${JSON.stringify(
      unexpected.map(({ fn }) => ({ fn }))
    )}`
  );

  // Ensure the exception cannot silently turn into a creator-scoped join.
  const helper = await db.query(
    `select pg_get_functiondef(
       'automation_internal.rule_targets_contact(uuid,text)'::regprocedure
     ) as src`
  );

  const source = helper.rows[0].src;

  assert.match(
    source,
    /join\s+public\.contacts\s+c\s+on\s+c\.workspace_id\s*=\s*r\.workspace_id/i,
    "rule_targets_contact must join rules to contacts through workspace_id"
  );

  assert.match(
    source,
    /r\.visibility\s*=\s*'shared'/i,
    "shared rules must remain eligible across their workspace"
  );

  assert.match(
    source,
    /c\.assigned_to_id\s+is\s+null\s+and\s+c\.user_id\s*=\s*r\.user_id/i,
    "the creator check must remain limited to unassigned personal-rule contacts"
  );
});


sqlTest("a reply stops an AGENT's enrollment on the OWNER's rule", async () => {
  // The mixed case the creator-matching join broke: the rule belongs to
  // the owner, the enrollment to the agent. The join used to find no rule,
  // so stop_on_reply was invisible and the enrollment was never stopped.
  const w = await teamWorld();
  const ownerRule = randomUUID();
  const agentEnrollment = randomUUID();
  await asService(async () => {
    await db.query(
      `insert into public.automation_rules
         (id,user_id,workspace_id,name,trigger_type,status,stop_on_reply,stop_on_unsubscribe,runtime_version)
       values ($1,$2,$3,'Owner Rule','manual','active',true,true,gen_random_uuid())`,
      [ownerRule, w.owner, w.ws]);
    // Enrolled BY THE AGENT onto the OWNER's rule.
    await db.query(
      `insert into public.automation_enrollments (id,user_id,workspace_id,rule_id,contact_id,status)
       values ($1,$2,$3,$4,$5,'active')`,
      [agentEnrollment, w.agent, w.ws, ownerRule, w.contactId]);
  });

  const out = await stopEvent(w, "reply", "inbound_email");
  assert.equal(out.outcome, "recorded", JSON.stringify(out));

  const e = await one(db,
    `select status, stop_reason from public.automation_enrollments where id=$1`,
    [agentEnrollment]);
  assert.equal(e.status, "stopped",
    "the owner's rule has stop_on_reply, so the agent's enrollment must stop");
  assert.equal(e.stop_reason, "reply");

  // And it was counted, not silently skipped.
  assert.ok(Number(out.enrollments_stopped) >= 2,
    `both enrollments stopped: ${JSON.stringify(out)}`);
});

sqlTest("open_enrollments_for_contact sees a cross-created enrollment", async () => {
  const w = await teamWorld();
  const ownerRule = randomUUID();
  const agentEnrollment = randomUUID();
  await asService(async () => {
    await db.query(
      `insert into public.automation_rules
         (id,user_id,workspace_id,name,trigger_type,status,stop_on_reply,stop_on_unsubscribe,runtime_version)
       values ($1,$2,$3,'Owner Rule','manual','active',true,false,gen_random_uuid())`,
      [ownerRule, w.owner, w.ws]);
    await db.query(
      `insert into public.automation_enrollments (id,user_id,workspace_id,rule_id,contact_id,status)
       values ($1,$2,$3,$4,$5,'active')`,
      [agentEnrollment, w.agent, w.ws, ownerRule, w.contactId]);
  });
  const rows = await asService(() => db.query(
    `select enrollment_id, stop_on_reply, stop_on_unsubscribe
       from public.realtoros_open_enrollments_for_contact($1,$2)
      order by enrollment_id`, [w.owner, w.contactId]));
  const ids = rows.rows.map((r) => r.enrollment_id);
  assert.ok(ids.includes(agentEnrollment),
    "the agent's enrollment on the owner's rule is listed");
  const mixed = rows.rows.find((r) => r.enrollment_id === agentEnrollment);
  assert.equal(mixed.stop_on_reply, true, "and its rule's flags are readable");
  assert.equal(mixed.stop_on_unsubscribe, false);
});

// ------------------------------------------------- the worker sweepers

sqlTest("the worker CLAIMS a job whose rule and enrollment belong to a teammate", async () => {
  // The most damaging form of the creator-join bug: claim_due_jobs joined
  // jobs to their rule and enrollment by creator, so an agent's job on the
  // owner's rule was never claimed at all. Not stopped, not failed - it
  // simply never ran, with no error anywhere.
  const w = await teamWorld();
  const ownerRule = randomUUID();
  const ownerEnrollment = randomUUID();
  const agentJob = randomUUID();
  await asService(async () => {
    await db.query(
      `insert into public.automation_rules
         (id,user_id,workspace_id,name,trigger_type,status,stop_on_reply,stop_on_unsubscribe,runtime_version)
       values ($1,$2,$3,'Owner Rule','manual','active',true,true,gen_random_uuid())`,
      [ownerRule, w.owner, w.ws]);
    await db.query(
      `insert into public.automation_enrollments (id,user_id,workspace_id,rule_id,contact_id,status)
       values ($1,$2,$3,$4,$5,'active')`,
      [ownerEnrollment, w.owner, w.ws, ownerRule, w.contactId]);
    // The JOB is the agent's, on the owner's rule and enrollment.
    await db.query(
      `insert into public.automation_jobs
         (id,user_id,workspace_id,enrollment_id,rule_id,contact_id,job_type,status,
          scheduled_at,idempotency_key,payload)
       values ($1,$2,$3,$4,$5,$6,'send_email','pending',now() - interval '1 minute',$7,$8)`,
      [agentJob, w.agent, w.ws, ownerEnrollment, ownerRule, w.contactId,
       `k-${agentJob}`, JSON.stringify({ step_order: 1, action_type: "send_email" })]);
  });

  const claimed = await asService(() => db.query(
    `select id from public.realtoros_claim_due_jobs(10)`));
  assert.ok(claimed.rows.some((r) => r.id === agentJob),
    "the agent's job on the owner's rule was claimed");

  // And the run record it must have alongside it.
  assert.equal(await count(
    `select count(*)::int as n from public.automation_runs
      where job_id=$1 and status='processing' and workspace_id=$2`, [agentJob, w.ws]), 1,
    "with exactly one processing run, carrying the workspace");
});

sqlTest("stale-lease recovery reaches a cross-created job", async () => {
  const w = await teamWorld();
  const ownerEnrollment = randomUUID();
  const agentJob = randomUUID();
  await asService(async () => {
    await db.query(
      `insert into public.automation_enrollments (id,user_id,workspace_id,rule_id,contact_id,status)
       values ($1,$2,$3,$4,$5,'active')`,
      [ownerEnrollment, w.owner, w.ws, w.ruleId, w.contactId]);
    await db.query(
      `insert into public.automation_jobs
         (id,user_id,workspace_id,enrollment_id,rule_id,contact_id,job_type,status,
          locked_at,locked_by,lock_token,attempts,idempotency_key,payload)
       values ($1,$2,$3,$4,$5,$6,'send_email','processing',
               now() - interval '2 hours','w',gen_random_uuid(),1,$7,$8)`,
      [agentJob, w.agent, w.ws, ownerEnrollment, w.ruleId, w.contactId,
       `k-${agentJob}`, JSON.stringify({ step_order: 1, action_type: "send_email" })]);
    await db.query(
      `insert into public.automation_runs
         (id,user_id,workspace_id,job_id,enrollment_id,attempt_number,status,started_at)
       values (gen_random_uuid(),$1,$2,$3,$4,1,'processing',now() - interval '2 hours')`,
      [w.owner, w.ws, agentJob, ownerEnrollment]);
  });

  const out = await asService(() => db.query(
    `select public.realtoros_recover_stale_automation_leases(60) as out`));
  assert.ok(Number(out.rows[0].out.recovered_jobs) >= 1, JSON.stringify(out.rows[0].out));

  const j = await one(db, `select status from public.automation_jobs where id=$1`, [agentJob]);
  assert.equal(j.status, "pending", "the job is released for another attempt");
  const r = await one(db,
    `select status, error_message from public.automation_runs where job_id=$1`, [agentJob]);
  assert.equal(r.status, "failed", "and its run is closed off");
  assert.equal(r.error_message, "stale_lease_recovered");
});
