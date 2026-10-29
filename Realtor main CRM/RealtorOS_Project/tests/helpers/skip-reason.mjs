// Why an environment-guarded test skipped, in one line.
//
// Three guards decide whether a whole family of tests can run - jsdom for
// the frontend tests (SKIP_DOM), xlsx/papaparse for the file-import tests
// (SKIP_LIBS) and PGlite for the SQL tests (SKIP_MESSAGE) - and each
// decides by trying to load the library and catching whatever comes back.
// Those catches used to swallow the error, so a run that skipped 29 tests
// on one machine and none on another said only "not installed", which is
// a guess: the import can also fail on an unsupported Node version, a
// half-written node_modules, or a native binding that will not load.
//
// Each guard now reports here instead, and the first failure per library
// prints its REAL error as a single line. Once per library per process,
// so a guard consulted by 28 tests still produces one line.
const reported = new Set();

export function reportSkipReason(library, err) {
  if (reported.has(library)) return;
  reported.add(library);
  const code = err && err.code ? `${err.code}: ` : "";
  const message = String((err && err.message) || err || "unknown error")
    .replace(/\s+/g, " ")
    .trim();
  console.error(
    `SKIP ${library} unavailable - ${code}${message} (run \`npm install\` in tests/ to enable these tests)`,
  );
}
