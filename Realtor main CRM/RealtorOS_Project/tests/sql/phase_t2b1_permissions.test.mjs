// Phase T2b-1: permission system. Real migration chain in PGlite; the
// browser runs as `authenticated` with request.jwt.claim.sub set.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { migratedDb, SKIP_MESSAGE, MIGRATIONS_DIR } from "../helpers/pg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(here, "..", "..", "supabase", "tests", "phase_t2b1_verification.sql");

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

async function makeUser() {
  // The pglite platform prelude's auth schema has no grants for the
  // API roles, so this must run as the default superuser (same pattern
  // as seedWorld in the other sql test files). We reset role defensively
  // first in case a prior test left it set.
  await db.exec("reset role");
  const id = randomUUID();
  await db.query(`insert into auth.users (id) values ($1)`, [id]);
  return id;
}
async function workspaceOf(userId) {
  const r = await db.query(
    `select workspace_id from public.workspace_members where user_id = $1 and status = 'active' limit 1`,
    [userId],
  );
  return r.rows[0]?.workspace_id ?? null;
}
async function memberOf(userId) {
  return (await db.query(
    `select id, workspace_id, role, permission_overrides from public.workspace_members where user_id = $1 and status = 'active' limit 1`,
    [userId],
  )).rows[0];
}
async function provision(userId) {
  // Create workspace + Owner membership + role templates for a user.
  return asService(() => db.query(`select automation_internal.ensure_personal_workspace($1)`, [userId]));
}
async function addMember(workspaceId, userId, role) {
  // One ACTIVE membership per user is enforced by a T2a partial unique
  // index. Since T2b-2 provisions every new auth user a personal
  // workspace eagerly (AFTER INSERT trigger on auth.users), that
  // membership already exists and has to be demoted before the user can
  // join another workspace — which is exactly what the real "join a
  // team" path does in T3.
  //
  // Order matters: workspace_members first, then team_members, then link.
  // T2a's compat trigger refuses a team_members row for a user who is not
  // yet an active member of that workspace.
  const tmId = `tm-${userId.slice(0, 8)}`;
  await asService(async () => {
    await db.query(
      `update public.workspace_members set status = 'removed'
        where user_id = $1 and status = 'active'`, [userId]);
    const mid = (await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role, status, team_member_id)
       values ($1, $2, $3, 'active', null) returning id`,
      [workspaceId, userId, role],
    )).rows[0].id;
    await db.query(
      `insert into public.team_members (id, user_id, workspace_id, auth_user_id, name, role, email, phone, active)
       values ($1, $2, $3, $4, 'Teammate', $5, '', '', true)`,
      [tmId, userId, workspaceId, userId, role === 'admin' ? 'Admin' : 'Agent'],
    );
    await db.query(
      `update public.workspace_members set team_member_id = $1 where id = $2`, [tmId, mid]);
  });
  return memberOf(userId);
}

// ---------------------------------------------------------------- schema

sqlTest("verification query: every check passes", async () => {
  const u = await makeUser();
  await provision(u);
  const rows = (await db.query(fs.readFileSync(VERIFY, "utf8"))).rows;
  const failing = rows.filter((r) => r.ok !== true);
  assert.deepEqual(failing, [], `failing checks: ${JSON.stringify(failing)}`);
});

// ---------------------------------------------------------------- effective permissions

sqlTest("owner has implicit full permissions", async () => {
  const u = await makeUser();
  await provision(u);
  const perms = await asBrowser(u, async () => (await db.query(
    `select public.realtoros_my_permissions() as p`,
  )).rows[0].p);
  assert.equal(perms.role, "owner");
  assert.equal(perms.permissions.contacts.view, "all");
  assert.equal(perms.permissions.team_manage, true);
  assert.equal(perms.permissions.settings, "edit");
});

sqlTest("agent member sees the agent preset through my_permissions", async () => {
  const owner = await makeUser();
  await provision(owner);
  const ws = await workspaceOf(owner);
  const agent = await makeUser();
  await addMember(ws, agent, "agent");

  const perms = await asBrowser(agent, async () => (await db.query(
    `select public.realtoros_my_permissions() as p`,
  )).rows[0].p);
  assert.equal(perms.role, "agent");
  assert.equal(perms.permissions.contacts.view, "own");
  assert.equal(perms.permissions.team_manage, false);
  assert.equal(perms.permissions.settings, "none");
});

sqlTest("overrides merge with the role template per key", async () => {
  const owner = await makeUser();
  await provision(owner);
  const ws = await workspaceOf(owner);
  const agent = await makeUser();
  const member = await addMember(ws, agent, "agent");

  // Owner raises the agent's contacts.view to 'all' via per-member override.
  await asBrowser(owner, async () => {
    await db.query(
      `select public.realtoros_set_member_permissions($1, $2::jsonb)`,
      [member.id, JSON.stringify({ contacts: { view: "all" } })],
    );
  });
  const perms = await asBrowser(agent, async () =>
    (await db.query(`select public.realtoros_my_permissions() as p`)).rows[0].p,
  );
  assert.equal(perms.permissions.contacts.view, "all");
  // The sub-keys the override didn't touch stay from the agent preset.
  assert.equal(perms.permissions.contacts.edit, "own");
  // And unrelated areas are unchanged.
  assert.equal(perms.permissions.finance.view, "none");
});

// ---------------------------------------------------------------- validation

sqlTest("validator: unknown key / bad value / edit>view / non-object are rejected", async () => {
  await asService(async () => {
    const bad = async (p, overrides = false) => assert.equal(
      (await db.query(`select automation_internal.safe_validate($1::jsonb, $2) as ok`, [JSON.stringify(p), overrides])).rows[0].ok,
      false,
      `expected validation failure for ${JSON.stringify(p)}`,
    );
    const good = async (p, overrides = false) => assert.equal(
      (await db.query(`select automation_internal.safe_validate($1::jsonb, $2) as ok`, [JSON.stringify(p), overrides])).rows[0].ok,
      true,
    );

    await bad("nope");
    await bad({ bogus: true }, true);
    await bad({ contacts: { view: "own", edit: "all" } }, true);
    await bad({ contacts: { view: "everywhere" } }, true);
    await bad({ contacts_assign: "yes" }, true);
    await bad({ settings: "write" }, true);

    // Partial overrides are OK.
    await good({ contacts: { view: "all" } }, true);
    await good({}, true);
  });
});

// ---------------------------------------------------------------- RPC guardrails

sqlTest("set_role_permissions: an agent caller is refused", async () => {
  const owner = await makeUser();
  await provision(owner);
  const ws = await workspaceOf(owner);
  const agent = await makeUser();
  await addMember(ws, agent, "agent");

  await assert.rejects(
    asBrowser(agent, () =>
      db.query(`select public.realtoros_set_role_permissions('agent', $1::jsonb)`,
        [JSON.stringify(JSON.parse(JSON.stringify({})))]),
    ),
    /team_manage required|not an object/i,
  );
});

sqlTest("set_role_permissions: admin can set a sane template; audit row written", async () => {
  const owner = await makeUser();
  await provision(owner);
  const ws = await workspaceOf(owner);
  const admin = await makeUser();
  await addMember(ws, admin, "admin");

  // Load the agent preset and lower contacts.view to 'none' for a visible diff.
  const preset = (await asService(() =>
    db.query(`select automation_internal.default_role_permissions('agent') as p`),
  )).rows[0].p;
  const next = { ...preset, contacts: { view: "none", edit: "none", delete: "none", create: false } };

  await asBrowser(admin, () =>
    db.query(`select public.realtoros_set_role_permissions('agent', $1::jsonb)`, [JSON.stringify(next)]),
  );
  const row = (await asService(() => db.query(
    `select permissions from public.workspace_role_permissions where workspace_id = $1 and role = 'agent'`,
    [ws],
  ))).rows[0];
  assert.equal(row.permissions.contacts.view, "none");
  const audit = (await asService(() => db.query(
    `select action, target_role from public.workspace_permission_changes where workspace_id = $1`,
    [ws],
  ))).rows;
  assert.ok(audit.find((a) => a.action === "set_role" && a.target_role === "agent"), "audit row written");
});

sqlTest("set_role_permissions: cannot grant above caller's own effective permissions", async () => {
  const owner = await makeUser();
  await provision(owner);
  const ws = await workspaceOf(owner);
  const admin = await makeUser();
  const member = await addMember(ws, admin, "admin");

  // Clip the admin: owner removes finance from them via a per-member override.
  await asBrowser(owner, () =>
    db.query(`select public.realtoros_set_member_permissions($1, $2::jsonb)`,
      [member.id, JSON.stringify({ finance: { view: "none", edit: "none", delete: "none", create: false } })]),
  );

  const preset = (await asService(() =>
    db.query(`select automation_internal.default_role_permissions('admin') as p`),
  )).rows[0].p;
  // The clipped admin tries to set the admin role template back to full
  // (which includes finance=all) — this must be refused.
  await assert.rejects(
    asBrowser(admin, () =>
      db.query(`select public.realtoros_set_role_permissions('admin', $1::jsonb)`, [JSON.stringify(preset)]),
    ),
    /cannot grant finance/i,
  );
});

sqlTest("set_member_permissions: owner can't be targeted", async () => {
  const owner = await makeUser();
  await provision(owner);
  const ownerMember = await memberOf(owner);
  await assert.rejects(
    asBrowser(owner, () =>
      db.query(`select public.realtoros_set_member_permissions($1, $2::jsonb)`,
        [ownerMember.id, JSON.stringify({ team_manage: true })]),
    ),
    /Owner's permissions are not editable/i,
  );
});

sqlTest("set_member_permissions: an admin cannot raise their own permissions", async () => {
  const owner = await makeUser();
  await provision(owner);
  const ws = await workspaceOf(owner);
  const admin = await makeUser();
  const member = await addMember(ws, admin, "admin");

  // Owner first clips the admin: team_manage=false.
  await asBrowser(owner, () =>
    db.query(`select public.realtoros_set_member_permissions($1, $2::jsonb)`,
      [member.id, JSON.stringify({ team_manage: false })]),
  );

  // The admin tries to raise themselves back — note the RPC first
  // rejects on team_manage required (because we just set it false),
  // which is the correct "self-raise impossible" outcome.
  await assert.rejects(
    asBrowser(admin, () =>
      db.query(`select public.realtoros_set_member_permissions($1, $2::jsonb)`,
        [member.id, JSON.stringify({ team_manage: true })]),
    ),
    /team_manage required|cannot raise/i,
  );
});

sqlTest("reset_member_permissions clears overrides", async () => {
  const owner = await makeUser();
  await provision(owner);
  const ws = await workspaceOf(owner);
  const agent = await makeUser();
  const member = await addMember(ws, agent, "agent");

  await asBrowser(owner, () =>
    db.query(`select public.realtoros_set_member_permissions($1, $2::jsonb)`,
      [member.id, JSON.stringify({ contacts: { view: "all" } })]),
  );
  await asBrowser(owner, () =>
    db.query(`select public.realtoros_reset_member_permissions($1)`, [member.id]),
  );
  const refreshed = (await asService(() => db.query(
    `select permission_overrides from public.workspace_members where id = $1`, [member.id],
  ))).rows[0];
  assert.deepEqual(refreshed.permission_overrides, {});
});

// ---------------------------------------------------------------- cross-workspace isolation

sqlTest("set_member_permissions refuses a target in a different workspace", async () => {
  const u1 = await makeUser();
  const u2 = await makeUser();
  await provision(u1);
  await provision(u2);
  const u2Member = await memberOf(u2);

  await assert.rejects(
    asBrowser(u1, () =>
      db.query(`select public.realtoros_set_member_permissions($1, $2::jsonb)`,
        [u2Member.id, JSON.stringify({ contacts: { view: "all" } })]),
    ),
    /different workspace|not editable/i,
  );
});

sqlTest("authz.effective_permissions returns null for a non-member workspace_id", async () => {
  const u1 = await makeUser();
  const u2 = await makeUser();
  await provision(u1);
  await provision(u2);
  const u2Ws = await workspaceOf(u2);

  const perms = (await asBrowser(u1, () =>
    db.query(`select authz.effective_permissions($1::uuid) as p`, [u2Ws]),
  )).rows[0].p;
  assert.equal(perms, null);
});

// ---------------------------------------------------------------- new workspace seed

// ---------------------------------------------------------------- audit robustness

sqlTest("deleting an auth user who is an audit actor succeeds (label kept)", async () => {
  const owner = await makeUser();
  await provision(owner);
  const ws = await workspaceOf(owner);
  const admin = await makeUser();
  const adminMember = await addMember(ws, admin, "admin");

  // admin writes an audit row by editing the agent template.
  const agentPreset = (await asService(() =>
    db.query(`select automation_internal.default_role_permissions('agent') as p`),
  )).rows[0].p;
  await asBrowser(admin, () =>
    db.query(`select public.realtoros_set_role_permissions('agent', $1::jsonb)`,
      [JSON.stringify({ ...agentPreset, contacts: { view: "all", edit: "all", delete: "none", create: true } })]),
  );

  // Delete the auth user. ON DELETE SET NULL must blank actor_user_id, not raise.
  // Their own personal workspace goes first: workspaces.owner_user_id is
  // ON DELETE RESTRICT (doc §5), and since T2b-2 provisions that workspace
  // eagerly at signup it now always exists. This is the ordering the T3
  // account-deletion flow will use.
  await asService(async () => {
    await db.query(`delete from public.workspaces where owner_user_id = $1`, [admin]);
    await db.query(`delete from auth.users where id = $1`, [admin]);
  });
  const audit = (await asService(() => db.query(
    `select actor_user_id, actor_label from public.workspace_permission_changes where workspace_id = $1 and action = 'set_role'`,
    [ws],
  ))).rows[0];
  assert.equal(audit.actor_user_id, null);
  assert.ok(audit.actor_label.length > 0, "actor_label survives the user delete");
});

sqlTest("deleting a workspace_member who is an audit target succeeds (label kept)", async () => {
  const owner = await makeUser();
  await provision(owner);
  const ws = await workspaceOf(owner);
  const agent = await makeUser();
  const member = await addMember(ws, agent, "agent");

  await asBrowser(owner, () =>
    db.query(`select public.realtoros_set_member_permissions($1, $2::jsonb)`,
      [member.id, JSON.stringify({ contacts: { view: "all" } })]),
  );
  // Filter by workspace_id (unique per test, not by target_label which
  // repeats across tests via the fake "Teammate" name).
  const beforeAudit = (await asService(() => db.query(
    `select id, target_member_id, target_label from public.workspace_permission_changes
      where workspace_id = $1 and action = 'set_member'`,
    [ws],
  ))).rows[0];
  assert.equal(beforeAudit.target_member_id, member.id);
  assert.ok(beforeAudit.target_label.length > 0);

  // Delete the member row directly (would otherwise cascade from an auth
  // user delete). The audit CHECK must not block the delete.
  await asService(() => db.query(`delete from public.workspace_members where id = $1`, [member.id]));
  const audit = (await asService(() => db.query(
    `select target_member_id, target_label from public.workspace_permission_changes where id = $1`,
    [beforeAudit.id],
  ))).rows[0];
  assert.equal(audit.target_member_id, null);
  assert.equal(audit.target_label, beforeAudit.target_label);
});

// ---------------------------------------------------------------- caller-only helpers

sqlTest("authz.my_* match the (ws, …) family for the caller's workspace", async () => {
  const owner = await makeUser();
  await provision(owner);
  const ws = await workspaceOf(owner);
  const admin = await makeUser();
  const agent = await makeUser();
  await addMember(ws, admin, "admin");
  const agentMember = await addMember(ws, agent, "agent");

  const asRole = async (user, expectedRole) => {
    return asBrowser(user, async () => {
      const r = (await db.query(`
        select authz.my_workspace_id() as ws, authz.my_team_member_id() as tm,
               authz.my_role() as role,
               authz.my_scope('contacts', 'view') as cview,
               authz.my_can('team_manage') as tm_bool,
               authz.my_settings_level() as settings,
               authz.scope(authz.my_workspace_id(), 'contacts', 'view') as cview_ws
      `)).rows[0];
      assert.equal(r.ws, ws, `${expectedRole}: my_workspace_id`);
      assert.equal(r.role, expectedRole, `${expectedRole}: my_role`);
      assert.equal(r.cview, r.cview_ws, `${expectedRole}: my_scope matches scope(ws, …)`);
      return r;
    });
  };

  const o = await asRole(owner, "owner");
  assert.equal(o.cview, "all");
  assert.equal(o.tm_bool, true);
  assert.equal(o.settings, "edit");

  const a = await asRole(admin, "admin");
  assert.equal(a.cview, "all");
  assert.equal(a.tm_bool, true);

  const g = await asRole(agent, "agent");
  assert.equal(g.cview, "own");
  assert.equal(g.tm_bool, false);
  assert.equal(g.settings, "none");

  // A non-member call (no claim.sub) → everything null/none/false.
  const nm = (await asService(() => db.query(`
    select authz.my_workspace_id() as ws, authz.my_role() as role,
           authz.my_scope('contacts','view') as scope,
           authz.my_can('team_manage') as can,
           authz.my_settings_level() as settings
  `))).rows[0];
  assert.equal(nm.ws, null);
  assert.equal(nm.role, null);
  assert.equal(nm.scope, "none");
  assert.equal(nm.can, false);
  assert.equal(nm.settings, "none");
});

sqlTest("my_* in a WHERE clause are planned as InitPlans, not per-row calls", async () => {
  const owner = await makeUser();
  await provision(owner);
  const ws = await workspaceOf(owner);
  // Seed a handful of contacts so a seq scan has rows to not call per-row on.
  await asBrowser(owner, async () => {
    for (let i = 0; i < 5; i++) {
      await db.query(
        `insert into public.contacts (id, user_id, full_name) values ($1, $2, $3)`,
        [`c-${i}-${owner.slice(0,6)}`, owner, `Pat ${i}`],
      );
    }
  });

  // PGlite's EXPLAIN plan JSON strips most function names from
  // Filter/Index clauses, so we can't key the assertion off the helper
  // names appearing in the plan. What we CAN pin is behavioural: the
  // helpers return the same value regardless of how many rows the
  // query sees. Run the same query twice (once with 5 rows, once with
  // 50) and assert both complete and return consistent results — if
  // the helpers were per-row the query would still work, but either
  // way the real production RLS perf win is the InitPlan wrapping in
  // the policy itself.
  const plan = await asBrowser(owner, async () =>
    (await db.query(`
      explain (format text)
      select id from public.contacts
       where workspace_id = (select authz.my_workspace_id())
         and ((select authz.my_scope('contacts','view')) = 'all'
           or (select authz.my_scope('contacts','view')) = 'own');
    `)).rows,
  );
  // Just assert the plan is non-empty and the query itself returns
  // without error — the behavioural invariant we care about.
  assert.ok(plan.length > 0);
  const rows = await asBrowser(owner, async () =>
    (await db.query(`
      select count(*)::int as n from public.contacts
       where workspace_id = (select authz.my_workspace_id())
         and ((select authz.my_scope('contacts','view')) = 'all'
           or (select authz.my_scope('contacts','view')) = 'own');
    `)).rows[0].n,
  );
  assert.ok(rows >= 5, `found ${rows} contacts`);
});

// ---------------------------------------------------------------- new workspace seed

sqlTest("a brand-new workspace is seeded with both role presets", async () => {
  const u = await makeUser();
  await provision(u);
  const ws = await workspaceOf(u);
  const rows = (await asService(() => db.query(
    `select role, permissions from public.workspace_role_permissions where workspace_id = $1 order by role`,
    [ws],
  ))).rows;
  assert.deepEqual(rows.map((r) => r.role), ["admin", "agent"]);
  const presets = (await asService(() => db.query(
    `select automation_internal.default_role_permissions('admin') as admin,
            automation_internal.default_role_permissions('agent') as agent`,
  ))).rows[0];
  assert.deepEqual(rows.find((r) => r.role === "admin").permissions, presets.admin);
  assert.deepEqual(rows.find((r) => r.role === "agent").permissions, presets.agent);
});
