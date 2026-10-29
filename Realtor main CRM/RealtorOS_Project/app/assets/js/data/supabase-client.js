/* cloudStore.js — the sole Supabase boundary. Existing feature modules keep
   using App.store; the versioned workspace object is stored unchanged. */
window.App = window.App || {};
App.cloud = (function () {
  "use strict";
  let client = null, user = null, recoveryActive = false;
  // Reassigned by gate() once the card exists, so the PASSWORD_RECOVERY
  // handler below (registered as soon as the client is created, which can be
  // before gate() has ever run) can switch an already-built card straight to
  // Update Password mode.
  let showAuthMode = function () {};
  function initClient() {
    if (client) return client;
    if (!window.supabase || !window.supabase.createClient) throw new Error("Supabase client failed to load.");
    client = window.supabase.createClient(App.config.url, App.config.publishableKey, { auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true } });
    // Registered once, immediately (not only after a successful checkSession
    // call), so it also catches PASSWORD_RECOVERY — the event Supabase fires
    // when the user returns from a reset-password email — before
    // checkSession would otherwise treat that temporary recovery session as
    // a normal sign-in.
    client.auth.onAuthStateChange((event, session) => {
      user = session && session.user ? session.user : null;
      if (event === "PASSWORD_RECOVERY") {
        recoveryActive = true;
        gate();
        showAuthMode("update-password");
        return;
      }
      if (!user && !recoveryActive) gate();
    });
    return client;
  }
  function setMessage(text, kind, targetId) { const el = document.getElementById(targetId || "cloudAuthMessage"); if (el) { el.textContent = text || ""; el.className = "cloud-auth-message" + (kind ? " " + kind : ""); } }
  function gate() {
    let root = document.getElementById("cloudAuth");
    if (root) { root.hidden = false; return; }
    root = document.createElement("div"); root.id = "cloudAuth"; root.className = "cloud-auth";
    document.body.appendChild(root);
    // Small inline icons only — no icon library/CDN. currentColor follows the
    // muted text token set in CSS; the Google/Facebook marks use their
    // official colors, scoped to just these small icons.
    const ICON_USER = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.2"></circle><path d="M5 19c0-3.5 3-6 7-6s7 2.5 7 6"></path></svg>';
    const ICON_EMAIL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 7l9 6 9-6"></path></svg>';
    const ICON_LOCK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>';
    const ICON_GOOGLE = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M19.6 10.23c0-.68-.06-1.36-.18-2H10v3.79h5.38a4.6 4.6 0 0 1-2 3.02v2.5h3.23c1.89-1.74 2.99-4.3 2.99-7.31z"/><path fill="#34A853" d="M10 20c2.7 0 4.96-.89 6.62-2.42l-3.23-2.5c-.9.6-2.06.95-3.39.95-2.6 0-4.8-1.76-5.59-4.12H1.06v2.59A10 10 0 0 0 10 20z"/><path fill="#FBBC05" d="M4.41 11.9a5.99 5.99 0 0 1 0-3.8V5.5H1.06a10 10 0 0 0 0 9l3.35-2.6z"/><path fill="#EA4335" d="M10 3.98c1.47 0 2.79.5 3.82 1.5l2.87-2.87C14.95.99 12.7 0 10 0 6.09 0 2.72 2.24 1.06 5.5l3.35 2.6C5.2 5.75 7.4 3.98 10 3.98z"/></svg>';
    const ICON_FACEBOOK = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path fill="#1877F2" d="M20 10a10 10 0 1 0-11.56 9.88v-6.99H5.9V10h2.54V7.8c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V10h2.78l-.44 2.89h-2.34v6.99A10 10 0 0 0 20 10z"/></svg>';
    // The card is built once. Switching modes (including into/out of Reset
    // and Update Password) toggles [hidden] on these sibling forms and
    // mutates their fields instead of re-rendering, so the fade transition
    // can actually animate rather than jump.
    root.innerHTML = `<div class="cloud-auth-card" id="cloudAuthCard">
        <div class="cloud-auth-form-panel" id="cloudAuthPanel">
          <h1>Realtor OS</h1>
          <form id="cloudAuthForm">
            <p class="cloud-auth-intro" id="cloudAuthIntro"></p>
            <div class="cloud-auth-tabs" role="tablist" aria-label="Account access">
              <button class="cloud-auth-tab" id="cloudSignInTab" type="button" role="tab" aria-selected="true" aria-controls="cloudAuthForm">Sign in</button>
              <button class="cloud-auth-tab" id="cloudCreateTab" type="button" role="tab" aria-selected="false" aria-controls="cloudAuthForm">Create account</button>
            </div>
            <div class="cloud-auth-field" id="cloudFullNameField" hidden>
              <label for="cloudFullName">Full name</label>
              <div class="cloud-auth-input-wrap"><span class="cloud-auth-input-icon">${ICON_USER}</span>
                <input id="cloudFullName" type="text" autocomplete="name" minlength="2" placeholder="Jane Doe"></div>
            </div>
            <div class="cloud-auth-field">
              <label for="cloudEmail">Email</label>
              <div class="cloud-auth-input-wrap"><span class="cloud-auth-input-icon">${ICON_EMAIL}</span>
                <input id="cloudEmail" type="email" autocomplete="email" placeholder="you@example.com" required></div>
            </div>
            <div class="cloud-auth-field">
              <div class="cloud-auth-label-row">
                <label for="cloudPassword">Password</label>
                <button type="button" class="cloud-auth-inline-link" id="cloudForgotLink">Forgot password?</button>
              </div>
              <div class="cloud-auth-input-wrap"><span class="cloud-auth-input-icon">${ICON_LOCK}</span>
                <input id="cloudPassword" type="password" autocomplete="current-password" placeholder="Enter your password" required minlength="6"></div>
            </div>
            <div class="cloud-auth-field" id="cloudConfirmField" hidden>
              <label for="cloudPasswordConfirm">Confirm password</label>
              <div class="cloud-auth-input-wrap"><span class="cloud-auth-input-icon">${ICON_LOCK}</span>
                <input id="cloudPasswordConfirm" type="password" autocomplete="new-password" placeholder="Re-enter your password" minlength="6"></div>
            </div>
            <button class="btn btn-primary cloud-auth-submit" id="cloudAuthSubmit" type="submit">Sign in</button>
            <p id="cloudAuthMessage" class="cloud-auth-message" aria-live="polite"></p>
            <div id="cloudOAuthBlock">
              <div class="cloud-auth-divider"><span>or continue with</span></div>
              <div class="cloud-auth-oauth-row">
                <button type="button" class="cloud-auth-oauth-btn" id="cloudOAuthGoogle">${ICON_GOOGLE}<span>Continue with Google</span></button>
                <button type="button" class="cloud-auth-oauth-btn" id="cloudOAuthFacebook">${ICON_FACEBOOK}<span>Continue with Facebook</span></button>
              </div>
            </div>
            <p class="cloud-auth-switch"><span id="cloudAuthSwitchCopy"></span> <button id="cloudAuthSwitch" type="button"></button></p>
            <p class="cloud-auth-switch"><a id="cloudBackToWebsite" href="#">Back to website</a></p>
          </form>
          <form id="cloudResetForm" hidden>
            <p class="cloud-auth-subheading">Reset your password</p>
            <p class="cloud-auth-intro">Enter your account email and we’ll send you a link to reset your password.</p>
            <div class="cloud-auth-field">
              <label for="cloudResetEmail">Email</label>
              <div class="cloud-auth-input-wrap"><span class="cloud-auth-input-icon">${ICON_EMAIL}</span>
                <input id="cloudResetEmail" type="email" autocomplete="email" placeholder="you@example.com" required></div>
            </div>
            <button class="btn btn-primary cloud-auth-submit" id="cloudResetSubmit" type="submit">Send reset link</button>
            <p id="cloudResetMessage" class="cloud-auth-message" aria-live="polite"></p>
            <p class="cloud-auth-switch"><button type="button" id="cloudResetBack">Back to sign in</button></p>
          </form>
          <form id="cloudUpdateForm" hidden>
            <p class="cloud-auth-subheading">Set a new password</p>
            <p class="cloud-auth-intro">Choose a new password for your account.</p>
            <div class="cloud-auth-field">
              <label for="cloudNewPassword">New password</label>
              <div class="cloud-auth-input-wrap"><span class="cloud-auth-input-icon">${ICON_LOCK}</span>
                <input id="cloudNewPassword" type="password" autocomplete="new-password" placeholder="Enter your password" required minlength="6"></div>
            </div>
            <div class="cloud-auth-field">
              <label for="cloudNewPasswordConfirm">Confirm new password</label>
              <div class="cloud-auth-input-wrap"><span class="cloud-auth-input-icon">${ICON_LOCK}</span>
                <input id="cloudNewPasswordConfirm" type="password" autocomplete="new-password" placeholder="Re-enter your password" required minlength="6"></div>
            </div>
            <button class="btn btn-primary cloud-auth-submit" id="cloudUpdateSubmit" type="submit">Update password</button>
            <p id="cloudUpdateMessage" class="cloud-auth-message" aria-live="polite"></p>
          </form>
        </div>
        <div class="cloud-auth-illustration" aria-hidden="true">
          <div class="cloud-auth-illustration-art">
            <img class="cloud-auth-illustration-img" src="assets/illustrations/realtor-auth-buy-house.svg" alt="" width="248" height="239">
          </div>
          <p class="cloud-auth-illustration-label">REALTOROS</p>
          <h2 class="cloud-auth-illustration-heading">Your real estate workspace</h2>
          <p class="cloud-auth-illustration-desc">Organize deals, build relationships, and close with confidence.</p>
        </div>
      </div>`;

    const card = root.querySelector("#cloudAuthCard");
    const authForm = root.querySelector("#cloudAuthForm");
    const resetForm = root.querySelector("#cloudResetForm");
    const updateForm = root.querySelector("#cloudUpdateForm");
    const intro = root.querySelector("#cloudAuthIntro");
    const signInTab = root.querySelector("#cloudSignInTab");
    const createTab = root.querySelector("#cloudCreateTab");
    const fullNameField = root.querySelector("#cloudFullNameField");
    const fullNameInput = root.querySelector("#cloudFullName");
    const emailInput = root.querySelector("#cloudEmail");
    const passwordInput = root.querySelector("#cloudPassword");
    const confirmField = root.querySelector("#cloudConfirmField");
    const confirmInput = root.querySelector("#cloudPasswordConfirm");
    const submitBtn = root.querySelector("#cloudAuthSubmit");
    const switchCopy = root.querySelector("#cloudAuthSwitchCopy");
    const switchBtn = root.querySelector("#cloudAuthSwitch");
    const forgotLink = root.querySelector("#cloudForgotLink");
    const oauthBlock = root.querySelector("#cloudOAuthBlock");
    const oauthGoogleBtn = root.querySelector("#cloudOAuthGoogle");
    const oauthFacebookBtn = root.querySelector("#cloudOAuthFacebook");
    const resetEmailInput = root.querySelector("#cloudResetEmail");
    const resetSubmitBtn = root.querySelector("#cloudResetSubmit");
    const resetBackBtn = root.querySelector("#cloudResetBack");
    const newPasswordInput = root.querySelector("#cloudNewPassword");
    const newPasswordConfirmInput = root.querySelector("#cloudNewPasswordConfirm");
    const updateSubmitBtn = root.querySelector("#cloudUpdateSubmit");
    let creating = false;
    let currentMode = "sign-in";
    let switching = false;

    function applySignMode(nextCreating) {
      creating = nextCreating;
      intro.textContent = creating ? "Create an account to securely start your workspace." : "Sign in to securely open your workspace.";
      signInTab.setAttribute("aria-selected", String(!creating));
      createTab.setAttribute("aria-selected", String(creating));
      fullNameField.hidden = !creating;
      fullNameInput.required = creating;
      if (!creating) fullNameInput.value = "";
      confirmField.hidden = !creating;
      confirmInput.required = creating;
      if (!creating) confirmInput.value = "";
      passwordInput.setAttribute("autocomplete", creating ? "new-password" : "current-password");
      submitBtn.textContent = creating ? "Create account" : "Sign in";
      switchCopy.textContent = creating ? "Already have an account?" : "Don’t have an account?";
      switchBtn.textContent = creating ? "Sign in" : "Create one";
      forgotLink.hidden = creating;
      oauthBlock.hidden = creating; // Google/Facebook are Sign in-only, per spec
      card.classList.toggle("is-create", creating);
      setMessage("");
    }

    // Desktop/tablet gets a brief fade+translate for every mode change
    // (including the panel-order swap between Sign in and Create account
    // underneath); mobile and reduced-motion just flip instantly.
    function transitionSwap(run) {
      if (switching) { run(); return; }
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const isDesktop = window.matchMedia("(min-width: 780px)").matches;
      if (reduceMotion || !isDesktop) { run(); return; }
      switching = true;
      card.classList.add("cloud-auth-switching");
      setTimeout(() => {
        run();
        requestAnimationFrame(() => {
          card.classList.remove("cloud-auth-switching");
          switching = false;
        });
      }, 190);
    }

    // mode: "sign-in" | "create" | "reset" | "update-password"
    function showMode(mode, opts) {
      if (mode === currentMode && !(opts && opts.force)) return;
      transitionSwap(() => {
        currentMode = mode;
        authForm.hidden = mode !== "sign-in" && mode !== "create";
        resetForm.hidden = mode !== "reset";
        updateForm.hidden = mode !== "update-password";
        card.classList.remove("is-create");
        if (mode === "sign-in" || mode === "create") {
          applySignMode(mode === "create");
        } else if (mode === "reset") {
          if (!resetEmailInput.value) resetEmailInput.value = emailInput.value;
          setMessage("", null, "cloudResetMessage");
        } else if (mode === "update-password") {
          newPasswordInput.value = "";
          newPasswordConfirmInput.value = "";
          setMessage("", null, "cloudUpdateMessage");
        }
      });
    }
    showAuthMode = showMode; // let the PASSWORD_RECOVERY handler drive this card once built

    signInTab.addEventListener("click", () => showMode("sign-in"));
    createTab.addEventListener("click", () => showMode("create"));
    switchBtn.addEventListener("click", () => showMode(creating ? "sign-in" : "create"));
    forgotLink.addEventListener("click", () => showMode("reset"));
    resetBackBtn.addEventListener("click", () => showMode("sign-in"));

    authForm.addEventListener("submit", async e => {
      e.preventDefault();
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (creating) {
        const fullName = fullNameInput.value.trim();
        if (fullName.length < 2) return setMessage("Please enter your full name.", "error");
        const confirmPassword = confirmInput.value;
        if (password !== confirmPassword) return setMessage("Passwords do not match.", "error");
        setMessage("Creating account…");
        const r = await initClient().auth.signUp({ email, password, options: { data: { full_name: fullName } } });
        if (r.error) return setMessage(r.error.message, "error");
        if (!r.data.session) return setMessage("Account created. Check your email to confirm it, then choose Sign in.", "success");
        window.location.reload();
        return;
      }
      setMessage("Signing in…");
      const r = await initClient().auth.signInWithPassword({ email, password });
      if (r.error) return setMessage(r.error.message, "error");
      window.location.reload();
    });

    // Forgot password: never reveals whether the address is registered —
    // the same confirmation is shown whether or not the call errors.
    resetForm.addEventListener("submit", async e => {
      e.preventDefault();
      const email = resetEmailInput.value.trim();
      if (!email) return;
      resetSubmitBtn.disabled = true;
      setMessage("Sending reset link…", null, "cloudResetMessage");
      try {
        await initClient().auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + window.location.pathname
        });
      } catch (err) { /* intentionally ignored — see comment above */ }
      setMessage("If an account exists for this email, a password reset link has been sent.", "success", "cloudResetMessage");
      resetSubmitBtn.disabled = false;
    });

    // Update password, reached only via the PASSWORD_RECOVERY event above.
    updateForm.addEventListener("submit", async e => {
      e.preventDefault();
      const p1 = newPasswordInput.value, p2 = newPasswordConfirmInput.value;
      if (p1 !== p2) return setMessage("Passwords do not match.", "error", "cloudUpdateMessage");
      updateSubmitBtn.disabled = true;
      setMessage("Updating password…", null, "cloudUpdateMessage");
      const r = await initClient().auth.updateUser({ password: p1 });
      updateSubmitBtn.disabled = false;
      if (r.error) return setMessage(r.error.message, "error", "cloudUpdateMessage");
      setMessage("Password updated. Redirecting you to sign in…", "success", "cloudUpdateMessage");
      recoveryActive = false;
      // Sign the temporary recovery session out — the user is returned to a
      // clean Sign in with their new password, never straight into the app.
      try { await initClient().auth.signOut(); } catch (err) { /* non-fatal */ }
      setTimeout(() => showMode("sign-in"), 1800);
    });

    async function handleOAuth(provider, btn) {
      btn.disabled = true;
      setMessage("Redirecting to " + (provider === "google" ? "Google" : "Facebook") + "…");
      try {
        const { error } = await initClient().auth.signInWithOAuth({
          provider,
          options: { redirectTo: window.location.origin + window.location.pathname }
        });
        if (error) { setMessage(error.message, "error"); btn.disabled = false; }
        // On success the browser navigates away to the provider now, so
        // there is nothing further to do here.
      } catch (err) {
        setMessage((err && err.message) || "Unable to start sign-in.", "error");
        btn.disabled = false;
      }
    }
    oauthGoogleBtn.addEventListener("click", () => handleOAuth("google", oauthGoogleBtn));
    oauthFacebookBtn.addEventListener("click", () => handleOAuth("facebook", oauthFacebookBtn));

    // The gate's way back to the public website. The target comes from
    // App.config.websiteUrl (per-environment, not a secret); without a
    // configured URL the link hides rather than pointing nowhere.
    const backToWebsite = root.querySelector("#cloudBackToWebsite");
    if (backToWebsite) {
      if (App.config.websiteUrl) backToWebsite.href = App.config.websiteUrl;
      else backToWebsite.hidden = true;
    }

    // A `mode` query parameter from the public website can ask for the
    // Create-account form directly (?mode=create). Read once, here at
    // gate construction; any other value - including no parameter -
    // keeps the historical default, Sign in. A password-recovery return
    // outranks it: that flow must land on Update Password.
    const requestedMode = new URLSearchParams(window.location.search).get("mode");
    showMode(recoveryActive ? "update-password" : (requestedMode === "create" ? "create" : "sign-in"), { force: true });
  }
  function hideGate() { const root = document.getElementById("cloudAuth"); if (root) root.hidden = true; }

  // The only thing boot needs from this module now: is someone signed in?
  // No workspace_state read/write happens here anymore — App.data owns the
  // one-time legacy migration (its own guarded, per-user workspace_state
  // read) and every normal entity read/write after that goes straight to
  // its own relational table. This replaces the old requireSessionAndHydrate,
  // which used to also read/write the whole-workspace blob on every boot.
  async function checkSession() {
    try {
      const api = initClient();
      const { data: { user: current }, error } = await api.auth.getUser();
      if (recoveryActive) return null; // Update Password mode is already showing.
      if (error || !current) { gate(); return null; }
      user = current;
      hideGate();
      return user;
    } catch (err) {
      if (!recoveryActive) { gate(); setMessage("Unable to reach your account: " + err.message, "error"); }
      return null;
    }
  }

  // ---------- PROFILE (display name, phone, avatar) ----------
  // Editable, non-security profile fields only, stored in Supabase Auth user
  // metadata per PART 5 — never roles/permissions, never workspace_state.

  function getUser() { return user; }

  async function signOutUser() {
    try { await initClient().auth.signOut(); } catch (err) { /* ignore — reload proceeds either way */ }
    window.location.reload();
  }

  async function updateProfile(fields) {
    const api = initClient();
    const current = (user && user.user_metadata) || {};
    const data = Object.assign({}, current, fields);
    const { data: res, error } = await api.auth.updateUser({ data });
    if (!error && res && res.user) user = res.user;
    return { error, user: res ? res.user : null };
  }

  // Uploads to the private `avatars` bucket under the user's own folder
  // (${user.id}/...), matching the Storage RLS policies in the migration.
  // Best-effort deletes the previous file so a user's folder doesn't
  // accumulate old photos across edits.
  async function uploadAvatar(file) {
    if (!user) throw new Error("Not signed in.");
    const api = initClient();
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = user.id + "/avatar-" + Date.now() + "." + ext;
    const { error } = await api.storage.from("avatars").upload(path, file, { upsert: false, contentType: file.type });
    if (error) throw error;
    const prevPath = user.user_metadata && user.user_metadata.avatar_path;
    if (prevPath && prevPath !== path) { try { await api.storage.from("avatars").remove([prevPath]); } catch (err) { /* best-effort cleanup */ } }
    return path;
  }

  async function removeAvatarFile(path) {
    if (!path) return;
    try { await initClient().storage.from("avatars").remove([path]); } catch (err) { /* best-effort */ }
  }

  // The bucket is private, so photos are only ever read back through a
  // short-lived signed URL — never a public URL, never stored as Base64.
  async function getAvatarSignedUrl(path) {
    if (!path) return null;
    try {
      const { data, error } = await initClient().storage.from("avatars").createSignedUrl(path, 3600);
      if (error || !data) return null;
      return data.signedUrl;
    } catch (err) { return null; }
  }

  return {
    checkSession,
    getUser, signOutUser, updateProfile, uploadAvatar, removeAvatarFile, getAvatarSignedUrl,
    // Exposes the already-created client so App.data (the direct per-entity
    // Supabase layer) reuses this exact client instance instead of creating
    // a second one. Auth/session/profile/avatar behavior above is unchanged.
    getClient: initClient
  };
})();
