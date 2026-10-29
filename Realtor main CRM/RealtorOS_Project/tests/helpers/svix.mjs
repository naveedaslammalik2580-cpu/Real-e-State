// Signs a webhook body the way Resend/Svix does: HMAC-SHA256 over
// "{id}.{timestamp}.{body}" with the base64 key after the "whsec_" prefix.
import { createHmac, randomBytes } from "node:crypto";

export const WEBHOOK_SECRET = "whsec_" + Buffer.from("offline-test-webhook-key-0123456789abcdef").toString("base64");

export function signedWebhookRequest(body, { id = `msg_${randomBytes(8).toString("hex")}`, secret = WEBHOOK_SECRET, timestamp, tamper = false } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  return {
    id,
    request: new Request("https://unit-test.supabase.co/functions/v1/resend-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": id,
        "svix-timestamp": ts,
        "svix-signature": `v1,${tamper ? sig.replace(/^./, (c) => (c === "A" ? "B" : "A")) : sig}`,
      },
      body: raw,
    }),
  };
}
