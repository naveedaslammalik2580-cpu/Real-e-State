// Phase T3: invitations, membership and ownership transfer.
//
// The six RPCs, each exercised for the happy path and for the refusals
// that matter. The refusals carry most of the risk: a token that works
// for the wrong person, a workspace left with no owner, or a member's own
// work orphaned by accepting an invitation.
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
    `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='realtoros_accept_invitation'`);
  applied = Number(r.rows[0].n) === 1;
});
function sqlTest(name, fn) {
  test(name, async (t) => {
    if (!db) return t.skip(SKIP_MESSAGE);
    if (!applied) return t.skip("T3 not in the migration chain");
    await fn();
  });
}

const svc = async (fn) => {
  await db.exec("set role service_role");
  try { return await fn(); } finally { await db.exec("reset role"); }
};
/** Run as a signed-in browser user. */
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
const count = async (sql, p = []) => Number((await db.query(sql, p)).rows[0].n);

/** An auth account with an email. Signup provisions it a workspace. */
async function account(email) {
  await db.exec("reset role");
  const id = randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
  return id;
}

/** An owner with a workspace, ready to invite. */
async function ownerWorkspace() {
  const owner = await account(`owner.${randomUUID().slice(0, 8)}@example.com`);
  await svc(() => db.query(`select automation_internal.ensure_personal_workspace($1)`, [owner]));
  const ws = (await db.query(
    `select workspace_id from public.workspace_members
      where user_id=$1 and status='active'`, [owner])).rows[0].workspace_id;
  return { owner, ws };
}

const activeWs = async (uid) => (await db.query(
  `select workspace_id from public.workspace_members
    where user_id=$1 and status='active'`, [uid])).rows[0].workspace_id;

// ---------------------------------------------------------------- invite

sqlTest("the owner invites an agent and gets the token exactly once", async () => {
  const w = await ownerWorkspace();
  const out = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "New.Agent@Example.com", p_role: "agent" });
  assert.equal(out.outcome, "invited", JSON.stringify(out));
  assert.equal(out.email, "new.agent@example.com", "the address is normalized");
  assert.match(out.token, /^[0-9a-f]{64}$/, "32 random bytes, hex");

  // Only the hash is stored; the plaintext is nowhere in the row.
  const row = await one(db,
    `select token_hash, status, role from public.workspace_invitations where id=$1`,
    [out.invitation_id]);
  assert.equal(row.status, "pending");
  assert.equal(row.role, "agent");
  assert.notEqual(row.token_hash, out.token);
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);

  // And listing never returns it.
  const list = await rpc(w.owner, "realtoros_list_invitations");
  assert.equal(list.invitations.length, 1);
  const keys = Object.keys(list.invitations[0]);
  assert.equal(keys.includes("token_hash"), false);
  assert.equal(keys.includes("token"), false);
});

sqlTest("invite refuses a bad role, a bad address, a member, and a duplicate", async () => {
  const w = await ownerWorkspace();
  assert.equal((await rpc(w.owner, "realtoros_invite_member",
    { p_email: "a@b.com", p_role: "owner" })).outcome, "invalid_role",
    "owner is never an invitable role");
  assert.equal((await rpc(w.owner, "realtoros_invite_member",
    { p_email: "not-an-email", p_role: "agent" })).outcome, "invalid_email");
  assert.equal((await rpc(w.owner, "realtoros_invite_member",
    { p_email: "with space@example.com", p_role: "agent" })).outcome, "invalid_email");

  const ownerEmail = (await one(db, `select email from auth.users where id=$1`, [w.owner])).email;
  assert.equal((await rpc(w.owner, "realtoros_invite_member",
    { p_email: ownerEmail, p_role: "agent" })).outcome, "already_a_member");

  await rpc(w.owner, "realtoros_invite_member", { p_email: "dup@example.com", p_role: "agent" });
  assert.equal((await rpc(w.owner, "realtoros_invite_member",
    { p_email: "DUP@example.com", p_role: "admin" })).outcome, "already_invited",
    "case-insensitively the same person");
});

sqlTest("an agent cannot invite", async () => {
  const w = await ownerWorkspace();
  const agent = await account("agent@example.com");
  await svc(async () => {
    await db.query(`update public.workspace_members set status='removed'
                     where user_id=$1 and status='active'`, [agent]);
    await db.query(
      `insert into public.workspace_members (workspace_id,user_id,role,status)
       values ($1,$2,'agent','active')`, [w.ws, agent]);
  });
  await assert.rejects(
    rpc(agent, "realtoros_invite_member", { p_email: "x@example.com", p_role: "agent" }),
    /team_manage permission required/);
});

// ---------------------------------------------------------------- accept

sqlTest("the invited person accepts and lands with the right role and access", async () => {
  const w = await ownerWorkspace();
  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "joiner@example.com", p_role: "admin" });
  const joiner = await account("joiner@example.com");

  const out = await rpc(joiner, "realtoros_accept_invitation", { p_token: inv.token });
  assert.equal(out.outcome, "accepted", JSON.stringify(out));
  assert.equal(out.workspace_id, w.ws);
  assert.equal(out.role, "admin");

  const m = await one(db,
    `select workspace_id, role, status, team_member_id from public.workspace_members
      where user_id=$1 and status='active'`, [joiner]);
  assert.equal(m.workspace_id, w.ws);
  assert.equal(m.role, "admin");
  assert.ok(m.team_member_id, "linked to a directory row");

  const tm = await one(db,
    `select workspace_id, auth_user_id, active from public.team_members where id=$1`,
    [m.team_member_id]);
  assert.equal(tm.workspace_id, w.ws);
  assert.equal(tm.auth_user_id, joiner);
  assert.equal(tm.active, true);

  // Their permissions are the admin preset, read through the real RPC.
  const perms = await as(joiner, async () =>
    (await db.query(`select public.realtoros_my_permissions() as p`)).rows[0].p);
  assert.equal(perms.role, "admin");
  assert.equal(perms.permissions.team_manage, true);

  const i = await one(db,
    `select status, accepted_by from public.workspace_invitations where id=$1`,
    [inv.invitation_id]);
  assert.equal(i.status, "accepted");
  assert.equal(i.accepted_by, joiner);
});

sqlTest("replaying an accepted token reports its state and creates nothing", async () => {
  const w = await ownerWorkspace();
  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "replay@example.com", p_role: "agent" });
  const u = await account("replay@example.com");
  await rpc(u, "realtoros_accept_invitation", { p_token: inv.token });

  const again = await rpc(u, "realtoros_accept_invitation", { p_token: inv.token });
  assert.equal(again.outcome, "accepted",
    "a used token reports the invitation's status rather than acting again");
  assert.equal(await count(
    `select count(*)::int as n from public.workspace_members where user_id=$1 and status='active'`,
    [u]), 1, "still exactly one active membership");
  // One directory row in the workspace they JOINED. They also still have
  // the one from their own personal workspace, whose membership was set
  // aside - that row is history and is meant to survive.
  assert.equal(await count(
    `select count(*)::int as n from public.team_members
      where auth_user_id=$1 and workspace_id=$2`, [u, w.ws]), 1,
    "one directory row in the joined workspace");
});

sqlTest("a token is useless to anyone but the invited address", async () => {
  const w = await ownerWorkspace();
  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "intended@example.com", p_role: "agent" });
  const someoneElse = await account("someone.else@example.com");

  const out = await rpc(someoneElse, "realtoros_accept_invitation", { p_token: inv.token });
  assert.equal(out.outcome, "email_mismatch", JSON.stringify(out));
  assert.equal(out.invited_email, "intended@example.com");
  assert.equal(await count(
    `select count(*)::int as n from public.workspace_members
      where workspace_id=$1 and user_id=$2 and status='active'`, [w.ws, someoneElse]), 0);
});

sqlTest("a garbage, revoked or expired token is refused", async () => {
  const w = await ownerWorkspace();
  const joiner = await account("j2@example.com");
  assert.equal((await rpc(joiner, "realtoros_accept_invitation",
    { p_token: "short" })).outcome, "invalid_token");
  assert.equal((await rpc(joiner, "realtoros_accept_invitation",
    { p_token: "f".repeat(64) })).outcome, "invalid_token");

  const revoked = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "j2@example.com", p_role: "agent" });
  await rpc(w.owner, "realtoros_revoke_invitation", { p_invitation_id: revoked.invitation_id });
  assert.equal((await rpc(joiner, "realtoros_accept_invitation",
    { p_token: revoked.token })).outcome, "revoked");

  const expiring = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "j3@example.com", p_role: "agent" });
  await svc(() => db.query(
    `update public.workspace_invitations set expires_at = now() - interval '1 day' where id=$1`,
    [expiring.invitation_id]));
  const j3 = await account("j3@example.com");
  assert.equal((await rpc(j3, "realtoros_accept_invitation",
    { p_token: expiring.token })).outcome, "expired");
  assert.equal((await one(db,
    `select status from public.workspace_invitations where id=$1`,
    [expiring.invitation_id])).status, "expired",
    "and the row is marked, not left pending");
});

sqlTest("accepting refuses to orphan the joiner's own work", async () => {
  const w = await ownerWorkspace();
  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "busy@example.com", p_role: "agent" });
  const busy = await account("busy@example.com");
  const ownWs = await activeWs(busy);
  await svc(() => db.query(
    `insert into public.contacts (id,user_id,workspace_id,full_name)
     values ($1,$2,$3,'Their Lead')`, [`c-${randomUUID().slice(0, 8)}`, busy, ownWs]));

  const out = await rpc(busy, "realtoros_accept_invitation", { p_token: inv.token });
  assert.equal(out.outcome, "own_workspace_not_empty", JSON.stringify(out));
  assert.equal(await activeWs(busy), ownWs, "nothing moved");
  assert.equal((await one(db,
    `select status from public.workspace_invitations where id=$1`, [inv.invitation_id])).status,
    "pending", "the invitation is still usable once they have dealt with their own workspace");
});

sqlTest("an empty personal workspace is set aside on accept", async () => {
  const w = await ownerWorkspace();
  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "fresh@example.com", p_role: "agent" });
  const fresh = await account("fresh@example.com");
  const ownWs = await activeWs(fresh);

  assert.equal((await rpc(fresh, "realtoros_accept_invitation",
    { p_token: inv.token })).outcome, "accepted");
  assert.equal(await count(
    `select count(*)::int as n from public.workspace_members
      where user_id=$1 and status='active'`, [fresh]), 1);
  assert.equal((await one(db,
    `select status from public.workspace_members where user_id=$1 and workspace_id=$2`,
    [fresh, ownWs])).status, "removed", "set aside, not deleted");
});

// ---------------------------------------------------------------- revoke

sqlTest("revoke is idempotent and refuses an accepted invitation", async () => {
  const w = await ownerWorkspace();
  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "rev@example.com", p_role: "agent" });
  assert.equal((await rpc(w.owner, "realtoros_revoke_invitation",
    { p_invitation_id: inv.invitation_id })).outcome, "revoked");
  assert.equal((await rpc(w.owner, "realtoros_revoke_invitation",
    { p_invitation_id: inv.invitation_id })).outcome, "revoked", "idempotent");
  assert.equal((await rpc(w.owner, "realtoros_revoke_invitation",
    { p_invitation_id: randomUUID() })).outcome, "not_found");

  const taken = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "taken@example.com", p_role: "agent" });
  const u = await account("taken@example.com");
  await rpc(u, "realtoros_accept_invitation", { p_token: taken.token });
  assert.equal((await rpc(w.owner, "realtoros_revoke_invitation",
    { p_invitation_id: taken.invitation_id })).outcome, "already_accepted",
    "an accepted invitation is history; remove the member instead");
});

// ---------------------------------------------------------------- remove

sqlTest("removing a member deactivates them without deleting history", async () => {
  const w = await ownerWorkspace();
  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "leaver@example.com", p_role: "agent" });
  const leaver = await account("leaver@example.com");
  const acc = await rpc(leaver, "realtoros_accept_invitation", { p_token: inv.token });

  const out = await rpc(w.owner, "realtoros_remove_member", { p_member_id: acc.member_id });
  assert.equal(out.outcome, "removed", JSON.stringify(out));
  assert.equal((await one(db,
    `select status from public.workspace_members where id=$1`, [acc.member_id])).status,
    "removed", "the row survives, so their rows still resolve");
  assert.equal((await one(db,
    `select active from public.team_members where id=$1`, [acc.team_member_id])).active,
    false, "the directory row is deactivated, not deleted");

  assert.equal((await rpc(w.owner, "realtoros_remove_member",
    { p_member_id: acc.member_id })).outcome, "already_removed");
});

sqlTest("the owner cannot be removed, and nobody removes themselves", async () => {
  const w = await ownerWorkspace();
  const ownerMember = (await one(db,
    `select id from public.workspace_members where user_id=$1 and status='active'`,
    [w.owner])).id;
  // The owner guard fires first, and says the more useful thing: the
  // reason this is refused is that they are the owner, not merely that it
  // is them. Ownership has to be transferred first.
  assert.equal((await rpc(w.owner, "realtoros_remove_member",
    { p_member_id: ownerMember })).outcome, "cannot_remove_owner");

  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "adm@example.com", p_role: "admin" });
  const adm = await account("adm@example.com");
  await rpc(adm, "realtoros_accept_invitation", { p_token: inv.token });
  assert.equal((await rpc(adm, "realtoros_remove_member",
    { p_member_id: ownerMember })).outcome, "cannot_remove_owner",
    "a workspace must never be left with no active owner");

  // cannot_remove_self is for a non-owner removing themselves: leaving is
  // not the same operation as being removed, and doing it this way would
  // strand them mid-session.
  const admMember = (await one(db,
    `select id from public.workspace_members where user_id=$1 and status='active'`,
    [adm])).id;
  assert.equal((await rpc(adm, "realtoros_remove_member",
    { p_member_id: admMember })).outcome, "cannot_remove_self");
});

// ---------------------------------------------------------------- transfer

sqlTest("ownership transfers, the old owner becomes an admin, and the stored owner moves", async () => {
  const w = await ownerWorkspace();
  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "heir@example.com", p_role: "admin" });
  const heir = await account("heir@example.com");
  const acc = await rpc(heir, "realtoros_accept_invitation", { p_token: inv.token });

  const out = await rpc(w.owner, "realtoros_transfer_ownership", { p_member_id: acc.member_id });
  assert.equal(out.outcome, "transferred", JSON.stringify(out));

  assert.equal((await one(db,
    `select role from public.workspace_members where user_id=$1 and status='active'`,
    [heir])).role, "owner");
  assert.equal((await one(db,
    `select role from public.workspace_members where user_id=$1 and status='active'`,
    [w.owner])).role, "admin", "the old owner stays, as an admin");
  assert.equal((await one(db,
    `select owner_user_id from public.workspaces where id=$1`, [w.ws])).owner_user_id, heir,
    "workspaces.owner_user_id is stored, so it has to move too");
  assert.equal(await count(
    `select count(*)::int as n from public.workspace_members
      where workspace_id=$1 and status='active' and role='owner'`, [w.ws]), 1);

  const perms = await as(heir, async () =>
    (await db.query(`select public.realtoros_my_permissions() as p`)).rows[0].p);
  assert.equal(perms.role, "owner");
});

sqlTest("only the owner transfers, and not to themselves or an inactive member", async () => {
  const w = await ownerWorkspace();
  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "adm2@example.com", p_role: "admin" });
  const adm = await account("adm2@example.com");
  const acc = await rpc(adm, "realtoros_accept_invitation", { p_token: inv.token });

  await assert.rejects(
    rpc(adm, "realtoros_transfer_ownership", { p_member_id: acc.member_id }),
    /only the workspace owner/, "an admin cannot promote themselves");

  const ownerMember = (await one(db,
    `select id from public.workspace_members where user_id=$1 and status='active'`,
    [w.owner])).id;
  assert.equal((await rpc(w.owner, "realtoros_transfer_ownership",
    { p_member_id: ownerMember })).outcome, "already_owner");
  assert.equal((await rpc(w.owner, "realtoros_transfer_ownership",
    { p_member_id: randomUUID() })).outcome, "not_found");

  await rpc(w.owner, "realtoros_remove_member", { p_member_id: acc.member_id });
  assert.equal((await rpc(w.owner, "realtoros_transfer_ownership",
    { p_member_id: acc.member_id })).outcome, "target_not_active");
});

// ---------------------------------------------------------------- isolation

sqlTest("the browser cannot read the invitations table directly", async () => {
  const w = await ownerWorkspace();
  await rpc(w.owner, "realtoros_invite_member", { p_email: "hidden@example.com", p_role: "agent" });
  // token_hash lives here and RLS cannot hide a column, so the table is
  // deny-all and the RPC is the only way in.
  assert.equal(await count(
    `select count(*)::int as n from information_schema.role_table_grants
      where grantee='authenticated' and table_schema='public'
        and table_name='workspace_invitations' and privilege_type='SELECT'`), 0);
  await assert.rejects(
    as(w.owner, () => db.query(`select token_hash from public.workspace_invitations`)),
    /permission denied/);
});

sqlTest("another workspace's manager sees and touches nothing", async () => {
  const a = await ownerWorkspace();
  const b = await ownerWorkspace();
  const inv = await rpc(a.owner, "realtoros_invite_member",
    { p_email: "a.invitee@example.com", p_role: "agent" });

  const list = await rpc(b.owner, "realtoros_list_invitations");
  assert.deepEqual(list.invitations, [], "workspace B sees none of A's invitations");
  assert.equal((await rpc(b.owner, "realtoros_revoke_invitation",
    { p_invitation_id: inv.invitation_id })).outcome, "not_found");
  assert.equal((await one(db,
    `select status from public.workspace_invitations where id=$1`, [inv.invitation_id])).status,
    "pending", "and A's invitation is untouched");
});

sqlTest("membership events are audited with labels that outlive the rows", async () => {
  const w = await ownerWorkspace();
  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "audited@example.com", p_role: "agent" });
  const u = await account("audited@example.com");
  const acc = await rpc(u, "realtoros_accept_invitation", { p_token: inv.token });
  await rpc(w.owner, "realtoros_remove_member", { p_member_id: acc.member_id });

  const rows = await db.query(
    `select action, target_label from public.workspace_permission_changes
      where workspace_id=$1 order by at`, [w.ws]);
  const actions = rows.rows.map(r => r.action);
  for (const a of ["invited", "invite_accepted", "member_removed"]) {
    assert.ok(actions.includes(a), `${a} audited (got ${actions.join(",")})`);
  }
  assert.ok(rows.rows.some(r => r.target_label === "audited@example.com"),
    "the label is stored, so the trail reads correctly after the row is gone");
});

// ------------------------------------------------- brand-new account

sqlTest("a brand-new account, auto-provisioned only, can accept an invite", async () => {
  // The guard that must NOT fire here: signup provisions a workspace, an
  // owner directory row, both role templates and a settings row. If
  // workspace_is_empty counted any of those, no new account could ever
  // join a team. It counts only real work.
  const w = await ownerWorkspace();
  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "brandnew@example.com", p_role: "agent" });
  const fresh = await account("brandnew@example.com");
  const ownWs = await activeWs(fresh);

  // Prove the auto-provisioned furniture really is there.
  assert.ok(await count(
    `select count(*)::int as n from public.team_members where workspace_id=$1`, [ownWs]) >= 1,
    "an owner directory row was provisioned");
  assert.equal(await count(
    `select count(*)::int as n from public.workspace_role_permissions where workspace_id=$1`,
    [ownWs]), 2, "both role templates were seeded");
  assert.equal(await count(
    `select count(*)::int as n from public.workspaces where id=$1`, [ownWs]), 1);

  // ...and that it still counts as empty.
  const empty = await svc(() => db.query(
    `select automation_internal.workspace_is_empty($1) as e`, [ownWs]));
  assert.equal(empty.rows[0].e, true, "auto-provisioned rows are not work");

  assert.equal((await rpc(fresh, "realtoros_accept_invitation",
    { p_token: inv.token })).outcome, "accepted");
  assert.equal(await activeWs(fresh), w.ws);
});

// ------------------------------------------------- change role

sqlTest("the owner moves a member between agent and admin", async () => {
  const w = await ownerWorkspace();
  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "mover@example.com", p_role: "agent" });
  const u = await account("mover@example.com");
  const acc = await rpc(u, "realtoros_accept_invitation", { p_token: inv.token });

  const up = await rpc(w.owner, "realtoros_change_member_role",
    { p_member_id: acc.member_id, p_role: "admin" });
  assert.equal(up.outcome, "changed", JSON.stringify(up));
  assert.equal(up.from_role, "agent");
  assert.equal(up.to_role, "admin");

  // The permissions they actually get follow the new role.
  let perms = await as(u, async () =>
    (await db.query(`select public.realtoros_my_permissions() as p`)).rows[0].p);
  assert.equal(perms.role, "admin");
  assert.equal(perms.permissions.team_manage, true);

  // And the directory label follows too, so the team list agrees.
  assert.equal((await one(db,
    `select role from public.team_members where id=$1`, [acc.team_member_id])).role, "Admin");

  // Back down again.
  assert.equal((await rpc(w.owner, "realtoros_change_member_role",
    { p_member_id: acc.member_id, p_role: "agent" })).outcome, "changed");
  perms = await as(u, async () =>
    (await db.query(`select public.realtoros_my_permissions() as p`)).rows[0].p);
  assert.equal(perms.permissions.team_manage, false);
  assert.equal((await one(db,
    `select role from public.team_members where id=$1`, [acc.team_member_id])).role, "Agent");
});

sqlTest("change_member_role refuses the owner, a bad role, a no-op and a non-member", async () => {
  const w = await ownerWorkspace();
  const ownerMember = (await one(db,
    `select id from public.workspace_members where user_id=$1 and status='active'`,
    [w.owner])).id;
  assert.equal((await rpc(w.owner, "realtoros_change_member_role",
    { p_member_id: ownerMember, p_role: "admin" })).outcome, "cannot_change_owner",
    "the owner's role moves only through transfer_ownership");
  assert.equal((await rpc(w.owner, "realtoros_change_member_role",
    { p_member_id: ownerMember, p_role: "owner" })).outcome, "invalid_role");
  assert.equal((await rpc(w.owner, "realtoros_change_member_role",
    { p_member_id: randomUUID(), p_role: "agent" })).outcome, "not_found");

  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "same@example.com", p_role: "agent" });
  const u = await account("same@example.com");
  const acc = await rpc(u, "realtoros_accept_invitation", { p_token: inv.token });
  assert.equal((await rpc(w.owner, "realtoros_change_member_role",
    { p_member_id: acc.member_id, p_role: "agent" })).outcome, "unchanged");

  await rpc(w.owner, "realtoros_remove_member", { p_member_id: acc.member_id });
  assert.equal((await rpc(w.owner, "realtoros_change_member_role",
    { p_member_id: acc.member_id, p_role: "admin" })).outcome, "not_active");
});

sqlTest("an agent cannot change roles, and a trimmed admin cannot mint a full one", async () => {
  const w = await ownerWorkspace();
  // An agent has no team_manage at all.
  const aInv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "plain@example.com", p_role: "agent" });
  const plain = await account("plain@example.com");
  const plainAcc = await rpc(plain, "realtoros_accept_invitation", { p_token: aInv.token });
  await assert.rejects(
    rpc(plain, "realtoros_change_member_role",
      { p_member_id: plainAcc.member_id, p_role: "admin" }),
    /team_manage permission required/);

  // An admin whose own permissions have been trimmed below the admin
  // template cannot promote anyone to admin and borrow it back.
  const bInv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "trimmed@example.com", p_role: "admin" });
  const trimmed = await account("trimmed@example.com");
  const trimmedAcc = await rpc(trimmed, "realtoros_accept_invitation", { p_token: bInv.token });
  await svc(() => db.query(
    `update public.workspace_members
        set permission_overrides = '{"integrations_manage": false}'::jsonb
      where id = $1`, [trimmedAcc.member_id]));

  const out = await rpc(trimmed, "realtoros_change_member_role",
    { p_member_id: plainAcc.member_id, p_role: "admin" });
  assert.equal(out.outcome, "exceeds_your_permissions", JSON.stringify(out));
  assert.equal((await one(db,
    `select role from public.workspace_members where id=$1`, [plainAcc.member_id])).role,
    "agent", "and nothing changed");

  // They can still move someone to agent, which is within their level.
  assert.equal((await rpc(trimmed, "realtoros_change_member_role",
    { p_member_id: plainAcc.member_id, p_role: "agent" })).outcome, "unchanged");
});

// ------------------------------------------------- leave

sqlTest("leaving releases the member's work and lands them in a fresh workspace", async () => {
  const w = await ownerWorkspace();
  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "goer@example.com", p_role: "agent" });
  const goer = await account("goer@example.com");
  const acc = await rpc(goer, "realtoros_accept_invitation", { p_token: inv.token });

  // A lead assigned to them, and one personal + one shared template.
  const cid = `c-${randomUUID().slice(0, 8)}`;
  await svc(async () => {
    await db.query(
      `insert into public.contacts (id,user_id,workspace_id,full_name,assigned_to_id)
       values ($1,$2,$3,'Their Lead',$4)`, [cid, w.owner, w.ws, acc.team_member_id]);
    await db.query(
      `insert into public.message_templates
         (id,user_id,workspace_id,name,subject,body_text,channel,visibility)
       values (gen_random_uuid(),$1,$2,'Mine','s','b','email','personal')`, [goer, w.ws]);
    await db.query(
      `insert into public.message_templates
         (id,user_id,workspace_id,name,subject,body_text,channel,visibility)
       values (gen_random_uuid(),$1,$2,'Ours','s','b','email','shared')`, [goer, w.ws]);
  });

  const out = await rpc(goer, "realtoros_leave_workspace");
  assert.equal(out.outcome, "left", JSON.stringify(out));
  assert.equal(out.left_workspace_id, w.ws);
  assert.ok(out.new_workspace_id && out.new_workspace_id !== w.ws, "a fresh workspace");
  assert.equal(out.leads_unassigned, 1);

  // The lead stayed in the workspace, unassigned.
  const c = await one(db,
    `select workspace_id, assigned_to_id from public.contacts where id=$1`, [cid]);
  assert.equal(c.workspace_id, w.ws, "the lead did not leave with them");
  assert.equal(c.assigned_to_id, null, "it is back in the pool");

  // Their personal template passed to the owner; the shared one is
  // untouched because it already belongs to the workspace.
  assert.equal((await one(db,
    `select user_id from public.message_templates where workspace_id=$1 and name='Mine'`,
    [w.ws])).user_id, w.owner);
  assert.equal((await one(db,
    `select user_id from public.message_templates where workspace_id=$1 and name='Ours'`,
    [w.ws])).user_id, goer, "a shared item is the workspace's and is left alone");

  // Deactivated, not deleted, and exactly one active membership (the new one).
  assert.equal((await one(db,
    `select status from public.workspace_members where id=$1`, [acc.member_id])).status, "removed");
  assert.equal((await one(db,
    `select active from public.team_members where id=$1`, [acc.team_member_id])).active, false);
  assert.equal(await count(
    `select count(*)::int as n from public.workspace_members
      where user_id=$1 and status='active'`, [goer]), 1);
  assert.equal(await activeWs(goer), out.new_workspace_id);

  // And they really are an owner of the new one.
  const perms = await as(goer, async () =>
    (await db.query(`select public.realtoros_my_permissions() as p`)).rows[0].p);
  assert.equal(perms.role, "owner");
  assert.equal(perms.workspace_id, out.new_workspace_id);
});

sqlTest("the owner cannot leave", async () => {
  const w = await ownerWorkspace();
  assert.equal((await rpc(w.owner, "realtoros_leave_workspace")).outcome,
    "owner_cannot_leave", "transfer ownership or delete the workspace instead");
  assert.equal(await activeWs(w.owner), w.ws, "nothing moved");
});

// ------------------------------------------------- delete

sqlTest("the owner deletes a workspace they are alone in, and gets a fresh one", async () => {
  const w = await ownerWorkspace();
  const name = (await one(db, `select name from public.workspaces where id=$1`, [w.ws])).name;
  // Some real work, to prove the cascade.
  const cid = `c-${randomUUID().slice(0, 8)}`;
  await svc(() => db.query(
    `insert into public.contacts (id,user_id,workspace_id,full_name)
     values ($1,$2,$3,'Doomed')`, [cid, w.owner, w.ws]));

  const out = await rpc(w.owner, "realtoros_delete_workspace", { p_confirm_name: name });
  assert.equal(out.outcome, "deleted", JSON.stringify(out));
  assert.equal(out.deleted_workspace_id, w.ws);
  assert.ok(out.new_workspace_id && out.new_workspace_id !== w.ws);

  assert.equal(await count(
    `select count(*)::int as n from public.workspaces where id=$1`, [w.ws]), 0);
  assert.equal(await count(
    `select count(*)::int as n from public.contacts where id=$1`, [cid]), 0,
    "everything cascaded with the workspace");
  assert.equal(await activeWs(w.owner), out.new_workspace_id);

  // The record of the deletion survives, in the new workspace.
  const audit = await db.query(
    `select action, target_label from public.workspace_permission_changes
      where workspace_id=$1 and action='workspace_deleted'`, [out.new_workspace_id]);
  assert.equal(audit.rows.length, 1);
  assert.ok(audit.rows[0].target_label.includes(name));
});

sqlTest("delete refuses a wrong name, other members, and a non-owner", async () => {
  const w = await ownerWorkspace();
  const name = (await one(db, `select name from public.workspaces where id=$1`, [w.ws])).name;

  const wrong = await rpc(w.owner, "realtoros_delete_workspace",
    { p_confirm_name: name + " x" });
  assert.equal(wrong.outcome, "name_mismatch", JSON.stringify(wrong));
  assert.equal(wrong.expected_name, name);
  assert.equal(await count(
    `select count(*)::int as n from public.workspaces where id=$1`, [w.ws]), 1, "still there");

  // With someone else in it, the name does not even get checked.
  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "stayer@example.com", p_role: "agent" });
  const stayer = await account("stayer@example.com");
  const acc = await rpc(stayer, "realtoros_accept_invitation", { p_token: inv.token });
  const busy = await rpc(w.owner, "realtoros_delete_workspace", { p_confirm_name: name });
  assert.equal(busy.outcome, "other_members_present", JSON.stringify(busy));
  assert.equal(busy.active_members, 1);

  // A member cannot delete it at all.
  await assert.rejects(
    rpc(stayer, "realtoros_delete_workspace", { p_confirm_name: name }),
    /only the workspace owner/);

  // Once they are gone, it works.
  await rpc(w.owner, "realtoros_remove_member", { p_member_id: acc.member_id });
  assert.equal((await rpc(w.owner, "realtoros_delete_workspace",
    { p_confirm_name: name })).outcome, "deleted");
});

// ------------------------------------------------- list members

sqlTest("list_members gives a manager the ids and names every other RPC needs", async () => {
  const w = await ownerWorkspace();
  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: "Rosa@Example.com", p_role: "admin" });
  const rosa = await account("rosa@example.com");
  const acc = await rpc(rosa, "realtoros_accept_invitation", { p_token: inv.token });

  const out = await rpc(w.owner, "realtoros_list_members");
  assert.equal(out.outcome, "ok", JSON.stringify(out));
  assert.equal(out.can_manage, true);
  assert.equal(out.members.length, 2);

  // Owner first, then the admin.
  assert.deepEqual(out.members.map(m => m.role), ["owner", "admin"]);
  const me = out.members[0];
  assert.equal(me.user_id, w.owner);
  assert.equal(me.is_self, true);
  assert.equal(me.status, "active");
  assert.ok(me.joined_at && me.updated_at, "the dates come back");

  const her = out.members[1];
  assert.equal(her.is_self, false);
  assert.equal(her.email, "rosa@example.com", "normalized, from the auth account");
  assert.equal(her.name, "rosa", "the directory name, local part as the fallback");
  assert.equal(her.team_member_id, acc.team_member_id);

  // The member_id it reports is the one the membership RPCs take: proof
  // that this closes the gap rather than returning a different id.
  assert.equal(her.member_id, acc.member_id);
  assert.equal((await rpc(w.owner, "realtoros_change_member_role",
    { p_member_id: her.member_id, p_role: "agent" })).outcome, "changed");
});

sqlTest("an agent gets the list too, but only the active members", async () => {
  const w = await ownerWorkspace();
  // Addresses are unique per test: one database serves the whole file and
  // auth.users.email is unique.
  const agentEmail = `agent.${randomUUID().slice(0, 8)}@example.com`;
  const gonerEmail = `goner.${randomUUID().slice(0, 8)}@example.com`;

  const invA = await rpc(w.owner, "realtoros_invite_member",
    { p_email: agentEmail, p_role: "agent" });
  const agent = await account(agentEmail);
  await rpc(agent, "realtoros_accept_invitation", { p_token: invA.token });

  const invB = await rpc(w.owner, "realtoros_invite_member",
    { p_email: gonerEmail, p_role: "agent" });
  const goner = await account(gonerEmail);
  const gone = await rpc(goner, "realtoros_accept_invitation", { p_token: invB.token });
  await rpc(w.owner, "realtoros_remove_member", { p_member_id: gone.member_id });

  // The agent needs names to render, so the call is not refused...
  const seen = await rpc(agent, "realtoros_list_members");
  assert.equal(seen.outcome, "ok", JSON.stringify(seen));
  assert.equal(seen.can_manage, false);
  // ...but a removal is not broadcast to them.
  assert.equal(seen.members.length, 2, "the owner and themselves");
  assert.ok(seen.members.some(m => m.email === agentEmail));
  assert.ok(!seen.members.some(m => m.email === gonerEmail), "the removed member is hidden");
  assert.ok(seen.members.every(m => m.status === "active"));

  // The manager still sees the person who left, which is the list they
  // administer.
  const managed = await rpc(w.owner, "realtoros_list_members");
  assert.equal(managed.members.length, 3);
  const removed = managed.members.find(m => m.email === gonerEmail);
  assert.equal(removed.status, "removed");
  assert.equal(removed.member_id, gone.member_id);
});

sqlTest("a suspended member is hidden from an agent and shown to a manager", async () => {
  const w = await ownerWorkspace();
  const watcherEmail = `watcher.${randomUUID().slice(0, 8)}@example.com`;
  const invA = await rpc(w.owner, "realtoros_invite_member",
    { p_email: watcherEmail, p_role: "agent" });
  const watcher = await account(watcherEmail);
  await rpc(watcher, "realtoros_accept_invitation", { p_token: invA.token });

  const pausedEmail = `paused.${randomUUID().slice(0, 8)}@example.com`;
  const invB = await rpc(w.owner, "realtoros_invite_member",
    { p_email: pausedEmail, p_role: "agent" });
  const paused = await account(pausedEmail);
  const pm = await rpc(paused, "realtoros_accept_invitation", { p_token: invB.token });
  // No RPC suspends yet; T2a's status column already allows it, so the
  // list has to handle it the day one does.
  await svc(() => db.query(
    `update public.workspace_members set status='suspended' where id=$1`, [pm.member_id]));

  const seen = await rpc(watcher, "realtoros_list_members");
  assert.ok(!seen.members.some(m => m.email === pausedEmail), "hidden from an agent");

  const managed = await rpc(w.owner, "realtoros_list_members");
  const row = managed.members.find(m => m.email === pausedEmail);
  assert.equal(row.status, "suspended");

  // And a suspended person gets no roster at all: workspace_of resolves
  // active memberships only.
  assert.equal((await rpc(paused, "realtoros_list_members")).outcome, "no_workspace");
});

sqlTest("list_members never reaches another workspace", async () => {
  const a = await ownerWorkspace();
  const b = await ownerWorkspace();
  const theirsEmail = `theirs.${randomUUID().slice(0, 8)}@example.com`;
  const inv = await rpc(b.owner, "realtoros_invite_member",
    { p_email: theirsEmail, p_role: "admin" });
  const theirs = await account(theirsEmail);
  await rpc(theirs, "realtoros_accept_invitation", { p_token: inv.token });

  const mine = await rpc(a.owner, "realtoros_list_members");
  assert.equal(mine.members.length, 1, "only their own workspace");
  assert.deepEqual(mine.members.map(m => m.user_id), [a.owner]);
  assert.ok(!mine.members.some(m => m.email === theirsEmail));

  // The other workspace's admin sees their own roster, not this one's.
  const hers = await rpc(theirs, "realtoros_list_members");
  assert.deepEqual(hers.members.map(m => m.user_id).sort(), [b.owner, theirs].sort());
  assert.ok(!hers.members.some(m => m.user_id === a.owner));

  // And the RPC is what makes the roster readable at all: the browser
  // reading the table itself still sees only its own membership row.
  const direct = await as(a.owner, async () => (await db.query(
    `select workspace_id, user_id from public.workspace_members`)).rows);
  assert.deepEqual(direct.map(r => r.user_id), [a.owner],
    "workspace_members_select_own: their own row and nothing else");
});

// ------------------------------------- leave, with a live-shaped JWT

// On Supabase, auth.uid() is
// coalesce(request.jwt.claim.sub, request.jwt.claims ->> 'sub'), and a real
// PostgREST request carries the whole claims object. Every other test here
// signs in through the flattened claim only, so leave_workspace could blank
// that one setting, look like a trusted server-side caller, and pass - while
// on live auth.uid() still resolved through the claims object, the
// contacts_enforce_assignment trigger still saw a JWT caller, and an agent
// with assigned leads could not leave at all. This test signs in the way
// live does: claims object only, flattened claim empty.
async function asClaims(uid, fn) {
  await db.query(
    `select set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, false)`,
    [uid]);
  await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  await db.exec("set role authenticated");
  try { return await fn(); } finally {
    await db.exec("reset role");
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}

sqlTest("an agent whose identity comes only from request.jwt.claims can leave", async () => {
  const w = await ownerWorkspace();
  const email = `claims.${randomUUID().slice(0, 8)}@example.com`;
  const inv = await rpc(w.owner, "realtoros_invite_member",
    { p_email: email, p_role: "agent" });
  const agent = await account(email);
  const acc = await rpc(agent, "realtoros_accept_invitation", { p_token: inv.token });

  // A lead assigned to them: releasing it is what the trigger guards, and
  // an agent does not hold contacts_assign.
  const cid = `c-${randomUUID()}`;
  await svc(() => db.query(
    `insert into public.contacts (id, user_id, workspace_id, email, assigned_to_id)
      values ($1, $2, $3, $4, $5)`,
    [cid, w.owner, w.ws, "lead@example.com", acc.team_member_id]));

  // Signed in as live does it: the claims object carries the subject.
  const out = await asClaims(agent, async () =>
    (await db.query(`select public.realtoros_leave_workspace() as out`)).rows[0].out);
  assert.equal(out.outcome, "left", JSON.stringify(out));
  assert.equal(out.left_workspace_id, w.ws);
  assert.equal(out.leads_unassigned, 1);

  // The lead stayed in the workspace, unassigned.
  const c = await one(db,
    `select workspace_id, assigned_to_id from public.contacts where id=$1`, [cid]);
  assert.equal(c.workspace_id, w.ws);
  assert.equal(c.assigned_to_id, null);

  // They are out, and landed somewhere of their own.
  assert.equal((await one(db,
    `select status from public.workspace_members where id=$1`, [acc.member_id])).status,
    "removed");
  assert.ok(out.new_workspace_id && out.new_workspace_id !== w.ws);

  // And the claim the function suspended is the caller's again afterwards:
  // the blanking is transaction-local and restored, not left behind.
  const whoami = await asClaims(agent, async () =>
    (await db.query(`select auth.uid() as uid`)).rows[0].uid);
  assert.equal(whoami, agent, "auth.uid() resolves to the caller after leaving");
});
