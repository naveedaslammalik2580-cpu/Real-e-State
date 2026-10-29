/* ============================================================
   pwa.js — registering the service worker, offering the update, and
   the three different ways a browser lets somebody install an app.

   WHY ANY OF THIS. An agent opens this on a phone between viewings. A
   browser tab is a thing you lose; a home-screen icon is a thing you
   tap. Everything here exists to get the icon onto the home screen and
   to keep the shell on disk so opening it is instant.

   THE THREE INSTALL STORIES, because there is no single API:
     * Chrome / Edge, Android or desktop: the browser fires
       beforeinstallprompt, we keep the event, and the button calls
       prompt() on it. That event only arrives once and only when the
       browser has decided the app is installable, so the button cannot
       be shown until it has.
     * Safari on iPhone / iPad: there is no API at all. The only honest
       thing is to show the three taps - Share, Add to Home Screen, Add.
     * Already installed: show nothing but a line saying so. An install
       button in an installed app is a dead control.

   NOTHING HERE DECIDES FROM THE USER AGENT except iOS, where there is no
   alternative - every other branch is driven by a capability (an event
   arrived, or display-mode says standalone).
   ============================================================ */
window.App = window.App || {};

App.pwa = (function () {
  "use strict";

  const U = () => App.util;

  const BANNER_DISMISSED_KEY = "realtoros.install.banner.dismissed";

  // Set when the browser tells us it would install this app. Kept
  // because the event can only be used once and only later, when
  // somebody presses a button.
  let deferredPrompt = null;
  let onStateChange = null;

  /* ---------- WHAT STATE ARE WE IN ---------- */

  function isStandalone(win) {
    const w = win || window;
    try {
      if (w.matchMedia && w.matchMedia("(display-mode: standalone)").matches) return true;
    } catch (e) { /* no matchMedia in this environment */ }
    // iOS Safari's own flag, which predates display-mode and is still
    // the only truth there.
    return w.navigator && w.navigator.standalone === true;
  }

  // The one user-agent test in the file. iOS has no install API, so
  // there is nothing else to key the instructions off. iPadOS reports
  // itself as a Mac, hence the touch check.
  function isIos(win) {
    const w = win || window;
    const nav = w.navigator || {};
    const ua = String(nav.userAgent || "");
    if (/iPhone|iPad|iPod/i.test(ua)) return true;
    return /Macintosh/i.test(ua) && (nav.maxTouchPoints || 0) > 1;
  }

  function isSecureContextFor(win) {
    const w = win || window;
    const loc = w.location || {};
    if (loc.protocol === "https:") return true;
    return loc.hostname === "localhost" || loc.hostname === "127.0.0.1" || loc.hostname === "[::1]";
  }

  /**
   * { installed, canPrompt, ios } — everything the UI branches on, in
   * one place so the card, the banner and the tests all agree.
   */
  function installState(win) {
    const w = win || window;
    return {
      installed: isStandalone(w),
      canPrompt: !!deferredPrompt,
      ios: isIos(w)
    };
  }

  /** The browser's offer, kept for the button. */
  function captureInstallPrompt(win) {
    const w = win || window;
    w.addEventListener("beforeinstallprompt", (e) => {
      // Without this the browser shows its own bar wherever it likes;
      // we want the offer in the places we chose.
      if (e && typeof e.preventDefault === "function") e.preventDefault();
      deferredPrompt = e;
      if (onStateChange) onStateChange();
    });
    w.addEventListener("appinstalled", () => {
      deferredPrompt = null;
      try { w.localStorage.setItem(BANNER_DISMISSED_KEY, "1"); } catch (err) { /* private mode */ }
      if (onStateChange) onStateChange();
    });
  }

  /** Runs the browser's install flow. Resolves to the outcome string. */
  async function promptInstall() {
    if (!deferredPrompt) return "unavailable";
    const e = deferredPrompt;
    // One use only: whatever happens, this event is spent.
    deferredPrompt = null;
    try {
      e.prompt();
      const choice = await e.userChoice;
      if (onStateChange) onStateChange();
      return (choice && choice.outcome) || "dismissed";
    } catch (err) {
      if (onStateChange) onStateChange();
      return "failed";
    }
  }

  /* ---------- THE SERVICE WORKER ---------- */

  /**
   * Registers sw.js, and offers a reload when a new one is waiting.
   *
   * Silent everywhere it cannot work - a file:// page, an http host that
   * is not localhost, a browser without service workers. None of those
   * is a fault worth a message: the app works, it is just not
   * installable.
   */
  async function registerServiceWorker(opts) {
    opts = opts || {};
    const win = opts.window || window;
    const nav = win.navigator || {};
    if (!nav.serviceWorker || !isSecureContextFor(win)) return null;

    let registration;
    try {
      registration = await nav.serviceWorker.register(opts.url || "sw.js");
    } catch (err) {
      // A registration failure is a deployment detail, not something to
      // put in front of an agent mid-call.
      if (win.console) win.console.warn("Service worker not registered:", err && err.message);
      return null;
    }

    const offer = (worker) => { if (worker) offerUpdate(worker, win); };

    // Already waiting when the page loaded: a previous visit installed
    // it and nobody reloaded.
    if (registration.waiting && nav.serviceWorker.controller) offer(registration.waiting);

    if (typeof registration.addEventListener === "function") {
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing || typeof installing.addEventListener !== "function") return;
        installing.addEventListener("statechange", () => {
          // "installed" with a controller already present means this is
          // an update rather than the very first install. On a first
          // install there is nothing to reload for.
          if (installing.state === "installed" && nav.serviceWorker.controller) offer(installing);
        });
      });
    }

    return registration;
  }

  // One toast, once, with the reload behind a button. Reloading somebody
  // out of a half-typed contact to deliver a new stylesheet would be a
  // worse bug than the one being fixed.
  let updateOffered = false;
  function offerUpdate(worker, win) {
    if (updateOffered) return;
    updateOffered = true;
    const w = win || window;
    App.app.toast("Update available.", "success", {
      actions: [{
        label: "Reload",
        onClick: () => {
          try { worker.postMessage({ type: "SKIP_WAITING" }); } catch (e) { /* gone already */ }
          // The new worker takes over and the page comes back on it.
          const nav = w.navigator;
          if (nav && nav.serviceWorker && typeof nav.serviceWorker.addEventListener === "function") {
            let reloaded = false;
            nav.serviceWorker.addEventListener("controllerchange", () => {
              if (reloaded) return;
              reloaded = true;
              w.location.reload();
            });
          }
          // And a belt-and-braces reload for a browser that never fires
          // controllerchange, so the button is never a no-op.
          w.setTimeout(() => w.location.reload(), 1200);
        }
      }]
    });
  }

  /* ---------- THE INSTALL CARD (Settings) ---------- */

  const IOS_STEPS = [
    "Tap the Share button at the bottom of Safari.",
    "Scroll down and tap “Add to Home Screen”.",
    "Tap Add. RealtorOS appears on your home screen like any other app."
  ];

  /**
   * Renders into `el` and wires the button. Re-renders itself whenever
   * the state changes, so the card cannot sit there offering an install
   * that already happened.
   */
  function renderInstallCard(el, win) {
    if (!el) return;
    const w = win || window;
    const state = installState(w);

    const body = state.installed
      ? `<p class="form-help" id="pwaInstalled">RealtorOS is installed on this device. Open it from your home screen or app list.</p>`
      : state.canPrompt
        ? `<p class="form-help">Install it and RealtorOS opens like any other app — its own window, its own icon, and the screens you have already visited open without waiting for the network.</p>
           <button type="button" class="btn btn-primary" id="pwaInstallBtn">Install</button>`
        : state.ios
          ? `<p class="form-help">Safari installs an app from the Share menu rather than a button:</p>
             <ol class="pwa-steps" id="pwaIosSteps">${IOS_STEPS.map((s) => `<li>${U().esc(s)}</li>`).join("")}</ol>`
          : `<p class="form-help" id="pwaNotYet">Your browser has not offered to install this yet. Chrome, Edge and Safari can; in Chrome and Edge the offer appears once you have used the app for a moment, and this card will show an Install button when it does.</p>`;

    el.innerHTML = `
      <section class="card" id="pwaInstallCard">
        <div class="card-header"><div class="card-title">Install the app</div></div>
        <div class="card-body">${body}</div>
      </section>`;

    const btn = el.querySelector("#pwaInstallBtn");
    if (btn) {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const outcome = await promptInstall();
        if (outcome === "accepted") App.app.toast("Installing RealtorOS…", "success");
        else if (outcome !== "unavailable") btn.disabled = false;
        renderInstallCard(el, w);
      });
    }
    // Keep this card honest if the browser's offer arrives, or the app
    // is installed, while Settings is open.
    onStateChange = () => { try { renderInstallCard(el, w); } catch (e) { /* page moved on */ } };
  }

  /* ---------- THE ONE-TIME BANNER (mobile) ---------- */

  function bannerDismissed(w) {
    try { return w.localStorage.getItem(BANNER_DISMISSED_KEY) === "1"; }
    catch (e) { return false; }   // private mode: show it, never crash
  }

  /**
   * One line above the content, once. Dismissing it is remembered, and
   * there is no second chance on purpose - Settings carries the card for
   * anybody who changes their mind.
   */
  function mountBanner(doc, win) {
    const d = doc || document;
    const w = win || window;
    if (d.getElementById("pwaInstallBanner")) return null;
    const state = installState(w);
    if (state.installed || bannerDismissed(w)) return null;
    if (!state.canPrompt && !state.ios) return null;

    const bar = d.createElement("div");
    bar.id = "pwaInstallBanner";
    bar.className = "pwa-banner";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Install RealtorOS");
    bar.innerHTML = `
      <span class="pwa-banner-text">${state.ios
        ? "Add RealtorOS to your home screen: Share, then Add to Home Screen."
        : "Install RealtorOS on this device for a faster start."}</span>
      ${state.canPrompt ? `<button type="button" class="btn btn-sm" id="pwaBannerInstall">Install</button>` : ""}
      <button type="button" class="pwa-banner-close" id="pwaBannerDismiss" aria-label="Dismiss">&times;</button>`;

    const host = d.getElementById("main") || d.body;
    host.insertBefore(bar, host.firstChild);

    const close = () => {
      try { w.localStorage.setItem(BANNER_DISMISSED_KEY, "1"); } catch (e) { /* private mode */ }
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    };
    bar.querySelector("#pwaBannerDismiss").addEventListener("click", close);
    const install = bar.querySelector("#pwaBannerInstall");
    if (install) install.addEventListener("click", async () => { await promptInstall(); close(); });
    return bar;
  }

  /** Everything the shell starts, in the order it wants starting. */
  function init(doc, win) {
    const w = win || window;
    const worker = w.navigator && w.navigator.serviceWorker;
    if (worker && worker.addEventListener && !w.__realtorosPushNavigationWired) {
      w.__realtorosPushNavigationWired = true;
      worker.addEventListener("message", event => {
        const data = event.data;
        if (!worker.controller || event.source !== worker.controller || !data || data.type !== "NAVIGATE") return;
        if (typeof data.url !== "string" || !/^\/[A-Za-z0-9/_-]*$/.test(data.url) || data.url.startsWith("//")) return;
        if (App.app && App.app.navigate) App.app.navigate(data.url);
      });
    }
    captureInstallPrompt(w);
    mountBanner(doc || document, w);
    registerServiceWorker({ window: w });
  }

  return {
    init, registerServiceWorker, captureInstallPrompt, promptInstall,
    installState, renderInstallCard, mountBanner,
    isStandalone, isIos, isSecureContextFor,
    IOS_STEPS, BANNER_DISMISSED_KEY,
    // For the tests: the deferred event is private, and resetting it
    // between cases is not something the app ever needs to do.
    _reset: () => { deferredPrompt = null; onStateChange = null; updateOffered = false; }
  };
})();
