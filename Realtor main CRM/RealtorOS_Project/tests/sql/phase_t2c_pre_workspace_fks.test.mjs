// Phase T2c-pre: the tenant half of every composite foreign key moves
// from user_id to workspace_id.
//
// The point of the phase is that teammates can reference each other's
// rows. These tests prove that directly - the admin-creates-a-task-on-
// the-owner's-contact case is the one that was failing with 23503 - and
// prove the isolation that must NOT be lost: a reference into another
// workspace is still refused, and the column-scoped ON DELETE SET NULL
// still nulls only the reference, never workspace_id.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedDb, SKIP_MESSAGE } from "../helpers/pg.mjs";

let db;
let applied = false;
const NOT_APPLIED = "T2c-pre not in the migration chain";

before(async () => {
  db = await migratedDb();
  if (!db) return;
  const r = await db.query(
    `select count(*)::int as n from pg_constraint c
       join pg_namespace ns on ns.oid = c.connamespace
      where c.contype='f' and ns.nspname='public'
        and c.conname = 'tasks_workspace_id_contact_id_fkey'`);
  applied = Number(r.rows[0].n) > 0;
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
async function asUser(uid, fn) {
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [uid]);
  await db.exec("set role authenticated");
  try { return await fn(); } finally {
    await db.exec("reset role");
    await db.query(`select set_config('request.jwt.claim.sub','',false)`);
  }
}
async function mkUser() {
  await db.exec("reset role");
  const id = randomUUID();
  await db.query(`insert into auth.users (id) values ($1)`, [id]);
  return id;
}
const count = async (sql, p = []) => Number((await db.query(sql, p)).rows[0].n);

/** Owner + admin + agent in one workspace; plus a separate stranger workspace. */
async function world() {
  const owner = await mkUser();
  const stranger = await mkUser();
  await asService(async () => {
    await db.query(`select automation_internal.ensure_personal_workspace($1)`, [owner]);
    await db.query(`select automation_internal.ensure_personal_workspace($1)`, [stranger]);
  });
  const ws = (await db.query(
    `select workspace_id from public.workspace_members where user_id=$1 and status='active'`,
    [owner])).rows[0].workspace_id;
  const strangerWs = (await db.query(
    `select workspace_id from public.workspace_members where user_id=$1 and status='active'`,
    [stranger])).rows[0].workspace_id;

  const ids = { owner, stranger, ws, strangerWs, tm: {} };
  for (const role of ["admin", "agent"]) {
    const uid = await mkUser();
    await asService(async () => {
      await db.query(
        `update public.workspace_members set status='removed'
          where user_id=$1 and status='active'`, [uid]);
      const mid = (await db.query(
        `insert into public.workspace_members (workspace_id,user_id,role,status,team_member_id)
         values ($1,$2,$3,'active',null) returning id`, [ws, uid, role])).rows[0].id;
      const tmid = `tm-${role}-${uid.slice(0, 8)}`;
      await db.query(
        `insert into public.team_members (id,user_id,workspace_id,auth_user_id,name,role,email,phone,active)
         values ($1,$2,$3,$4,$5,$5,'','',true)`, [tmid, owner, ws, uid, role]);
      await db.query(
        `update public.workspace_members set team_member_id=$1 where id=$2`, [tmid, mid]);
    });
    ids[role] = uid;
    ids.tm[role] = `tm-${role}-${uid.slice(0, 8)}`;
  }
  ids.tm.owner = (await db.query(
    `select team_member_id from public.workspace_members where user_id=$1 and status='active'`,
    [owner])).rows[0].team_member_id;
  return ids;
}

/** A contact created BY the owner, in the owner's workspace. */
async function ownerContact(w, name = "Owner Lead") {
  const cid = `c-${randomUUID().slice(0, 8)}`;
  await asService(() => db.query(
    `insert into public.contacts (id,user_id,workspace_id,full_name)
     values ($1,$2,$3,$4)`, [cid, w.owner, w.ws, name]));
  return cid;
}

// ---------------------------------------------------------------- schema

sqlTest("no composite FK starts with user_id any more", async () => {
  const left = await count(
    `select count(*)::int as n from pg_constraint c
       join pg_namespace ns on ns.oid = c.connamespace
      where c.contype='f' and ns.nspname='public' and array_length(c.conkey,1)=2
        and (select a.attname from pg_attribute a
              where a.attrelid=c.conrelid and a.attnum=c.conkey[1]) = 'user_id'`);
  assert.equal(left, 0);
});

sqlTest("59 composite FKs are workspace-scoped (56 converted + T2a's 2 + Phase 2A's 1)", async () => {
  const ws = await count(
    `select count(*)::int as n from pg_constraint c
       join pg_namespace ns on ns.oid = c.connamespace
      where c.contype='f' and ns.nspname='public' and array_length(c.conkey,1)=2
        and (select a.attname from pg_attribute a
              where a.attrelid=c.conrelid and a.attnum=c.conkey[1]) = 'workspace_id'`);
  // Phase 2A adds automation_trigger_events_workspace_id_rule_id_fkey
  // in 20261015120000_phase_2a_time_based_triggers.sql.
  assert.equal(ws, 59);
});

sqlTest("every composite SET NULL stays COLUMN-SCOPED (workspace_id is never nulled)", async () => {
  const plain = await count(
    `select count(*)::int as n from pg_constraint c
       join pg_namespace ns on ns.oid = c.connamespace
      where c.contype='f' and ns.nspname='public' and array_length(c.conkey,1)=2
        and c.confdeltype='n' and c.confdelsetcols is null`);
  assert.equal(plain, 0, "a plain SET NULL would orphan the row from its workspace");
  const scoped = await count(
    `select count(*)::int as n from pg_constraint c
       join pg_namespace ns on ns.oid = c.connamespace
      where c.contype='f' and ns.nspname='public' and array_length(c.conkey,1)=2
        and c.confdeltype='n' and c.confdelsetcols is not null`);
  assert.equal(scoped, 36, "34 converted here + T2a's contacts and workspace_members pair");
});

sqlTest("user_id is still on every table, and still points at auth.users", async () => {
  const fks = await count(
    `select count(*)::int as n from pg_constraint c
       join pg_namespace ns on ns.oid = c.connamespace
      where c.contype='f' and ns.nspname='public' and array_length(c.conkey,1)=1
        and (select a.attname from pg_attribute a
              where a.attrelid=c.conrelid and a.attnum=c.conkey[1]) = 'user_id'`);
  assert.ok(fks > 0, "user_id -> auth.users survives as the audit trail");
});

sqlTest("the parents keep their (user_id, id) unique indexes, so the revert stays usable", async () => {
  const n = await count(
    `select count(*)::int as n from pg_indexes
      where schemaname='public' and indexdef like '%UNIQUE%'
        and indexdef like '%(user_id, id)%'`);
  assert.ok(n >= 15, `found ${n} (user_id, id) unique indexes, expected at least 15`);
});

// ------------------------------------------------- the case that was broken

sqlTest("an admin can create a task on the OWNER's contact (was 23503)", async () => {
  const w = await world();
  const cid = await ownerContact(w);

  // Precondition: RLS already allowed this; only the FK refused.
  const scopes = await asUser(w.admin, () => db.query(
    `select authz.my_scope('contacts','view') as v, authz.my_scope('work','edit') as e`));
  assert.equal(scopes.rows[0].v, "all");
  assert.equal(scopes.rows[0].e, "all");

  await asUser(w.admin, () => db.query(
    `insert into public.tasks (id,user_id,contact_id,title)
     values ($1,$2,$3,'Follow up')`, [`t-${randomUUID().slice(0, 8)}`, w.admin, cid]));

  const got = await count(
    `select count(*)::int as n from public.tasks where contact_id=$1 and user_id=$2`,
    [cid, w.admin]);
  assert.equal(got, 1);
});

sqlTest("an admin can create a deal and a showing on the owner's contact", async () => {
  const w = await world();
  const cid = await ownerContact(w);
  const did = `d-${randomUUID().slice(0, 8)}`;

  await asUser(w.admin, () => db.query(
    `insert into public.deals (id,user_id,contact_id,title)
     values ($1,$2,$3,'Their deal')`, [did, w.admin, cid]));
  await asUser(w.admin, () => db.query(
    `insert into public.showings (id,user_id,contact_id,deal_id)
     values ($1,$2,$3,$4)`, [`s-${randomUUID().slice(0, 8)}`, w.admin, cid, did]));

  assert.equal(await count(
    `select count(*)::int as n from public.deals where contact_id=$1`, [cid]), 1);
  assert.equal(await count(
    `select count(*)::int as n from public.showings where deal_id=$1`, [did]), 1);
});

sqlTest("a task can be assigned to a teammate's directory row", async () => {
  const w = await world();
  const cid = await ownerContact(w);
  // The owner creates the task and assigns it to the agent.
  await asService(() => db.query(
    `insert into public.tasks (id,user_id,workspace_id,contact_id,title,assigned_to_id)
     values ($1,$2,$3,$4,'Call them',$5)`,
    [`t-${randomUUID().slice(0, 8)}`, w.owner, w.ws, cid, w.tm.agent]));
  assert.equal(await count(
    `select count(*)::int as n from public.tasks where assigned_to_id=$1`, [w.tm.agent]), 1);
});

sqlTest("an agent's work on a lead assigned to them references the owner's contact", async () => {
  const w = await world();
  const cid = await ownerContact(w);
  await asService(() => db.query(
    `update public.contacts set assigned_to_id=$1 where id=$2`, [w.tm.agent, cid]));

  await asUser(w.agent, () => db.query(
    `insert into public.tasks (id,user_id,contact_id,title)
     values ($1,$2,$3,'My follow-up')`, [`t-${randomUUID().slice(0, 8)}`, w.agent, cid]));
  assert.equal(await count(
    `select count(*)::int as n from public.tasks where contact_id=$1 and user_id=$2`,
    [cid, w.agent]), 1);
});

// ------------------------------------------------- isolation must survive

sqlTest("a reference into ANOTHER workspace is still refused", async () => {
  const w = await world();
  const cid = await ownerContact(w);
  // The stranger (own workspace) tries to attach a task to this contact.
  await assert.rejects(
    asService(() => db.query(
      `insert into public.tasks (id,user_id,workspace_id,contact_id,title)
       values ($1,$2,$3,$4,'Cross-tenant')`,
      [`t-${randomUUID().slice(0, 8)}`, w.stranger, w.strangerWs, cid])),
    /violates foreign key constraint/,
    "the workspace half of the key still isolates tenants");
});

sqlTest("a deal cannot be assigned to another workspace's team member", async () => {
  const w = await world();
  const strangerTm = (await db.query(
    `select team_member_id from public.workspace_members
      where workspace_id=$1 and status='active'`, [w.strangerWs])).rows[0].team_member_id;
  await assert.rejects(
    asService(() => db.query(
      `insert into public.deals (id,user_id,workspace_id,title,assigned_to_id)
       values ($1,$2,$3,'Nope',$4)`,
      [`d-${randomUUID().slice(0, 8)}`, w.owner, w.ws, strangerTm])),
    /violates foreign key constraint/);
});

sqlTest("deleting a contact nulls the reference but keeps workspace_id", async () => {
  const w = await world();
  const cid = await ownerContact(w);
  const tid = `t-${randomUUID().slice(0, 8)}`;
  await asService(() => db.query(
    `insert into public.tasks (id,user_id,workspace_id,contact_id,title)
     values ($1,$2,$3,$4,'Orphan me')`, [tid, w.owner, w.ws, cid]));

  await asService(() => db.query(`delete from public.contacts where id=$1`, [cid]));

  const row = (await db.query(
    `select contact_id, workspace_id, user_id from public.tasks where id=$1`, [tid])).rows[0];
  assert.equal(row.contact_id, null, "the reference is nulled");
  assert.equal(row.workspace_id, w.ws, "but the task still belongs to its workspace");
  assert.equal(row.user_id, w.owner, "and still records who created it");
});

sqlTest("deleting a deal still cascades to its milestones", async () => {
  const w = await world();
  const did = `d-${randomUUID().slice(0, 8)}`;
  await asService(async () => {
    await db.query(
      `insert into public.deals (id,user_id,workspace_id,title) values ($1,$2,$3,'Doomed')`,
      [did, w.owner, w.ws]);
    await db.query(
      `insert into public.milestones (id,user_id,workspace_id,deal_id,title)
       values ($1,$2,$3,$4,'Step')`,
      [`m-${randomUUID().slice(0, 8)}`, w.owner, w.ws, did]);
  });
  assert.equal(await count(
    `select count(*)::int as n from public.milestones where deal_id=$1`, [did]), 1);
  await asService(() => db.query(`delete from public.deals where id=$1`, [did]));
  assert.equal(await count(
    `select count(*)::int as n from public.milestones where deal_id=$1`, [did]), 0,
    "CASCADE survived the conversion");
});

// ------------------------------------------------- the fan-out it unblocks

sqlTest("a notification can reference a teammate's contact (fan-out no longer aborts)", async () => {
  const w = await world();
  const cid = await ownerContact(w);
  // The agent gets a notification about a contact the OWNER created.
  await asService(() => db.query(
    `insert into public.notifications (user_id,workspace_id,type,title,dedupe_key,contact_id)
     values ($1,$2,'lead_replied','They replied',$3,$4)`,
    [w.agent, w.ws, `k-${randomUUID()}`, cid]));
  assert.equal(await count(
    `select count(*)::int as n from public.notifications where user_id=$1 and contact_id=$2`,
    [w.agent, cid]), 1);
});

sqlTest("one event can notify several teammates about one contact", async () => {
  const w = await world();
  const cid = await ownerContact(w);
  const key = `stop:${randomUUID()}`;
  await asService(async () => {
    for (const u of [w.owner, w.admin, w.agent]) {
      await db.query(
        `insert into public.notifications (user_id,workspace_id,type,title,dedupe_key,contact_id)
         values ($1,$2,'lead_replied','They replied',$3,$4)`, [u, w.ws, key, cid]);
    }
  });
  assert.equal(await count(
    `select count(*)::int as n from public.notifications where dedupe_key=$1`, [key]), 3,
    "three rows, one dedupe_key - the per-user unique index allows it");
});
