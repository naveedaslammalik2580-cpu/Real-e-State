// Phase T2c: the backend becomes team-aware.
//
// What these tests pin, in the order the migration does it:
//   * uniqueness is per WORKSPACE, not per user, so two teammates
//     importing one person get one contact;
//   * the file-import allowance and the advisory lock are the
//     workspace's;
//   * imports_file is enforced inside the RPC, because the Edge Function
//     calls as service_role and RLS does not apply to it;
//   * imported leads land UNASSIGNED;
//   * a notification reaches the people responsible for the lead, not
//     whoever's user_id happened to be on the triggering row.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedDb, SKIP_MESSAGE } from "../helpers/pg.mjs";

let db;
let t2c = false;
const NOT_APPLIED = "T2c not applied yet";

before(async () => {
  db = await migratedDb();
  if (!db) return;
  const r = await db.query(
    `select count(*)::int as n from pg_proc p
       join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'automation_internal' and p.proname = 'member_can'`);
  t2c = Number(r.rows[0].n) > 0;
});

function sqlTest(name, fn) {
  test(name, async (t) => {
    if (!db) return t.skip(SKIP_MESSAGE);
    if (!t2c) return t.skip(NOT_APPLIED);
    await fn();
  });
}

// ---------------------------------------------------------------- harness
async function asService(fn) {
  await db.exec("set role service_role");
  try { return await fn(); } finally { await db.exec("reset role"); }
}
async function mkUser() {
  await db.exec("reset role");
  const id = randomUUID();
  await db.query(`insert into auth.users (id) values ($1)`, [id]);
  return id;
}
const n = (r) => Number(r.rows[0].n);
const count = async (sql, p = []) => n(await db.query(sql, p));

/** An owner plus one agent in the same workspace. */
async function team() {
  const owner = await mkUser();
  const agent = await mkUser();
  await asService(async () => {
    await db.query(`select automation_internal.ensure_personal_workspace($1)`, [owner]);
  });
  const ws = (await db.query(
    `select workspace_id from public.workspace_members
      where user_id=$1 and status='active'`, [owner])).rows[0].workspace_id;

  // T2b-2 provisions every signup a workspace eagerly, so demote the
  // agent's own membership before joining them to the owner's.
  let agentTm;
  await asService(async () => {
    await db.query(
      `update public.workspace_members set status='removed'
        where user_id=$1 and status='active'`, [agent]);
    const mid = (await db.query(
      `insert into public.workspace_members (workspace_id,user_id,role,status,team_member_id)
       values ($1,$2,'agent','active',null) returning id`, [ws, agent])).rows[0].id;
    agentTm = `tm-agent-${agent.slice(0, 8)}`;
    await db.query(
      `insert into public.team_members (id,user_id,workspace_id,auth_user_id,name,role,email,phone,active)
       values ($1,$2,$3,$4,'Agent','Agent','','',true)`, [agentTm, owner, ws, agent]);
    await db.query(
      `update public.workspace_members set team_member_id=$1 where id=$2`, [agentTm, mid]);
  });
  const ownerTm = (await db.query(
    `select team_member_id from public.workspace_members
      where user_id=$1 and status='active'`, [owner])).rows[0].team_member_id;
  return { owner, agent, ws, ownerTm, agentTm };
}

const fileRows = (...people) =>
  JSON.stringify(people.map((p) => ({ full_name: p.name, email: p.email ?? "", phone: p.phone ?? "" })));

async function importFile(userId, people, { startAutomation = false } = {}) {
  return asService(async () => {
    const r = await db.query(
      `select public.realtoros_ingest_lead_file($1, $2, $3, $4::jsonb, $5) as out`,
      [userId, randomUUID(), "team.csv", fileRows(...people), startAutomation]);
    return r.rows[0].out;
  });
}

// ------------------------------------------------- schema / applicability

sqlTest("the migration applies on the full chain and member_can works", async () => {
  const t = await team();
  const ownerCan = await asService(() => db.query(
    `select automation_internal.member_can($1,$2,'imports_file') as a,
            automation_internal.member_can($1,$2,'team_manage') as b`, [t.ws, t.owner]));
  assert.equal(ownerCan.rows[0].a, true, "owner holds imports_file");
  assert.equal(ownerCan.rows[0].b, true, "owner holds team_manage");

  const agentCan = await asService(() => db.query(
    `select automation_internal.member_can($1,$2,'imports_file') as a,
            automation_internal.member_can($1,$2,'team_manage') as b`, [t.ws, t.agent]));
  assert.equal(agentCan.rows[0].a, true, "the agent preset holds imports_file");
  assert.equal(agentCan.rows[0].b, false, "the agent preset does not hold team_manage");
});

sqlTest("member_can returns false for a non-member, never an error", async () => {
  const t = await team();
  const outsider = await mkUser();
  const r = await asService(() => db.query(
    `select automation_internal.member_can($1,$2,'imports_file') as a,
            automation_internal.member_permissions($1,$2) is null as b`,
    [t.ws, outsider]));
  assert.equal(r.rows[0].a, false);
  assert.equal(r.rows[0].b, true, "a non-member has no permissions at all");
});

sqlTest("uniqueness is workspace-scoped, and the user-scoped versions are gone", async () => {
  const gone = await count(
    `select count(*)::int as n from pg_indexes
      where schemaname='public' and indexname in (
        'contact_identity_keys_user_id_identity_type_identity_hash_key',
        'lead_import_rows_user_id_connection_id_source_row_key_key',
        'lead_import_batches_user_id_connection_id_source_event_id_key',
        'lead_import_batches_file_import_idx',
        'lead_source_connections_user_id_spreadsheet_id_ready_tab_na_key',
        'lead_source_mappings_one_active_idx')`);
  assert.equal(gone, 0, "every user-scoped uniqueness rule was replaced");

  const present = await count(
    `select count(*)::int as n from pg_indexes
      where schemaname='public' and indexname in (
        'contact_identity_keys_ws_identity_uq',
        'lead_import_rows_ws_source_uq',
        'lead_import_batches_ws_conn_event_uq',
        'lead_import_batches_ws_file_event_uq',
        'lead_source_connections_ws_sheet_uq',
        'lead_source_mappings_ws_one_active_uq')`);
  assert.equal(present, 6, "all six workspace-scoped rules exist");
});

sqlTest("the old 8-argument ingest_lead_rows is gone (no silent per-user fallback)", async () => {
  const sigs = await db.query(
    `select pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname='automation_internal' and p.proname='ingest_lead_rows'`);
  assert.equal(sigs.rows.length, 1, "exactly one signature");
  assert.match(sigs.rows[0].args, /p_workspace_id uuid/, "and it takes the workspace");
});

// ------------------------------------------------- workspace-wide dedupe

sqlTest("two teammates importing the same person create ONE contact", async () => {
  const t = await team();
  const person = { name: "John Smith", email: "john@example.com", phone: "555-1234" };

  const first = await importFile(t.owner, [person]);
  assert.equal(first.outcome, "imported");
  assert.equal(first.imported_count, 1, "the owner's import creates the contact");

  const second = await importFile(t.agent, [person]);
  assert.equal(second.outcome, "imported");
  assert.equal(second.imported_count, 0, "the agent's import creates nothing new");

  const contacts = await count(
    `select count(*)::int as n from public.contacts
      where workspace_id=$1 and lower(btrim(email))='john@example.com'`, [t.ws]);
  assert.equal(contacts, 1, "one person is one contact in the workspace");
});

sqlTest("the same person in two DIFFERENT workspaces stays two contacts", async () => {
  const a = await team();
  const b = await team();
  const person = { name: "Jane Doe", email: "jane@example.com" };
  await importFile(a.owner, [person]);
  await importFile(b.owner, [person]);
  const total = await count(
    `select count(*)::int as n from public.contacts
      where lower(btrim(email))='jane@example.com'`);
  assert.equal(total, 2, "workspaces are still isolated from each other");
});

sqlTest("identity keys are unique per workspace", async () => {
  const t = await team();
  await importFile(t.owner, [{ name: "Key Test", email: "keys@example.com" }]);
  const keys = await count(
    `select count(*)::int as n from public.contact_identity_keys
      where workspace_id=$1 and identity_type='email'`, [t.ws]);
  assert.equal(keys, 1);
  // A second import by a different member must not add a second key.
  await importFile(t.agent, [{ name: "Key Test", email: "keys@example.com" }]);
  const after = await count(
    `select count(*)::int as n from public.contact_identity_keys
      where workspace_id=$1 and identity_type='email'`, [t.ws]);
  assert.equal(after, 1, "the agent's import reuses the workspace's key");
});

// ------------------------------------------------- quota and lock

sqlTest("the file-import allowance is the WORKSPACE's, shared by members", async () => {
  const t = await team();
  await importFile(t.owner, [
    { name: "A One", email: "a1@example.com" },
    { name: "B Two", email: "b2@example.com" },
  ]);
  const ownerQuota = await asService(() => db.query(
    `select public.realtoros_file_import_quota($1) as q`, [t.owner]));
  const agentQuota = await asService(() => db.query(
    `select public.realtoros_file_import_quota($1) as q`, [t.agent]));

  assert.equal(ownerQuota.rows[0].q.used, 2);
  assert.equal(
    agentQuota.rows[0].q.used, 2,
    "the agent sees the same usage - it is one shared allowance, not one each");
  assert.equal(ownerQuota.rows[0].q.limit, agentQuota.rows[0].q.limit);
  assert.equal(
    ownerQuota.rows[0].q.remaining, agentQuota.rows[0].q.remaining,
    "and the same remaining");
});

sqlTest("the allowance limit comes from one place", async () => {
  const t = await team();
  const r = await asService(() => db.query(
    `select automation_internal.file_import_daily_limit() as fn,
            (public.realtoros_file_import_quota($1) ->> 'limit')::int as q`, [t.owner]));
  assert.equal(r.rows[0].fn, r.rows[0].q, "the quota reports the single constant");
});

sqlTest("the import lock is taken on the workspace, not the importer", async () => {
  const r = await db.query(
    `select pg_get_functiondef(p.oid) as def from pg_proc p
       join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname='public' and p.proname='realtoros_ingest_lead_file'`);
  const def = r.rows[0].def;
  assert.match(
    def, /pg_advisory_xact_lock\(hashtextextended\(v_workspace::text/,
    "the file path locks the workspace");
  const b = await db.query(
    `select pg_get_functiondef(p.oid) as def from pg_proc p
       join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname='public' and p.proname='realtoros_ingest_lead_batch'`);
  assert.match(
    b.rows[0].def, /hashtextextended\(\s*v_connection\.workspace_id::text/,
    "the sheet path locks the workspace too");
  assert.doesNotMatch(
    def, /hashtextextended\(p_user_id::text/,
    "and neither one still locks the user");
});

// ------------------------------------------------- imports_file

sqlTest("an agent without imports_file is refused by the RPC, not just by RLS", async () => {
  const t = await team();
  await asService(async () => {
    await db.query(
      `update public.workspace_members
          set permission_overrides = '{"imports_file": false}'::jsonb
        where workspace_id=$1 and user_id=$2 and status='active'`, [t.ws, t.agent]);
  });
  const can = await asService(() => db.query(
    `select automation_internal.member_can($1,$2,'imports_file') as a`, [t.ws, t.agent]));
  assert.equal(can.rows[0].a, false);

  await assert.rejects(
    importFile(t.agent, [{ name: "Blocked", email: "blocked@example.com" }]),
    /imports_file permission required/,
    "service_role bypasses RLS, so the RPC itself has to refuse");

  // And the owner is unaffected.
  const ok = await importFile(t.owner, [{ name: "Allowed", email: "allowed@example.com" }]);
  assert.equal(ok.outcome, "imported");
});

sqlTest("a user with no workspace cannot import", async () => {
  const orphan = await mkUser();
  await asService(async () => {
    await db.query(
      `update public.workspace_members set status='removed'
        where user_id=$1 and status='active'`, [orphan]);
  });
  await assert.rejects(
    importFile(orphan, [{ name: "Nowhere", email: "nowhere@example.com" }]),
    /workspace_required/);
});

// ------------------------------------------------- unassigned on import

sqlTest("imported leads land UNASSIGNED so a manager can distribute them", async () => {
  const t = await team();
  await importFile(t.owner, [
    { name: "Lead One", email: "l1@example.com" },
    { name: "Lead Two", email: "l2@example.com" },
  ]);
  const unassigned = await count(
    `select count(*)::int as n from public.contacts
      where workspace_id=$1 and assigned_to_id is null`, [t.ws]);
  const assigned = await count(
    `select count(*)::int as n from public.contacts
      where workspace_id=$1 and assigned_to_id is not null`, [t.ws]);
  assert.equal(unassigned, 2);
  assert.equal(assigned, 0, "nothing is auto-assigned to the importer");
});

sqlTest("an agent's own import is still unassigned (not self-assigned)", async () => {
  const t = await team();
  await importFile(t.agent, [{ name: "Agent Lead", email: "agentlead@example.com" }]);
  const r = await db.query(
    `select assigned_to_id, user_id from public.contacts
      where workspace_id=$1 and lower(btrim(email))='agentlead@example.com'`, [t.ws]);
  assert.equal(r.rows[0].assigned_to_id, null, "unassigned");
  assert.equal(r.rows[0].user_id, t.agent, "but the importer is recorded as the creator");
});

// ------------------------------------------------- notification fan-out

/** Fire a stop event for a contact and return who was notified. */
async function stopEventRecipients(t, contactId, eventRef) {
  await asService(async () => {
    await db.query(
      `select public.realtoros_record_contact_stop_event(
         $1, $2, 'unsubscribe', 'unsubscribe_link', $3, null, now())`,
      [t.owner, contactId, eventRef]);
  });
  const r = await db.query(
    `select user_id from public.notifications
      where workspace_id=$1 and contact_id=$2 order by user_id`, [t.ws, contactId]);
  return r.rows.map((x) => x.user_id).sort();
}

sqlTest("an UNASSIGNED lead's event goes to the unassigned_view holders", async () => {
  const t = await team();
  const cid = `c-${randomUUID().slice(0, 8)}`;
  await asService(async () => {
    await db.query(
      `insert into public.contacts (id,user_id,workspace_id,full_name,email)
       values ($1,$2,$3,'Nobody''s Lead','nobody@example.com')`, [cid, t.owner, t.ws]);
  });
  const got = await stopEventRecipients(t, cid, `ev-${randomUUID()}`);
  // The owner holds unassigned_view; the agent preset does not.
  assert.deepEqual(got, [t.owner], "only the owner is told about an unclaimed lead");
});

sqlTest("an ASSIGNED lead's event goes to the assignee AND the managers", async () => {
  const t = await team();
  const cid = `c-${randomUUID().slice(0, 8)}`;
  await asService(async () => {
    await db.query(
      `insert into public.contacts (id,user_id,workspace_id,full_name,email,assigned_to_id)
       values ($1,$2,$3,'Agent''s Lead','mine@example.com',$4)`,
      [cid, t.owner, t.ws, t.agentTm]);
  });
  const got = await stopEventRecipients(t, cid, `ev-${randomUUID()}`);
  assert.deepEqual(
    got, [t.agent, t.owner].sort(),
    "the agent who holds it, plus the owner who could reassign it");
});

sqlTest("an agent hears nothing about a lead assigned to someone else", async () => {
  const t = await team();
  const cid = `c-${randomUUID().slice(0, 8)}`;
  await asService(async () => {
    await db.query(
      `insert into public.contacts (id,user_id,workspace_id,full_name,email,assigned_to_id)
       values ($1,$2,$3,'Owner''s Lead','theirs@example.com',$4)`,
      [cid, t.owner, t.ws, t.ownerTm]);
  });
  const got = await stopEventRecipients(t, cid, `ev-${randomUUID()}`);
  assert.deepEqual(got, [t.owner], "the agent is not on it");
});

sqlTest("unassigned_view as an override pulls the agent into the audience", async () => {
  const t = await team();
  await asService(async () => {
    await db.query(
      `update public.workspace_members
          set permission_overrides = '{"unassigned_view": true}'::jsonb
        where workspace_id=$1 and user_id=$2 and status='active'`, [t.ws, t.agent]);
  });
  const cid = `c-${randomUUID().slice(0, 8)}`;
  await asService(async () => {
    await db.query(
      `insert into public.contacts (id,user_id,workspace_id,full_name,email)
       values ($1,$2,$3,'Shared Pool','pool@example.com')`, [cid, t.owner, t.ws]);
  });
  const got = await stopEventRecipients(t, cid, `ev-${randomUUID()}`);
  assert.deepEqual(got, [t.agent, t.owner].sort(), "both now watch the unassigned pool");
});

sqlTest("the same event reaching two people is two rows, one dedupe_key", async () => {
  const t = await team();
  const cid = `c-${randomUUID().slice(0, 8)}`;
  await asService(async () => {
    await db.query(
      `insert into public.contacts (id,user_id,workspace_id,full_name,email,assigned_to_id)
       values ($1,$2,$3,'Two Watchers','two@example.com',$4)`,
      [cid, t.owner, t.ws, t.agentTm]);
  });
  await stopEventRecipients(t, cid, `ev-${randomUUID()}`);
  const keys = await db.query(
    `select dedupe_key, count(*)::int as n from public.notifications
      where workspace_id=$1 and contact_id=$2 group by dedupe_key`, [t.ws, cid]);
  assert.equal(keys.rows.length, 1, "one logical event");
  assert.equal(keys.rows[0].n, 2, "delivered to two people");
});

sqlTest("a file import notifies only the uploader", async () => {
  const t = await team();
  await importFile(t.agent, [{ name: "Solo", email: "solo@example.com" }]);
  const r = await db.query(
    `select user_id from public.notifications
      where workspace_id=$1 and type='import_finished'`, [t.ws]);
  assert.deepEqual(
    r.rows.map((x) => x.user_id), [t.agent],
    "the person who clicked Upload, and nobody else");
});

sqlTest("the audience never ends up empty - it falls back to the owner", async () => {
  const t = await team();
  // Strip unassigned_view from the owner too, so nobody qualifies.
  await asService(async () => {
    await db.query(
      `insert into public.workspace_role_permissions (workspace_id, role, permissions)
       values ($1, 'agent', (automation_internal.member_permissions($1,$2)
                             || '{"unassigned_view": false}'::jsonb))
       on conflict (workspace_id, role) do update set permissions = excluded.permissions`,
      [t.ws, t.agent]);
  });
  const empty = await asService(() => db.query(
    `select count(*)::int as n from automation_internal.contact_audience($1, null)`, [t.ws]));
  assert.ok(Number(empty.rows[0].n) >= 1, "somebody always hears about it");
});
