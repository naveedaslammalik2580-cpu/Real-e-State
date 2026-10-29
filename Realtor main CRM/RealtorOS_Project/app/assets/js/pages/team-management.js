/* ============================================================
   team-management.js — Settings → Team & Access.

   Who is in this workspace and what they may do. Everything here goes
   through App.store.team, which calls the database functions that do the
   real checking; nothing on this page is security. A member who edits
   App.workspace in the console gets buttons that then fail on the
   server, which is the correct outcome.

   Nothing here is optimistic either: after every change the affected
   list is read again, so what the screen shows is what the server did.

   Invitations are COPY-LINK only in this version. No email is sent, and
   no copy on this page may suggest one was.

   Depends on: app.js, store.js (App.store.team / App.store.settings),
   workspace.js (App.workspace), customization.js, util.js
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.teamManagement = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;
  const W = () => App.workspace;

  const ROLE_LABEL = { owner: "Owner", admin: "Admin", agent: "Agent" };
  const ROLE_BADGE = { owner: "badge-success", admin: "badge-info", agent: "badge-neutral" };

  // What an invitation's state is called in the UI, and what it means.
  const INVITE_STATE = {
    pending:  { label: "Waiting to be accepted", cls: "badge-info" },
    accepted: { label: "Joined", cls: "badge-success" },
    revoked:  { label: "Cancelled", cls: "badge-neutral" },
    expired:  { label: "Expired", cls: "badge-warning" }
  };

  function lookup(map, key) {
    if (typeof key !== "string") return null;
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  }
  function roleLabel(role) { return lookup(ROLE_LABEL, role) || "Member"; }
  function roleBadge(role) {
    return `<span class="badge ${lookup(ROLE_BADGE, role) || "badge-neutral"}">${U().esc(roleLabel(role))}</span>`;
  }
  function inviteBadge(status) {
    const meta = lookup(INVITE_STATE, status) || { label: "Unknown", cls: "badge-neutral" };
    return `<span class="badge ${meta.cls}">${U().esc(meta.label)}</span>`;
  }

  // "in 5 days" / "today" / "3 days ago", from a timestamp. Days rather
  // than hours on purpose: an invitation lives a week, so hours would be
  // false precision.
  function daysFromNow(iso) {
    if (!iso) return null;
    const then = new Date(iso);
    if (isNaN(then.getTime())) return null;
    return Math.round((then.getTime() - Date.now()) / 86400000);
  }
  function expiryText(inv) {
    if (inv.status === "accepted") return "Accepted";
    if (inv.status === "revoked") return "Cancelled";
    const d = daysFromNow(inv.expires_at);
    if (d === null) return "";
    if (inv.status === "expired" || d < 0) return "Expired";
    if (d === 0) return "Expires today";
    return "Expires in " + d + (d === 1 ? " day" : " days");
  }

  // Exceptions set for one person. The field only arrives for a caller who
  // may manage the team, so "absent" means "not my business" rather than
  // "none" - and both read as no badge, which is the right outcome either way.
  function hasOverrides(m) {
    const o = m && m.permission_overrides;
    return !!(o && typeof o === "object" && Object.keys(o).length > 0);
  }

  function memberName(m) {
    return (m.name && String(m.name).trim()) || m.email || "Someone";
  }

  // ---------- SCREEN ----------

  // Kept at module scope so a refresh after a change re-renders the same
  // pane without the Settings shell having to re-run.
  let lastPane = null;

  async function render(pane) {
    if (!pane) return;
    lastPane = pane;
    pane.innerHTML = App.app.loadingHtml("your team");

    try {
      await W().load();
      await S().ensureLoaded(["settings"]);
    } catch (err) {
      pane.innerHTML = App.app.errorHtml("Your team could not load.");
      wireRetry(pane);
      return;
    }

    // Managing the team needs permission. Somebody without it still has to
    // be able to leave, so they get that one card and nothing else - and no
    // roster is requested, because the server would refuse it.
    if (!W().can("team_manage")) {
      pane.innerHTML = `
        ${head("Team & Access", "Who is in this workspace, and what each person can do.")}
        <section class="card">
          <div class="card-body">
            <div class="empty-state">
              <div class="empty-title">You cannot manage this team</div>
              <div class="empty-desc">Ask an owner or admin to change who is in the workspace, or to change what you can do.</div>
            </div>
          </div>
        </section>
        ${leaveCard()}`;
      wireLeave(pane);
      return;
    }

    const teamOn = App.customization ? App.customization.isTeamMode() : false;

    // Team mode off: the toggle and nothing else. Inviting people into a
    // workspace whose team features are all hidden would be a trap.
    if (!teamOn) {
      pane.innerHTML = `
        ${head("Team & Access", "Who is in this workspace, and what each person can do.")}
        ${teamModeCard(false)}
        ${viewingAsCard()}`;
      wireTeamMode(pane);
      wireViewingAs(pane);
      return;
    }

    let members = [];
    let invitations = [];
    let failed = false;
    try {
      const [mRes, iRes] = await Promise.all([S().team.listMembers(), S().team.listInvitations()]);
      if (mRes && mRes.outcome === "ok") members = mRes.members || [];
      else failed = failed || !mRes || mRes.outcome !== "ok";
      if (iRes && iRes.outcome === "ok") invitations = iRes.invitations || [];
      else failed = failed || !iRes || iRes.outcome !== "ok";
    } catch (err) {
      failed = true;
    }

    if (failed) {
      pane.innerHTML = `
        ${head("Team & Access", "Who is in this workspace, and what each person can do.")}
        ${teamModeCard(true)}
        <section class="card"><div class="card-body">${App.app.errorHtml("Your team could not load.")}</div></section>`;
      wireTeamMode(pane);
      wireRetry(pane);
      return;
    }

    const active = members.filter(m => m.status === "active");
    const former = members.filter(m => m.status !== "active");
    const isOwner = W().isOwner();

    pane.innerHTML = `
      ${head("Team & Access", "Who is in this workspace, and what each person can do.")}
      ${teamModeCard(true)}
      ${viewingAsCard()}
      <section aria-label="Members">
        <h2 class="settings-category-title">Members</h2>
        ${membersCard(active, isOwner)}
        ${formerCard(former)}
      </section>
      <section aria-label="Invitations">
        <h2 class="settings-category-title">Invitations</h2>
        ${inviteCard()}
        ${invitationsCard(invitations)}
      </section>
      <section aria-label="Assignments">
        <h2 class="settings-category-title">Assignments</h2>
        <div class="card"><div class="card-body">
          <p class="form-help">Review workloads in Team. Assign leads using the existing Contacts controls.</p>
          <button type="button" class="btn" data-go-workload>View team workload</button>
          ${W().can("contacts_assign") ? '<button type="button" class="btn" data-go-assignments>Assign leads in Contacts</button>' : ""}
        </div></div>
      </section>
      <section aria-label="Permissions">
        <h2 class="settings-category-title">Permissions</h2>
        <div class="card"><div class="card-body">
          <p class="form-help">Set role permissions here, or use a member's permission action in Members.</p>
          <button type="button" class="btn" data-go-permissions>Set what each role can do</button>
        </div></div>
      </section>
      ${leaveCard()}
      ${isOwner ? dangerCard() : ""}`;

    wireTeamMode(pane);
    wireViewingAs(pane);
    wireMembers(pane);
    pane.querySelector("[data-go-workload]").addEventListener("click", () => App.app.navigate("/team"));
    const assignments = pane.querySelector("[data-go-assignments]");
    if (assignments) assignments.addEventListener("click", () => App.app.navigate("/contacts"));
    wireInvite(pane);
    wireInvitations(pane);
    wireLeave(pane);
    if (isOwner) wireDanger(pane);
  }

  function head(title, desc) {
    return `<div class="settings-category-head">
      <div class="settings-category-title">${U().esc(title)}</div>
      <p class="form-help">${U().esc(desc)}</p>
    </div>`;
  }

  function wireRetry(pane) {
    const btn = pane.querySelector('[data-role="route-retry"]');
    if (btn) btn.addEventListener("click", () => render(pane));
  }

  async function refresh() {
    if (lastPane) await render(lastPane);
  }

  // ---------- TEAM MODE ----------

  function teamModeCard(on) {
    return `
      <section class="card">
        <div class="card-header"><div class="card-title">Work as a team</div></div>
        <div class="card-body">
          <div class="split-row">
            <div class="split-row-main">
              <div class="split-row-label">
                <strong>Team features</strong>
                <div class="form-help" id="teamModeSub">${on
                  ? "On. You can invite people, assign leads, and set what each person can do."
                  : "Off. This workspace works as a single agent. Turn this on to invite people and share work."}</div>
              </div>
            </div>
            <label class="toggle-switch" title="${on ? "On" : "Off"}">
              <input type="checkbox" id="teamModeToggle" ${on ? "checked" : ""}
                     aria-label="Team features">
              <span class="toggle-track"></span>
            </label>
          </div>
          ${on ? "" : `<p class="form-help" style="margin-top:12px">Turning this on does not change any of your records. It adds the team pages, and lets you give other people their own sign-in.</p>`}
        </div>
      </section>`;
  }

  function wireTeamMode(pane) {
    const cb = pane.querySelector("#teamModeToggle");
    if (!cb) return;
    cb.addEventListener("change", async () => {
      const on = cb.checked;
      cb.disabled = true;
      try {
        await S().settings.setTeamMode(on);
        App.app.refreshNav();
        App.app.toast(on ? "Team features are on." : "Team features are off.", "success");
        await refresh();
      } catch (err) {
        cb.checked = !on;
        cb.disabled = false;
        App.app.toast(teamModeError(err), "danger");
      }
    });
  }

  // The database refuses to let team mode go off under a team, because
  // switching it off does not remove anybody: they would keep their access
  // while the person who switched it off lost every screen that shows them.
  function teamModeError(err) {
    const msg = (err && (err.message || err.code)) ? String(err.message || err.code) : "";
    if (/team_mode_has_members/.test(msg)) {
      return "Remove other members before turning Team mode off.";
    }
    return "Could not save: " + (msg || "please try again.");
  }

  // ---------- LEGACY "VIEWING AS" ----------
  //
  // The old Active Identity screen set settings.currentTeamMemberId to
  // narrow what one browser showed. That screen is gone, but a workspace
  // that used it would otherwise be stuck in that view with nothing left
  // to clear it - so the row appears only while the value is set.

  function viewingAsCard() {
    const s = S().getState();
    const id = s.settings && s.settings.currentTeamMemberId;
    if (!id) return "";
    const member = (s.teamMembers || []).find(m => m.id === id);
    return `
      <section class="card" data-card="viewing-as">
        <div class="card-header"><div class="card-title">Restricted view</div></div>
        <div class="card-body">
          <p class="form-help">This browser is showing a narrowed view${member ? " for " + U().esc(member.name) : ""}. It is left over from an older version and is not access control.</p>
          <button class="btn" id="clearViewingAs">Show everything again</button>
        </div>
      </section>`;
  }

  function wireViewingAs(pane) {
    const btn = pane.querySelector("#clearViewingAs");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await S().settings.update({ currentTeamMemberId: null });
        App.app.toast("Showing everything again.", "success");
        await refresh();
      } catch (err) {
        btn.disabled = false;
        App.app.toast("Could not save: " + (err && err.message ? err.message : "please try again."), "danger");
      }
    });
  }

  // ---------- MEMBERS ----------

  function membersCard(active, isOwner) {
    if (!active.length) {
      return `
        <section class="card" data-card="members">
          <div class="card-header"><div class="card-title">People</div></div>
          <div class="card-body">
            <div class="empty-state">
              <div class="empty-title">You are the only person here</div>
              <div class="empty-desc">Invite someone below to share this workspace with them.</div>
              <button type="button" class="btn btn-primary" id="membersInviteCta">Invite someone</button>
            </div>
          </div>
        </section>`;
    }

    const rows = active.map(m => {
      const self = m.is_self === true;
      const owner = m.role === "owner";
      const canAct = !self && !owner;
      const actions = [];
      if (canAct) {
        actions.push(`<select class="member-role" data-member="${U().esc(m.member_id)}"
            aria-label="Role for ${U().esc(memberName(m))}">
            <option value="admin" ${m.role === "admin" ? "selected" : ""}>Admin</option>
            <option value="agent" ${m.role === "agent" ? "selected" : ""}>Agent</option>
          </select>`);
        actions.push(`<button class="btn btn-sm" data-perms="${U().esc(m.member_id)}"
            data-name="${U().esc(memberName(m))}">What they can do</button>`);
        if (isOwner) {
          actions.push(`<button class="btn btn-sm" data-transfer="${U().esc(m.member_id)}"
            data-name="${U().esc(memberName(m))}">Make owner</button>`);
        }
        actions.push(`<button class="btn btn-sm btn-danger" data-remove="${U().esc(m.member_id)}"
            data-name="${U().esc(memberName(m))}">Remove</button>`);
      }
      return `
        <tr data-member-row="${U().esc(m.member_id)}">
          <td data-label="Name" class="primary-cell">
            <strong>${U().esc(memberName(m))}</strong>
            ${self ? ` <span class="badge badge-neutral">You</span>` : ""}
            ${hasOverrides(m) ? ` <span class="badge badge-info" title="Some permissions were set just for this person">Custom permissions</span>` : ""}
            <div class="form-help">${U().esc(m.email || "")}</div>
          </td>
          <td data-label="Role">${roleBadge(m.role)}</td>
          <td class="actions" data-label="">
            <span style="display:inline-flex;gap:6px;flex-wrap:wrap;align-items:center">${actions.join("") || `<span class="form-help">${owner ? "Owners cannot be changed here" : "This is you"}</span>`}</span>
          </td>
        </tr>`;
    }).join("");

    return `
      <section class="card" data-card="members">
        <div class="card-header">
          <div class="card-title">People <span class="badge badge-neutral">${active.length}</span></div>
        </div>
        <div class="card-body zero">
          <div class="table-wrap">
            <table class="tbl tbl-responsive">
              <thead><tr><th>Name</th><th>Role</th><th class="actions">&nbsp;</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </section>`;
  }

  function formerCard(former) {
    if (!former.length) return "";
    const rows = former.map(m => `
      <tr>
        <td data-label="Name" class="primary-cell">
          <strong>${U().esc(memberName(m))}</strong>
          <div class="form-help">${U().esc(m.email || "")}</div>
        </td>
        <td data-label="Role">${roleBadge(m.role)}</td>
        <td data-label="Status">${m.status === "suspended"
          ? `<span class="badge badge-warning">Paused</span>`
          : `<span class="badge badge-neutral">No longer here</span>`}</td>
      </tr>`).join("");
    return `
      <section class="card" data-card="former">
        <details>
          <summary class="card-header" style="cursor:pointer">
            <div class="card-title">People who have left <span class="badge badge-neutral">${former.length}</span></div>
          </summary>
          <div class="card-body zero">
            <p class="form-help" style="padding:12px 16px 0">Their records stay in the workspace, and their name still shows on anything they worked on.</p>
            <div class="table-wrap">
              <table class="tbl tbl-responsive">
                <thead><tr><th>Name</th><th>Role</th><th>Status</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>
        </details>
      </section>`;
  }

  function wireMembers(pane) {
    const goPerms = pane.querySelector("[data-go-permissions]");
    if (goPerms) goPerms.addEventListener("click", () => App.app.navigate("/settings/team-permissions"));
    const cta = pane.querySelector("#membersInviteCta");
    if (cta) cta.addEventListener("click", () => {
      const field = pane.querySelector("#inviteEmail");
      if (field) field.focus();
    });

    pane.querySelectorAll(".member-role").forEach(sel => {
      // Remembered so a refused change can be put back without a re-render.
      const before = sel.value;
      sel.addEventListener("change", async () => {
        const memberId = sel.getAttribute("data-member");
        const role = sel.value;
        sel.disabled = true;
        try {
          const out = await S().team.changeRole(memberId, role);
          if (out && out.outcome === "changed") {
            App.app.toast("Role changed.", "success");
            await refresh();
            return;
          }
          sel.value = before;
          sel.disabled = false;
          App.app.toast(roleChangeMessage(out), "danger");
        } catch (err) {
          sel.value = before;
          sel.disabled = false;
          App.app.toast(serverRefusal(err, "Only an owner or admin can change roles."), "danger");
        }
      });
    });

    pane.querySelectorAll("[data-perms]").forEach(btn => {
      btn.addEventListener("click", () => {
        App.app.navigate("/settings/team-permissions?member=" + encodeURIComponent(btn.getAttribute("data-perms")));
      });
    });

    pane.querySelectorAll("[data-remove]").forEach(btn => {
      btn.addEventListener("click", () => {
        const memberId = btn.getAttribute("data-remove");
        const name = btn.getAttribute("data-name");
        App.app.confirmDialog({
          title: "Remove " + name + "?",
          message: "They lose access to this workspace straight away. Their leads, deals and tasks stay here and become unassigned, and their name still shows on everything they worked on. You can invite them again later.",
          okLabel: "Remove",
          danger: true
        }, async () => {
          try {
            const out = await S().team.remove(memberId);
            if (out && out.outcome === "removed") {
              App.app.toast(name + " was removed.", "success");
            } else if (out && out.outcome === "cannot_remove_owner") {
              App.app.toast("Make somebody else the owner first.", "danger");
            } else if (out && out.outcome === "cannot_remove_self") {
              App.app.toast("Use Leave this team instead.", "danger");
            } else if (out && out.outcome === "already_removed") {
              App.app.toast("They had already been removed.", "info");
            } else if (out && out.outcome === "not_found") {
              App.app.toast("That person is no longer in this workspace.", "info");
            } else {
              App.app.toast("Could not remove them.", "danger");
            }
          } catch (err) {
            App.app.toast(serverRefusal(err, "Only an owner or admin can remove people."), "danger");
          }
          await refresh();
        });
      });
    });

    pane.querySelectorAll("[data-transfer]").forEach(btn => {
      btn.addEventListener("click", () => {
        const memberId = btn.getAttribute("data-transfer");
        const name = btn.getAttribute("data-name");
        App.app.confirmDialog({
          title: "Make " + name + " the owner?",
          message: "They become the owner of this workspace and you become an admin. Only they can hand it back. This cannot be undone by you.",
          okLabel: "Make owner",
          danger: true
        }, async () => {
          try {
            const out = await S().team.transferOwnership(memberId);
            if (out && out.outcome === "transferred") {
              App.app.toast(name + " is now the owner. You are an admin.", "success");
            } else if (out && out.outcome === "target_not_active") {
              App.app.toast("That person is no longer in this workspace.", "danger");
            } else if (out && out.outcome === "already_owner") {
              App.app.toast("They are already the owner.", "info");
            } else if (out && out.outcome === "not_found") {
              App.app.toast("That person is no longer in this workspace.", "info");
            } else {
              App.app.toast("Could not hand over the workspace.", "danger");
            }
          } catch (err) {
            App.app.toast(serverRefusal(err, "Only the owner can hand over a workspace."), "danger");
          }
          await refresh();
        });
      });
    });
  }

  function roleChangeMessage(out) {
    if (!out) return "Could not change the role.";
    if (out.outcome === "exceeds_your_permissions") {
      return "You cannot give somebody more than you have yourself" +
        (out.reason ? " (" + out.reason + ")." : ".");
    }
    if (out.outcome === "cannot_change_owner") return "The owner's role is changed by handing over the workspace.";
    if (out.outcome === "not_active") return "That person is no longer in this workspace.";
    if (out.outcome === "not_found") return "That person is no longer in this workspace.";
    if (out.outcome === "unchanged") return "They already have that role.";
    return "Could not change the role.";
  }

  // A thrown error here is the server refusing on permission grounds
  // (the functions raise for that and return an outcome for everything
  // else), so it is reported as a refusal rather than as a crash.
  function serverRefusal(err, fallback) {
    const msg = err && err.message ? String(err.message) : "";
    if (/permission|not authenticated|only the workspace owner/i.test(msg)) return fallback;
    return fallback;
  }

  // ---------- INVITE ----------

  function inviteCard() {
    return `
      <section class="card" data-card="invite">
        <div class="card-header"><div class="card-title">Invite someone</div></div>
        <div class="card-body">
          <p class="form-help">You will get a link to send them yourself. We do not email it for you.</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
            <label class="field" style="flex:1 1 240px;margin:0">
              <span>Their email address</span>
              <input type="email" id="inviteEmail" autocomplete="off" placeholder="name@example.com">
            </label>
            <label class="field" style="margin:0">
              <span>They join as</span>
              <select id="inviteRole">
                <option value="agent">Agent — works their own leads</option>
                <option value="admin">Admin — can manage the team</option>
              </select>
            </label>
            <button class="btn btn-primary" id="inviteBtn">Create invite link</button>
          </div>
          <div class="field-error-hint" id="inviteError" role="alert" hidden></div>
          <div id="invitePanel"></div>
        </div>
      </section>`;
  }

  function wireInvite(pane) {
    const btn = pane.querySelector("#inviteBtn");
    const emailEl = pane.querySelector("#inviteEmail");
    const roleEl = pane.querySelector("#inviteRole");
    const errEl = pane.querySelector("#inviteError");
    if (!btn || !emailEl || !roleEl) return;

    const showError = (msg) => {
      if (!errEl) return;
      errEl.textContent = msg;
      errEl.hidden = false;
    };
    const clearError = () => { if (errEl) { errEl.textContent = ""; errEl.hidden = true; } };

    emailEl.addEventListener("input", clearError);
    emailEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); btn.click(); } });

    btn.addEventListener("click", async () => {
      clearError();
      const email = emailEl.value.trim();
      const role = roleEl.value;
      if (!email) { showError("Enter their email address."); emailEl.focus(); return; }
      btn.disabled = true;
      try {
        const out = await S().team.invite(email, role);
        btn.disabled = false;
        if (out && out.outcome === "invited") {
          // The form keeps nothing: the address is now shown in the panel.
          emailEl.value = "";
          showInvitePanel(pane, out);
          await refreshInvitationsOnly(pane);
          return;
        }
        if (out && out.outcome === "invalid_email") { showError("That does not look like an email address."); emailEl.focus(); return; }
        if (out && out.outcome === "already_a_member") { showError("They are already in this workspace."); return; }
        if (out && out.outcome === "already_invited") { showError("They already have an invite waiting. Cancel it below if you need a new link."); return; }
        if (out && out.outcome === "invalid_role") {
          // Unreachable from a closed list, so this is a bug, not a user error.
          console.error("Invite refused an unexpected role:", role);
          showError("Something went wrong. Please try again.");
          return;
        }
        showError("Could not create the invite.");
      } catch (err) {
        btn.disabled = false;
        showError("Only an owner or admin can invite people.");
      }
    });
  }

  // The link is shown ONCE. Only a hash of the token is stored, so it
  // cannot be shown again - which the panel has to say plainly, because
  // the alternative is somebody closing it and quietly losing the invite.
  function showInvitePanel(pane, out) {
    const host = pane.querySelector("#invitePanel");
    if (!host) return;
    const link = joinUrl(out.token);
    const days = daysFromNow(out.expires_at);
    host.innerHTML = `
      <div class="release-callout" data-panel="invite-link" style="margin-top:14px">
        <strong>Send this link to ${U().esc(out.email)}</strong>
        <p class="form-help" style="margin:6px 0 10px">
          It works only for ${U().esc(out.email)}, and ${days !== null && days >= 0 ? "stops working in " + days + (days === 1 ? " day" : " days") : "is already past its date"}.
          This is the only time the link is shown — we cannot show it again. If it gets lost, cancel the invite and make a new one.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="text" id="inviteLink" readonly value="${U().esc(link)}"
                 aria-label="Invite link" style="flex:1 1 280px">
          <button class="btn btn-primary" id="copyInviteLink">Copy link</button>
          <button class="btn" id="dismissInviteLink">I have copied it</button>
        </div>
        <div class="form-help" id="copyState" role="status" aria-live="polite"></div>
      </div>`;

    const input = host.querySelector("#inviteLink");
    const state = host.querySelector("#copyState");
    const copyBtn = host.querySelector("#copyInviteLink");
    const done = host.querySelector("#dismissInviteLink");

    if (copyBtn) copyBtn.addEventListener("click", async () => {
      const ok = await copyText(link, input);
      if (state) state.textContent = ok
        ? "Copied. Paste it into an email or a message."
        : "Could not copy automatically — the link is selected, so copy it by hand.";
    });
    if (done) done.addEventListener("click", () => { host.innerHTML = ""; });
    if (input) input.addEventListener("focus", () => { try { input.select(); } catch (e) {} });
  }

  async function copyText(text, input) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through to the manual path */ }
    try {
      if (input) { input.focus(); input.select(); }
      if (document.execCommand && document.execCommand("copy")) return true;
    } catch (e) { /* nothing else to try */ }
    if (input) { try { input.focus(); input.select(); } catch (e) {} }
    return false;
  }

  // The token travels in the hash, which is how the app routes and which
  // also means it survives the sign-in screen without a redirect.
  function joinUrl(token) {
    const loc = (typeof window !== "undefined" && window.location) ? window.location : { origin: "", pathname: "" };
    const base = (loc.origin || "") + (loc.pathname || "");
    return base + "#/join?token=" + encodeURIComponent(token);
  }

  // ---------- INVITATIONS ----------

  function invitationsCard(invitations) {
    const body = invitations.length ? `
      <div class="table-wrap">
        <table class="tbl tbl-responsive">
          <thead><tr><th>Email</th><th>Joining as</th><th>Status</th><th class="actions">&nbsp;</th></tr></thead>
          <tbody>
            ${invitations.map(inv => `
              <tr data-invite-row="${U().esc(inv.id)}">
                <td data-label="Email" class="primary-cell">
                  <strong>${U().esc(inv.email || "")}</strong>
                  <div class="form-help">${U().esc(expiryText(inv))}${inv.invited_by_email ? " · invited by " + U().esc(inv.invited_by_email) : ""}</div>
                </td>
                <td data-label="Joining as">${roleBadge(inv.role)}</td>
                <td data-label="Status">${inviteBadge(inv.status)}</td>
                <td class="actions" data-label="">
                  ${inv.status === "pending"
                    ? `<button class="btn btn-sm" data-revoke="${U().esc(inv.id)}" data-email="${U().esc(inv.email || "")}">Cancel</button>`
                    : inv.status === "expired"
                      ? `<button class="btn btn-sm" data-revoke="${U().esc(inv.id)}" data-email="${U().esc(inv.email || "")}">Clear</button>`
                      : ""}
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
      ${invitations.some(i => i.status === "expired")
        ? `<p class="form-help" style="padding:10px 16px 0">An expired link no longer works. Invite the person again to send a new one.</p>`
        : ""}` : `
      <div class="empty-state">
        <div class="empty-title">No invites yet</div>
        <div class="empty-desc">Invite someone above, then send them the link yourself.</div>
      </div>`;

    return `
      <section class="card" data-card="invitations">
        <div class="card-header"><div class="card-title">Invites</div></div>
        <div class="card-body ${invitations.length ? "zero" : ""}">${body}</div>
      </section>`;
  }

  async function refreshInvitationsOnly(pane) {
    const card = pane.querySelector('[data-card="invitations"]');
    if (!card) return;
    try {
      const res = await S().team.listInvitations();
      if (!res || res.outcome !== "ok") return;
      card.outerHTML = invitationsCard(res.invitations || []);
      wireInvitations(pane);
    } catch (err) { /* the list is simply left as it was */ }
  }

  function wireInvitations(pane) {
    pane.querySelectorAll("[data-revoke]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-revoke");
        const email = btn.getAttribute("data-email");
        btn.disabled = true;
        try {
          const out = await S().team.revokeInvitation(id);
          if (out && out.outcome === "revoked") {
            App.app.toast("The invite for " + email + " no longer works.", "success");
          } else if (out && out.outcome === "already_accepted") {
            App.app.toast("They have already joined — remove them from People instead.", "info");
          } else if (out && out.outcome === "not_found") {
            App.app.toast("That invite is already gone.", "info");
          } else {
            App.app.toast("Could not cancel the invite.", "danger");
          }
        } catch (err) {
          App.app.toast("Only an owner or admin can cancel invites.", "danger");
        }
        await refresh();
      });
    });
  }

  // ---------- LEAVE ----------

  function leaveCard() {
    // The owner cannot leave: they hand the workspace over or delete it.
    if (W().isOwner() || !W().id()) return "";
    return `
      <section class="card" data-card="leave">
        <div class="card-header"><div class="card-title">Leave this team</div></div>
        <div class="card-body">
          <p class="form-help">You keep your sign-in and get a workspace of your own. You lose access to this one.</p>
          <button class="btn btn-danger" id="leaveTeamBtn">Leave this team</button>
        </div>
      </section>`;
  }

  function wireLeave(pane) {
    const btn = pane.querySelector("#leaveTeamBtn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      App.app.confirmDialog({
        title: "Leave this team?",
        message: "Your leads, deals and tasks stay with the team and become unassigned. Anything you made just for yourself — your templates, scripts, prompts and automations — goes to the owner. You get a fresh empty workspace of your own. You cannot undo this yourself.",
        okLabel: "Leave this team",
        danger: true
      }, async () => {
        btn.disabled = true;
        try {
          const out = await S().team.leave();
          if (out && out.outcome === "left") {
            App.app.toast("You have left the team. This is your own workspace now.", "success");
            App.app.navigate("/dashboard");
            return;
          }
          if (out && out.outcome === "owner_cannot_leave") {
            App.app.toast("Make somebody else the owner first, or delete the team.", "danger");
          } else if (out && out.outcome === "not_a_member") {
            App.app.toast("You are not in this team.", "info");
          } else {
            App.app.toast("Could not leave the team.", "danger");
          }
        } catch (err) {
          App.app.toast("Could not leave the team.", "danger");
        }
        btn.disabled = false;
        await refresh();
      });
    });
  }

  // ---------- DELETE ----------

  function dangerCard() {
    return `
      <section class="card" data-card="danger">
        <div class="card-header"><div class="card-title">Delete this team</div></div>
        <div class="card-body">
          <p class="form-help">Everything in this workspace is deleted — every contact, deal, property, task and record of what the team did. This cannot be undone. Remove everybody else first.</p>
          <button class="btn btn-danger" id="deleteTeamBtn">Delete this team</button>
        </div>
      </section>`;
  }

  function wireDanger(pane) {
    const btn = pane.querySelector("#deleteTeamBtn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const s = S().getState();
      const name = (s.settings && s.settings.agencyName) || "";
      const h = App.app.openModal({
        title: "Delete this team",
        extraClass: "confirm",
        body: `
          <p>Everything in this workspace is deleted: every contact, deal, property, task, and the record of what the team did. It cannot be brought back.</p>
          <label class="field">
            <span>Type the workspace name to confirm</span>
            <input type="text" id="deleteConfirmName" autocomplete="off" placeholder="Workspace name">
          </label>
          <p class="form-help">Type it exactly, including capital letters.${name ? "" : ""}</p>
          <div class="field-error-hint" id="deleteError" role="alert" hidden></div>`,
        footer: `
          <button class="btn" data-role="cancel">Keep this team</button>
          <button class="btn btn-danger" data-role="ok">Delete for good</button>`,
        onOpen: (modal) => {
          const input = modal.querySelector("#deleteConfirmName");
          const err = modal.querySelector("#deleteError");
          const ok = modal.querySelector('[data-role="ok"]');
          const showErr = (m) => { if (err) { err.textContent = m; err.hidden = false; } };
          modal.querySelector('[data-role="cancel"]').addEventListener("click", () => h.close());
          ok.addEventListener("click", async () => {
            const typed = input ? input.value : "";
            if (!typed.trim()) { showErr("Type the workspace name to confirm."); if (input) input.focus(); return; }
            ok.disabled = true;
            try {
              const out = await S().team.deleteTeam(typed);
              if (out && out.outcome === "deleted") {
                h.close();
                App.app.toast("The team was deleted. This is your own workspace now.", "success");
                App.app.navigate("/dashboard");
                return;
              }
              ok.disabled = false;
              if (out && out.outcome === "other_members_present") {
                showErr("Remove the other " + out.active_members + " " +
                  (out.active_members === 1 ? "person" : "people") + " first.");
              } else if (out && out.outcome === "name_mismatch") {
                // Never filled in from the server's answer: the typing IS the guard.
                showErr("That name did not match.");
              } else {
                showErr("Could not delete the team.");
              }
            } catch (err2) {
              ok.disabled = false;
              showErr("Only the owner can delete a team.");
            }
          });
          if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ok.click(); } });
        }
      });
    });
  }

  return { render, joinUrl, expiryText, teamModeError, hasOverrides };
})();
