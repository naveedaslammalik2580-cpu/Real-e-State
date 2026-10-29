// Builds the migrated-database snapshot, or clears it.
//
// The SQL tests do this for themselves the first time one of them needs it,
// so this script is only for when you want the cost paid up front (or want
// to know whether the chain still applies cleanly at all):
//
//   npm run test:cache          build it now, and say how long it took
//   npm run test:cache:clear    throw it away
//
// Clearing is the thing to do if a snapshot is ever suspected: it is keyed
// by every migration's name and contents, so it should rebuild itself after
// any migration change, and a stale one is a bug rather than a routine
// state.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migratedDb, migrationFiles, loadPGlite } from "./pg.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(here, "..", ".cache");

if (process.argv.includes("--clear")) {
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  console.log("Snapshot cleared. The next SQL test run rebuilds it.");
  process.exit(0);
}

const PGlite = await loadPGlite();
if (!PGlite) {
  // loadPGlite already printed the reason.
  console.log("Nothing to build: the SQL tests will skip.");
  process.exit(0);
}

const started = Date.now();
const db = await migratedDb();
if (!db) {
  console.error("Could not build the database.");
  process.exit(1);
}
const count = (await db.query("select count(*)::int as n from pg_tables where schemaname = 'public'")).rows[0].n;
await db.close();

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`${migrationFiles().length} migrations applied, ${count} tables, in ${seconds}s.`);
console.log(`Snapshot: ${path.relative(process.cwd(), path.join(CACHE_DIR, "migrated.tar.gz"))}`);
