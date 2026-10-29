// Phase T4 follow-ups: the roster carries a member's exceptions for a
// manager, and team mode cannot be switched off while other people are
// still members.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedDb, one, SKIP_MESSAGE } from "../helpers/pg.mjs";

let db;
let applied = false;
before(async () => {
  db = await migratedDb();
  if (!db) return;
  const r = await db.query(
    `select count(*)::int as n from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
      where c.relname = 'workspace_settings'
        and t.tgname = 'workspace_settings_guard_team_mode'`);
  applied = Number(r.rows[0].n) === 1;
});
function sqlTest(name, fn) {
  test(name, async (t) => {
    if (!db) return t.skip(SKIP_MESSAGE);
    if (!applied) return t.skip("T4 follow-ups not in the migration chain");
    await fn();
  });
}

const svc = async (fn) => {
  await db.exec("set role service_role");
  try { return await fn(); } finally { await db.exec("reset role"); }
};
async function as(uid, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
  await db.exec("set role authenticated");
  try { return await fn(); } finally {
    await db.exec("reset role");
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}
const rpc = (uid, fn, args = {}) => {
  const keys = Object.keys(args);
  const ph = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
  return as(uid, async () =>
    (await db.query(`select public.${fn}(${ph}) as out`, keys.map(k => args[k]))).rows[0].out);
};

async function account(email) {
  await db.exec("reset role");
  const id = randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
  return id;
}
async function ownerWorkspace() {
  const owner = await account(`owner.${randomUUID().slice(0, 8)}@example.com`);
  await svc(() => db.query(`select automation_internal.ensure_personal_workspace($1)`, [owner]));
  const ws = (await db.query(
    `select workspace_id from public.workspace_members where user_id=$1 and status='active'`,
    [owner])).rows[0].workspace_id;
  return { owner, ws };
}
/** An invited person who has accepted, so they are a real second member. */
async function joiner(w, role = "agent") {
  const email = `joiner.${randomUUID().slice(0, 8)}@example.com`;
  const inv = await rpc(w.owner, "realtoros_invite_member", { p_email: email, p_role: role });
  const uid = await account(email);
  const acc = await rpc(uid, "realtoros_accept_invitation", { p_token: inv.token });
  return { uid, email, member_id: acc.member_id, team_member_id: acc.team_member_id };
}

/** The settings row for a workspace, created the way the app's own row is. */
async function settingsRow(w, teamMode) {
  await svc(() => db.query(
    `insert into public.workspace_settings (id, user_id, workspace_id, settings_data)
     values ($1, $2, $3, jsonb_build_object('teamMode', $4::boolean))
     on conflict (workspace_id) do update set settings_data = excluded.settings_data`,
    ['ws_' + randomUUID().slice(0, 8), w.owner, w.ws, teamMode]));
}
const teamModeOf = async (w) => (await one(db,
  `select settings_data -> 'teamMode' as flag from public.workspace_settings where workspace_id=$1`,
  [w.ws])).flag;

// ------------------------------------------------- list_members overrides

sqlTest("a manager sees each member's exceptions, and '{}' when there are none", async () => {
  const w = await ownerWorkspace();
  const m = await joiner(w);

  let out = await rpc(w.owner, "realtoros_list_members");
  assert.equal(out.outcome, "ok");
  const before = out.members.find(x => x.member_id === m.member_id);
  assert.deepEqual(before.permission_overrides, {},
    "no exceptions reads as an empty set, not as a missing field");

  // Set one through the real RPC, then read it back off the roster.
  const overrides = { imports_file: false, contacts: { view: "all" } };
  await rpc(w.owner, "realtoros_set_member_permissions",
    { p_member_id: m.member_id, p_overrides: overrides });

  out = await rpc(w.owner, "realtoros_list_members");
  const after = out.members.find(x => x.member_id === m.member_id);
  assert.deepEqual(after.permission_overrides, overrides,
    "exactly what was stored, so a manager can see what they are replacing");
  // Everything else about the row is unchanged from T3.
  assert.equal(after.role, "agent");
  assert.equal(after.status, "active");
  assert.equal(after.team_member_id, m.team_member_id);
  assert.ok(after.email && after.name && after.joined_at);
});

sqlTest("somebody who cannot manage the team is not told anybody's exceptions", async () => {
  const w = await ownerWorkspace();
  const agent = await joiner(w, "agent");
  await rpc(w.owner, "realtoros_set_member_permissions",
    { p_member_id: agent.member_id, p_overrides: { imports_file: false } });

  const seen = await rpc(agent.uid, "realtoros_list_members");
  assert.equal(seen.outcome, "ok", "an agent still gets the roster");
  assert.equal(seen.can_manage, false);
  assert.ok(seen.members.length >= 2);
  seen.members.forEach(row => {
    assert.ok(!Object.prototype.hasOwnProperty.call(row, "permission_overrides"),
      "the field is absent entirely, including on their own row");
  });

  // An admin may manage, so they do get them.
  const admin = await joiner(w, "admin");
  const asAdmin = await rpc(admin.uid, "realtoros_list_members");
  assert.equal(asAdmin.can_manage, true);
  assert.ok(asAdmin.members.every(r => Object.prototype.hasOwnProperty.call(r, "permission_overrides")));
});

// ------------------------------------------------- team mode guard

sqlTest("team mode cannot be switched off while somebody else is still a member", async () => {
  const w = await ownerWorkspace();
  await settingsRow(w, true);
  const m = await joiner(w);

  await assert.rejects(
    svc(() => db.query(
      `update public.workspace_settings
          set settings_data = settings_data || jsonb_build_object('teamMode', false)
        where workspace_id = $1`, [w.ws])),
    /team_mode_has_members/);
  assert.equal(await teamModeOf(w), true, "and the flag is untouched");

  // Removing the key rather than setting it false is the same thing.
  await assert.rejects(
    svc(() => db.query(
      `update public.workspace_settings set settings_data = settings_data - 'teamMode'
        where workspace_id = $1`, [w.ws])),
    /team_mode_has_members/);
  assert.equal(await teamModeOf(w), true);

  // Once they are gone it is allowed.
  await rpc(w.owner, "realtoros_remove_member", { p_member_id: m.member_id });
  await svc(() => db.query(
    `update public.workspace_settings
        set settings_data = settings_data || jsonb_build_object('teamMode', false)
      where workspace_id = $1`, [w.ws]));
  assert.equal(await teamModeOf(w), false);
});

sqlTest("the owner alone may switch it off, and everything else still saves", async () => {
  const w = await ownerWorkspace();
  await settingsRow(w, true);

  // A team of one is the owner by themselves: allowed.
  await svc(() => db.query(
    `update public.workspace_settings
        set settings_data = settings_data || jsonb_build_object('teamMode', false)
      where workspace_id = $1`, [w.ws]));
  assert.equal(await teamModeOf(w), false);

  // Turning it back ON is never guarded, even with people in the workspace.
  const m = await joiner(w);
  await svc(() => db.query(
    `update public.workspace_settings
        set settings_data = settings_data || jsonb_build_object('teamMode', true)
      where workspace_id = $1`, [w.ws]));
  assert.equal(await teamModeOf(w), true);

  // And an unrelated settings change is not blocked while it stays on.
  await svc(() => db.query(
    `update public.workspace_settings set pipeline_stages = '[{"id":"new"}]'::jsonb
      where workspace_id = $1`, [w.ws]));
  assert.equal(await teamModeOf(w), true);
  assert.ok(m.member_id);
});

sqlTest("the guard is the database's, so the browser cannot talk its way past it", async () => {
  const w = await ownerWorkspace();
  await settingsRow(w, true);
  await joiner(w);

  // The same UPDATE the app itself issues, as the signed-in owner.
  await assert.rejects(
    as(w.owner, () => db.query(
      `update public.workspace_settings
          set settings_data = settings_data || jsonb_build_object('teamMode', false)
        where workspace_id = $1`, [w.ws])),
    /team_mode_has_members/);
  assert.equal(await teamModeOf(w), true);
});
