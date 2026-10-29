// Prints one VAPID key pair for web push.
//
//   node tools/make-vapid-keys.mjs
//
// WHAT IT DOES NOT DO: write anything. Not a file, not an .env, not a
// clipboard. The private key is a server secret, and a tool that helpfully
// drops it into the working tree is a tool that eventually commits it. It
// goes on screen once; you paste it into the Supabase dashboard and close
// the terminal.
//
// WHAT GOES WHERE
//
//   VAPID_PUBLIC_KEY   Edge Function secret, AND app/assets/js/config.js
//                      (vapidPublicKey). Public by definition - it travels
//                      in the headers of every push request.
//   VAPID_PRIVATE_KEY  Edge Function secret only. Never in the repo, never
//                      in config.js, never in a browser.
//   VAPID_SUBJECT      Edge Function secret: mailto:you@yourdomain.com, so
//                      a push service has somebody to contact about your
//                      traffic.
//
// ROTATING THESE INVALIDATES EVERY DEVICE. A subscription is bound to the
// public key it was created with, so after a rotation every browser has to
// subscribe again - old endpoints simply start returning 403. Generate
// once, keep them.
import { webcrypto } from "node:crypto";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

const pair = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

// The public key as an uncompressed point (65 bytes, 0x04 || x || y),
// which is the form RFC 8292 puts in the `k=` parameter.
const publicRaw = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
// The private key as the raw scalar, which is what the `d` of its JWK is.
const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);

if (publicRaw.length !== 65 || publicRaw[0] !== 4) {
  console.error("Unexpected public key encoding; refusing to print a pair that may not work.");
  process.exit(1);
}

console.log(`
A new VAPID key pair. Both halves below; the private one is a secret.

  VAPID_PUBLIC_KEY   ${b64url(publicRaw)}
  VAPID_PRIVATE_KEY  ${jwk.d}
  VAPID_SUBJECT      mailto:you@yourdomain.com      <- change this

Next:
  1. Set all three as Edge Function secrets (Supabase dashboard →
     Project Settings → Edge Functions → Secrets, or
     \`supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=...\`).
  2. Put the PUBLIC key, and only the public key, into
     app/assets/js/config.js as vapidPublicKey.
  3. Deploy process-automation. Until all three secrets exist the worker
     skips the push step and nothing breaks.

Rotating these later unsubscribes every device, so keep them somewhere safe.
`);
