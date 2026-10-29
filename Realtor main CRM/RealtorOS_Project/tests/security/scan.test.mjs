// Security scan: static checks over the source tree, plus a live run of
// the Edge Functions with console and responses captured, asserting that
// no secret, token or raw email address is ever logged or echoed back.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { automationScenario, mockFetch, workerRequest, WORKER_ENV, OWNER, CONTACT, CONTACT_EMAIL } from "../helpers/automation-fixture.mjs";
import { signedWebhookRequest, WEBHOOK_SECRET } from "../helpers/svix.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..", "..");

function walk(dir, pred, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}
const read = (p) => fs.readFileSync(p, "utf8");
const rel = (p) => path.relative(ROOT, p).replaceAll("\\", "/");

const FUNCTION_FILES = walk(path.join(ROOT, "supabase", "functions"), (p) => p.endsWith(".ts"));
const FRONTEND_FILES = [
  ...walk(path.join(ROOT, "app", "assets", "js"), (p) => p.endsWith(".js")),
  ...walk(path.join(ROOT, "app"), (p) => p.endsWith(".html")),
];

test("Edge Functions never log (no console.* anywhere)", () => {
  const hits = FUNCTION_FILES.filter((f) => /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/.test(read(f))).map(rel);
  assert.deepEqual(hits, []);
});

test("browser code never writes runtime, consent, email-block or webhook tables", () => {
  const protectedTables = [
    "automation_jobs", "automation_enrollments", "automation_runs", "automation_trigger_events", "automation_failures",
    "communication_consents", "email_suppressions", "outbound_messages", "webhook_events", "contact_stop_events",
  ];
  const offenders = [];
  for (const f of FRONTEND_FILES) {
    const src = read(f);
    for (const t of protectedTables) {
      const re = new RegExp(`from\\(\\s*["'\`]${t}["'\`]\\s*\\)([\\s\\S]{0,160})`, "g");
      let m;
      while ((m = re.exec(src))) {
        if (/\.(insert|update|upsert|delete)\s*\(/.test(m[1].split(/;|\n\s*\n/)[0])) offenders.push(`${rel(f)}: ${t}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("browser never calls worker/ingest functions or stop RPCs directly", () => {
  const offenders = [];
  for (const f of FRONTEND_FILES) {
    const src = read(f);
    if (/invoke\(\s*["'`](ingest-sheet-leads|process-automation|resend-webhook)["'`]/.test(src)) offenders.push(`${rel(f)}: invokes a machine-only function`);
    if (/\.rpc\(\s*["'`]realtoros_(record_contact_stop_event|stop_enrollment_on_event|presend_guard|skip_claimed_job)["'`]/.test(src)) offenders.push(`${rel(f)}: calls a service-role stop RPC`);
  }
  assert.deepEqual(offenders, []);
});


test("no browser storage of tokens (localStorage / sessionStorage / IndexedDB)", () => {
  const hits = [];

  // Preserve the original strict scanner.
  const storagePattern =
    /\b(localStorage|sessionStorage)\s*[.[]|\bindexedDB\s*\.\s*open\b/;

  const approvedPwaFile = "app/assets/js/core/pwa.js";

  const approvedWrite =
    'w.localStorage.setItem(BANNER_DISMISSED_KEY, "1")';

  const approvedRead =
    "w.localStorage.getItem(BANNER_DISMISSED_KEY)";

  const countOccurrences = (source, text) =>
    source.split(text).length - 1;

  for (const file of FRONTEND_FILES) {
    let source = read(file);

    if (rel(file) === approvedPwaFile) {
      // Only the fixed PWA installation-banner preference is allowed.
      // No authentication data, session details or tokens are stored.
      assert.match(
        source,
        /const\s+BANNER_DISMISSED_KEY\s*=\s*["']realtoros\.install\.banner\.dismissed["']\s*;/,
        "The PWA preference key must remain the approved fixed value"
      );

      // The existing PWA implementation performs exactly two writes.
      assert.equal(
        countOccurrences(source, approvedWrite),
        2,
        "Only two approved PWA banner writes are permitted"
      );

      // The existing PWA implementation performs exactly one read.
      assert.equal(
        countOccurrences(source, approvedRead),
        1,
        "Only one approved PWA banner read is permitted"
      );

      // Exclude only the three explicitly verified harmless operations.
      source = source
        .split(approvedWrite).join("")
        .split(approvedRead).join("");
    }

    // Continue rejecting every other storage access recognized
    // by the original security scanner.
    if (storagePattern.test(source)) {
      hits.push(rel(file));
    }
  }

  assert.deepEqual(
    hits,
    [],
    `Unexpected browser storage usage: ${hits.join(", ")}`
  );
});


test("no secrets in tracked files", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)
    .filter((f) => !f.startsWith("tests/") && /\.(ts|js|mjs|sql|md|toml|json|html|gs|example)$/.test(f));
  const patterns = [
    [/\bre_[A-Za-z0-9]{24,}\b/, "Resend API key"],
    [/\bwhsec_[A-Za-z0-9+/=]{20,}/, "webhook signing secret"],
    [/\bsb_secret_[A-Za-z0-9_-]{10,}/, "Supabase secret key"],
    [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, "JWT (service role?)"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  ];
  const hits = [];
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p) || fs.statSync(p).size > 2_000_000) continue;
    const src = read(p);
    for (const [re, what] of patterns) if (re.test(src)) hits.push(`${f}: ${what}`);
  }
  assert.deepEqual(hits, []);
});

test("live run: no secret, token or raw address in logs or responses", async () => {
  const secrets = [WORKER_ENV.RESEND_API_KEY, WORKER_ENV.AUTOMATION_WORKER_SECRET, WORKER_ENV.UNSUBSCRIBE_SIGNING_SECRET, WORKER_ENV.SUPABASE_SERVICE_ROLE_KEY, WEBHOOK_SECRET];
  const logged = [];
  const saved = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) {
    saved[k] = console[k];
    console[k] = (...a) => logged.push(a.map(String).join(" "));
  }
  const bodies = [];
  const fetchMock = mockFetch((url) => url.includes("/emails/receiving/")
    ? new Response(JSON.stringify({ headers: {}, subject: "Re: hi", from: CONTACT_EMAIL }), { status: 200 })
    : new Response(JSON.stringify({ id: "re_live_1" }), { status: 200 }));
  try {
    const env = { ...WORKER_ENV, RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET, INBOUND_REPLY_DOMAIN: "reply.example.com" };
    globalThis.__edge.setEnv(env);
    const worker = await globalThis.__edge.load("process-automation");
    const webhook = await globalThis.__edge.load("resend-webhook");
    const unsub = await globalThis.__edge.load("email-unsubscribe");

    const s = automationScenario();
    s.db.unique("webhook_events", ["provider", "provider_event_id"]);
    s.db.install();
    bodies.push(await (await worker(workerRequest())).text());
    bodies.push(await (await worker(workerRequest("wrong-secret"))).text());
    const msg = s.db.table("outbound_messages")[0];

    for (const type of ["email.delivered", "email.complained", "email.bounced"]) {
      bodies.push(await (await webhook(signedWebhookRequest({ type, data: { email_id: "re_live_1" } }).request)).text());
    }
    bodies.push(await (await webhook(signedWebhookRequest({ type: "email.received", data: { email_id: "in_1", to: [`r-${msg.metadata.reply_token}@reply.example.com`] } }).request)).text());

    const unsubUrl = /<([^>]+)>/.exec(fetchMock.calls[0].body.headers["List-Unsubscribe"])[1];
    // The GET confirmation page must carry the token in its own form
    // action (that is how the POST authenticates); it is only ever served
    // to whoever already holds the link. Checked for secrets/addresses only.
    const confirmPage = await (await unsub(new Request(unsubUrl))).text();
    bodies.push(await (await unsub(new Request(unsubUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }))).text());
    const token = new URL(unsubUrl).searchParams.get("t");

    const forbidden = [...secrets, CONTACT_EMAIL, CONTACT_EMAIL.toLowerCase(), token, OWNER];
    for (const text of [...logged, ...bodies]) {
      for (const f of forbidden) assert.ok(!text.includes(f), `leaked ${f.slice(0, 12)}… in: ${text.slice(0, 120)}`);
    }
    for (const f of [...secrets, CONTACT_EMAIL, CONTACT_EMAIL.toLowerCase(), OWNER]) {
      assert.ok(!confirmPage.includes(f), `confirmation page leaked ${f.slice(0, 12)}…`);
    }
    for (const row of s.db.table("webhook_events")) {
      assert.ok(!JSON.stringify(row.payload).includes("@"), "no address stored in webhook payloads");
    }
    assert.equal(logged.length, 0, "nothing logged at all");
    assert.ok(s.db.table("contact_stop_events").length >= 1);
  } finally {
    fetchMock.restore();
    for (const k of Object.keys(saved)) console[k] = saved[k];
  }
});
