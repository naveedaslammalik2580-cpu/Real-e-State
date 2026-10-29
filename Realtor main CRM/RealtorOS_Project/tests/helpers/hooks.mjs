// Node module-resolution hooks for the offline test suite.
//
// The Edge Functions import `npm:@supabase/supabase-js@...` (a Deno-only
// specifier). Under Node that specifier is redirected to a local stub whose
// createClient() hands back the in-memory fake from fake-db.mjs, so no test
// can ever reach a real Supabase project.
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const supabaseStub = pathToFileURL(path.join(here, "supabase-stub.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("npm:@supabase/supabase-js")) {
    return { url: supabaseStub, shortCircuit: true };
  }
  if (specifier.startsWith("npm:") || specifier.startsWith("jsr:") || specifier.startsWith("https:")) {
    throw new Error(`offline test suite: unexpected remote import ${specifier}`);
  }
  return nextResolve(specifier, context);
}
