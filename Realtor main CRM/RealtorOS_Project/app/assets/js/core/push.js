/* ============================================================
   push.js — turning notifications on for this device, and off again.

   THE SHAPE OF THIS. Four things have to line up before a notification
   can arrive: the browser supports push, the app is installed or at
   least served over https, the person said yes to the permission
   prompt, and the server has VAPID keys. Three of those can be false
   for perfectly good reasons, so this module's main job is answering
   "what is the state" in a way the settings screen can put into plain
   words, rather than offering a button that fails.

   WHY ASKING IS BEHIND A BUTTON. A permission prompt on page load is
   the single most-blocked pattern on the web: say no once and the
   browser may never ask again, on any future visit, with no way back
   except digging through site settings. So the prompt only ever follows
   a deliberate tap on "Turn on notifications".

   iPHONE. Safari can do this, but only for an app that has been added
   to the Home Screen, and only on iOS 16.4 and later. In a normal
   Safari tab there is no API at all - not a refusal, an absence - so
   the only useful thing to show is how to install it first.
   ============================================================ */
window.App = window.App || {};

App.push = (function () {
  "use strict";

  const S = () => App.store;

  /* ---------- the VAPID public key ---------- */

  // Public by definition: it travels in every push request's headers.
  // Absent until go-live, which is a state the UI names rather than
  // treats as an error.
  function publicKey() {
    const key = (App.config && App.config.vapidPublicKey) || "";
    return typeof key === "string" && key.trim() ? key.trim() : null;
  }

  // A VAPID key is base64url; PushManager wants the raw bytes.
  function keyToBytes(base64url) {
    const padded = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4))
      .replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(padded);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // The other direction, for the keys the browser hands back.
  function bufferToB64url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /* ---------- what state are we in ---------- */

  function supported(win) {
    const w = win || window;
    return !!(w.navigator && w.navigator.serviceWorker && "PushManager" in w);
  }

  /**
   * One of:
   *   not_configured - the server has no VAPID key yet (pre-go-live)
   *   ios_needs_install - iPhone/iPad, not installed: Add to Home Screen first
   *   unsupported - this browser cannot do push at all
   *   blocked - the person said no, and only site settings can undo it
   *   on / off - the ordinary two
   */
  async function state(win) {
    const w = win || window;
    if (!publicKey()) return "not_configured";
    if (!supported(w)) {
      // Distinguish "your iPhone can, once it is installed" from "this
      // browser never will", because the first has an answer.
      if (App.pwa && App.pwa.isIos(w) && !(App.pwa.isStandalone && App.pwa.isStandalone(w))) {
        return "ios_needs_install";
      }
      return "unsupported";
    }
    const permission = (w.Notification && w.Notification.permission) || "default";
    if (permission === "denied") return "blocked";
    if (permission !== "granted") return "off";
    return (await currentSubscription(w)) ? "on" : "off";
  }

  async function currentSubscription(win) {
    const w = win || window;
    try {
      const reg = await w.navigator.serviceWorker.ready;
      return await reg.pushManager.getSubscription();
    } catch (e) {
      return null;
    }
  }

  /* ---------- turning it on ---------- */

  // Something recognisable in the device list. Not a fingerprint, and
  // not the full user-agent string: a person needs to know which of
  // their own devices a row is.
  function deviceLabel(win) {
    const w = win || window;
    const ua = String((w.navigator && w.navigator.userAgent) || "");
    const platform =
      /iPhone/i.test(ua) ? "iPhone"
      : /iPad/i.test(ua) ? "iPad"
      : /Android/i.test(ua) ? "Android phone"
      : /Macintosh/i.test(ua) ? "Mac"
      : /Windows/i.test(ua) ? "Windows PC"
      : /Linux/i.test(ua) ? "Linux"
      : "This device";
    const browser =
      /Edg\//i.test(ua) ? "Edge"
      : /OPR\//i.test(ua) ? "Opera"
      : /Chrome\//i.test(ua) ? "Chrome"
      : /Firefox\//i.test(ua) ? "Firefox"
      : /Safari\//i.test(ua) ? "Safari"
      : "";
    return (browser ? platform + " (" + browser + ")" : platform).slice(0, 60);
  }

  /**
   * Ask, subscribe, register. Returns an outcome string the caller puts
   * into words: on | blocked | dismissed | not_configured | unsupported |
   * failed.
   */
  async function enable(win) {
    const w = win || window;
    if (!publicKey()) return "not_configured";
    if (!supported(w)) return "unsupported";

    let permission;
    try {
      permission = await w.Notification.requestPermission();
    } catch (e) {
      return "failed";
    }
    if (permission === "denied") return "blocked";
    // "default" means the prompt was dismissed rather than answered -
    // not a refusal, and worth saying differently.
    if (permission !== "granted") return "dismissed";

    let subscription;
    try {
      const reg = await w.navigator.serviceWorker.ready;
      subscription = await reg.pushManager.getSubscription();
      if (!subscription) {
        subscription = await reg.pushManager.subscribe({
          // Required by every browser now: a push that shows nothing is
          // not allowed.
          userVisibleOnly: true,
          applicationServerKey: keyToBytes(publicKey()),
        });
      }
    } catch (e) {
      return "failed";
    }

    try {
      const out = await S().push.register(describe(subscription), deviceLabel(w));
      if (!out || out.outcome !== "registered") return "failed";
    } catch (e) {
      // Registered with the browser but not with us: unsubscribe again
      // rather than leave a device that will be pushed to by nobody.
      try { await subscription.unsubscribe(); } catch (err) { /* nothing to undo */ }
      return "failed";
    }
    return "on";
  }

  /** The three fields the server needs, out of a PushSubscription. */
  function describe(subscription) {
    const json = typeof subscription.toJSON === "function" ? subscription.toJSON() : subscription;
    const keys = (json && json.keys) || {};
    return {
      endpoint: json.endpoint,
      p256dh: keys.p256dh || (subscription.getKey
        ? bufferToB64url(subscription.getKey("p256dh")) : ""),
      auth: keys.auth || (subscription.getKey
        ? bufferToB64url(subscription.getKey("auth")) : ""),
    };
  }

  /** Off on this device: the browser forgets it, and so do we. */
  async function disable(win) {
    const w = win || window;
    const subscription = await currentSubscription(w);
    if (!subscription) return "off";
    const endpoint = subscription.endpoint;
    try { await subscription.unsubscribe(); } catch (e) { /* already gone */ }
    try { await S().push.remove(endpoint); } catch (e) { return "failed"; }
    return "off";
  }

  return {
    publicKey, supported, state, enable, disable, describe,
    deviceLabel, currentSubscription, keyToBytes, bufferToB64url,
  };
})();
