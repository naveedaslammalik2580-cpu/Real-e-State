// Step 1: the 20-hour provider retry cutoff must be measured from the
// PERSISTED outbound_messages.first_provider_attempt_at, never from an
// in-memory fallback.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { automationScenario, mockFetch, workerRequest, WORKER_ENV } from "../helpers/automation-fixture.mjs";

let handler;
let fetchMock;

beforeEach(async () => {
  globalThis.__edge.setEnv(WORKER_ENV);
  handler = await globalThis.__edge.load("process-automation");
  fetchMock = mockFetch();
});
afterEach(() => fetchMock.restore());

test("persistedTimestamp accepts only a parseable, non-empty string", () => {
  const { persistedTimestamp } = handler.module;
  assert.equal(persistedTimestamp("2026-09-28T10:00:00.000Z"), "2026-09-28T10:00:00.000Z");
  assert.equal(persistedTimestamp("2026-09-28 10:00:00+00"), "2026-09-28 10:00:00+00");
  assert.equal(persistedTimestamp(null), null);
  assert.equal(persistedTimestamp(undefined), null);
  assert.equal(persistedTimestamp(""), null);
  assert.equal(persistedTimestamp("   "), null);
  assert.equal(persistedTimestamp("not-a-date"), null);
  assert.equal(persistedTimestamp(1727517600000), null);
});

test("valid persisted first_provider_attempt_at -> provider called once, job completed", async () => {
  const { db, jobId } = automationScenario();
  db.install();
  const res = await handler(workerRequest());
  assert.equal(res.status, 200);
  assert.equal(fetchMock.calls.filter((c) => c.url.includes("api.resend.com/emails")).length, 1);
  const job = db.table("automation_jobs").find((j) => j.id === jobId);
  assert.equal(job.status, "completed");
  const msg = db.table("outbound_messages")[0];
  assert.equal(msg.status, "sent");
  assert.ok(msg.first_provider_attempt_at);
});

for (const [label, tamperValue] of [["missing", undefined], ["null", null], ["invalid", "not-a-date"]]) {
  test(`${label} persisted first_provider_attempt_at -> no provider call, retryable, message stays queued`, async () => {
    const { db, jobId } = automationScenario();
    db.install();
    db.tamper("outbound_messages", (row) => {
      if (tamperValue === undefined) delete row.first_provider_attempt_at;
      else row.first_provider_attempt_at = tamperValue;
    });
    const res = await handler(workerRequest());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.counters.jobsRescheduled, 1);
    assert.equal(fetchMock.calls.length, 0, "provider must not be called");
    const job = db.table("automation_jobs").find((j) => j.id === jobId);
    assert.equal(job.status, "pending", "job released for another attempt");
    assert.equal(job.last_error_code, "first_attempt_not_persisted");
    assert.equal(db.table("outbound_messages")[0].status, "queued");
  });
}

test("after a missing value, the next attempt stamps + verifies the column and then sends", async () => {
  const { db, jobId } = automationScenario();
  db.install();
  db.tamper("outbound_messages", (row) => { delete row.first_provider_attempt_at; });
  await handler(workerRequest());
  assert.equal(fetchMock.calls.length, 0);
  db.tampers.clear();
  const job = db.table("automation_jobs").find((j) => j.id === jobId);
  job.scheduled_at = "2026-09-01T00:00:00Z";
  await handler(workerRequest());
  assert.equal(fetchMock.calls.length, 1);
  assert.equal(job.status, "completed");
  const msg = db.table("outbound_messages")[0];
  assert.equal(msg.status, "sent");
  assert.ok(msg.first_provider_attempt_at, "stamped by ensureFirstProviderAttemptAt");
});
