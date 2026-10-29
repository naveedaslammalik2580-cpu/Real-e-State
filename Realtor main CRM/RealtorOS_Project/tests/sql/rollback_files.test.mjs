// The revert files in supabase/rollback/ are the safety net for the two
// phases that changed live behaviour irreversibly-looking. A revert file
// nobody has executed is a guess, so these tests execute them against the
// real migration chain in PGlite and prove they land exactly on the state
// the phase started from.
//
// Compared by md5(pg_proc.prosrc) per function and by index/constraint
// inventory - not by eyeballing the SQL.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migratedDb as openMigratedDb, one, SKIP_MESSAGE } from "../helpers/pg.mjs";

// Each test here opens one or two databases of its own, because a revert
// has to be proven against the state its phase started from. An open
// PGlite instance keeps node's event loop alive, so they are tracked and
// closed at the end - otherwise this file's process never exits after the
// last assertion. Wrapped under the original name so every call site
// below is unchanged.
const opened = [];
const migratedDb = async (...args) => {
  const db = await openMigratedDb(...args);
  if (db) opened.push(db);
  return db;
};

afterEach(async () => {
  const databases = opened.splice(0);

  for (const db of databases) {
    if (!db.closed) {
      await db.close();
    }

    assert.equal(
      db.closed,
      true,
      "PGlite database must be closed after each test"
    );
  }
});

const here = path.dirname(fileURLToPath(import.meta.url));
const ROLLBACK = path.join(here, "..", "..", "supabase", "rollback");
const T2C = "20261006132041_phase_t2c_workspace_backend.sql";
const T2C_PRE = "20261006125509_phase_t2c_pre_workspace_fks.sql";
const T2C_POST = "20261007033030_phase_t2c_post_workspace_rpcs.sql";
const T4 = "20261013120000_phase_t4_followups.sql";
const P2A = "20261015120000_phase_2a_time_based_triggers.sql";
const P2C = "20261015130000_phase_2c_response_tracking.sql";
const P2D = "20261015140000_phase_2d_past_clients.sql";
const P2E = "20261015150000_phase_2e_audience_tags.sql";
const P2F = "20261015160000_phase_2f_audience_type_temp.sql";
const P3B = "20261015170000_phase_3b_push.sql";
const T2A = "20261001160608_phase_t2a_workspace_foundation.sql";
const T2B1 = "20261005140817_phase_t2b1_permissions.sql";
const T2D = "20261007041926_phase_t2d_workspace_settings_singleton.sql";
const T3 = "20261007130000_phase_t3_invitations_membership.sql";

// ---------------------------------------------------------------- coverage
//
// Every migration from T2a onward must have a revert file, and this is
// where that is enforced rather than remembered. The map is explicit
// because the names do not transform: t2c_revert.sql reverts
// phase_t2c_workspace_backend, and nothing in either name says so.
//
// PRE-ROLLBACK ERA. Everything before T2a shipped before this project
// had a rollback discipline, and several of them are not revertible in
// any useful sense - 20260829050743 is the relational migration itself,
// and "reverting" it would mean deleting the schema the product is. They
// are listed here so that the list is a decision rather than an
// oversight, and so a NEW migration can never quietly join them.
const PRE_ROLLBACK_ERA = new Set([
  "20260827040054_create_realtoros_workspace_state.sql",
  "20260828072525_add_realtoros_avatar_storage.sql",
  "20260829050743_migrate_realtoros_to_relational.sql",
  "20260829074753_harden_realtoros_trigger_function.sql",
  "20260829074854_index_realtoros_relationships.sql",
  "20260829082546_realtoros_deal_and_followup_rpcs.sql",
  "20260829120654_fix_composite_fk_set_null.sql",
  "20260831091706_add_realtoros_automation_foundation.sql",
  "20260831091901_index_automation_foreign_keys.sql",
  "20260831093216_add_atomic_sheet_lead_ingestion.sql",
  "20260831114425_remove_sample_data_feature.sql",
  "20260904020906_phase_4c_email_delivery_foundation.sql",
  "20260904020954_phase_4c_email_delivery_reliability.sql",
  "20260904021204_phase_4d_automation_execution.sql",
  "20260904021416_phase_4d_automation_execution_reliability.sql",
  "20260904060217_phase_4e_reply_unsubscribe_stop_logic.sql",
  "20260929041708_phase_4e_2_stop_logic_completion.sql",
  "20260929051621_phase_4e_3_unsubscribe_by_reply.sql",
  "20260929095530_phase_4e_4_file_lead_import.sql",
  "20260929150944_phase_4h_in_app_notifications.sql",
]);

// migration file -> the revert file that undoes it.
const REVERT_FOR = {
  "20261001160608_phase_t2a_workspace_foundation.sql": "t2a_workspace_foundation_revert.sql",
  "20261005140817_phase_t2b1_permissions.sql": "t2b1_permissions_revert.sql",
  "20261006033532_phase_t2b2_workspace_rls.sql": "t2b2_revert_to_user_id_policies.sql",
  "20261006125509_phase_t2c_pre_workspace_fks.sql": "t2c_pre_revert_fks.sql",
  "20261006132041_phase_t2c_workspace_backend.sql": "t2c_revert.sql",
  "20261007033030_phase_t2c_post_workspace_rpcs.sql": "t2c_post_revert.sql",
  "20261007041926_phase_t2d_workspace_settings_singleton.sql": "t2d_settings_singleton_revert.sql",
  "20261007130000_phase_t3_invitations_membership.sql": "t3_invitations_membership_revert.sql",
  "20261013120000_phase_t4_followups.sql": "t4_followups_revert.sql",
  "20261014120000_sheet_import_matches_manual_contacts.sql": "sheet_import_manual_match_revert.sql",
  "20261015120000_phase_2a_time_based_triggers.sql": "phase_2a_time_based_triggers_revert.sql",
  "20261015130000_phase_2c_response_tracking.sql": "phase_2c_response_tracking_revert.sql",
  "20261015140000_phase_2d_past_clients.sql": "phase_2d_past_clients_revert.sql",
  "20261015150000_phase_2e_audience_tags.sql": "phase_2e_audience_tags_revert.sql",
  "20261015160000_phase_2f_audience_type_temp.sql": "phase_2f_audience_type_temp_revert.sql",
  "20261015170000_phase_3b_push.sql": "phase_3b_push_revert.sql",
  "20261029120000_phase_c1_deterministic_workspace_selection.sql": "phase_c1_deterministic_workspace_selection_revert.sql",
};

// Runs without a database: it reads two directories.
test("every migration from T2a onward has a revert file", () => {
  const MIGRATIONS = path.join(here, "..", "..", "supabase", "migrations");
  // APPLY_*.sql are SQL-Editor wrappers around real migrations, not
  // migrations themselves (same exclusion as tests/helpers/pg.mjs): each
  // wrapper's payload is its timestamped counterpart, which IS mapped in
  // REVERT_FOR below, so rollback coverage is still enforced for them.
  const migrations = fs.readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql") && !f.startsWith("APPLY_"))
    .sort();
  assert.ok(migrations.length >= 36, "found " + migrations.length + " migrations");

  const missing = [];
  const unknown = [];
  for (const m of migrations) {
    if (PRE_ROLLBACK_ERA.has(m)) continue;
    const revert = REVERT_FOR[m];
    if (!revert) { unknown.push(m); continue; }
    if (!fs.existsSync(path.join(ROLLBACK, revert))) missing.push(m + " -> " + revert);
  }

  assert.deepEqual(unknown, [],
    "a migration was added with no revert file and no entry in REVERT_FOR. Write "
    + "supabase/rollback/<phase>_revert.sql and map it here; the pre-rollback-era "
    + "allowlist is closed to new migrations: " + JSON.stringify(unknown));
  assert.deepEqual(missing, [], "mapped revert files that do not exist: " + JSON.stringify(missing));

  // And the other way: a revert file nobody claims is either a typo or a
  // file somebody forgot to map.
  const claimed = new Set(Object.values(REVERT_FOR));
  const orphans = fs.readdirSync(ROLLBACK)
    .filter((f) => f.endsWith(".sql") && !claimed.has(f));
  assert.deepEqual(orphans, [], "revert files mapped to no migration: " + JSON.stringify(orphans));

  // The allowlist must stay a list of things that really exist, so a
  // renamed old migration cannot hide behind it.
  const gone = [...PRE_ROLLBACK_ERA].filter((f) => !migrations.includes(f));
  assert.deepEqual(gone, [], "the pre-rollback-era list names migrations that are not there: "
    + JSON.stringify(gone));
});

// Reverts unwind in REVERSE chain order. T2c-post came after T2c and also
// replaces functions, so undoing T2c on its own cannot reach the state
// before T2c - T2c-post has to come off first. Each file is still proven
// on its own against the state its own phase started from.
const revert = (db, name) =>
  db.exec(fs.readFileSync(path.join(ROLLBACK, name), "utf8"));

// The starting point for every revert check is the chain AS IT STOOD when
// these three phases were the newest - not the whole chain as it is today.
//
// A revert file undoes its own phase and nothing else, so comparing
// against a database that also contains LATER migrations fails on those
// later changes, which is not a defect in the revert. T2d is the first
// phase to prove the point: it adds workspace_settings_workspace_id_uq
// and drops two per-user indexes, none of which the T2c reverts touch or
// should touch.
//
// Anchoring here instead of at the tip means adding a migration never
// breaks these tests again. When a LATER phase gets its own revert file,
// it gets its own anchor.
const atPhaseEnd = () => migratedDb((f) => f <= T2C_POST);

let ok = false;
before(async () => { ok = Boolean(await migratedDb()); });

function sqlTest(name, fn) {
  test(name, async (t) => {
    if (!ok) return t.skip(SKIP_MESSAGE);
    await fn();
  });
}

const FN_SQL = `
  select n.nspname || '.' || p.proname as fn, md5(p.prosrc) as body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'automation_internal')
   order by 1, 2`;

const IDX_SQL = `
  select indexname, indexdef from pg_indexes
   where schemaname = 'public' order by indexname`;

// Phase 2C adds a column, which no other snapshot here would notice.
const COL_SQL = `
  select table_name, column_name from information_schema.columns
   where table_schema = 'public' order by 1, 2`;

const FK_SQL = `
  select c.conname, c.conrelid::regclass::text as tbl, pg_get_constraintdef(c.oid) as def
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace
   where c.contype = 'f' and n.nspname = 'public' order by 1`;

// T4's second half is a trigger, which FN_SQL cannot see.
const TRG_SQL = `
  select c.relname as tbl, t.tgname, pg_get_triggerdef(t.oid) as def
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal
   order by 1, 2`;

const snap = async (db, sql) => (await db.query(sql)).rows;

// ---------------------------------------------------------------- T2c

sqlTest("t2c_post_revert.sql reproduces the pre-T2c-post state exactly", async () => {
  const beforePost = await migratedDb((f) => f < T2C_POST);
  const full = await atPhaseEnd();
  assert.ok(beforePost && full);

  const fnPre = await snap(beforePost, FN_SQL);
  assert.notDeepEqual(await snap(full, FN_SQL), fnPre,
    "T2c-post must actually change something");

  await revert(full, "t2c_post_revert.sql");
  assert.deepEqual(await snap(full, FN_SQL), fnPre,
    "function bodies after the revert must match the pre-T2c-post chain");
});

sqlTest("t2c_post_revert then t2c_revert reproduces the pre-T2c state exactly", async () => {
  const before2c = await migratedDb((f) => f < T2C);
  const full = await atPhaseEnd();
  assert.ok(before2c && full);

  const fnPre = await snap(before2c, FN_SQL);
  assert.notDeepEqual(await snap(full, FN_SQL), fnPre,
    "T2c must actually change something");

  // Reverse order: the later phase comes off first.
  await revert(full, "t2c_post_revert.sql");
  await revert(full, "t2c_revert.sql");

  assert.deepEqual(await snap(full, FN_SQL), fnPre,
    "function bodies after both reverts must match the pre-T2c chain");
  assert.deepEqual(await snap(full, IDX_SQL), await snap(before2c, IDX_SQL),
    "indexes too");
});

sqlTest("the T2c reverts leave T2c-pre's foreign keys alone", async () => {
  const full = await atPhaseEnd();
  const fksBefore = await snap(full, FK_SQL);
  await revert(full, "t2c_post_revert.sql");
  await revert(full, "t2c_revert.sql");
  assert.deepEqual(await snap(full, FK_SQL), fksBefore,
    "reverting T2c must not touch the T2c-pre conversion");
  // And they are still workspace-scoped.
  const userScoped = (await full.query(
    `select count(*)::int as n from pg_constraint c
       join pg_namespace n on n.oid = c.connamespace
      where c.contype='f' and n.nspname='public' and array_length(c.conkey,1)=2
        and (select a.attname from pg_attribute a
              where a.attrelid=c.conrelid and a.attnum=c.conkey[1]) = 'user_id'`)).rows[0].n;
  assert.equal(Number(userScoped), 0);
});

sqlTest("the T2c reverts touch no data", async () => {
  const full = await atPhaseEnd();
  const counts = async (db) => (await db.query(
    `select (select count(*) from public.contacts) as contacts,
            (select count(*) from public.notifications) as notifs,
            (select count(*) from public.lead_import_rows) as rows,
            (select count(*) from public.workspaces) as workspaces`)).rows[0];
  const before = await counts(full);
  await revert(full, "t2c_post_revert.sql");
  await revert(full, "t2c_revert.sql");
  assert.deepEqual(await counts(full), before);
});

// ---------------------------------------------------------------- T2c-pre

sqlTest("t2c_pre_revert_fks.sql puts all 56 composite FKs back on user_id", async () => {
  const beforePre = await migratedDb((f) => f < T2C_PRE);
  const full = await atPhaseEnd();
  assert.ok(beforePre && full);

  // Unwind the whole stack in reverse order to get back to the state
  // before T2c-pre.
  await revert(full, "t2c_post_revert.sql");
  await revert(full, "t2c_revert.sql");
  await revert(full, "t2c_pre_revert_fks.sql");

  assert.deepEqual(await snap(full, FK_SQL), await snap(beforePre, FK_SQL),
    "every foreign key must match the pre-T2c-pre chain, name and definition");
});

sqlTest("after both reverts, an admin can no longer touch the owner's contact", async () => {
  // The whole point of T2c-pre, demonstrated in reverse: with the old FKs
  // back, the write that T2c-pre enabled fails again. If this ever stops
  // failing, the revert did not really revert.
  const full = await atPhaseEnd();
  await revert(full, "t2c_post_revert.sql");
  await revert(full, "t2c_revert.sql");
  await revert(full, "t2c_pre_revert_fks.sql");

  const { randomUUID } = await import("node:crypto");
  await full.exec("set role service_role");
  const owner = randomUUID();
  const other = randomUUID();
  await full.exec("reset role");
  await full.query(`insert into auth.users (id) values ($1), ($2)`, [owner, other]);
  await full.exec("set role service_role");
  await full.query(`select automation_internal.ensure_personal_workspace($1)`, [owner]);
  const ws = (await full.query(
    `select workspace_id from public.workspace_members
      where user_id=$1 and status='active'`, [owner])).rows[0].workspace_id;
  const cid = `c-${randomUUID().slice(0, 8)}`;
  await full.query(
    `insert into public.contacts (id,user_id,workspace_id,full_name)
     values ($1,$2,$3,'Owner Lead')`, [cid, owner, ws]);

  await assert.rejects(
    full.query(
      `insert into public.tasks (id,user_id,workspace_id,contact_id,title)
       values ($1,$2,$3,$4,'Should fail')`,
      [`t-${randomUUID().slice(0, 8)}`, other, ws, cid]),
    /violates foreign key constraint/,
    "the user-scoped FK is back, so a non-creator cannot reference the contact");
  await full.exec("reset role");
});

// ---------------------------------------------------------------- T4

// T4's own anchor, per the note above: the chain through T4, not the tip.
// A later migration (20261014120000 redefines ingest_lead_rows) touches
// neither list_members nor the team-mode guard, so this stays correct as
// the chain grows.
const atT4 = () => migratedDb((f) => f <= T4);
const beforeT4 = () => migratedDb((f) => f < T4);

sqlTest("t4_followups_revert.sql reproduces the pre-T4 state exactly", async () => {
  const pre = await beforeT4();
  const full = await atT4();
  assert.ok(pre && full);

  const fnPre = await snap(pre, FN_SQL);
  const trgPre = await snap(pre, TRG_SQL);

  // T4 must actually change something, in both halves, or this test is
  // proving nothing.
  assert.notDeepEqual(await snap(full, FN_SQL), fnPre,
    "T4 must actually change a function body");
  assert.notDeepEqual(await snap(full, TRG_SQL), trgPre,
    "T4 must actually add a trigger");

  await revert(full, "t4_followups_revert.sql");

  assert.deepEqual(await snap(full, FN_SQL), fnPre,
    "function bodies after the revert must match the pre-T4 chain");
  assert.deepEqual(await snap(full, TRG_SQL), trgPre,
    "triggers after the revert must match the pre-T4 chain");
  assert.deepEqual(await snap(full, IDX_SQL), await snap(pre, IDX_SQL),
    "T4 touched no index, so the revert must not either");
  assert.deepEqual(await snap(full, FK_SQL), await snap(pre, FK_SQL),
    "T4 touched no foreign key, so the revert must not either");
});

sqlTest("the T4 revert puts back T3's grants and comment, not just the body", async () => {
  const pre = await beforeT4();
  const full = await atT4();
  assert.ok(pre && full);

  const meta = async (db) => (await db.query(
    `select pg_get_function_identity_arguments(p.oid) as args,
            p.proacl::text as acl,
            obj_description(p.oid, 'pg_proc') as comment
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'realtoros_list_members'`)).rows[0];

  const before = await meta(pre);
  await revert(full, "t4_followups_revert.sql");
  const after = await meta(full);

  assert.deepEqual(after, before,
    "signature, ACL and comment must all match the pre-T4 chain");
  assert.match(String(after.comment), /^Phase T3\./,
    "the comment must be T3's again");
});

sqlTest("T4 re-applies cleanly after its own revert", async () => {
  const full = await atT4();
  assert.ok(full);
  const atT4Fns = await snap(full, FN_SQL);
  const atT4Trgs = await snap(full, TRG_SQL);

  await revert(full, "t4_followups_revert.sql");
  // The migration is idempotent by design, so re-running it must both
  // succeed and land back on exactly the T4 state.
  await full.exec(fs.readFileSync(path.join(here, "..", "..", "supabase", "migrations", T4), "utf8"));

  assert.deepEqual(await snap(full, FN_SQL), atT4Fns,
    "re-applying T4 must restore the T4 function bodies");
  assert.deepEqual(await snap(full, TRG_SQL), atT4Trgs,
    "re-applying T4 must restore the guard trigger");
});

sqlTest("after the T4 revert, team mode can be switched off under a team again", async () => {
  // The point of T4's second half, demonstrated in reverse: the UPDATE
  // the guard refuses must succeed once the guard is gone.
  const full = await atT4();
  assert.ok(full);
  await revert(full, "t4_followups_revert.sql");

  const { randomUUID } = await import("node:crypto");
  const owner = randomUUID();
  const other = randomUUID();
  // T2b2's realtoros_provision_workspace trigger gives every new auth user
  // their own workspace and one active membership, and
  // workspace_members_one_active_per_user allows only that one. So the
  // second person is MOVED into the owner's workspace rather than added to
  // it - the end state is what the guard counted either way.
  await full.query(`insert into auth.users (id) values ($1), ($2)`, [owner, other]);
  await full.exec("set role service_role");
  const ws = (await full.query(
    `select workspace_id from public.workspace_members
      where user_id = $1 and status = 'active'`, [owner])).rows[0].workspace_id;
  // team_member_id is cleared with the move: the composite FK
  // (workspace_id, team_member_id) -> team_members would otherwise point
  // at a directory row still in the person's old workspace. It is
  // nullable, the FK ignores nulls, and the guard counts workspace_members
  // rows only.
  await full.query(
    `update public.workspace_members
        set workspace_id = $1, role = 'agent', team_member_id = null
      where user_id = $2 and status = 'active'`, [ws, other]);
  const others = (await full.query(
    `select count(*)::int as n from public.workspace_members
      where workspace_id = $1 and status = 'active' and user_id <> $2`,
    [ws, owner])).rows[0].n;
  assert.equal(Number(others), 1, "the workspace must really have a second member");
  await full.query(
    `insert into public.workspace_settings (id, user_id, workspace_id, settings_data)
     values ($1, $2, $3, '{"teamMode": true}'::jsonb)`,
    ['ws_' + randomUUID().slice(0, 8), owner, ws]);

  await full.query(
    `update public.workspace_settings
        set settings_data = '{"teamMode": false}'::jsonb
      where workspace_id = $1`, [ws]);

  const after = (await full.query(
    `select settings_data -> 'teamMode' as flag from public.workspace_settings
      where workspace_id = $1`, [ws])).rows[0].flag;
  assert.equal(String(after), "false",
    "with the guard reverted, the switch-off must go through");
  await full.exec("reset role");
});

// ---------------------------------------------------------------- Phase 2A

const atP2A = () => migratedDb((f) => f <= P2A);
const beforeP2A = () => migratedDb((f) => f < P2A);

sqlTest("phase_2a_time_based_triggers_revert.sql reproduces the pre-2A state exactly", async () => {
  const pre = await beforeP2A();
  const full = await atP2A();
  assert.ok(pre && full);

  const fnPre = await snap(pre, FN_SQL);
  const idxPre = await snap(pre, IDX_SQL);
  const trgPre = await snap(pre, TRG_SQL);

  // 2A must really change all three kinds of thing, or this proves nothing.
  assert.notDeepEqual(await snap(full, FN_SQL), fnPre, "2A must add functions");
  assert.notDeepEqual(await snap(full, IDX_SQL), idxPre, "2A must add indexes");
  assert.notDeepEqual(await snap(full, TRG_SQL), trgPre, "2A must add triggers");

  await revert(full, "phase_2a_time_based_triggers_revert.sql");

  assert.deepEqual(await snap(full, FN_SQL), fnPre,
    "function bodies after the revert must match the pre-2A chain");
  assert.deepEqual(await snap(full, IDX_SQL), idxPre, "indexes too");
  assert.deepEqual(await snap(full, TRG_SQL), trgPre, "triggers too");
  assert.deepEqual(await snap(full, FK_SQL), await snap(pre, FK_SQL), "and foreign keys");
});

sqlTest("the 2A revert removes its columns and narrows both CHECKs back", async () => {
  const full = await atP2A();
  assert.ok(full);
  await revert(full, "phase_2a_time_based_triggers_revert.sql");

  const cols = (await full.query(
    `select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and ((table_name = 'automation_rules' and column_name = 'trigger_config')
          or (table_name = 'automation_trigger_events' and column_name in ('rule_id','event_key'))
          or (table_name = 'contacts' and column_name = 'status_changed_at'))`)).rows;
  assert.deepEqual(cols, [], "every 2A column is gone");

  const checks = (await full.query(
    `select conname, pg_get_constraintdef(c.oid) d from pg_constraint c
      where conname in ('automation_rules_trigger_type_check',
                        'automation_trigger_events_event_type_check')`)).rows;
  assert.equal(checks.length, 2);
  for (const ck of checks) {
    assert.ok(!/follow_up_due|no_contact|status_stale|deal_stage_changed/.test(ck.d),
      ck.conname + " still mentions a 2A trigger type");
  }
});

sqlTest("the 2A revert archives a rule that used a 2A trigger rather than deleting it", async () => {
  const full = await atP2A();
  assert.ok(full);
  const { randomUUID } = await import("node:crypto");
  const uid = randomUUID();
  await full.query(`insert into auth.users (id) values ($1)`, [uid]);
  await full.exec("set role service_role");
  const ws = (await full.query(
    `select workspace_id from public.workspace_members
      where user_id = $1 and status = 'active'`, [uid])).rows[0].workspace_id;
  const ruleId = randomUUID();
  await full.query(
    `insert into public.automation_rules
       (id, user_id, workspace_id, name, trigger_type, trigger_config, status, activated_at)
     values ($1,$2,$3,'Silent 30','no_contact','{"days":30}'::jsonb,'active',now())`,
    [ruleId, uid, ws]);
  await full.exec("reset role");

  await revert(full, "phase_2a_time_based_triggers_revert.sql");

  const row = (await full.query(
    `select status, trigger_type, metadata from public.automation_rules where id = $1`,
    [ruleId])).rows[0];
  assert.ok(row, "the rule still exists - its history is not thrown away");
  assert.equal(row.status, "archived");
  assert.equal(row.trigger_type, "manual", "rewritten to a type the restored CHECK allows");
  assert.equal(row.metadata.phase_2a_reverted_from_trigger_type, "no_contact",
    "and what it used to be is recorded");
});

sqlTest("Phase 2A re-applies cleanly after its own revert", async () => {
  const full = await atP2A();
  assert.ok(full);
  const fns = await snap(full, FN_SQL);
  const trgs = await snap(full, TRG_SQL);

  await revert(full, "phase_2a_time_based_triggers_revert.sql");
  await full.exec(fs.readFileSync(path.join(here, "..", "..", "supabase", "migrations", P2A), "utf8"));

  assert.deepEqual(await snap(full, FN_SQL), fns, "re-applying 2A restores its functions");
  assert.deepEqual(await snap(full, TRG_SQL), trgs, "and its triggers");
});

// ---------------------------------------------------------------- Phase 2C

const atP2C = () => migratedDb((f) => f <= P2C);
const beforeP2C = () => migratedDb((f) => f < P2C);

sqlTest("phase_2c_response_tracking_revert.sql reproduces the pre-2C state exactly", async () => {
  const pre = await beforeP2C();
  const full = await atP2C();
  assert.ok(pre && full);

  const fnPre = await snap(pre, FN_SQL);
  const colPre = await snap(pre, COL_SQL);
  const trgPre = await snap(pre, TRG_SQL);

  assert.notDeepEqual(await snap(full, FN_SQL), fnPre, "2C must add functions");
  assert.notDeepEqual(await snap(full, COL_SQL), colPre, "2C must add a column");
  assert.notDeepEqual(await snap(full, TRG_SQL), trgPre, "2C must add triggers");

  await revert(full, "phase_2c_response_tracking_revert.sql");

  assert.deepEqual(await snap(full, FN_SQL), fnPre,
    "function bodies after the revert must match the pre-2C chain");
  assert.deepEqual(await snap(full, COL_SQL), colPre, "columns too");
  assert.deepEqual(await snap(full, TRG_SQL), trgPre, "triggers too");
  assert.deepEqual(await snap(full, IDX_SQL), await snap(pre, IDX_SQL), "and indexes");
});

sqlTest("the 2C revert puts the detector back to carrying its own visibility clause", async () => {
  const full = await atP2C();
  assert.ok(full);
  // While 2C is applied, the detector delegates to the shared helper.
  const before = await one(full,
    `select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'realtoros_scan_time_triggers'`);
  assert.match(before.prosrc, /rule_targets_contact/);

  await revert(full, "phase_2c_response_tracking_revert.sql");

  const after = await one(full,
    `select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'realtoros_scan_time_triggers'`);
  assert.ok(!/rule_targets_contact/.test(after.prosrc),
    "the detector must not reference a helper that no longer exists");
  assert.match(after.prosrc, /v_owner_tm/, "it carries the 2A clause again");

  const helper = await full.query(
    `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'automation_internal' and p.proname = 'rule_targets_contact'`);
  assert.equal(helper.rows.length, 0, "and the helper is gone");
});

sqlTest("the 2C revert deletes its own notifications and narrows the type check back", async () => {
  const full = await atP2C();
  assert.ok(full);
  const { randomUUID } = await import("node:crypto");
  const uid = randomUUID();
  await full.query(`insert into auth.users (id) values ($1)`, [uid]);
  await full.exec("set role service_role");
  // One notification of each kind: a 2C one that must go, and an older one
  // that must survive untouched.
  for (const [type, key] of [["contact_untouched", "untouched:x:l1"], ["lead_replied", "stop:y"]]) {
    await full.query(
      `insert into public.notifications (user_id, type, title, body, dedupe_key)
       values ($1, $2, 'A title', 'A body', $3)`, [uid, type, key]);
  }
  await full.exec("reset role");

  await revert(full, "phase_2c_response_tracking_revert.sql");

  const left = (await full.query(
    `select type from public.notifications where user_id = $1 order by type`, [uid])).rows;
  assert.deepEqual(left.map((r) => r.type), ["lead_replied"],
    "the 2C nudge is deleted, the older record is kept");

  const check = await one(full,
    `select pg_get_constraintdef(oid) d from pg_constraint
      where conrelid = 'public.notifications'::regclass
        and conname = 'notifications_type_check'`);
  assert.ok(!/contact_untouched|overdue_followups/.test(check.d));
  assert.match(check.d, /lead_replied/);
});

sqlTest("Phase 2C re-applies cleanly after its own revert", async () => {
  const full = await atP2C();
  assert.ok(full);
  const fns = await snap(full, FN_SQL);
  const trgs = await snap(full, TRG_SQL);

  await revert(full, "phase_2c_response_tracking_revert.sql");
  await full.exec(fs.readFileSync(path.join(here, "..", "..", "supabase", "migrations", P2C), "utf8"));

  assert.deepEqual(await snap(full, FN_SQL), fns, "re-applying 2C restores its functions");
  assert.deepEqual(await snap(full, TRG_SQL), trgs, "and its triggers");
});

// ---------------------------------------------------------------- Phase 2D

const atP2D = () => migratedDb((f) => f <= P2D);
const beforeP2D = () => migratedDb((f) => f < P2D);

sqlTest("phase_2d_past_clients_revert.sql reproduces the pre-2D state exactly", async () => {
  const pre = await beforeP2D();
  const full = await atP2D();
  assert.ok(pre && full);

  const fnPre = await snap(pre, FN_SQL);
  const colPre = await snap(pre, COL_SQL);
  const trgPre = await snap(pre, TRG_SQL);

  assert.notDeepEqual(await snap(full, FN_SQL), fnPre, "2D must add functions");
  assert.notDeepEqual(await snap(full, COL_SQL), colPre, "2D must add columns");
  assert.notDeepEqual(await snap(full, TRG_SQL), trgPre, "2D must add triggers");

  await revert(full, "phase_2d_past_clients_revert.sql");

  assert.deepEqual(await snap(full, FN_SQL), fnPre,
    "function bodies after the revert must match the pre-2D chain");
  assert.deepEqual(await snap(full, COL_SQL), colPre, "columns too");
  assert.deepEqual(await snap(full, TRG_SQL), trgPre, "triggers too");
  assert.deepEqual(await snap(full, IDX_SQL), await snap(pre, IDX_SQL), "and indexes");
});

sqlTest("the 2D revert puts the summary back to reading today in UTC", async () => {
  const full = await atP2D();
  assert.ok(full);
  const src = async () => (await one(full,
    `select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'realtoros_scan_follow_up_reminders'`)).prosrc;
  assert.match(await src(), /workspace_timezone/, "2D reads the workspace zone");

  await revert(full, "phase_2d_past_clients_revert.sql");

  const after = await src();
  assert.ok(!/workspace_timezone/.test(after),
    "and must not reference a helper that no longer exists");
  assert.match(after, /at time zone 'UTC'/, "it is back to UTC - the defect 2D fixed");
});

sqlTest("the 2D revert archives a yearly rule rather than deleting it", async () => {
  const full = await atP2D();
  assert.ok(full);
  const { randomUUID } = await import("node:crypto");
  const uid = randomUUID();
  await full.query(`insert into auth.users (id) values ($1)`, [uid]);
  await full.exec("set role service_role");
  const ws = (await full.query(
    `select workspace_id from public.workspace_members
      where user_id = $1 and status = 'active'`, [uid])).rows[0].workspace_id;
  const ruleId = randomUUID();
  await full.query(
    `insert into public.automation_rules
       (id, user_id, workspace_id, name, trigger_type, trigger_config, status, activated_at)
     values ($1,$2,$3,'Birthday greeting','birthday','{"days_before":0,"fire_hour":9}'::jsonb,'active',now())`,
    [ruleId, uid, ws]);
  await full.exec("reset role");

  await revert(full, "phase_2d_past_clients_revert.sql");

  const row = (await full.query(
    `select status, trigger_type, metadata from public.automation_rules where id = $1`,
    [ruleId])).rows[0];
  assert.ok(row, "the rule and its history survive");
  assert.equal(row.status, "archived");
  assert.equal(row.trigger_type, "manual", "rewritten to a type the restored CHECK allows");
  assert.equal(row.metadata.phase_2d_reverted_from_trigger_type, "birthday");
});

sqlTest("Phase 2D re-applies cleanly after its own revert, and twice over", async () => {
  const full = await atP2D();
  assert.ok(full);
  const fns = await snap(full, FN_SQL);
  const trgs = await snap(full, TRG_SQL);
  const sql = fs.readFileSync(path.join(here, "..", "..", "supabase", "migrations", P2D), "utf8");

  await revert(full, "phase_2d_past_clients_revert.sql");
  await full.exec(sql);
  // Applied a second time on top of itself: the task asked for this
  // explicitly, and every guard in the migration exists for it.
  await full.exec(sql);

  assert.deepEqual(await snap(full, FN_SQL), fns, "re-applying 2D restores its functions");
  assert.deepEqual(await snap(full, TRG_SQL), trgs, "and its triggers, with no duplicates");
});

// ---------------------------------------------------------------- Phase 2E

const atP2E = () => migratedDb((f) => f <= P2E);
const beforeP2E = () => migratedDb((f) => f < P2E);

sqlTest("phase_2e_audience_tags_revert.sql reproduces the pre-2E state exactly", async () => {
  const pre = await beforeP2E();
  const full = await atP2E();
  assert.ok(pre && full);

  const fnPre = await snap(pre, FN_SQL);
  const idxPre = await snap(pre, IDX_SQL);
  const trgPre = await snap(pre, TRG_SQL);

  assert.notDeepEqual(await snap(full, FN_SQL), fnPre, "2E must change functions");
  assert.notDeepEqual(await snap(full, IDX_SQL), idxPre, "2E must add an index");
  assert.notDeepEqual(await snap(full, TRG_SQL), trgPre, "2E must add a trigger");

  await revert(full, "phase_2e_audience_tags_revert.sql");

  assert.deepEqual(await snap(full, FN_SQL), fnPre,
    "function bodies after the revert must match the pre-2E chain");
  assert.deepEqual(await snap(full, IDX_SQL), idxPre, "indexes too");
  assert.deepEqual(await snap(full, TRG_SQL), trgPre, "triggers too");
  assert.deepEqual(await snap(full, COL_SQL), await snap(pre, COL_SQL), "and columns");
});

sqlTest("the 2E revert parks a tag audience and pauses that rule rather than widening it", async () => {
  const full = await atP2E();
  assert.ok(full);
  const { randomUUID } = await import("node:crypto");
  const uid = randomUUID();
  await full.query(`insert into auth.users (id) values ($1)`, [uid]);
  await full.exec("set role service_role");
  const ws = (await full.query(
    `select workspace_id from public.workspace_members
      where user_id = $1 and status = 'active'`, [uid])).rows[0].workspace_id;
  const ruleId = randomUUID();
  await full.query(
    `insert into public.automation_rules
       (id, user_id, workspace_id, name, trigger_type, trigger_config, status,
        activated_at, audience_filter)
     values ($1,$2,$3,'Stay in touch','no_contact','{"days":90}'::jsonb,'active',now(),
             '{"tags_any":["Past client"]}'::jsonb)`,
    [ruleId, uid, ws]);
  await full.exec("reset role");

  await revert(full, "phase_2e_audience_tags_revert.sql");

  const row = (await full.query(
    `select status, audience_filter, metadata from public.automation_rules where id = $1`,
    [ruleId])).rows[0];
  assert.ok(row, "the rule survives");
  assert.ok(!row.audience_filter.tags_any, "the tag filter is gone, because nothing can honour it");
  assert.deepEqual(row.metadata.phase_2e_reverted_tags_any, ["Past client"],
    "but it is recorded, so an agent can see what the rule used to mean");
  assert.equal(row.status, "paused",
    "and the rule is paused rather than quietly reaching everybody");
});

sqlTest("Phase 2E re-applies cleanly after its own revert, and twice over", async () => {
  const full = await atP2E();
  assert.ok(full);
  const fns = await snap(full, FN_SQL);
  const sql = fs.readFileSync(path.join(here, "..", "..", "supabase", "migrations", P2E), "utf8");

  await revert(full, "phase_2e_audience_tags_revert.sql");
  await full.exec(sql);
  await full.exec(sql);   // the re-run the 2C/2D wrappers could not survive

  assert.deepEqual(await snap(full, FN_SQL), fns, "re-applying 2E restores its functions");
});

// ---------------------------------------------------------------- Phase 2F

const atP2F = () => migratedDb((f) => f <= P2F);
const beforeP2F = () => migratedDb((f) => f < P2F);

sqlTest("phase_2f_audience_type_temp_revert.sql reproduces the pre-2F state exactly", async () => {
  const pre = await beforeP2F();
  const full = await atP2F();
  assert.ok(pre && full);

  const fnPre = await snap(pre, FN_SQL);
  assert.notDeepEqual(await snap(full, FN_SQL), fnPre, "2F must change functions");

  await revert(full, "phase_2f_audience_type_temp_revert.sql");

  assert.deepEqual(await snap(full, FN_SQL), fnPre,
    "function bodies after the revert must match the pre-2F chain, which is "
    + "also what proves the two helpers were dropped and the 2E bodies were "
    + "restored verbatim");
  assert.deepEqual(await snap(full, IDX_SQL), await snap(pre, IDX_SQL), "indexes too");
  assert.deepEqual(await snap(full, TRG_SQL), await snap(pre, TRG_SQL), "triggers too");
  assert.deepEqual(await snap(full, COL_SQL), await snap(pre, COL_SQL), "and columns");
});

sqlTest("the 2F revert parks a type or temperature audience and pauses that rule", async () => {
  const full = await atP2F();
  assert.ok(full);
  const { randomUUID } = await import("node:crypto");
  const uid = randomUUID();
  await full.query(`insert into auth.users (id) values ($1)`, [uid]);
  await full.exec("set role service_role");
  const ws = (await full.query(
    `select workspace_id from public.workspace_members
      where user_id = $1 and status = 'active'`, [uid])).rows[0].workspace_id;
  const mk = async (name, filter) => {
    const id = randomUUID();
    await full.query(
      `insert into public.automation_rules
         (id, user_id, workspace_id, name, trigger_type, trigger_config, status,
          activated_at, audience_filter)
       values ($1,$2,$3,$4,'contact_created','{}'::jsonb,'active',now(),$5::jsonb)`,
      [id, uid, ws, name, JSON.stringify(filter)]);
    return id;
  };
  const buyers = await mk("New buyer lead", { type_in: ["Buyer"], temperature_in: ["Cold"] });
  const tagged = await mk("Open-house visitor", { tags_any: ["Open house"] });
  await full.exec("reset role");

  await revert(full, "phase_2f_audience_type_temp_revert.sql");

  const row = (await full.query(
    `select status, audience_filter, metadata from public.automation_rules where id = $1`,
    [buyers])).rows[0];
  assert.ok(!row.audience_filter.type_in, "the type filter is gone, because nothing can honour it");
  assert.ok(!row.audience_filter.temperature_in);
  assert.deepEqual(row.metadata.phase_2f_reverted_type_in, ["Buyer"],
    "but it is recorded, so an agent can see what the rule used to mean");
  assert.deepEqual(row.metadata.phase_2f_reverted_temperature_in, ["Cold"]);
  assert.equal(row.status, "paused",
    "and the rule is paused rather than quietly welcoming sellers");

  const untouched = (await full.query(
    `select status, audience_filter from public.automation_rules where id = $1`,
    [tagged])).rows[0];
  assert.deepEqual(untouched.audience_filter, { tags_any: ["Open house"] },
    "a rule that only used the 2E tag audience is left exactly as it was");
  assert.equal(untouched.status, "active");
});

sqlTest("Phase 2F re-applies cleanly after its own revert, and twice over", async () => {
  const full = await atP2F();
  assert.ok(full);
  const fns = await snap(full, FN_SQL);
  const sql = fs.readFileSync(path.join(here, "..", "..", "supabase", "migrations", P2F), "utf8");

  await revert(full, "phase_2f_audience_type_temp_revert.sql");
  await full.exec(sql);
  await full.exec(sql);

  assert.deepEqual(await snap(full, FN_SQL), fns, "re-applying 2F restores its functions");
});

// ---------------------------------------------------------------- Phase 3B

const atP3B = () => migratedDb((f) => f <= P3B);
const beforeP3B = () => migratedDb((f) => f < P3B);

sqlTest("phase_3b_push_revert.sql reproduces the pre-3B state exactly", async () => {
  const pre = await beforeP3B();
  const full = await atP3B();
  assert.ok(pre && full);

  const fnPre = await snap(pre, FN_SQL);
  const colPre = await snap(pre, COL_SQL);
  assert.notDeepEqual(await snap(full, FN_SQL), fnPre, "3B must add functions");
  assert.notDeepEqual(await snap(full, COL_SQL), colPre, "and tables and columns");

  await revert(full, "phase_3b_push_revert.sql");

  assert.deepEqual(await snap(full, FN_SQL), fnPre, "every 3B function is gone again");
  assert.deepEqual(await snap(full, COL_SQL), colPre,
    "and both tables, and the four columns on notifications");
  assert.deepEqual(await snap(full, IDX_SQL), await snap(pre, IDX_SQL), "indexes too");
  assert.deepEqual(await snap(full, TRG_SQL), await snap(pre, TRG_SQL), "triggers too");
});

sqlTest("the 3B revert takes the devices but never a notification", async () => {
  const full = await atP3B();
  assert.ok(full);
  const { randomUUID } = await import("node:crypto");
  const uid = randomUUID();
  await full.query(`insert into auth.users (id) values ($1)`, [uid]);
  await full.exec("set role service_role");
  const ws = (await full.query(
    `select workspace_id from public.workspace_members
      where user_id = $1 and status = 'active'`, [uid])).rows[0].workspace_id;
  const note = randomUUID();
  await full.query(
    `insert into public.notifications
       (id, user_id, workspace_id, type, title, body, dedupe_key)
     values ($1::uuid,$2,$3,'hot_reply','A lead replied','','k:'||($1::uuid)::text)`,
    [note, uid, ws]);
  await full.query(
    `insert into public.push_subscriptions (workspace_id, user_id, endpoint, p256dh, auth)
     values ($1,$2,'https://fcm.googleapis.com/fcm/send/abcdefghijklmno',$3,'c2FsdHNhbHQ')`,
    [ws, uid, "B".repeat(87)]);
  await full.exec("reset role");

  await revert(full, "phase_3b_push_revert.sql");

  const kept = (await full.query(
    `select id, title from public.notifications where id = $1`, [note])).rows;
  assert.equal(kept.length, 1, "the notification itself is not this revert's business");
  assert.equal(kept[0].title, "A lead replied");
});

sqlTest("Phase 3B re-applies cleanly after its own revert, and twice over", async () => {
  const full = await atP3B();
  assert.ok(full);
  const fns = await snap(full, FN_SQL);
  const cols = await snap(full, COL_SQL);
  const sql = fs.readFileSync(path.join(here, "..", "..", "supabase", "migrations", P3B), "utf8");

  await revert(full, "phase_3b_push_revert.sql");
  await full.exec(sql);
  await full.exec(sql);

  assert.deepEqual(await snap(full, FN_SQL), fns, "re-applying 3B restores its functions");
  assert.deepEqual(await snap(full, COL_SQL), cols, "and its tables and columns, once each");
});

// ---------------------------------------------------------------- the team era
//
// T2a, T2b-1, T2d and T3 had no revert files until cleanup round B.
// Each is proven the same way as the others here: build the chain up to
// that phase, revert, and compare against the chain built up to the
// phase before it.
//
// T2a and T2b-1 are the two that refuse to run out of order, so each
// test also proves the guard - a revert that quietly half-ran would be
// worse than one that would not start.

const atT2D = () => migratedDb((f) => f <= T2D);
const beforeT2D = () => migratedDb((f) => f < T2D);

sqlTest("t2d_settings_singleton_revert.sql puts the per-user unique back", async () => {
  const pre = await beforeT2D();
  const full = await atT2D();
  assert.ok(pre && full);

  const idxPre = await snap(pre, IDX_SQL);
  assert.notDeepEqual(await snap(full, IDX_SQL), idxPre, "T2d must change the indexes");

  await revert(full, "t2d_settings_singleton_revert.sql");

  assert.deepEqual(await snap(full, IDX_SQL), idxPre, "index for index, back to pre-T2d");
  // The constraint, not just an index of the same name: the two are
  // different objects and only one of them is what the original was.
  const con = (await full.query(
    `select conname from pg_constraint where conname = 'workspace_settings_user_id_key'`)).rows;
  assert.equal(con.length, 1, "unique (user_id) is a constraint again");
});

const atT3 = () => migratedDb((f) => f <= T3);
const beforeT3 = () => migratedDb((f) => f < T3);

sqlTest("t3_invitations_membership_revert.sql removes the membership functions only", async () => {
  const pre = await beforeT3();
  const full = await atT3();
  assert.ok(pre && full);
  const fnPre = await snap(pre, FN_SQL);

  await revert(full, "t3_invitations_membership_revert.sql");

  assert.deepEqual(await snap(full, FN_SQL), fnPre, "function for function, back to pre-T3");
  // T2a's table and T2b-1's helper are not T3's to take.
  const kept = (await full.query(`
    select (select count(*) from information_schema.tables
             where table_schema = 'public' and table_name = 'workspace_invitations') as inv,
           (select count(*) from information_schema.tables
             where table_schema = 'public' and table_name = 'workspace_role_permissions') as perms`)).rows[0];
  assert.equal(Number(kept.inv), 1, "the invitations table stays - T2a owns it");
  assert.equal(Number(kept.perms), 1, "and the permission templates stay - T2b-1 owns them");
});

sqlTest("T3 re-applies cleanly after its own revert", async () => {
  const full = await atT3();
  assert.ok(full);
  const fns = await snap(full, FN_SQL);
  const sql = fs.readFileSync(path.join(here, "..", "..", "supabase", "migrations", T3), "utf8");

  await revert(full, "t3_invitations_membership_revert.sql");
  await full.exec(sql);

  assert.deepEqual(await snap(full, FN_SQL), fns, "every membership function is back");
});

const atT2B1 = () => migratedDb((f) => f <= T2B1);
const beforeT2B1 = () => migratedDb((f) => f < T2B1);

sqlTest("t2b1_permissions_revert.sql reproduces the pre-T2b-1 state exactly", async () => {
  const pre = await beforeT2B1();
  const full = await atT2B1();
  assert.ok(pre && full);

  const fnPre = await snap(pre, FN_SQL);
  const colPre = await snap(pre, COL_SQL);
  assert.notDeepEqual(await snap(full, FN_SQL), fnPre, "T2b-1 must add functions");
  assert.notDeepEqual(await snap(full, COL_SQL), colPre, "and tables and columns");

  await revert(full, "t2b1_permissions_revert.sql");

  assert.deepEqual(await snap(full, FN_SQL), fnPre, "function for function");
  assert.deepEqual(await snap(full, COL_SQL), colPre,
    "including visibility coming off the four library tables");
  assert.deepEqual(await snap(full, IDX_SQL), await snap(pre, IDX_SQL), "indexes too");
  assert.deepEqual(await snap(full, TRG_SQL), await snap(pre, TRG_SQL), "triggers too");

  const authz = (await full.query(
    `select count(*) as n from information_schema.schemata where schema_name = 'authz'`)).rows[0];
  assert.equal(Number(authz.n), 0, "and the authz schema with them");
});

sqlTest("the T2b-1 revert refuses to run while a later phase still needs it", async () => {
  // The whole chain, where 2C's rule_targets_contact reads
  // automation_rules.visibility. Dropping that column is not an error
  // Postgres can see - the function body is a string - so the revert has
  // to notice for itself.
  const tip = await migratedDb();
  assert.ok(tip);
  await assert.rejects(
    revert(tip, "t2b1_permissions_revert.sql"),
    /still installed|Revert the later phases first/,
    "it must refuse rather than leave policies and functions pointing at nothing");
  // The refusal is raised inside the file's own transaction, which is
  // left open and aborted; close it before asking anything else.
  await tip.exec("rollback");

  // And having refused, it changed nothing.
  const still = (await tip.query(`
    select count(*) as n from information_schema.columns
     where table_schema = 'public' and table_name = 'automation_rules' and column_name = 'visibility'`)).rows[0];
  assert.equal(Number(still.n), 1, "visibility survives a refused revert");
});

const atT2A = () => migratedDb((f) => f <= T2A);
const beforeT2A = () => migratedDb((f) => f < T2A);

sqlTest("t2a_workspace_foundation_revert.sql reproduces the pre-T2a state exactly", async () => {
  const pre = await beforeT2A();
  const full = await atT2A();
  assert.ok(pre && full);

  const colPre = await snap(pre, COL_SQL);
  const idxPre = await snap(pre, IDX_SQL);
  const trgPre = await snap(pre, TRG_SQL);
  const fnPre = await snap(pre, FN_SQL);
  assert.notDeepEqual(await snap(full, COL_SQL), colPre, "T2a must add workspace_id everywhere");

  await revert(full, "t2a_workspace_foundation_revert.sql");

  assert.deepEqual(await snap(full, COL_SQL), colPre,
    "all 36 workspace_id columns, auth_user_id and assigned_to_id are gone");
  assert.deepEqual(await snap(full, IDX_SQL), idxPre, "and every index they carried");
  assert.deepEqual(await snap(full, TRG_SQL), trgPre, "and the compat trigger on all 36 tables");
  assert.deepEqual(await snap(full, FN_SQL), fnPre, "and both functions, and the schema");
});

sqlTest("the T2a revert keeps every business row and says what it does lose", async () => {
  const full = await atT2A();
  assert.ok(full);
  const { randomUUID } = await import("node:crypto");
  const uid = randomUUID();
  await full.query(`insert into auth.users (id) values ($1)`, [uid]);
  await full.exec("set role service_role");
  // At T2a there is no trigger that provisions a workspace for a new
  // account - the migration backfills the users that existed when it
  // ran, and everything after that goes through this function. Later
  // phases wire it to sign-up; here it is called directly.
  const ws = (await full.query(
    `select automation_internal.ensure_personal_workspace($1) as id`, [uid])).rows[0].id;
  const tm = "tm_" + randomUUID().replace(/-/g, "").slice(0, 16);
  await full.query(
    `insert into public.team_members (id, user_id, workspace_id, name, role, active)
     values ($1,$2,$3,'Sam','Agent',true)`, [tm, uid, ws]);
  await full.query(
    `insert into public.contacts (id, user_id, workspace_id, full_name, assigned_to_id)
     values ('ct_keep',$1,$2,'Sarah Khan',$3)`, [uid, ws, tm]);
  await full.exec("reset role");

  await revert(full, "t2a_workspace_foundation_revert.sql");

  const kept = (await full.query(
    `select id, user_id, full_name from public.contacts where id = 'ct_keep'`)).rows;
  assert.equal(kept.length, 1, "the contact is still here");
  assert.equal(kept[0].full_name, "Sarah Khan");
  assert.equal(kept[0].user_id, uid, "still owned, through the column that always owned it");

  const cols = (await full.query(`
    select count(*) as n from information_schema.columns
     where table_schema = 'public' and table_name = 'contacts'
       and column_name in ('workspace_id', 'assigned_to_id')`)).rows[0];
  assert.equal(Number(cols.n), 0, "the assignment is what was lost, as the header says");

  // The owner's directory row survives: deleting it would take them out
  // of their own team.
  const team = (await full.query(`select count(*) as n from public.team_members`)).rows[0];
  assert.ok(Number(team.n) >= 1, "team_members rows are not deleted");
});

sqlTest("the T2a revert refuses while the workspace era is still installed", async () => {
  const tip = await migratedDb();
  assert.ok(tip);
  await assert.rejects(
    revert(tip, "t2a_workspace_foundation_revert.sql"),
    /still installed|Unwind those first|Run t2b/,
    "the bottom of the stack has to be the last thing removed");
  await tip.exec("rollback");

  const still = (await tip.query(`
    select count(*) as n from information_schema.tables
     where table_schema = 'public' and table_name = 'workspaces'`)).rows[0];
  assert.equal(Number(still.n), 1, "and nothing was removed on the way to refusing");
});

sqlTest("T2a re-applies cleanly after its own revert", async () => {
  const full = await atT2A();
  assert.ok(full);
  const cols = await snap(full, COL_SQL);
  const fns = await snap(full, FN_SQL);
  const sql = fs.readFileSync(path.join(here, "..", "..", "supabase", "migrations", T2A), "utf8");

  await revert(full, "t2a_workspace_foundation_revert.sql");
  await full.exec(sql);

  assert.deepEqual(await snap(full, COL_SQL), cols, "the whole foundation is back");
  assert.deepEqual(await snap(full, FN_SQL), fns);
});
