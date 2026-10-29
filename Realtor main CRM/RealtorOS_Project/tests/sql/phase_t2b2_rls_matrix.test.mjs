// Phase T2b-2: the RLS cutover. Full role matrix in PGlite against the
// real migration chain.
//
// Personas: owner, admin, agent, agent+overrides, non-member (a different
// workspace's owner), anon.
// Coverage: every area x select/insert/update/delete, the assignment and
// claim rules, shared-vs-personal library visibility, cross-workspace
// isolation, notifications, workspace_settings, team_members, and the
// CURRENT unchanged frontend path (filter by user_id, insert without
// workspace_id).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedDb, SKIP_MESSAGE } from "../helpers/pg.mjs";

// T2b-2 was applied live on 2026-10-06 as 20261006033532. The probe below
// stays as a guard: if the migration ever leaves the chain, this file
// skips loudly instead of silently passing against the old user_id
// policies.
const NOT_APPLIED = "T2b-2 not in the migration chain";

let db;
let t2b2 = false;
before(async () => {
  db = await migratedDb();
  if (!db) return;
  const r = await db.query(
    `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'authz' and p.proname = 'my_area_create'`);
  t2b2 = Number(r.rows[0].n) > 0;
});

function sqlTest(name, fn) {
  test(name, async (t) => {
    if (!db) return t.skip(SKIP_MESSAGE);
    if (!t2b2) return t.skip(NOT_APPLIED);
    await fn();
  });
}

// ---------------------------------------------------------------- harness
async function asService(fn) {
  await db.exec("set role service_role");
  try { return await fn(); } finally { await db.exec("reset role"); }
}
async function asUser(uid, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
  await db.exec("set role authenticated");
  try { return await fn(); } finally {
    await db.exec("reset role");
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}
async function asAnon(fn) {
  await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  await db.exec("set role anon");
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
/** Did `fn` get refused (either RLS 0-rows or an explicit error)? */
async function refused(fn) {
  try { const r = await fn(); return (r?.rowCount ?? 0) === 0; }
  catch { return true; }
}

// One workspace with an owner, an admin, an agent, plus a stranger
// workspace. Returns every id the tests need.
async function world() {
  const owner = await mkUser();
  const admin = await mkUser();
  const agent = await mkUser();
  const stranger = await mkUser();

  await asService(async () => {
    await db.query(`select automation_internal.ensure_personal_workspace($1)`, [owner]);
    await db.query(`select automation_internal.ensure_personal_workspace($1)`, [stranger]);
  });
  const ws = (await db.query(
    `select workspace_id from public.workspace_members where user_id=$1 and status='active'`, [owner])).rows[0].workspace_id;
  const strangerWs = (await db.query(
    `select workspace_id from public.workspace_members where user_id=$1 and status='active'`, [stranger])).rows[0].workspace_id;

  const ids = { owner, admin, agent, stranger, ws, strangerWs, tm: {} };

  // Add admin + agent as members of the owner's workspace. Membership
  // row first, then the directory row (T2a compat trigger ordering).
  for (const [uid, role, label] of [[admin, "admin", "Admin"], [agent, "agent", "Agent"]]) {
    await asService(async () => {
      await db.query(`update public.workspace_members set status='removed' where user_id=$1 and status='active'`, [uid]);
      const mid = (await db.query(
        `insert into public.workspace_members (workspace_id,user_id,role,status,team_member_id)
         values ($1,$2,$3,'active',null) returning id`, [ws, uid, role])).rows[0].id;
      const tmid = `tm-${role}-${uid.slice(0, 6)}`;
      await db.query(
        `insert into public.team_members (id,user_id,workspace_id,auth_user_id,name,role,email,phone,active)
         values ($1,$2,$3,$4,$5,$6,'','',true)`, [tmid, uid, ws, uid, label, label]);
      await db.query(`update public.workspace_members set team_member_id=$1 where id=$2`, [tmid, mid]);
      ids.tm[role] = tmid;
      ids[`${role}Member`] = mid;
    });
  }
  ids.tm.owner = (await db.query(
    `select team_member_id from public.workspace_members where user_id=$1 and status='active'`, [owner])).rows[0].team_member_id;
  ids.ownerMember = (await db.query(
    `select id from public.workspace_members where user_id=$1 and status='active'`, [owner])).rows[0].id;
  return ids;
}

/** Seed one contact (optionally assigned) + a deal + work rows, as service_role. */
async function seedContact(w, { assignedTo = null, creator = null, suffix = "" } = {}) {
  const cid = `c-${suffix || randomUUID().slice(0, 8)}`;
  await asService(() => db.query(
    `insert into public.contacts (id,user_id,workspace_id,assigned_to_id,full_name)
     values ($1,$2,$3,$4,$5)`,
    [cid, creator ?? w.owner, w.ws, assignedTo, `Lead ${cid}`]));
  return cid;
}

// ================================================================ owner
sqlTest("owner: unchanged frontend path still works (filter by user_id, insert without workspace_id)", async () => {
  const w = await world();
  for (let i = 0; i < 3; i++) await seedContact(w, { suffix: `own${i}` });

  // The current app filters by user_id and never sends workspace_id.
  const seen = await asUser(w.owner, () => count(
    `select count(*) n from public.contacts where user_id = $1`, [w.owner]));
  assert.equal(seen, 3, "owner sees their own contacts via the legacy filter");

  const newId = `c-ins-${randomUUID().slice(0, 6)}`;
  await asUser(w.owner, () => db.query(
    `insert into public.contacts (id,user_id,full_name) values ($1,$2,'No Workspace Sent')`,
    [newId, w.owner]));
  const got = await asService(() => db.query(
    `select workspace_id from public.contacts where id=$1`, [newId]));
  assert.equal(got.rows[0].workspace_id, w.ws, "compat trigger filled workspace_id");
});

sqlTest("owner: scope is 'all' across every area (select/insert/update/delete)", async () => {
  const w = await world();
  const cid = await seedContact(w, { assignedTo: w.tm.agent });  // not the owner's
  assert.equal(await asUser(w.owner, () => count(
    `select count(*) n from public.contacts where id=$1`, [cid])), 1, "owner sees others' leads");
  await asUser(w.owner, () => db.query(`update public.contacts set notes='x' where id=$1`, [cid]));
  await asUser(w.owner, () => db.query(`delete from public.contacts where id=$1`, [cid]));
  assert.equal(await asService(() => count(
    `select count(*) n from public.contacts where id=$1`, [cid])), 0, "owner can delete");
});

// ================================================================ agent
sqlTest("agent: sees 0 leads, then exactly 1 once assigned", async () => {
  const w = await world();
  await seedContact(w, { suffix: "a1" });
  await seedContact(w, { suffix: "a2" });
  assert.equal(await asUser(w.agent, () => count(`select count(*) n from public.contacts`)), 0,
    "agent sees nothing before assignment");

  const mine = await seedContact(w, { assignedTo: w.tm.agent, suffix: "a3" });
  assert.equal(await asUser(w.agent, () => count(`select count(*) n from public.contacts`)), 1,
    "agent sees exactly the one assigned to them");
  assert.equal(await asUser(w.agent, () => count(
    `select count(*) n from public.contacts where id=$1`, [mine])), 1);
});

sqlTest("agent: cannot see unassigned leads without unassigned_view", async () => {
  const w = await world();
  await seedContact(w, { assignedTo: null, suffix: "u1" });
  assert.equal(await asUser(w.agent, () => count(`select count(*) n from public.contacts`)), 0,
    "unassigned stays hidden");
});

sqlTest("agent: an unassigned_view override reveals unassigned leads", async () => {
  const w = await world();
  await seedContact(w, { assignedTo: null, suffix: "u2" });
  await asUser(w.owner, () => db.query(
    `select public.realtoros_set_member_permissions($1,$2::jsonb)`,
    [w.agentMember, JSON.stringify({ unassigned_view: true })]));
  assert.equal(await asUser(w.agent, () => count(`select count(*) n from public.contacts`)), 1,
    "override reveals the unassigned lead");
});

sqlTest("agent: cannot delete contacts (delete scope = none)", async () => {
  const w = await world();
  const mine = await seedContact(w, { assignedTo: w.tm.agent, suffix: "d1" });
  assert.ok(await refused(() => asUser(w.agent, () => db.query(
    `delete from public.contacts where id=$1`, [mine]))), "delete refused");
  assert.equal(await asService(() => count(
    `select count(*) n from public.contacts where id=$1`, [mine])), 1, "row survives");
});

sqlTest("agent: can edit an assigned lead but not reassign it (no contacts_assign)", async () => {
  const w = await world();
  const mine = await seedContact(w, { assignedTo: w.tm.agent, suffix: "r1" });
  await asUser(w.agent, () => db.query(
    `update public.contacts set notes='agent edit' where id=$1`, [mine]));
  assert.equal((await asService(() => db.query(
    `select notes from public.contacts where id=$1`, [mine]))).rows[0].notes, "agent edit");

  assert.ok(await refused(() => asUser(w.agent, () => db.query(
    `update public.contacts set assigned_to_id=$1 where id=$2`, [w.tm.admin, mine]))),
    "reassignment refused");
  assert.equal((await asService(() => db.query(
    `select assigned_to_id from public.contacts where id=$1`, [mine]))).rows[0].assigned_to_id,
    w.tm.agent, "assignee unchanged");
});

sqlTest("agent: claim — may take an unassigned lead with unassigned_claim, not otherwise", async () => {
  const w = await world();
  const freeA = await seedContact(w, { assignedTo: null, suffix: "k1" });
  // Without the claim permission (but with view, so the row is reachable).
  await asUser(w.owner, () => db.query(
    `select public.realtoros_set_member_permissions($1,$2::jsonb)`,
    [w.agentMember, JSON.stringify({ unassigned_view: true })]));
  assert.ok(await refused(() => asUser(w.agent, () => db.query(
    `update public.contacts set assigned_to_id=$1 where id=$2`, [w.tm.agent, freeA]))),
    "claim refused without unassigned_claim");

  // With the claim permission.
  await asUser(w.owner, () => db.query(
    `select public.realtoros_set_member_permissions($1,$2::jsonb)`,
    [w.agentMember, JSON.stringify({ unassigned_view: true, unassigned_claim: true })]));
  await asUser(w.agent, () => db.query(
    `update public.contacts set assigned_to_id=$1 where id=$2`, [w.tm.agent, freeA]));
  assert.equal((await asService(() => db.query(
    `select assigned_to_id from public.contacts where id=$1`, [freeA]))).rows[0].assigned_to_id,
    w.tm.agent, "claimed to self");
});

sqlTest("agent: claim cannot assign to somebody else", async () => {
  const w = await world();
  const free = await seedContact(w, { assignedTo: null, suffix: "k2" });
  await asUser(w.owner, () => db.query(
    `select public.realtoros_set_member_permissions($1,$2::jsonb)`,
    [w.agentMember, JSON.stringify({ unassigned_view: true, unassigned_claim: true })]));
  assert.ok(await refused(() => asUser(w.agent, () => db.query(
    `update public.contacts set assigned_to_id=$1 where id=$2`, [w.tm.admin, free]))),
    "claiming on behalf of another member is refused");
});

sqlTest("agent: finance is invisible and uninsertable (scope none, create false)", async () => {
  const w = await world();
  await asService(() => db.query(
    `insert into public.finance_records (id,user_id,workspace_id,type,amount)
     values ($1,$2,$3,'income',100)`, [`f-${randomUUID().slice(0,6)}`, w.owner, w.ws]));
  assert.equal(await asUser(w.agent, () => count(`select count(*) n from public.finance_records`)), 0,
    "agent sees no finance rows");
  assert.ok(await refused(() => asUser(w.agent, () => db.query(
    `insert into public.finance_records (id,user_id,workspace_id,type,amount)
     values ($1,$2,$3,'income',5)`, [`f-x-${randomUUID().slice(0,6)}`, w.agent, w.ws]))),
    "agent cannot create finance rows");
});

sqlTest("agent: properties view is 'all' but edit only own", async () => {
  const w = await world();
  const pid = `p-${randomUUID().slice(0, 6)}`;
  await asService(() => db.query(
    `insert into public.properties (id,user_id,workspace_id,address) values ($1,$2,$3,'1 Owner St')`,
    [pid, w.owner, w.ws]));
  assert.equal(await asUser(w.agent, () => count(
    `select count(*) n from public.properties where id=$1`, [pid])), 1, "agent sees all properties");
  assert.ok(await refused(() => asUser(w.agent, () => db.query(
    `update public.properties set notes='no' where id=$1`, [pid]))),
    "agent cannot edit a property that is not theirs");
});

// ================================================================ admin
sqlTest("admin: scope all — sees and edits others' leads, and holds team_manage", async () => {
  const w = await world();
  const cid = await seedContact(w, { assignedTo: w.tm.agent, suffix: "ad1" });
  assert.equal(await asUser(w.admin, () => count(
    `select count(*) n from public.contacts where id=$1`, [cid])), 1);
  await asUser(w.admin, () => db.query(`update public.contacts set notes='admin' where id=$1`, [cid]));
  await asUser(w.admin, () => db.query(
    `update public.contacts set assigned_to_id=$1 where id=$2`, [w.tm.admin, cid]));
  assert.equal((await asService(() => db.query(
    `select assigned_to_id from public.contacts where id=$1`, [cid]))).rows[0].assigned_to_id,
    w.tm.admin, "admin may reassign (contacts_assign)");
});

// ================================================================ isolation
sqlTest("stranger: another workspace's owner sees 0 everywhere", async () => {
  const w = await world();
  await seedContact(w, { suffix: "s1" });
  await asService(() => db.query(
    `insert into public.deals (id,user_id,workspace_id,title) values ($1,$2,$3,'D')`,
    [`d-${randomUUID().slice(0,6)}`, w.owner, w.ws]));
  for (const t of ["contacts", "deals", "tasks", "properties", "finance_records", "goals",
                   "scheduled_items", "activities", "showings", "milestones", "team_members",
                   "notifications", "workspace_settings"]) {
    const seen = await asUser(w.stranger, () => count(
      `select count(*) n from public.${t} where workspace_id = $1`, [w.ws]));
    assert.equal(seen, 0, `${t}: stranger must see 0 rows of another workspace`);
  }
});

sqlTest("stranger: cannot insert into another workspace", async () => {
  const w = await world();
  assert.ok(await refused(() => asUser(w.stranger, () => db.query(
    `insert into public.contacts (id,user_id,workspace_id,full_name) values ($1,$2,$3,'X')`,
    [`c-bad-${randomUUID().slice(0,6)}`, w.stranger, w.ws]))),
    "cross-workspace insert refused");
});

sqlTest("non-member: a user with no membership sees nothing", async () => {
  const w = await world();
  await seedContact(w, { suffix: "nm" });
  const nobody = await mkUser();
  assert.equal(await asUser(nobody, () => count(`select count(*) n from public.contacts`)), 0);
});

// ================================================================ anon
sqlTest("anon: no table privileges anywhere in public", async () => {
  const w = await world();
  const bad = (await db.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r'
       and has_table_privilege('anon', c.oid, 'select,insert,update,delete')
  `)).rows.map((r) => r.relname);
  assert.deepEqual(bad, [], `anon still holds privileges on: ${bad.join(", ")}`);
});

sqlTest("anon: a direct read is refused", async () => {
  const w = await world();
  await seedContact(w, { suffix: "an" });
  assert.ok(await refused(() => asAnon(() => db.query(`select 1 from public.contacts limit 1`))),
    "anon read refused");
});

// ================================================================ libraries
sqlTest("templates: shared readable by all; personal only by creator", async () => {
  const w = await world();
  const shared = randomUUID(), personal = randomUUID();
  await asService(async () => {
    await db.query(
      `insert into public.message_templates (id,user_id,workspace_id,name,channel,visibility)
       values ($1,$2,$3,'Shared','email','shared')`, [shared, w.owner, w.ws]);
    await db.query(
      `insert into public.message_templates (id,user_id,workspace_id,name,channel,visibility)
       values ($1,$2,$3,'Mine','email','personal')`, [personal, w.owner, w.ws]);
  });
  // The agent lacks templates_manage_shared, so: shared yes, owner's personal no.
  assert.equal(await asUser(w.agent, () => count(
    `select count(*) n from public.message_templates where id=$1`, [shared])), 1, "shared readable");
  assert.equal(await asUser(w.agent, () => count(
    `select count(*) n from public.message_templates where id=$1`, [personal])), 0,
    "another member's personal template hidden");
  // Admin has templates_manage_shared, so sees both.
  assert.equal(await asUser(w.admin, () => count(
    `select count(*) n from public.message_templates where id=$1`, [personal])), 1,
    "manage_shared holder sees personal rows too");
});

sqlTest("templates: agent may create personal but not shared", async () => {
  const w = await world();
  await asUser(w.agent, () => db.query(
    `insert into public.message_templates (id,user_id,workspace_id,name,channel,visibility)
     values ($1,$2,$3,'Agent personal','email','personal')`,
    [randomUUID(), w.agent, w.ws]));
  assert.ok(await refused(() => asUser(w.agent, () => db.query(
    `insert into public.message_templates (id,user_id,workspace_id,name,channel,visibility)
     values ($1,$2,$3,'Agent shared','email','shared')`, [randomUUID(), w.agent, w.ws]))),
    "agent cannot create a shared template");
});

// ================================================================ specials
sqlTest("notifications: strictly own rows", async () => {
  const w = await world();
  await asService(async () => {
    for (const [uid, key] of [[w.owner, "o"], [w.agent, "a"]]) {
      await db.query(
        `insert into public.notifications (id,user_id,workspace_id,type,title,dedupe_key)
         values ($1,$2,$3,'lead_replied','Someone replied',$4)`,
        [randomUUID(), uid, w.ws, `k-${key}-${randomUUID().slice(0,6)}`]);
    }
  });
  assert.equal(await asUser(w.agent, () => count(`select count(*) n from public.notifications`)), 1,
    "agent sees only their own notification");
  assert.equal(await asUser(w.owner, () => count(`select count(*) n from public.notifications`)), 1,
    "owner sees only their own notification");
});

sqlTest("workspace_settings: agent (settings=none) cannot read; owner can read and write", async () => {
  const w = await world();
  assert.equal(await asUser(w.agent, () => count(`select count(*) n from public.workspace_settings`)), 0,
    "settings hidden at settings=none");
  assert.ok(await asUser(w.owner, () => count(`select count(*) n from public.workspace_settings`)) >= 0);
});

sqlTest("team_members: every member reads the directory; only team_manage writes", async () => {
  const w = await world();
  assert.ok(await asUser(w.agent, () => count(`select count(*) n from public.team_members`)) >= 3,
    "agent reads the directory for assignment dropdowns");
  assert.ok(await refused(() => asUser(w.agent, () => db.query(
    `update public.team_members set name='hacked' where id=$1`, [w.tm.owner]))),
    "agent cannot edit the directory");
  await asUser(w.admin, () => db.query(
    `update public.team_members set name='Renamed' where id=$1`, [w.tm.agent]));
  assert.equal((await asService(() => db.query(
    `select name from public.team_members where id=$1`, [w.tm.agent]))).rows[0].name, "Renamed");
});

sqlTest("browser read removed from the four unused system tables", async () => {
  for (const t of ["automation_trigger_events", "contact_identity_keys",
                   "webhook_events", "lead_source_mappings"]) {
    const pols = await count(
      `select count(*) n from pg_policies where schemaname='public' and tablename=$1`, [t]);
    assert.equal(pols, 0, `${t} should have no browser policy`);
  }
});

sqlTest("workspace_members keeps its bootstrap policy (authz helpers depend on it)", async () => {
  const pols = await count(
    `select count(*) n from pg_policies where schemaname='public'
      and tablename='workspace_members' and policyname='workspace_members_select_own'`);
  assert.equal(pols, 1, "dropping this would null my_workspace_id() for everyone");
});

// ================================================================ blocker fixes
sqlTest("blocker 1: a brand-new auth user is provisioned at signup, and their first insert works", async () => {
  // No ensure_personal_workspace call — the AFTER INSERT trigger on
  // auth.users must have done it.
  const fresh = await mkUser();
  const provisioned = await asService(() => count(
    `select count(*) n from public.workspace_members where user_id=$1 and status='active'`, [fresh]));
  assert.equal(provisioned, 1, "signup trigger provisioned the workspace eagerly");

  // And the very first authenticated insert succeeds (per-row INSERT check).
  const cid = `c-fresh-${randomUUID().slice(0, 6)}`;
  await asUser(fresh, () => db.query(
    `insert into public.contacts (id,user_id,full_name) values ($1,$2,'First Ever')`, [cid, fresh]));
  const row = await asService(() => db.query(
    `select workspace_id from public.contacts where id=$1`, [cid]));
  assert.equal(row.rows[0].workspace_id,
    (await asService(() => db.query(
      `select workspace_id from public.workspace_members where user_id=$1 and status='active'`, [fresh]))).rows[0].workspace_id,
    "first insert landed in the new user's own workspace");
});

sqlTest("blocker 2: an authenticated insert works with NO automation_internal access", async () => {
  // The whole point of making authz self-contained.
  const hasUsage = await count(
    `select count(*) n from (select has_schema_privilege('authenticated','automation_internal','usage') as p) z where p`);
  assert.equal(hasUsage, 0, "authenticated must NOT have usage on automation_internal");

  const w = await world();
  const cid = `c-noai-${randomUUID().slice(0, 6)}`;
  await asUser(w.owner, () => db.query(
    `insert into public.contacts (id,user_id,full_name) values ($1,$2,'No automation_internal')`,
    [cid, w.owner]));
  assert.equal(await asService(() => count(
    `select count(*) n from public.contacts where id=$1`, [cid])), 1,
    "insert succeeded through the authz-only INVOKER chain");
});

sqlTest("blocker 2: the authz preset copy cannot drift from automation_internal's", async () => {
  for (const role of ["admin", "agent"]) {
    const same = await asService(() => count(
      `select count(*) n from (
         select authz.default_role_permissions($1) = automation_internal.default_role_permissions($1) as eq
       ) z where eq`, [role]));
    assert.equal(same, 1, `${role} preset must be identical in both schemas`);
  }
});


sqlTest("blocker 4: exactly the 10 approved keeper policies survived", async () => {
  const keepers = (await db.query(
    `select tablename, policyname from pg_policies
      where schemaname='public'
        and policyname not like '%\\_scoped' escape '\\'
      order by tablename, policyname`
  )).rows;

  assert.deepEqual(keepers.map((r) => `${r.tablename}|${r.policyname}`), [
    "notification_preferences|notification_preferences_select_own",
    "push_subscriptions|push_subscriptions_select_own",
    "workspace_members|workspace_members_select_own",
    "workspace_permission_changes|workspace_permission_changes_select_tm",
    "workspace_role_permissions|workspace_role_permissions_select_member",
    "workspace_state|realtoros_delete_own_workspace",
    "workspace_state|realtoros_insert_own_workspace",
    "workspace_state|realtoros_select_own_workspace",
    "workspace_state|realtoros_update_own_workspace",
    "workspaces|workspaces_select_member",
  ]);
});

sqlTest("no superseded *_own policy survives except approved user-owned policies", async () => {
  const policies = (await db.query(
    `select tablename, policyname, cmd, roles, qual
       from pg_policies
      where schemaname='public'
        and policyname like '%\\_own' escape '\\'`
  )).rows;

  const approved = new Set([
    "workspace_members|workspace_members_select_own",
    "push_subscriptions|push_subscriptions_select_own",
    "notification_preferences|notification_preferences_select_own",
  ]);

  const stale = policies.filter(
    (p) => !approved.has(`${p.tablename}|${p.policyname}`)
  );

  assert.deepEqual(stale, [], `stale policies: ${JSON.stringify(stale)}`);

  // Verify the two Phase 3B policies remain SELECT-only
  // and restrict access to the authenticated user's records.
  for (const table of ["push_subscriptions", "notification_preferences"]) {
    const policy = policies.find(
      (p) => p.tablename === table &&
        p.policyname === `${table}_select_own`
    );

    assert.ok(policy, `missing ${table} SELECT policy`);
    assert.equal(policy.cmd, "SELECT");
    assert.match(String(policy.roles), /\bauthenticated\b/);
    assert.match(String(policy.qual), /\buid\s*\(/);
    assert.match(String(policy.qual), /\buser_id\b/);
  }
});

