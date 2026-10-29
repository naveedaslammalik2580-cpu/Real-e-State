// Phase C-1: deterministic workspace selection. Real migration chain in
// PGlite.
//
// DISCOVERY THAT SHAPES THESE TESTS (2026-10-29): the original C-1
// regression plan - "create a user with TWO active memberships" - is
// impossible in this schema, by design. T2a enforces one ACTIVE
// membership per person with the partial unique index
// workspace_members_one_active_per_user (an owner decision recorded in
// that migration), and T3's accept-invitation flow removes the previous
// active membership before activating a new one. So the bare LIMIT 1
// picks the C-1 migration replaced could only ever match one row: the
// defect was latent-by-constraint. The C-1 ORDER BY is defense-in-depth
// for the day that constraint is relaxed.
//
// What CAN and is pinned here:
//   1. The one-active constraint itself still holds (a second active
//      membership is rejected), so nobody "fixes" C-1 by quietly
//      dropping the guard that makes it latent.
//   2. With memberships in several workspaces in mixed statuses
//      (active / suspended / removed), EVERY resolver in the C-1 family
//      returns the one ACTIVE membership - consistently, across
//      repeated calls, and in agreement with each other. Statuses other
//      than 'active' must never leak into the pick, whichever workspace
//      is older, newer, or owned.
//   3. A single-workspace user (the provisioning path) is unaffected.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedDb, one, SKIP_MESSAGE } from "../helpers/pg.mjs";

let db;
before(async () => { db = await migratedDb(); await seedWorld(); });

function sqlTest(name, fn) {
  test(name, async (t) => {
    if (!db) return t.skip(SKIP_MESSAGE);
    await fn();
  });
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
  const id = randomUUID();
  await db.query(`insert into auth.users (id) values ($1)`, [id]);
  return id;
}

async function makeWorkspace(ownerId, createdAt) {
  const id = randomUUID();
  await db.query(
    `insert into public.workspaces (id, name, owner_user_id, created_at, updated_at)
     values ($1, 'W', $2, $3, $3)`,
    [id, ownerId, createdAt],
  );
  return id;
}

// Membership seeding follows the established suite pattern (see
// phase_t2b1_permissions.test.mjs): workspace_members first with a null
// team_member_id, then the team_members directory row, then the link -
// T2a's compat trigger refuses a team_members row for a user who is not
// yet a member of that workspace, and the FK refuses the reverse order.
async function addMember(workspaceId, userId, role, status, teamMemberId) {
  const mid = (await db.query(
    `insert into public.workspace_members (workspace_id, user_id, role, status, team_member_id)
     values ($1, $2, $3, $4, null) returning id`,
    [workspaceId, userId, role, status],
  )).rows[0].id;
  if (teamMemberId) {
    await db.query(
      `insert into public.team_members (id, user_id, workspace_id, auth_user_id, name, role, email, phone, active)
       values ($1, $2, $3, $4, 'Member', $5, '', '', true)`,
      [teamMemberId, userId, workspaceId, userId, role === "admin" ? "Admin" : role === "owner" ? "Owner" : "Agent"],
    );
    await db.query(
      `update public.workspace_members set team_member_id = $1 where id = $2`,
      [teamMemberId, mid],
    );
  }
}

// Every auth.users insert is eagerly provisioned a personal workspace
// with an ACTIVE owner membership (T2b-2 AFTER INSERT trigger), exactly
// as on live. Moving a fixture user into a different active workspace
// therefore starts by demoting that membership - the same thing T3's
// real join-a-team path does.
async function demoteAutoProvisioned(userId) {
  await db.query(
    `update public.workspace_members set status = 'removed'
      where user_id = $1 and status = 'active'`,
    [userId],
  );
}

// The world, built once:
//   wsA - owned by other1, created FIRST (2026-01-01)
//   wsB - owned by userU,  created LATER (2026-02-01)
//   wsC - owned by other2, created LAST  (2026-03-01)
// userU: wsA 'removed', wsC 'suspended', wsB 'active' (owner) -> wsB.
// userV: wsC 'removed', wsA 'active' (agent)                  -> wsA.
const W = {};
async function seedWorld() {
  if (!db) return;
  W.other1 = await makeUser();
  W.other2 = await makeUser();
  W.userU = await makeUser();
  W.userV = await makeUser();
  W.wsA = await makeWorkspace(W.other1, "2026-01-01T00:00:00Z");
  W.wsB = await makeWorkspace(W.userU, "2026-02-01T00:00:00Z");
  W.wsC = await makeWorkspace(W.other2, "2026-03-01T00:00:00Z");
  await demoteAutoProvisioned(W.userU);
  await demoteAutoProvisioned(W.userV);
  await addMember(W.wsA, W.userU, "agent", "removed", null);
  await addMember(W.wsC, W.userU, "agent", "suspended", null);
  await addMember(W.wsB, W.userU, "owner", "active", "tm_u_in_b");
  await addMember(W.wsC, W.userV, "agent", "removed", null);
  await addMember(W.wsA, W.userV, "agent", "active", "tm_v_in_a");
}

sqlTest("the one-active-membership constraint still holds", async () => {
  await assert.rejects(
    () => db.query(
      `insert into public.workspace_members (workspace_id, user_id, role, status, team_member_id)
       values ($1, $2, 'agent', 'active', null)`,
      [W.wsA, W.userU],
    ),
    /workspace_members_one_active_per_user/,
    "a second ACTIVE membership must stay impossible while T2a's index stands",
  );
});

sqlTest("every resolver returns the one active membership, every call (U)", async () => {
  for (let i = 0; i < 5; i++) {
    const row = await asBrowser(W.userU, () =>
      one(db, `select authz.my_workspace_id() as ws`));
    assert.equal(row.ws, W.wsB, `call ${i}: my_workspace_id`);
  }
  const role = await asBrowser(W.userU, () =>
    one(db, `select authz.my_role() as r`));
  assert.equal(role.r, "owner");
  const tm = await asBrowser(W.userU, () =>
    one(db, `select authz.my_team_member_id() as tm`));
  assert.equal(tm.tm, "tm_u_in_b");
  const perms = await asBrowser(W.userU, () =>
    one(db, `select public.realtoros_my_permissions() as p`));
  assert.equal(perms.p.workspace_id, W.wsB);
  assert.equal(perms.p.role, "owner");
  assert.equal(perms.p.team_member_id, "tm_u_in_b");
});

sqlTest("every resolver returns the one active membership, every call (V)", async () => {
  for (let i = 0; i < 5; i++) {
    const row = await asBrowser(W.userV, () =>
      one(db, `select authz.my_workspace_id() as ws`));
    assert.equal(row.ws, W.wsA, `call ${i}: my_workspace_id`);
  }
  const perms = await asBrowser(W.userV, () =>
    one(db, `select public.realtoros_my_permissions() as p`));
  assert.equal(perms.p.workspace_id, W.wsA);
  assert.equal(perms.p.role, "agent");
});

sqlTest("provisioning + worker helpers agree with the authz helpers", async () => {
  for (let i = 0; i < 3; i++) {
    const a = await one(db,
      `select automation_internal.ensure_personal_workspace($1) as ws`, [W.userU]);
    assert.equal(a.ws, W.wsB, `call ${i}: ensure_personal_workspace(U)`);
    const b = await one(db,
      `select automation_internal.workspace_of($1) as ws`, [W.userU]);
    assert.equal(b.ws, W.wsB, `call ${i}: workspace_of(U)`);
    const c = await one(db,
      `select automation_internal.ensure_personal_workspace($1) as ws`, [W.userV]);
    assert.equal(c.ws, W.wsA, `call ${i}: ensure_personal_workspace(V)`);
    const d = await one(db,
      `select automation_internal.workspace_of($1) as ws`, [W.userV]);
    assert.equal(d.ws, W.wsA, `call ${i}: workspace_of(V)`);
  }
});

sqlTest("a single-workspace user is unaffected", async () => {
  const solo = await makeUser();
  const ws = await one(db,
    `select automation_internal.ensure_personal_workspace($1) as ws`, [solo]);
  assert.ok(ws.ws, "provisioning created a workspace");
  const row = await asBrowser(solo, () =>
    one(db, `select authz.my_workspace_id() as ws`));
  assert.equal(row.ws, ws.ws);
});
