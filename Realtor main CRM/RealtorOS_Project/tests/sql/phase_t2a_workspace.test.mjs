// Phase T2a: workspace foundation. Real migration chain in PGlite; the
// browser runs as `authenticated` with request.jwt.claim.sub set, writers
// run as `service_role`. These tests pin the invariants the T2a migration
// is supposed to deliver: idempotent provisioning, the compat BEFORE
// INSERT trigger, cross-workspace rejection, and the uniqueness rules.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { migratedDb, one, SKIP_MESSAGE, MIGRATIONS_DIR } from "../helpers/pg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(here, "..", "..", "supabase", "tests", "phase_t2a_verification.sql");
const MIGRATION_T2A = "20261001160608_phase_t2a_workspace_foundation.sql";

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

async function makeUser(_email) {
  // The platform-prelude auth.users only has `id`. ensure_personal_workspace
  // reads email through to_jsonb(u)->>'email' which gracefully returns null
  // when the column is absent, so there is nothing more to seed here.
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

// ---------------------------------------------------------------- schema

sqlTest("verification query: every check passes", async () => {
  // Seed one real user so the "count = auth.users count" checks have
  // something to compare — the migration ran on an empty db for the
  // test harness.
  const u = await makeUser();
  await db.exec(`select automation_internal.ensure_personal_workspace('${u}')`);
  const rows = (await db.query(fs.readFileSync(VERIFY, "utf8"))).rows;
  const failing = rows.filter((r) => r.ok !== true);
  assert.deepEqual(failing, [], `failing checks: ${JSON.stringify(failing)}`);
  assert.ok(rows.length >= 25, `got ${rows.length} checks`);
});

sqlTest("migration is re-runnable (idempotent)", async () => {
  await db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_T2A), "utf8"));
  const rows = (await db.query(fs.readFileSync(VERIFY, "utf8"))).rows;
  assert.deepEqual(rows.filter((r) => r.ok !== true), []);
});

// ---------------------------------------------------------------- provisioning

sqlTest("ensure_personal_workspace: idempotent (two calls return the same workspace)", async () => {
  const u = await makeUser();
  const a = (await db.query(`select automation_internal.ensure_personal_workspace($1) as id`, [u])).rows[0].id;
  const b = (await db.query(`select automation_internal.ensure_personal_workspace($1) as id`, [u])).rows[0].id;
  assert.equal(a, b);
  // Exactly one workspace, one member, one Owner team_members for this
  // user. pglite returns bigint counts as strings; compare as strings.
  assert.equal(String((await db.query(`select count(*) from public.workspaces where owner_user_id = $1`, [u])).rows[0].count), "1");
  assert.equal(String((await db.query(`select count(*) from public.workspace_members where user_id = $1`, [u])).rows[0].count), "1");
  assert.equal(String((await db.query(`select count(*) from public.team_members where auth_user_id = $1`, [u])).rows[0].count), "1");
});

sqlTest("ensure_personal_workspace: null user_id raises", async () => {
  await assert.rejects(
    db.query(`select automation_internal.ensure_personal_workspace(null)`),
    /user_id is null/,
  );
});

// ---------------------------------------------------------------- compat trigger

sqlTest("compat trigger fills workspace_id for an authenticated insert that omits it", async () => {
  const u = await makeUser();
  await asService(async () => {
    await db.query(`select automation_internal.ensure_personal_workspace($1)`, [u]);
  });
  const ws = await workspaceOf(u);

  await asBrowser(u, async () => {
    await db.query(
      `insert into public.contacts (id, user_id, full_name) values ($1, $2, 'Pat')`,
      [`c-${randomUUID()}`, u],
    );
  });
  const r = await db.query(`select workspace_id from public.contacts where user_id = $1`, [u]);
  assert.equal(r.rows[0].workspace_id, ws);
});

sqlTest("compat trigger fills workspace_id for a service_role insert that omits it", async () => {
  const u = await makeUser();
  await asService(async () => {
    await db.query(`select automation_internal.ensure_personal_workspace($1)`, [u]);
    await db.query(
      `insert into public.contacts (id, user_id, full_name) values ($1, $2, 'ServicePat')`,
      [`c-${randomUUID()}`, u],
    );
  });
  const r = await db.query(`select workspace_id from public.contacts where user_id = $1`, [u]);
  assert.equal(r.rows[0].workspace_id, await workspaceOf(u));
});

sqlTest("brand-new user's first insert creates their workspace on the fly", async () => {
  const u = await makeUser();
  // No prior ensure_personal_workspace call — the compat trigger must run it.
  await asBrowser(u, async () => {
    await db.query(
      `insert into public.contacts (id, user_id, full_name) values ($1, $2, 'Fresh')`,
      [`c-${randomUUID()}`, u],
    );
  });
  const ws = await workspaceOf(u);
  assert.ok(ws, "workspace was created by the first insert");
  const r = await db.query(`select workspace_id from public.contacts where user_id = $1`, [u]);
  assert.equal(r.rows[0].workspace_id, ws);
});

sqlTest("authenticated insert with someone else's workspace_id is rejected", async () => {
  const alice = await makeUser("alice@test");
  const bob = await makeUser("bob@test");
  await asService(async () => {
    await db.query(`select automation_internal.ensure_personal_workspace($1)`, [alice]);
    await db.query(`select automation_internal.ensure_personal_workspace($1)`, [bob]);
  });
  const bobWs = await workspaceOf(bob);

  await assert.rejects(
    asBrowser(alice, () =>
      db.query(
        `insert into public.contacts (id, user_id, workspace_id, full_name)
         values ($1, $2, $3, 'Impersonator')`,
        [`c-${randomUUID()}`, alice, bobWs],
      ),
    ),
    /workspace_id does not belong to the row owner/,
  );
});

sqlTest("authenticated insert with the caller's own workspace_id is accepted", async () => {
  const u = await makeUser();
  await asService(async () => {
    await db.query(`select automation_internal.ensure_personal_workspace($1)`, [u]);
  });
  const ws = await workspaceOf(u);
  await asBrowser(u, async () => {
    await db.query(
      `insert into public.contacts (id, user_id, workspace_id, full_name)
       values ($1, $2, $3, 'Explicit')`,
      [`c-${randomUUID()}`, u, ws],
    );
  });
  const r = await db.query(`select workspace_id from public.contacts where user_id = $1`, [u]);
  assert.equal(r.rows[0].workspace_id, ws);
});

// ---------------------------------------------------------------- invariants

sqlTest("one active membership per user: second active row refused", async () => {
  const u = await makeUser();
  await asService(async () => {
    await db.query(`select automation_internal.ensure_personal_workspace($1)`, [u]);
    const w = randomUUID();
    await db.query(
      `insert into public.workspaces (id, name, owner_user_id) values ($1, 'Second', $2)`,
      [w, u],
    );
    await assert.rejects(
      db.query(
        `insert into public.workspace_members (workspace_id, user_id, role, status)
         values ($1, $2, 'owner', 'active')`,
        [w, u],
      ),
      /workspace_members_one_active_per_user/,
    );
  });
});

sqlTest("one active owner per workspace: a second active owner is refused", async () => {
  const alice = await makeUser();
  const bob = await makeUser();
  await asService(async () => {
    await db.query(`select automation_internal.ensure_personal_workspace($1)`, [alice]);
    // Since T2b-2 provisions every signup a personal workspace eagerly,
    // Bob already holds an active membership. Demote it first, otherwise
    // the one-active-per-USER index fires and we never reach the
    // one-active-OWNER-per-workspace index this test is about.
    await db.query(
      `update public.workspace_members set status = 'removed'
        where user_id = $1 and status = 'active'`, [bob]);
    const ws = (await db.query(
      `select id from public.workspaces where owner_user_id = $1`, [alice],
    )).rows[0].id;
    await assert.rejects(
      db.query(
        `insert into public.workspace_members (workspace_id, user_id, role, status)
         values ($1, $2, 'owner', 'active')`,
        [ws, bob],
      ),
      /workspace_members_one_active_owner_per_workspace/,
    );
  });
});

sqlTest("role CHECK enforces owner|admin|agent only", async () => {
  const u = await makeUser();
  const other = await makeUser();
  await asService(async () => {
    await db.query(`select automation_internal.ensure_personal_workspace($1)`, [u]);
    const ws = await workspaceOf(u);
    await assert.rejects(
      db.query(
        `insert into public.workspace_members (workspace_id, user_id, role, status)
         values ($1, $2, 'manager', 'active')`,
        [ws, other],
      ),
      /workspace_members_role_check/,
    );
  });
});

// ---------------------------------------------------------------- composite FK form

sqlTest("workspace_members FK uses column-scoped SET NULL (team_member_id only)", async () => {
  const u = await makeUser();
  await asService(async () => {
    await db.query(`select automation_internal.ensure_personal_workspace($1)`, [u]);
  });
  const before = await one(
    db,
    `select workspace_id, team_member_id from public.workspace_members where user_id = $1`,
    [u],
  );
  assert.ok(before.team_member_id);
  // Deleting the team_members row should null team_member_id but keep
  // workspace_id intact.
  await asService(async () => {
    await db.query(`delete from public.team_members where id = $1`, [before.team_member_id]);
  });
  const after = await one(
    db,
    `select workspace_id, team_member_id from public.workspace_members where user_id = $1`,
    [u],
  );
  assert.equal(after.workspace_id, before.workspace_id);
  assert.equal(after.team_member_id, null);
});
