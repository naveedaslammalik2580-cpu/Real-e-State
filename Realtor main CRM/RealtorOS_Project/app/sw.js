/* ============================================================
   sw.js — the app shell, cached, and nothing else.

   WHAT THIS IS FOR. One thing: opening the app on a phone with a bad
   signal should show the app rather than the dinosaur. The shell is the
   HTML, the CSS, the scripts, the icons and the fonts - files that are
   the same for every agent and change only when a version ships.

   WHAT IT MUST NEVER TOUCH, and the reason each one matters:

     * Anything to do with Supabase. A cached contact is a wrong contact
       the moment somebody edits it, and a cached response to an
       authenticated read is somebody else's data if two accounts ever
       share a browser profile. Business data has one source of truth and
       it is not here.
     * Anything carrying an Authorization header, wherever it is going.
       Same reason, stated as a rule rather than a hostname, so a new
       backend does not quietly get cached because nobody updated a list.
     * Anything that is not a GET. A POST is an instruction, not a
       document; replaying one from a cache would be a second write.

   For those, this worker does not call respondWith at all - the request
   goes to the network as if no service worker existed. That is stronger
   than fetching and not caching: the worker is not in the path.

   UPDATES. A new worker installs in the background and waits. The page
   notices it waiting and offers "Reload" (see core/pwa.js); only then
   does it send SKIP_WAITING. Swapping the shell under somebody mid-edit
   to save them a click is not a trade worth making.
   ============================================================ */

// Bump this when the shell changes. The cache name carries it, so a new
// version installs beside the old one and the old one is deleted on
// activate - never a half-old, half-new shell.
const VERSION = "u7-onboarding-20261018";
const CACHE = "realtoros-shell-" + VERSION;

// Everything the app needs to render its first screen without a network.
// Kept in index.html's own order; tests/frontend/pwa.test.mjs fails if
// index.html grows a script this list does not have.
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/css/realtoros.css",
  "./assets/js/config.js",
  "./assets/js/core/utils.js",
  "./assets/js/core/lead-file.js",
  "./assets/js/core/commission.js",
  "./assets/js/core/follow-up.js",
  "./assets/js/core/response-stats.js",
  "./assets/js/core/starter-packs.js",
  "./assets/js/core/quick-add.js",
  "./assets/js/core/header-actions.js",
  "./assets/js/data/store.js",
  "./assets/js/data/supabase-client.js",
  "./assets/js/data/workspace.js",
  "./assets/js/data/data-service.js",
  "./assets/js/core/customization.js",
  "./assets/js/core/pwa.js",
  "./assets/js/core/mobile-nav.js",
  "./assets/js/core/push.js",
  "./assets/js/ui/custom-fields-ui.js",
  "./assets/js/core/derived.js",
  "./assets/js/data/backup.js",
  "./assets/js/app.js",
  "./assets/js/pages/contacts.js",
  "./assets/js/pages/lead-file-import.js",
  "./assets/js/pages/properties.js",
  "./assets/js/pages/buyer.js",
  "./assets/js/pages/seller.js",
  "./assets/js/pages/deals.js",
  "./assets/js/pages/commission.js",
  "./assets/js/pages/activities.js",
  "./assets/js/pages/tasks.js",
  "./assets/js/pages/calendar.js",
  "./assets/js/pages/referrals.js",
  "./assets/js/pages/goals.js",
  "./assets/js/pages/finances.js",
  "./assets/js/pages/reports.js",
  "./assets/js/pages/release.js",
  "./assets/js/pages/google-sheets-settings.js",
  "./assets/js/pages/google-sheets-import-history.js",
  "./assets/js/pages/email-templates.js",
  "./assets/js/pages/automation.js",
  "./assets/js/pages/notifications.js",
  "./assets/js/pages/push-settings.js",
  "./assets/js/pages/onboarding.js",
  "./assets/js/pages/email-sending-settings.js",
  "./assets/js/pages/custom-fields-settings.js",
  "./assets/js/pages/team-management.js",
  "./assets/js/pages/team-permissions.js",
  "./assets/js/pages/team-join.js",
  "./assets/js/pages/team-dashboard.js",
  "./assets/js/pages/scheduler.js",
  "./assets/js/boot.js",
  "./assets/fonts/inter-latin.woff2",
  "./assets/fonts/source-serif-4-latin.woff2",
  "./assets/fonts/manrope-latin.woff2",
  "./assets/fonts/dm-serif-display-latin.woff2",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/icon-maskable-512.png",
  "./assets/icons/apple-touch-icon-180.png",
  "./assets/icons/favicon-32.png",
  "./assets/icons/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One at a time, each allowed to fail. cache.addAll() is all-or-
    // nothing: one 404 on a font would leave the app with no offline
    // shell at all and no clue why.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    // No skipWaiting here on purpose - the page asks for it.
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith("realtoros-shell-") && n !== CACHE)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event && event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/* ============================================================
   PHASE 3B — SHOWING A PUSH, AND WHAT HAPPENS WHEN IT IS TAPPED

   The caching rules above are untouched. A push is a different event
   entirely: it arrives with no page open and no fetch involved.

   WHAT ARRIVES. { title, body, url } and nothing else - the payload is
   built in supabase/functions/_shared/push.ts and carries no contact
   id, address or phone number, because until the device collects it the
   payload sits on a push service's server.

   A MALFORMED PUSH STILL SHOWS SOMETHING. Browsers may wake a worker
   with an empty push to test it, and some services strip payloads;
   showing a generic line is better than showing nothing, and on several
   browsers failing to show anything at all is a policy violation that
   costs the site its permission.
   ============================================================ */

const PUSH_FALLBACK_TITLE = "RealtorOS";

self.addEventListener("push", (event) => {
  let data = {};
  try {
    if (event && event.data) data = event.data.json();
  } catch (e) {
    data = {};
  }
  const title = (typeof data.title === "string" && data.title.trim())
    ? data.title.slice(0, 200)
    : PUSH_FALLBACK_TITLE;
  const body = typeof data.body === "string" ? data.body.slice(0, 400) : "";
  // An internal route only, exactly like the database's own link_route
  // check. Anything else - an absolute URL above all - is dropped and
  // the notification opens the app's front door instead.
  const url = (typeof data.url === "string" && /^\/[A-Za-z0-9/_-]*$/.test(data.url))
    ? data.url
    : "/dashboard";

  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "./assets/icons/icon-192.png",
    badge: "./assets/icons/icon-192.png",
    data: { url },
    // The notification id, so a second push about the same thing
    // replaces the first rather than stacking up.
    tag: typeof data.id === "string" ? data.id : undefined,
    renotify: false,
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/dashboard";

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // A window that is already open is the one to use: opening a second
    // copy of a single-page app loses whatever was on screen, and this
    // app routes on the hash, so it can simply be pointed somewhere.
    for (const client of clients) {
      if (!client.url || client.url.indexOf(self.location.origin) !== 0) continue;
      try {
        await client.focus();
        if ("navigate" in client) await client.navigate("./#" + target);
        else client.postMessage({ type: "NAVIGATE", url: target });
        return;
      } catch (e) {
        // A client that will not focus (another tab took it) falls
        // through to opening a window.
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow("./#" + target);
  })());
});

/**
 * Is this a request this worker is allowed to have an opinion about?
 * Exported onto self so the tests can ask it directly rather than
 * inferring it from whether respondWith happened to be called.
 */
function isShellRequest(request) {
  if (!request || request.method !== "GET") return false;
  // An Authorization header means this is somebody's data, whatever the
  // host. Not ours to store.
  try {
    if (request.headers && request.headers.get && request.headers.get("authorization")) return false;
  } catch (e) { return false; }

  let url;
  try { url = new URL(request.url); } catch (e) { return false; }

  // Supabase: the REST API, auth, realtime, storage and every Edge
  // Function all live under the project host.
  if (/(^|\.)supabase\.(co|in|net)$/i.test(url.hostname)) return false;
  if (/\/functions\/v1\//.test(url.pathname)) return false;
  if (/\/(rest|auth|realtime|storage)\/v\d/.test(url.pathname)) return false;

  // Only our own origin. The Supabase client comes off a CDN; a
  // third-party script is not ours to version.
  if (url.origin !== self.location.origin) return false;

  return true;
}
self.isShellRequest = isShellRequest;

const isHtml = (request, url) =>
  request.mode === "navigate"
  || url.pathname.endsWith("/")
  || url.pathname.endsWith("/index.html");

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (!isShellRequest(request)) return;   // not ours: no respondWith at all

  let url;
  try { url = new URL(request.url); } catch (e) { return; }

  if (isHtml(request, url)) {
    // Network-first, so a deployed change is picked up on the next load
    // rather than after a cache expiry nobody can explain. The cache is
    // the fallback for a dead connection.
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put("./index.html", fresh.clone());
        }
        return fresh;
      } catch (err) {
        const cached = await caches.match("./index.html", { ignoreSearch: true });
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  // Everything else in the shell is versioned by the cache name, so the
  // copy on disk is by definition the copy this version wants.
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const fresh = await fetch(request);
    if (fresh && fresh.ok && fresh.type !== "opaque") {
      const cache = await caches.open(CACHE);
      cache.put(request, fresh.clone());
    }
    return fresh;
  })());
});
