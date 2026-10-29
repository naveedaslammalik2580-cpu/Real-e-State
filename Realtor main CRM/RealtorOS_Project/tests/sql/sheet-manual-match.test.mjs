// Phase H-1: a Google Sheet import must recognise a contact the agent
// entered by hand, instead of creating a second one for the same person.
//
// Before H-1, the email / phone fallback that matches a contact with no
// identity key ran for file uploads only. These tests drive the real
// Sheet path (public.realtoros_ingest_lead_batch) against the real
// migration chain in PGlite, and finish by proving the revert file puts
// the old behaviour back.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { migratedDb, one, rpc, SKIP_MESSAGE } from "../helpers/pg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REVERT = path.join(here, "..", "..", "supabase", "rollback",
  "sheet_import_manual_match_revert.sql");

let db;
before(async () => { db = await migratedDb(); });
// An open PGlite instance keeps node's event loop alive, so the process
// would never exit after the last assertion.
after(async () => { if (db) { try { await db.close(); } catch (e) { /* already closed */ } } });

function sqlTest(name, fn) {
  test(name, async (t) => {
    if (!db) return t.skip(SKIP_MESSAGE);
    await fn(db);
  });
}

async function asService(d, fn) {
  await d.exec("set role service_role");
  try { return await fn(); } finally { await d.exec("reset role"); }
}

/** An owner with a personal workspace (the auth.users trigger makes it). */
async function owner(d) {
  const id = randomUUID();
  await d.exec("reset role");
  await d.query(`insert into auth.users (id) values ($1)`, [id]);
  const ws = (await one(d,
    `select workspace_id from public.workspace_members
      where user_id = $1 and status = 'active'`, [id])).workspace_id;
  return { id, ws };
}

/** A Sheets connection for that owner. */
async function connection(d, o) {
  const conn = randomUUID();
  await d.query(
    `insert into public.lead_source_connections (id, user_id, workspace_id, spreadsheet_id, status)
     values ($1, $2, $3, $4, 'active')`,
    [conn, o.id, o.ws, "sheet-" + randomUUID().slice(0, 8)]);
  return conn;
}

/** A contact typed into the Contacts page: NO identity key is written. */
async function manualContact(d, o, { id, name = "", email = "", phone = "", createdAt = null }) {
  await d.query(
    `insert into public.contacts (id, user_id, workspace_id, full_name, email, phone, source)
     values ($1, $2, $3, $4, $5, $6, 'Other')`,
    [id, o.id, o.ws, name, email, phone]);
  if (createdAt) {
    await d.query(`update public.contacts set created_at = $2 where id = $1`, [id, createdAt]);
  }
  return id;
}

const sync = (d, conn, event, rows) => asService(d, () => rpc(d, "realtoros_ingest_lead_batch", {
  p_connection_id: conn,
  p_source_event_id: event,
  p_sheet_revision: "rev-1",
  p_rows: JSON.stringify(rows),
}));

const fileImport = (d, o, rows) => asService(d, () => rpc(d, "realtoros_ingest_lead_file", {
  p_user_id: o.id,
  p_file_name: "leads.csv",
  p_import_id: randomUUID(),
  p_rows: JSON.stringify(rows),
  p_start_automation: false,
}));

const contactCount = async (d, o) => Number((await one(d,
  `select count(*)::int as n from public.contacts where workspace_id = $1`, [o.ws])).n);

const keysFor = async (d, o, contactId) => (await d.query(
  `select identity_type, source from public.contact_identity_keys
    where workspace_id = $1 and contact_id = $2 order by identity_type`,
  [o.ws, contactId])).rows;

const event = () => "event-" + randomUUID().replace(/-/g, "").slice(0, 12);

// ------------------------------------------------------------ email

sqlTest("a Sheet row matches a hand-entered contact by email, writes the key, and the next sync matches by key", async (d) => {
  const o = await owner(d);
  const conn = await connection(d, o);
  await manualContact(d, o, { id: "man-email", name: "Hand Typed", email: "hand@example.com" });
  assert.equal(await contactCount(d, o), 1);
  assert.deepEqual(await keysFor(d, o, "man-email"), [],
    "a hand-entered contact starts with no identity key");

  // Different case and surrounding space, which is what the fallback
  // normalizes away.
  const first = await sync(d, conn, event(), [
    { lead_id: "L1", full_name: "Hand Typed", email: "  Hand@Example.COM  " },
  ]);

  assert.equal(await contactCount(d, o), 1, "no duplicate contact was created");
  assert.equal(Number(first.imported_count), 0, "nothing was imported as new");
  assert.equal(Number(first.duplicate_count), 1, "the row was counted as a duplicate");

  const linked = await one(d,
    `select contact_id from public.lead_import_rows
      where workspace_id = $1 and source_row_key = 'L1'`, [o.ws]);
  assert.equal(linked.contact_id, "man-email", "the row is linked to the hand-entered contact");

  const keys = await keysFor(d, o, "man-email");
  assert.deepEqual(keys.map(k => k.identity_type), ["email"],
    "the email identity key is now written");
  assert.equal(keys[0].source, "google_sheets");

  // Second sync, a NEW event so it is not a replay: now there is a key, so
  // the fallback is not even reached, and the answer must be the same.
  const second = await sync(d, conn, event(), [
    { lead_id: "L1", full_name: "Hand Typed", email: "hand@example.com" },
  ]);
  assert.equal(await contactCount(d, o), 1, "still one contact");
  assert.equal(Number(second.imported_count), 0);
});

// ------------------------------------------------------------ phone

sqlTest("a Sheet row matches a hand-entered contact by phone, whatever the formatting", async (d) => {
  const o = await owner(d);
  const conn = await connection(d, o);
  await manualContact(d, o, { id: "man-phone", name: "Phone Only", phone: "(555) 123-4567" });

  const r = await sync(d, conn, event(), [
    { lead_id: "P1", full_name: "Phone Only", phone: "555.123.4567" },
  ]);

  assert.equal(await contactCount(d, o), 1, "no duplicate for a differently formatted number");
  assert.equal(Number(r.imported_count), 0);
  const linked = await one(d,
    `select contact_id from public.lead_import_rows
      where workspace_id = $1 and source_row_key = 'P1'`, [o.ws]);
  assert.equal(linked.contact_id, "man-phone");
  assert.deepEqual((await keysFor(d, o, "man-phone")).map(k => k.identity_type), ["phone"]);
});

// ------------------------------------------------------------ scoping

sqlTest("a hand-entered contact in ANOTHER workspace is never matched", async (d) => {
  const mine = await owner(d);
  const theirs = await owner(d);
  const conn = await connection(d, mine);
  // Same address, somebody else's workspace.
  await manualContact(d, theirs, { id: "other-ws", name: "Not Mine", email: "shared@example.com" });

  const r = await sync(d, conn, event(), [
    { lead_id: "X1", full_name: "Shared Address", email: "shared@example.com" },
  ]);

  assert.equal(Number(r.imported_count), 1,
    "the row must create a new contact in MY workspace, not match theirs");
  assert.equal(await contactCount(d, mine), 1);
  assert.equal(await contactCount(d, theirs), 1, "their workspace is untouched");
  const linked = await one(d,
    `select contact_id from public.lead_import_rows
      where workspace_id = $1 and source_row_key = 'X1'`, [mine.ws]);
  assert.notEqual(linked.contact_id, "other-ws");
});

sqlTest("when two hand-entered contacts share an address, the oldest wins", async (d) => {
  const o = await owner(d);
  const conn = await connection(d, o);
  await manualContact(d, o, {
    id: "twin-old", name: "Older", email: "twin@example.com",
    createdAt: "2026-01-01T00:00:00Z",
  });
  await manualContact(d, o, {
    id: "twin-new", name: "Newer", email: "twin@example.com",
    createdAt: "2026-06-01T00:00:00Z",
  });

  await sync(d, conn, event(), [
    { lead_id: "T1", full_name: "Twin", email: "twin@example.com" },
  ]);

  const linked = await one(d,
    `select contact_id from public.lead_import_rows
      where workspace_id = $1 and source_row_key = 'T1'`, [o.ws]);
  assert.equal(linked.contact_id, "twin-old",
    "order by created_at, id must pick the oldest contact deterministically");
  assert.equal(await contactCount(d, o), 2, "and no third contact appears");
});

sqlTest("email and phone resolving to two different contacts is still rejected", async (d) => {
  const o = await owner(d);
  const conn = await connection(d, o);
  await manualContact(d, o, { id: "conf-mail", name: "Mail", email: "conflict@example.com" });
  await manualContact(d, o, { id: "conf-phone", name: "Phone", phone: "555-000-1111" });

  const r = await sync(d, conn, event(), [
    { lead_id: "C1", full_name: "Conflict", email: "conflict@example.com", phone: "5550001111" },
  ]);

  assert.equal(Number(r.rejected_count), 1, "the ambiguous row is rejected, not guessed at");
  const row = await one(d,
    `select status, error_code from public.lead_import_rows
      where workspace_id = $1 and source_row_key = 'C1'`, [o.ws]);
  assert.equal(row.status, "rejected");
  assert.equal(row.error_code, "identity_conflict");
  assert.equal(await contactCount(d, o), 2, "no contact was created or merged");
});

// ------------------------------------------------------------ file path

sqlTest("file import behaviour is unchanged: it still matches a hand-entered contact", async (d) => {
  const o = await owner(d);
  await manualContact(d, o, { id: "man-file", name: "", email: "viafile@example.com" });

  const r = await fileImport(d, o, [
    { full_name: "Via File", email: "viafile@example.com", preferred_area: "North" },
  ]);

  assert.equal(Number(r.imported_count), 0, "the file row matched rather than imported");
  assert.equal(await contactCount(d, o), 1);
  // The file path fills blank fields on a match; that rule is untouched.
  const c = await one(d, `select full_name, preferred_area from public.contacts where id = 'man-file'`);
  assert.equal(c.full_name, "Via File", "the file path still fills an empty name");
  assert.equal(c.preferred_area, "North");
});

// ------------------------------------------------------------ revert

sqlTest("the revert file puts the file-only behaviour back", async (d) => {
  // A database of its own: the revert changes the function for everybody.
  const rolled = await migratedDb();
  assert.ok(rolled);
  try {
    await runRevertCase(rolled);
  } finally {
    // Closed explicitly: a second PGlite instance left open keeps the
    // test process alive after the last assertion.
    try { await rolled.close(); } catch (e) { /* already closed */ }
  }
});

async function runRevertCase(rolled) {
  await rolled.exec(fs.readFileSync(REVERT, "utf8"));

  const o = await owner(rolled);
  const conn = await connection(rolled, o);
  await manualContact(rolled, o, { id: "man-back", name: "Hand Typed", email: "back@example.com" });

  const r = await sync(rolled, conn, event(), [
    { lead_id: "R1", full_name: "Hand Typed", email: "back@example.com" },
  ]);

  assert.equal(Number(r.imported_count), 1,
    "with the revert applied, the Sheet row duplicates the hand-entered contact again");
  assert.equal(await contactCount(rolled, o), 2, "which is the defect H-1 fixes");

  // And the file path still matches, as it did before H-1.
  const o2 = await owner(rolled);
  await manualContact(rolled, o2, { id: "man-back-file", email: "backfile@example.com" });
  const f = await fileImport(rolled, o2, [{ full_name: "F", email: "backfile@example.com" }]);
  assert.equal(Number(f.imported_count), 0, "the file fallback survives the revert");
}
