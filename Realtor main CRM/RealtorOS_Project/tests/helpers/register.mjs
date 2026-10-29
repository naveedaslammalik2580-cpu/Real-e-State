// Loaded with `node --import ./tests/helpers/register.mjs`. Installs the
// module hooks and a minimal `Deno` global before any Edge Function module
// is imported.
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);

const env = new Map();
const handlers = new Map();
let pendingName = null;

globalThis.Deno = {
  env: {
    get: (name) => (env.has(name) ? env.get(name) : undefined),
  },
  serve: (handler) => {
    handlers.set(pendingName ?? `anonymous-${handlers.size}`, handler);
  },
};

// Test-side controls, never visible to the functions under test.
globalThis.__edge = {
  env,
  setEnv(values) {
    env.clear();
    for (const [k, v] of Object.entries(values)) env.set(k, v);
  },
  // Imports a function module once and returns its Deno.serve handler.
  async load(name) {
    if (handlers.has(name)) return handlers.get(name);
    pendingName = name;
    const url = new URL(`../../supabase/functions/${name}/index.ts`, import.meta.url);
    const mod = await import(url.href);
    pendingName = null;
    const handler = handlers.get(name);
    if (!handler) throw new Error(`${name} did not call Deno.serve`);
    handler.module = mod;
    return handler;
  },
};
