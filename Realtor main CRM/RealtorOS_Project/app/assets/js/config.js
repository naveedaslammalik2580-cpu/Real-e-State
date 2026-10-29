window.App = window.App || {};
// Non-secret public configuration only: Supabase project URL and
// publishable (anon) key. Never place a service-role key here — this
// file ships to every browser as plain text.
App.config = {
  url: "https://yanasorwmaybnabfuepn.supabase.co",
  publishableKey: "sb_publishable_rACVZ0zvWjYtEhdxt1SyiA_XfRtUgrp",
  // Phase 3B. The VAPID PUBLIC key, which is public by definition - it
  // travels in the headers of every push request. The private half is a
  // server secret and lives only in the Edge Function environment
  // (VAPID_PRIVATE_KEY); it must never appear in this file.
  //
  // Empty until go-live. While it is empty the app says
  // "Phone notifications switch on when RealtorOS goes live." and never
  // asks for the notification permission - asking and then failing is
  // the one thing that costs the permission for good.
  //
  // Generate the pair with: node tools/make-vapid-keys.mjs
  vapidPublicKey: "",
  // Where the public website lives, for the auth gate's "Back to
  // website" link. Local development value; the production deployment
  // sets this to https://www.<production-domain> when the CRM ships to
  // https://app.<production-domain>. Not a secret.
  websiteUrl: "http://localhost:5501"
};
