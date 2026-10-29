// Stand-in for npm:@supabase/supabase-js. Every client created by the
// function under test talks to the current in-memory FakeDb.
export function createClient(url, key, options = {}) {
  const db = globalThis.__fakeDb;
  if (!db) throw new Error("no FakeDb installed for this test");
  const authorization = options?.global?.headers?.Authorization ?? null;
  return db.client({ url, key, authorization });
}
