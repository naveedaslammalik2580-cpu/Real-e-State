/* ============================================================
   team-join.js — the /join screen.

   Reached from an invite link, by somebody who may not be in any
   workspace yet. The token lives in the hash (#/join?token=…), which is
   both how this app routes and why the token survives the sign-in
   screen: the gate is drawn in the same page, so signing in lands them
   back here with the link intact.

   Every answer the server can give has its own words here. None of them
   is an error state — "this link expired" is an ordinary thing to be
   told, not a crash.

   Depends on: app.js, store.js (App.store.team), supabase-client.js
   (App.cloud), workspace.js, util.js
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.teamJoin = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;

  const ROLE_WORD = { owner: "an owner", admin: "an admin", agent: "an agent" };

  /**
   * The token out of a route path like "/join?token=abc". Exported so it
   * can be tested on its own, and deliberately tolerant: a link that has
   * been through an email client may arrive with the query encoded, or
   * with nothing at all.
   */
  function tokenFromPath(path) {
    if (typeof path !== "string") return null;
    const q = path.indexOf("?");
    if (q === -1) return null;
    const parts = path.slice(q + 1).split("&");
    for (let i = 0; i < parts.length; i++) {
      const eq = parts[i].indexOf("=");
      if (eq === -1) continue;
      if (parts[i].slice(0, eq) !== "token") continue;
      let raw = parts[i].slice(eq + 1);
      try { raw = decodeURIComponent(raw); } catch (e) { /* use it as it came */ }
      raw = raw.trim();
      return raw || null;
    }
    return null;
  }

  /** The token for the link currently in the address bar. */
  function tokenFromLocation() {
    const hash = (typeof window !== "undefined" && window.location && window.location.hash) || "";
    return tokenFromPath(hash.replace(/^#/, ""));
  }

  function shell(title, bodyHtml) {
    return `
      <div class="page-header">
        <div>
          <div class="page-title">${U().esc(title)}</div>
          <div class="page-desc">An invitation to work in somebody else's workspace.</div>
        </div>
      </div>
      <section class="card" data-card="join">
        <div class="card-body">${bodyHtml}</div>
      </section>`;
  }

  function state(title, desc, actionsHtml) {
    return `
      <div class="empty-state">
        <div class="empty-title">${U().esc(title)}</div>
        <div class="empty-desc">${desc}</div>
        ${actionsHtml || ""}
      </div>`;
  }

  async function render(container, token) {
    if (!container) return;
    App.app.setBreadcrumbs([{ label: "Join a team" }]);
    App.app.setTopActions("");

    const t = token || tokenFromLocation();

    if (!t) {
      container.innerHTML = shell("Join a team", state(
        "This link is missing its invitation code",
        "Ask whoever invited you to send the link again — the whole link has to be copied, right to the end.",
        `<button type="button" class="btn" data-role="join-home">Go to my workspace</button>`));
      wireHome(container);
      return;
    }

    const user = App.cloud && App.cloud.getUser ? App.cloud.getUser() : null;
    if (!user) {
      container.innerHTML = shell("Join a team", state(
        "Sign in to accept this invitation",
        "The invitation was sent to one email address and only works for that address, so sign in (or create your sign-in) with the address it was sent to. This link stays open while you do.",
        ""));
      return;
    }

    container.innerHTML = shell("Join a team", `
      <p>You have been invited to join a workspace. Accepting moves you into it, and you work on the team's records from then on.</p>
      <p class="form-help" id="joinSignedInAs">You are signed in as ${U().esc(user.email || "this account")}.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        <button class="btn btn-primary" id="joinAcceptBtn">Accept invitation</button>
        <button class="btn" data-role="join-home">Not now</button>
      </div>
      <div id="joinOutcome" style="margin-top:14px"></div>`);
    wireHome(container);

    const btn = container.querySelector("#joinAcceptBtn");
    if (btn) btn.addEventListener("click", () => accept(container, t, user));
  }

  function wireHome(container) {
    container.querySelectorAll('[data-role="join-home"]').forEach(b => {
      b.addEventListener("click", () => App.app.navigate("/dashboard"));
    });
  }

  async function accept(container, token, user) {
    const btn = container.querySelector("#joinAcceptBtn");
    const out = container.querySelector("#joinOutcome");
    if (btn) btn.disabled = true;
    if (out) out.innerHTML = App.app.loadingHtml();

    let res = null;
    try {
      res = await S().team.acceptInvitation(token);
    } catch (err) {
      if (out) out.innerHTML = message("Could not accept this invitation",
        "Something went wrong on the way. Check your connection and try again.");
      if (btn) btn.disabled = false;
      return;
    }

    const outcome = res && res.outcome;

    // An invitation that was already used echoes its own status back, so
    // "accepted" alone does not mean WE just accepted it. A real acceptance
    // is the only answer that carries the new membership with it.
    const joinedNow = outcome === "accepted" && !!(res.member_id || res.workspace_id);

    if (joinedNow) {
      const role = Object.prototype.hasOwnProperty.call(ROLE_WORD, res.role) ? ROLE_WORD[res.role] : "a member";
      App.app.toast("You have joined the team as " + role.replace(/^an? /, "") + ".", "success");
      App.app.navigate("/dashboard");
      return;
    }

    if (btn) btn.disabled = false;

    if (outcome === "email_mismatch") {
      if (out) out.innerHTML = message(
        "This invitation is for a different address",
        "It was sent to <strong>" + U().esc(res.invited_email || "another address") + "</strong>, but you are signed in as <strong>" +
        U().esc((user && user.email) || "this account") + "</strong>. Sign in with the invited address, then open the link again.",
        `<button type="button" class="btn" id="joinSignOut">Sign out</button>`);
      const so = container.querySelector("#joinSignOut");
      if (so) so.addEventListener("click", async () => {
        try { await App.cloud.signOutUser(); } catch (e) { /* the reload below is the fallback */ }
        if (typeof window !== "undefined" && window.location && window.location.reload) window.location.reload();
      });
      return;
    }

    if (outcome === "own_workspace_not_empty") {
      if (out) out.innerHTML = message(
        "This account already has records of its own",
        "Joining a team means working in the team's workspace instead of your own, and this account has contacts, deals or other records here already — so they would be left behind. Join with a different sign-in, or clear this workspace first.");
      return;
    }

    const COPY = {
      invalid_token: ["This invitation link is not valid", "Ask whoever invited you to send a new link."],
      expired: ["This invitation has expired", "Invitations last a week. Ask whoever invited you for a new link."],
      revoked: ["This invitation was cancelled", "Ask whoever invited you for a new link."],
      accepted_already: ["This invitation has already been used", "If that was you, you are already in the team."],
      already_a_member: ["You are already in this team", "Nothing to do — carry on where you left off."],
      no_workspace: ["This invitation no longer points anywhere", "The workspace it was for is gone. Ask whoever invited you."]
    };
    // The server echoes an invitation's own status back as the outcome, so
    // "accepted" arriving here means already used, not just succeeded.
    const key = outcome === "accepted" ? "accepted_already" : outcome;  // never a fresh join: that returned above
    const copy = Object.prototype.hasOwnProperty.call(COPY, key) ? COPY[key] : null;

    if (copy) {
      const extra = (key === "already_a_member")
        ? `<button type="button" class="btn btn-primary" data-role="join-home">Go to my workspace</button>` : "";
      if (out) out.innerHTML = message(copy[0], copy[1], extra);
      wireHome(container);
      return;
    }

    if (out) out.innerHTML = message("Could not accept this invitation",
      "Ask whoever invited you to send a new link.");
  }

  function message(title, descHtml, actionsHtml) {
    return `<div class="empty-state" role="status">
      <div class="empty-title">${U().esc(title)}</div>
      <div class="empty-desc">${descHtml}</div>
      ${actionsHtml || ""}
    </div>`;
  }

  return { render, tokenFromPath, tokenFromLocation };
})();
