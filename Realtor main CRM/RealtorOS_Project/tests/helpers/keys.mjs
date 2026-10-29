// Recomputes process-automation's deterministic per-job message
// idempotency key (deterministicUuid(`automation-email:${jobId}`)), so a
// test can seed "a message from an earlier attempt of this job".
import { createHash } from "node:crypto";

export async function deterministicKey(jobId) {
  const hex = createHash("sha256").update(`automation-email:${jobId}`).digest("hex").slice(0, 32);
  const version4 = "4" + hex.slice(13, 16);
  const variant = "89ab"[parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version4}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
