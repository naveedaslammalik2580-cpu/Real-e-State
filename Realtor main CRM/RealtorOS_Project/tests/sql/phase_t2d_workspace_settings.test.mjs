// Phase T2d: workspace_settings is one shared row per workspace, enforced.
//
// The failure this prevents: every member calls loadSettings(), which
// inserts when no row exists. Under the old unique (user_id) two members
// opening a fresh workspace both succeed, and the single-row read then
// fails for everyone for ever.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedDb, SKIP_MESSAGE } from "../helpers/pg.mjs";

let db;
let applied = false;
before(async () => {
  db = await migratedDb();
  if (!db) return;
  const r = await db.query(
    `select count(*)::int as n from pg_indexes
      where schemaname='public' and indexname='workspace_settings_workspace_id_uq'`);
  applied = Number(r.rows[0].n) === 1;
});

function sqlTest(name, fn) {
  test(name, async (t) => {
    if (!db) return t.skip(SKIP_MESSAGE);
    if (!applied) return t.skip("T2d not in the migration chain");
    await fn();
  });
}
const svc = async (fn) => {
  await db.exec("set role service_role");
  try { return await fn(); } finally { await db.exec("reset role"); }
};

async function world() {
  await db.exec("reset role");
  const owner = randomUUID();
  const member = randomUUID();
  await db.query(`insert into auth.users (id) values ($1), ($2)`, [owner, member]);
  await svc(() => db.query(`select automation_internal.ensure_personal_workspace($1)`, [owner]));
  const ws = (await db.query(
    `select workspace_id from public.workspace_members
      where user_id=$1 and status='active'`, [owner])).rows[0].workspace_id;
  await svc(async () => {
    await db.query(`update public.workspace_members set status='removed'
                     where user_id=$1 and status='active'`, [member]);
    await db.query(
      `insert into public.workspace_members (workspace_id,user_id,role,status)
       values ($1,$2,'agent','active')`, [ws, member]);
  });
  return { owner, member, ws };
}

sqlTest("a second settings row for the same workspace is refused", async () => {
  const w = await world();
  await svc(() => db.query(
    `insert into public.workspace_settings (id,user_id,workspace_id)
     values ($1,$2,$3)`, [`ws-${randomUUID().slice(0, 8)}`, w.owner, w.ws]));
  // A different member, same workspace: the exact race T2d closes.
  await assert.rejects(
    svc(() => db.query(
      `insert into public.workspace_settings (id,user_id,workspace_id)
       values ($1,$2,$3)`, [`ws-${randomUUID().slice(0, 8)}`, w.member, w.ws])),
    /workspace_settings_workspace_id_uq/);
  const n = Number((await db.query(
    `select count(*)::int as n from public.workspace_settings where workspace_id=$1`,
    [w.ws])).rows[0].n);
  assert.equal(n, 1);
});

sqlTest("the per-user unique constraint is gone", async () => {
  const n = Number((await db.query(
    `select count(*)::int as n from pg_constraint
      where conname='workspace_settings_user_id_key'`)).rows[0].n);
  assert.equal(n, 0, "one row per USER is the wrong rule for a shared row");
});

sqlTest("two members of the same workspace can both hold a sender profile", async () => {
  // The contrast: email_sender_profiles IS per person, and stays that way.
  const w = await world();
  await svc(async () => {
    await db.query(
      `insert into public.email_sender_profiles
         (user_id,workspace_id,display_name,reply_to_email)
       values ($1,$2,'Owner','owner@example.com')`, [w.owner, w.ws]);
    await db.query(
      `insert into public.email_sender_profiles
         (user_id,workspace_id,display_name,reply_to_email)
       values ($1,$2,'Member','member@example.com')`, [w.member, w.ws]);
  });
  const n = Number((await db.query(
    `select count(*)::int as n from public.email_sender_profiles where workspace_id=$1`,
    [w.ws])).rows[0].n);
  assert.equal(n, 2);
});
