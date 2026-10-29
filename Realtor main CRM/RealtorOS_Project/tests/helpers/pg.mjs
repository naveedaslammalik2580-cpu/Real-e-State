// Loads every migration, in filename order, into an in-process PGlite
// database behind a minimal stand-in for the Supabase platform objects the
// migrations reference (roles, auth.users/auth.uid(), storage, realtime).
// Returns null when PGlite is not installed so SQL tests can skip cleanly.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { reportSkipReason } from "./skip-reason.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Where the migrated-database snapshot is kept between test files. One
// directory, git-ignored, rebuilt whenever a migration changes.
const SNAPSHOT_DIR = path.join(here, "..", ".cache");
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, "migrated.tar.gz");
const SNAPSHOT_KEY_FILE = path.join(SNAPSHOT_DIR, "migrated.key");

export const MIGRATIONS_DIR = path.join(here, "..", "..", "supabase", "migrations");

export const PLATFORM_PRELUDE = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
-- email is here because T3's invitations are addressed to an email and
-- matched against the accepting account's own, so a stand-in without it
-- cannot exercise the flow at all. Real Supabase has it (nullable, and
-- unique per instance); this mirrors that closely enough to test against.
create table auth.users (id uuid primary key, email text unique);
-- Mirrors live Supabase, which resolves the caller from EITHER the
-- flattened claim or the whole claims object:
--   coalesce(request.jwt.claim.sub, request.jwt.claims ->> 'sub')
-- A shim that read only the first made any code that blanks only
-- request.jwt.claim.sub look like a trusted server-side caller here while
-- still being a JWT caller on live - which is precisely the bug that
-- reached production in realtoros_leave_workspace.
create function auth.uid() returns uuid language sql stable
  as $$ select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid $$;
create function auth.role() returns text language sql stable
  as $$ select current_setting('request.jwt.claim.role', true) $$;
-- Match live Supabase: the three API roles may call auth.uid()/auth.role()
-- from their own schemas (e.g. an INVOKER function in a custom schema).
-- service_role has full table access on auth so account-admin flows and
-- audit-cleanup tests can delete auth.users rows.
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
grant select, insert, update, delete on auth.users to service_role;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
create schema extensions;
create publication supabase_realtime;
-- Supabase's defaults: every new public table/function/sequence is granted
-- to all three API roles. This is exactly why each migration explicitly
-- revokes from anon/authenticated, so the grant checks below are real.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

export async function loadPGlite() {
  try {
    const mod = await import("@electric-sql/pglite");
    return mod.PGlite;
  } catch (err) {
    // The exact condition behind every SKIP_MESSAGE skip, printed once.
    reportSkipReason("@electric-sql/pglite", err);
    return null;
  }
}

export function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
}

// A fresh database with the platform prelude and pgcrypto installed in the
// `extensions` schema, as on Supabase (the lead-import functions hash with
// extensions.digest). Returns null when PGlite is not installed.
export async function platformDb() {
  const PGlite = await loadPGlite();
  if (!PGlite) return null;
  let extensions = {};
  try {
    const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
    extensions = { pgcrypto };
  } catch {
    // pgcrypto unavailable: functions that hash will fail loudly in tests.
  }
  const db = new PGlite({ extensions });
  await db.exec(PLATFORM_PRELUDE);
  if (extensions.pgcrypto) await db.exec("create extension if not exists pgcrypto with schema extensions;");
  // As on Supabase: the API roles may use the extensions schema.
  await db.exec("grant usage on schema extensions to anon, authenticated, service_role;");
  return db;
}

// Applies migrations in filename order. `filter` selects a prefix of the
// chain (e.g. everything before a given migration) for regression tests.
// ---------- THE MIGRATED DATABASE, BUILT ONCE PER RUN ----------
//
// Applying the whole migration chain takes seconds, and every SQL test
// file used to pay it again. PGlite can dump its data directory to a tar
// and start from one, so the full chain is built once, dumped to
// tests/.cache, and every later caller starts from that dump instead -
// across test files, since node --test runs each file in its own process
// and the cache is on disk.
//
// The snapshot is keyed by the migration filenames AND their contents, so
// editing or adding a migration invalidates it automatically. Nothing
// else is in the key, because nothing else goes into the database.
//
// A filtered call (a prefix of the chain, for the regression tests that
// need the schema as it stood at some point) never uses the snapshot:
// those want a different database by definition.
function chainKey(files) {
  const h = crypto.createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\0");
    h.update(fs.readFileSync(path.join(MIGRATIONS_DIR, f)));
  }
  return h.digest("hex");
}

function readSnapshot(key) {
  try {
    if (fs.readFileSync(SNAPSHOT_KEY_FILE, "utf8").trim() !== key) return null;
    return fs.readFileSync(SNAPSHOT_FILE);
  } catch {
    return null;
  }
}

function writeSnapshot(key, bytes) {
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    // Written to a temporary name and renamed, so two test processes
    // building it at once can never leave a half-written tar behind.
    const tmp = SNAPSHOT_FILE + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, SNAPSHOT_FILE);
    fs.writeFileSync(SNAPSHOT_KEY_FILE, key);
  } catch {
    // A cache that cannot be written is only slow, never wrong.
  }
}

async function applyChain(db, files) {
  for (const f of files) {
    await db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
  }
  return db;
}

/**
 * A database with the migration chain applied. With no filter this is the
 * full chain and comes from the shared snapshot; with a filter the named
 * prefix is applied from scratch.
 */
export async function migratedDb(filter) {
  if (typeof filter === "function") {
    const db = await platformDb();
    if (!db) return null;
    return applyChain(db, migrationFiles().filter(filter));
  }

  const PGlite = await loadPGlite();
  if (!PGlite) return null;
  const files = migrationFiles();
  const key = chainKey(files);

  const cached = readSnapshot(key);
  if (cached) {
    const db = await fromSnapshot(PGlite, cached);
    if (db) return db;
    // A snapshot that will not load is treated as absent: build instead.
  }

  const db = await platformDb();
  if (!db) return null;
  await applyChain(db, files);
  try {
    const dump = await db.dumpDataDir("gzip");
    writeSnapshot(key, Buffer.from(await dump.arrayBuffer()));
  } catch {
    // Same again: no snapshot only costs time.
  }
  return db;
}

async function fromSnapshot(PGlite, bytes) {
  let extensions = {};
  try {
    const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
    extensions = { pgcrypto };
  } catch {
    // As in platformDb: functions that hash will fail loudly instead.
  }
  try {
    // A fresh Blob per load: the file bytes are reused, the Blob is not.
    const blob = new Blob([bytes], { type: "application/x-gzip" });
    return await PGlite.create({ loadDataDir: blob, extensions });
  } catch {
    return null;
  }
}

export const SKIP_MESSAGE = "PGlite not installed — run `npm install` in tests/ to enable SQL tests";

// Seeds one owner with one contact, one active rule (with the given stop
// flags) and one active enrollment holding one pending job. Returns ids.
export async function seedWorld(db, opts = {}) {
  const userId = randomUUID();
  const contactId = `c-${randomUUID()}`;
  const ruleId = randomUUID();
  const enrollmentId = randomUUID();
  const jobId = randomUUID();
  const email = opts.email ?? `Person.${contactId.slice(2, 8)}@Example.com`;
  await db.query(`insert into auth.users (id) values ($1)`, [userId]);
  await db.query(
    `insert into public.contacts (id, user_id, full_name, email, status) values ($1, $2, 'Test Person', $3, 'New Lead')`,
    [contactId, userId, email],
  );
  await db.query(
    `insert into public.automation_rules (id, user_id, name, trigger_type, status, stop_on_reply, stop_on_unsubscribe, runtime_version)
     values ($1, $2, $3, 'manual', $4, $5, $6, gen_random_uuid())`,
    [ruleId, userId, `Rule ${ruleId.slice(0, 8)}`, opts.ruleStatus ?? "active", opts.stopOnReply ?? true, opts.stopOnUnsubscribe ?? true],
  );
  await db.query(
    `insert into public.automation_enrollments (id, user_id, rule_id, contact_id, status) values ($1, $2, $3, $4, $5)`,
    [enrollmentId, userId, ruleId, contactId, opts.enrollmentStatus ?? "active"],
  );
  await db.query(
    `insert into public.automation_jobs (id, user_id, enrollment_id, rule_id, contact_id, job_type, status, idempotency_key, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [jobId, userId, enrollmentId, ruleId, contactId, opts.jobType ?? "send_email", opts.jobStatus ?? "pending", `k-${jobId}`,
      JSON.stringify({ step_order: 1, action_type: opts.jobType ?? "send_email" })],
  );
  return { userId, contactId, ruleId, enrollmentId, jobId, email };
}

export async function one(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0];
}

export async function rpc(db, fn, args) {
  const keys = Object.keys(args);
  const placeholders = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
  const r = await db.query(`select public.${fn}(${placeholders}) as out`, keys.map((k) => args[k]));
  return r.rows[0].out;
}
