// Phase T2a: seeded-rows backfill regression.
//
// Pins the live-dry-run failure (null-into-scheduled_items.assigned_to_name,
// which is NOT NULL on the live schema) and the full backfill behavior
// against a database that already has rows BEFORE T2a runs — the gap the
// first PGlite tests missed because they ran T2a against an empty db.
//
// Flow: migrate up to just-before T2a → seed one user with real rows across
// several tables + a fake team_members referenced by a scheduled_items row
// + four more auth users with no data → apply T2a → assert everything.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { migratedDb, platformDb, migrationFiles, SKIP_MESSAGE, MIGRATIONS_DIR } from "../helpers/pg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const T2A = "20261001160608_phase_t2a_workspace_foundation.sql";
const T2A_SQL = (() => {
  try { return fs.readFileSync(path.join(MIGRATIONS_DIR, T2A), "utf8"); }
  catch { return null; }
})();

async function freshDbBeforeT2a() {
  // migratedDb(filter) applies only the files the filter accepts, in
  // filename order — so filtering out T2A (and anything after it, like
  // T2b-1 which depends on workspaces) gives us the chain up to it.
  return migratedDb((f) => f < T2A);
}

function sqlTest(name, fn) {
  test(name, async (t) => {
    const db = await freshDbBeforeT2a();
    if (!db) return t.skip(SKIP_MESSAGE);
    await fn(db);
  });
}

async function seedLiveLikeWorld(db) {
  const owner = randomUUID();
  const extras = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const u of [owner, ...extras]) {
    await db.query(`insert into auth.users (id) values ($1)`, [u]);
  }

  // Fake team_members row (as reported on live), referenced by a
  // scheduled_items row with assigned_to set and assigned_to_name
  // non-empty — the exact shape that broke the dry run.
  const fakeTm = `tm-fake-${owner.slice(0, 8)}`;
  await db.query(
    `insert into public.team_members (id, user_id, name, role, email, phone, active)
     values ($1, $2, 'Pat Fake', 'Agent', '', '', true)`,
    [fakeTm, owner],
  );

  const scheduled = `sch-${owner.slice(0, 8)}`;
  await db.query(
    `insert into public.scheduled_items
       (id, user_id, title, type, date, time, assigned_to, assigned_to_name)
     values ($1, $2, 'Open house', 'Showing', '2026-10-05', '14:00', $3, 'Pat Fake')`,
    [scheduled, owner, fakeTm],
  );

  const contact = `c-${owner.slice(0, 8)}`;
  await db.query(
    `insert into public.contacts (id, user_id, full_name, email, status)
     values ($1, $2, 'Alex Owner', 'alex@test', 'New Lead')`,
    [contact, owner],
  );
  const deal = `d-${owner.slice(0, 8)}`;
  await db.query(
    `insert into public.deals (id, user_id, title, contact_id, side, stage)
     values ($1, $2, '123 Main', $3, 'Buyer', 'New')`,
    [deal, owner, contact],
  );
  await db.query(
    `insert into public.tasks (id, user_id, title, status) values ($1, $2, 'Prep CMA', 'To Do')`,
    [`t-${owner.slice(0, 8)}`, owner],
  );
  await db.query(
    `insert into public.notifications (id, user_id, type, title, body, dedupe_key)
     values ($1, $2, 'lead_replied', 'Alex replied', '', $3)`,
    [randomUUID(), owner, `seed:${owner}`],
  );
  await db.query(
    `insert into public.workspace_settings (id, user_id) values ($1, $2)`,
    [`ws-${owner.slice(0, 8)}`, owner],
  );

  return { owner, extras, fakeTm, scheduled, contact, deal };
}

sqlTest("T2a applies cleanly with live-like seeded rows", async (db) => {
  if (!T2A_SQL) assert.fail("migration file is missing");
  const seeded = await seedLiveLikeWorld(db);

  // Apply T2a as the actual production step.
  await db.exec(T2A_SQL);

  // 1. scheduled_items row cleared to (null, '') — never (null, null).
  const sch = (await db.query(
    `select assigned_to, assigned_to_name from public.scheduled_items where id = $1`,
    [seeded.scheduled],
  )).rows[0];
  assert.equal(sch.assigned_to, null);
  assert.equal(sch.assigned_to_name, "");

  // 2. The fake team_members row is gone; the owner's own backfilled
  //    team_members row is the only one left.
  const tms = (await db.query(`select id, name, role, auth_user_id from public.team_members where user_id = $1`, [seeded.owner])).rows;
  assert.equal(tms.length, 1);
  assert.equal(tms[0].role, "Owner");
  assert.equal(tms[0].auth_user_id, seeded.owner);
  assert.notEqual(tms[0].id, seeded.fakeTm);
  assert.equal((await db.query(`select count(*)::int as n from public.team_members where id = $1`, [seeded.fakeTm])).rows[0].n, 0);

  // 3. One workspace per auth user (5), each with one active owner.
  assert.equal(String((await db.query(`select count(*) from public.workspaces`)).rows[0].count), "5");
  assert.equal(String((await db.query(`select count(*) from public.workspace_members where role = 'owner' and status = 'active'`)).rows[0].count), "5");

  // 4. Every seeded row got the owner's workspace.
  const ws = (await db.query(`select workspace_id from public.workspace_members where user_id = $1 and status = 'active'`, [seeded.owner])).rows[0].workspace_id;
  for (const [table, id] of [
    ["scheduled_items", seeded.scheduled],
    ["contacts", seeded.contact],
    ["deals", seeded.deal],
  ]) {
    const r = (await db.query(`select workspace_id from public.${table} where id = $1`, [id])).rows[0];
    assert.equal(r.workspace_id, ws, `${table}.workspace_id for seeded row`);
  }
  // No row anywhere left with a null workspace_id (zero-nulls proof).
  for (const t of ["contacts", "deals", "tasks", "notifications", "scheduled_items", "workspace_settings", "team_members"]) {
    const n = (await db.query(`select count(*)::int as n from public.${t} where workspace_id is null`)).rows[0].n;
    assert.equal(n, 0, `${t} has ${n} null workspace_id rows after T2a`);
  }
});

sqlTest("T2a is re-runnable on a seeded database (no-op the second time)", async (db) => {
  if (!T2A_SQL) assert.fail("migration file is missing");
  const seeded = await seedLiveLikeWorld(db);

  await db.exec(T2A_SQL);
  // Snapshot the three "did anything change" counters.
  const workspacesBefore = String((await db.query(`select count(*) from public.workspaces`)).rows[0].count);
  const membersBefore = String((await db.query(`select count(*) from public.workspace_members`)).rows[0].count);
  const teamMembersBefore = String((await db.query(`select count(*) from public.team_members`)).rows[0].count);

  // Re-apply.
  await db.exec(T2A_SQL);

  const workspacesAfter = String((await db.query(`select count(*) from public.workspaces`)).rows[0].count);
  const membersAfter = String((await db.query(`select count(*) from public.workspace_members`)).rows[0].count);
  const teamMembersAfter = String((await db.query(`select count(*) from public.team_members`)).rows[0].count);

  assert.equal(workspacesAfter, workspacesBefore);
  assert.equal(membersAfter, membersBefore);
  assert.equal(teamMembersAfter, teamMembersBefore);

  // scheduled_items.assigned_to_name is still '' (not clobbered by the
  // re-apply's cleanup — guarded on "no workspaces exist yet").
  const sch = (await db.query(
    `select assigned_to, assigned_to_name from public.scheduled_items where id = $1`,
    [seeded.scheduled],
  )).rows[0];
  assert.equal(sch.assigned_to, null);
  assert.equal(sch.assigned_to_name, "");
});
