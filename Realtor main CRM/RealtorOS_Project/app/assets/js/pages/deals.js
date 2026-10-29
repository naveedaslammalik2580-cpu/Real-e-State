/* ============================================================
   deals.js — Deals Pipeline (Kanban) + Deal Detail + Deal Form.
   Depends on: app.js, store.js, derived.js, commission.js, util.js
   Uses existing data-layer logic. No formulas duplicated.
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.deals = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;
  const D = () => App.derived;
  const C = () => App.commission;

  // View state: "pipeline" (active stages Kanban) or "terminal" (Closed + Lost table)
  let currentView = "pipeline";
  let searchQ = "";

  const LIST_DEPS = ["deals", "contacts", "properties"];
  const DETAIL_DEPS = ["deals", "contacts", "properties", "milestones", "activities", "tasks", "showings"];
  const MODAL_DEPS = ["deals", "contacts", "properties", "teamMembers"];

  // ---------- HELPERS ----------

  function stageObj(stageName) {
    const s = S().getState();
    return s.settings.pipelineStages.find(x => x.name === stageName) || null;
  }
  function activeStages() {
    return S().getState().settings.pipelineStages.filter(s => !s.terminal).sort((a,b) => a.order - b.order);
  }
  function dealSideBadge(side) {
    const cls = side === "Seller" ? "badge-warning" : side === "Dual" ? "badge-info" : "badge-cold";
    return `<span class="badge ${cls}">${U().esc(side)}</span>`;
  }
  function closeDateStatus(deal) {
    const st = D().dealClosingStatus(S().getState(), deal);
    if (st.status === "past-due")     return `<span class="badge badge-overdue">Past due ${st.daysPast}d</span>`;
    if (st.status === "closing-today")return `<span class="badge badge-today">Closing today</span>`;
    if (st.status === "this-week")    return `<span class="badge badge-warning">This week</span>`;
    if (st.status === "this-month")   return `<span class="badge badge-info">This month</span>`;
    return "";
  }

  // ==========================================================
  // PIPELINE (KANBAN) PAGE
  // ==========================================================

  async function renderPipeline(container) {
    App.app.setBreadcrumbs([{ label: "Deals Pipeline" }]);
    App.app.setTopActions("");
    container.innerHTML = App.app.loadingHtml();
    await S().ensureLoaded(LIST_DEPS);

    const s = S().getState();
    const cur = s.settings.currency;
    const filtered = filtered_by_search();

    // Global pipeline totals (active only) from derived layer
    const glance = D().businessAtAGlance(s);

    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Deals Pipeline</div>
          <div class="page-desc">Every deal, in every stage, from first contact to closing — drag to move stages, click a card to open it.</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" id="addDealBtn">${App.app.icon("plus")} Add Deal</button>
        </div>
      </div>

      <div class="stat-row">
        <div class="stat-card">
          <div class="k">Active Deals</div>
          <div class="v">${glance.activeDealsCount}</div>
          <div class="sub">across active stages</div>
        </div>
        <div class="stat-card">
          <div class="k">Pipeline Value</div>
          <div class="v">${U().formatCompact(glance.activePipelineValue, cur)}</div>
          <div class="sub">${U().formatCurrency(glance.activePipelineValue, cur)}</div>
        </div>
        <div class="stat-card">
          <div class="k">Expected Net</div>
          <div class="v">${U().formatCompact(glance.expectedNetCommission, cur)}</div>
          <div class="sub">if all deals close</div>
        </div>
        <div class="stat-card">
          <div class="k">Weighted Pipeline</div>
          <div class="v">${U().formatCompact(glance.expectedWeightedCommission, cur)}</div>
          <div class="sub">probability-adjusted</div>
        </div>
      </div>

      <div class="filter-bar">
        <div class="search-wrap">
          ${App.app.icon("search")}
          <input type="search" id="dSearch" placeholder="Search deal, client, or address…" value="${U().esc(searchQ)}">
        </div>
        <div class="view-tabs" role="tablist" aria-label="Deal view">
          <button class="btn btn-sm ${currentView==='pipeline'?'btn-primary':''}" id="viewPipeline" role="tab">Active Pipeline</button>
          <button class="btn btn-sm ${currentView==='terminal'?'btn-primary':''}" id="viewTerminal" role="tab">Closed / Lost</button>
        </div>
      </div>

      <div id="pipelineBody"></div>
    `;

    document.getElementById("addDealBtn").addEventListener("click", () => openDealModal(null));
    document.getElementById("dSearch").addEventListener("input", (e) => {
      searchQ = e.target.value;
      renderPipelineBody(filtered_by_search());
    });
    document.getElementById("viewPipeline").addEventListener("click", () => { currentView = "pipeline"; renderPipeline(container); });
    document.getElementById("viewTerminal").addEventListener("click", () => { currentView = "terminal"; renderPipeline(container); });

    if (currentView === "pipeline") {
      renderKanban(document.getElementById("pipelineBody"), filtered);
    } else {
      renderTerminalTable(document.getElementById("pipelineBody"), filtered);
    }
  }

  function filtered_by_search() {
    const state = S().getState();
    const q = searchQ.toLowerCase().trim();
    const all = state.deals;
    if (!q) return all;
    return all.filter(d => {
      const contact = d.contactId ? state.contacts.find(c => c.id === d.contactId) : null;
      const property = d.propertyId ? state.properties.find(p => p.id === d.propertyId) : null;
      return (d.name || "").toLowerCase().includes(q) ||
             (contact && contact.name.toLowerCase().includes(q)) ||
             (property && (property.address||"").toLowerCase().includes(q));
    });
  }

  function renderPipelineBody(deals) {
    const el = document.getElementById("pipelineBody");
    if (!el) return;
    if (currentView === "pipeline") renderKanban(el, deals);
    else renderTerminalTable(el, deals);
  }

  // ---------- KANBAN VIEW ----------

  function renderKanban(container, deals) {
    const s = S().getState();
    const cur = s.settings.currency;
    const stages = activeStages();
    const activeOnly = deals.filter(d => !D().isTerminalStage(s, d.stage));

    if (activeOnly.length === 0 && !searchQ) {
      container.innerHTML = `
        <div class="card">
          <div class="empty">
            <div class="empty-icon">${App.app.icon("columns")}</div>
            <h3>No deals yet</h3>
            <p>Create your first deal to start tracking your pipeline. Link it to a contact and property to see everything connect — you can also add deals from any contact's detail page.</p>
            <button class="btn btn-primary" onclick="App.pages.deals.openDealModal(null)">Create Your First Deal</button>
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="kanban-scroll">
        <div class="kanban" id="kanban">
          ${stages.map(stage => {
            const stageDeals = activeOnly.filter(d => d.stage === stage.name);
            const totalValue = stageDeals.reduce((t,d) => t + U().num(d.salePrice), 0);
            const totalNet   = stageDeals.reduce((t,d) => t + C().netGCI(d), 0);
            return `
              <section class="kanban-col" data-stage-id="${stage.id}" data-stage-name="${U().esc(stage.name)}" aria-label="${U().esc(stage.name)} stage">
                <header class="kanban-col-header" style="border-top-color: ${stage.color};">
                  <div class="kanban-col-title">
                    <span class="stage-dot" style="background:${stage.color}"></span>
                    <span>${U().esc(stage.name)}</span>
                    <span class="kanban-col-count">${stageDeals.length}</span>
                  </div>
                  <div class="kanban-col-sub">
                    ${stage.probability}% prob · ${U().formatCompact(totalValue, cur)} · Net ${U().formatCompact(totalNet, cur)}
                  </div>
                </header>
                <div class="kanban-col-body">
                  ${stageDeals.length === 0
                    ? `<div class="kanban-empty">Drop deals here</div>`
                    : stageDeals.map(d => renderKanbanCard(d, cur, s)).join("")}
                </div>
              </section>
            `;
          }).join("")}
        </div>
      </div>
    `;

    // Wire up drag & drop and card clicks
    wireKanbanEvents(container);
  }

  function renderKanbanCard(d, cur, s) {
    const c = d.contactId ? s.contacts.find(x => x.id === d.contactId) : null;
    const p = d.propertyId ? s.properties.find(x => x.id === d.propertyId) : null;
    const gross = C().grossGCI(d);
    const weighted = C().weightedGCI(d);
    const dueBadge = closeDateStatus(d);

    return `
      <article class="kanban-card" draggable="true" data-deal-id="${d.id}" tabindex="0" role="button" aria-label="${U().esc(d.name)}">
        <div class="kanban-card-top">
          <div class="kanban-card-name">${U().esc(d.name)}</div>
        </div>
        <div class="kanban-card-meta">
          ${c ? `<div class="kanban-card-line">👤 ${U().esc(c.name)}</div>` : ""}
          ${p ? `<div class="kanban-card-line">🏠 ${U().esc(p.address)}</div>` : ""}
        </div>
        <div class="kanban-card-money">
          <div class="kanban-card-price">${d.salePrice ? U().formatCurrency(d.salePrice, cur) : "—"}</div>
          <div class="kanban-card-gci">Gross ${U().formatCompact(gross, cur)} · Wt ${U().formatCompact(weighted, cur)}</div>
        </div>
        <div class="kanban-card-bottom">
          <span class="badge badge-neutral">${d.probability || 0}%</span>
          ${dealSideBadge(d.side)}
          ${d.closeDate ? `<span class="kanban-card-date">${U().formatDate(d.closeDate, 'short')}</span>` : ''}
          ${dueBadge}
        </div>
      </article>
    `;
  }

  function wireKanbanEvents(container) {
    // Card click → detail
    container.querySelectorAll(".kanban-card").forEach(card => {
      card.addEventListener("click", (e) => {
        if (e.target.closest("button, a")) return;
        App.app.navigate("/pipeline/" + card.getAttribute("data-deal-id"));
      });
      // Keyboard: Enter opens
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          App.app.navigate("/pipeline/" + card.getAttribute("data-deal-id"));
        }
      });
      // Drag start
      card.addEventListener("dragstart", (e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", card.getAttribute("data-deal-id"));
        card.classList.add("dragging");
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
    });

    // Column drop targets
    container.querySelectorAll(".kanban-col").forEach(col => {
      col.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        col.classList.add("drop-target");
      });
      col.addEventListener("dragleave", (e) => {
        // only remove if leaving the column entirely
        if (!col.contains(e.relatedTarget)) col.classList.remove("drop-target");
      });
      col.addEventListener("drop", async (e) => {
        e.preventDefault();
        col.classList.remove("drop-target");
        const dealId = e.dataTransfer.getData("text/plain");
        const stageId = col.getAttribute("data-stage-id");
        const currentDeal = S().getState().deals.find(x => x.id === dealId);
        if (!currentDeal) return;
        const targetStage = S().getState().settings.pipelineStages.find(x => x.id === stageId);
        if (!targetStage) return;
        if (currentDeal.stage === targetStage.name) return; // no-op

        // Uses the existing data-layer function — DO NOT duplicate logic
        try {
          await S().deals.moveToStage(dealId, stageId);
          App.app.toast(`Moved to ${targetStage.name}.`, "success");
          renderPipelineBody(filtered_by_search());
        } catch (err) {
          App.app.toast("Could not move deal: " + err.message, "danger");
        }
      });
    });
  }

  // ---------- TERMINAL (CLOSED + LOST) TABLE ----------

  function renderTerminalTable(container, deals) {
    const s = S().getState();
    const cur = s.settings.currency;
    const terminals = deals.filter(d => D().isTerminalStage(s, d.stage));
    const closed = terminals.filter(d => D().isTerminalWon(s, d.stage))
                            .sort((a,b) => (b.closeDate||"").localeCompare(a.closeDate||""));
    const lost   = terminals.filter(d => D().isTerminalLost(s, d.stage))
                            .sort((a,b) => (b.updatedAt||"").localeCompare(a.updatedAt||""));

    container.innerHTML = `
      <div class="card" style="margin-bottom:20px;">
        <div class="card-header">
          <div class="card-title">Closed Deals</div>
          <span class="badge badge-success">${closed.length}</span>
        </div>
        <div class="card-body zero">
          ${closed.length === 0
            ? `<div class="empty" style="padding:var(--empty-padding)"><p>No closed deals yet.</p></div>`
            : renderDealsTable(closed, cur, true, s)}
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title">Lost Deals</div>
          <span class="badge badge-danger">${lost.length}</span>
        </div>
        <div class="card-body zero">
          ${lost.length === 0
            ? `<div class="empty" style="padding:var(--empty-padding)"><p>No lost deals.</p></div>`
            : renderDealsTable(lost, cur, false, s)}
        </div>
      </div>
    `;

    container.querySelectorAll("tr[data-deal-id]").forEach(tr => {
      tr.addEventListener("click", () => App.app.navigate("/pipeline/" + tr.getAttribute("data-deal-id")));
    });
  }

  function renderDealsTable(deals, cur, showNet, s) {
    return `
      <div class="table-wrap">
        <table class="tbl tbl-responsive">
          <thead>
            <tr>
              <th>Deal</th>
              <th>Client</th>
              <th>Property</th>
              <th class="num">Sale Price</th>
              ${showNet ? `<th class="num">Net GCI</th>` : `<th>Reason</th>`}
              <th>Close Date</th>
            </tr>
          </thead>
          <tbody>
            ${deals.map(d => {
              const c = d.contactId ? s.contacts.find(x => x.id === d.contactId) : null;
              const p = d.propertyId ? s.properties.find(x => x.id === d.propertyId) : null;
              return `
                <tr class="clickable" data-deal-id="${d.id}">
                  <td data-label="Deal" class="primary-cell">${U().esc(d.name)}</td>
                  <td data-label="Client">${c ? U().esc(c.name) : "—"}</td>
                  <td data-label="Property">${p ? U().esc(p.address) : "—"}</td>
                  <td data-label="Sale Price" class="num">${d.salePrice ? U().formatCurrency(d.salePrice, cur) : "—"}</td>
                  ${showNet
                    ? `<td data-label="Net GCI" class="num">${U().formatCurrency(C().netGCI(d), cur)}</td>`
                    : `<td data-label="Reason">${U().esc(d.lostReason || "—")}</td>`}
                  <td data-label="Close Date">${d.closeDate ? U().formatDate(d.closeDate) : "—"}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  // ==========================================================
  // DEAL DETAIL PAGE
  // ==========================================================

  async function renderDealDetail(container, id) {
    container.innerHTML = App.app.loadingHtml();
    await S().ensureLoaded(DETAIL_DEPS);
    const state = S().getState();
    const d = state.deals.find(x => x.id === id);
    if (!d) {
      App.app.setBreadcrumbs([{ label: "Deals Pipeline", route: "/pipeline" }, { label: "Not Found" }]);
      container.innerHTML = `<div class="empty"><h3>Deal not found</h3><a href="#/pipeline" class="btn btn-primary">Back to Pipeline</a></div>`;
      return;
    }

    App.app.setBreadcrumbs([
      { label: "Deals Pipeline", route: "/pipeline" },
      { label: d.name || "(unnamed deal)" }
    ]);
    App.app.setTopActions(`
      <button class="btn" id="editDealBtn">${App.app.icon("edit")} Edit</button>
      <button class="btn btn-danger" id="deleteDealBtn">${App.app.icon("trash")} Delete</button>
    `);

    const s = state;
    const cur = s.settings.currency;
    const contact = d.contactId ? state.contacts.find(c => c.id === d.contactId) : null;
    const property = d.propertyId ? state.properties.find(p => p.id === d.propertyId) : null;
    const stage = stageObj(d.stage);
    const bd = C().breakdown(d);

    const milestones = state.milestones.filter(m => m.dealId === id).sort((a,b) => a.order - b.order);
    const activities = state.activities.filter(a => a.dealId === id)
                        .sort((a,b) => (b.date||"").localeCompare(a.date||""));
    const tasks = state.tasks.filter(t => t.dealId === id);
    const showings = state.showings.filter(sh => sh.dealId === id)
                        .sort((a,b) => (b.date||"").localeCompare(a.date||""));

    // Stage dropdown for the "Move Stage" action
    const stageOptions = s.settings.pipelineStages
      .sort((a,b) => a.order - b.order)
      .map(st => `<option value="${st.id}" ${st.name===d.stage?'selected':''}>${U().esc(st.name)} (${st.probability}%)</option>`)
      .join("");

    container.innerHTML = `
      ${App.app.backLink("/pipeline", "Deals Pipeline")}
      <div class="detail-grid">
        <div class="col">
          <div class="card">
            <div class="profile-hero">
              <div class="name">${U().esc(d.name)}</div>
              <div class="subline">
                <span class="stage-pill"><span class="stage-dot" style="background:${stage?stage.color:'#94A3B8'}"></span>${U().esc(d.stage)}</span>
                <span>·</span>
                ${dealSideBadge(d.side)}
                <span>·</span>
                <span>${d.probability || 0}% probability</span>
                ${d.closeDate ? `<span>·</span><span>Close ${U().formatDate(d.closeDate)}</span>` : ""}
                ${closeDateStatus(d) ? " " + closeDateStatus(d) : ""}
              </div>
            </div>
            <div class="card-body">
              <div class="meta">
                <div><div class="k">Client</div><div class="v">${contact ? `<a class="link" href="#/contacts/${contact.id}">${U().esc(contact.name)}</a>` : '<span style="color:var(--text-soft)">—</span>'}</div></div>
                <div><div class="k">Property</div><div class="v">${property ? `<a class="link" href="#/properties/${property.id}">${U().esc(property.address)}</a>` : '<span style="color:var(--text-soft)">—</span>'}</div></div>
                <div><div class="k">Side</div><div class="v">${U().esc(d.side)}</div></div>
                <div><div class="k">Stage</div><div class="v">${U().esc(d.stage)}</div></div>
              </div>
              ${d.notes ? `
                <div style="margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--border);">
                  <div class="k" style="font-size: var(--font-size-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:6px;">Notes</div>
                  <div style="white-space:pre-wrap;">${U().esc(d.notes)}</div>
                </div>` : ""}
              ${d.lostReason ? `
                <div style="margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--border);">
                  <div class="k" style="font-size: var(--font-size-xs);color:var(--danger);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:6px;">Lost Reason</div>
                  <div>${U().esc(d.lostReason)}</div>
                </div>` : ""}
            </div>
          </div>

          <div class="card">
            <div class="card-header"><div class="card-title">Transaction</div></div>
            <div class="card-body">
              <div class="stat-row" style="margin:0">
                <div class="stat-card"><div class="k">Sale Price</div><div class="v">${d.salePrice ? U().formatCurrency(d.salePrice, cur) : "—"}</div></div>
                <div class="stat-card"><div class="k">Offer Date</div><div class="v">${d.offerDate ? U().formatDate(d.offerDate) : "—"}</div></div>
                <div class="stat-card"><div class="k">Contract Date</div><div class="v">${d.contractDate ? U().formatDate(d.contractDate) : "—"}</div></div>
                <div class="stat-card"><div class="k">Close Date</div><div class="v">${d.closeDate ? U().formatDate(d.closeDate) : "—"}</div></div>
              </div>
            </div>
          </div>

          ${renderCommissionBreakdownCard(bd, cur)}
          ${renderMilestonesCard(milestones)}
          ${renderRelatedActivitiesCard(activities)}
          ${renderRelatedShowingsCard(showings, state)}
          ${renderRelatedTasksCard(tasks)}
        </div>

        <div class="col">
          <div class="card">
            <div class="card-header"><div class="card-title">Move Stage</div></div>
            <div class="card-body">
              <div class="form-field">
                <label for="stageMove">Current stage</label>
                <select id="stageMove">${stageOptions}</select>
                <div class="hint">Probability auto-updates unless you've overridden it. Moving to Closed fills the close date automatically.</div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header"><div class="card-title">Quick Actions</div></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:8px;">
              <button class="btn btn-primary btn-block" id="qAddActD">${App.app.icon("plus")} Log Activity</button>
              <button class="btn btn-block" id="qAddTaskD">${App.app.icon("plus")} Add Task</button>
              <button class="btn btn-block" id="qAddShowD">${App.app.icon("plus")} Schedule Showing</button>
            </div>
          </div>

          <div class="card">
            <div class="card-header"><div class="card-title">Summary</div></div>
            <div class="card-body">
              <div style="display:flex;flex-direction:column;gap:14px;">
                <div><div class="k" style="font-size: var(--font-size-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Milestones complete</div><div style="font-size: var(--font-size-xl);font-weight:700;">${milestones.filter(m => m.status === "Complete").length} / ${milestones.length}</div></div>
                <div><div class="k" style="font-size: var(--font-size-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Open tasks</div><div style="font-size: var(--font-size-xl);font-weight:700;">${tasks.filter(t => t.status !== "Completed").length}</div></div>
                <div><div class="k" style="font-size: var(--font-size-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Activities logged</div><div style="font-size: var(--font-size-xl);font-weight:700;">${activities.length}</div></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Wire actions
    document.getElementById("editDealBtn").addEventListener("click", () => openDealModal(id));
    document.getElementById("deleteDealBtn").addEventListener("click", () => openDeleteDealConfirm(id));
    document.getElementById("stageMove").addEventListener("change", async (e) => {
      const sel = e.target;
      const newStageId = sel.value;
      sel.disabled = true;
      try {
        await S().deals.moveToStage(id, newStageId);
        App.app.toast("Stage updated.", "success");
        App.app.route();
      } catch (err) {
        App.app.toast("Could not update stage: " + err.message, "danger");
        sel.disabled = false;
      }
    });
    document.getElementById("qAddActD").addEventListener("click", () =>
      App.pages.contacts.openActivityModal({ contactId: d.contactId, dealId: id }));
    document.getElementById("qAddTaskD").addEventListener("click", () =>
      App.pages.contacts.openTaskModal({ contactId: d.contactId, dealId: id }));
    wireMilestoneCompletion(container, id);
    document.getElementById("qAddShowD").addEventListener("click", () =>
      App.pages.contacts.openShowingModal({ contactId: d.contactId, propertyId: d.propertyId, dealId: id }));
  }

  // ---------- COMMISSION BREAKDOWN CARD ----------

  function renderCommissionBreakdownCard(bd, cur) {
    const fmt = (x) => U().formatCurrency(x, cur);
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Commission Breakdown</div>
        </div>
        <div class="card-body">
          <div class="calc-table" role="table" aria-label="Commission calculation">
            <div class="calc-row calc-input">
              <div class="calc-label">Sale Price</div>
              <div class="calc-op"></div>
              <div class="calc-value">${fmt(bd.salePrice)}</div>
            </div>
            <div class="calc-row calc-input">
              <div class="calc-label">Commission Rate</div>
              <div class="calc-op">×</div>
              <div class="calc-value">${U().formatPercent(bd.commissionRate, bd.commissionRate % 1 === 0 ? 0 : 2)}</div>
            </div>
            <div class="calc-row calc-sum">
              <div class="calc-label">Gross GCI</div>
              <div class="calc-op">=</div>
              <div class="calc-value">${fmt(bd.gross)}</div>
            </div>

            <div class="calc-row calc-deduct">
              <div class="calc-label">Team Split (${U().formatPercent(bd.deductions.teamSplitPct)})</div>
              <div class="calc-op">−</div>
              <div class="calc-value">${fmt(bd.deductions.teamSplitAmt)}</div>
            </div>
            <div class="calc-row calc-deduct">
              <div class="calc-label">Brokerage Fee (${U().formatPercent(bd.deductions.brokerageFeePct)})</div>
              <div class="calc-op">−</div>
              <div class="calc-value">${fmt(bd.deductions.brokerageFeeAmt)}</div>
            </div>
            <div class="calc-row calc-deduct">
              <div class="calc-label">Referral Fee (${U().formatPercent(bd.deductions.referralFeePct)})</div>
              <div class="calc-op">−</div>
              <div class="calc-value">${fmt(bd.deductions.referralFeeAmt)}</div>
            </div>
            <div class="calc-row calc-deduct">
              <div class="calc-label">Tax Reserve (${U().formatPercent(bd.deductions.taxReservePct)})</div>
              <div class="calc-op">−</div>
              <div class="calc-value">${fmt(bd.deductions.taxReserveAmt)}</div>
            </div>
            <div class="calc-row calc-total">
              <div class="calc-label">Net GCI (your take-home)</div>
              <div class="calc-op">=</div>
              <div class="calc-value">${fmt(bd.net)}</div>
            </div>

            <div class="calc-row calc-weighted">
              <div class="calc-label">Weighted GCI (Gross × ${bd.probability}% probability)</div>
              <div class="calc-op"></div>
              <div class="calc-value">${fmt(bd.weighted)}</div>
            </div>
          </div>

          <p class="calc-disclaimer">These calculations are estimates based on your inputs and are not tax, legal, brokerage, or financial advice.</p>
        </div>
      </div>
    `;
  }

  // Phase 2C. Marking a milestone complete had its only control on the old
  // Daily View, which Phase 2B replaced, so S().milestones.complete() was
  // reachable from nowhere. It belongs here, beside the milestone it acts
  // on. Same confirm wording as before, including the due date, because
  // completing the wrong milestone silently shifts a deal's whole timeline.
  function wireMilestoneCompletion(container, dealId) {
    const card = container.querySelector("[data-milestones-card]");
    if (!card) return;
    card.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-complete-milestone]");
      if (!btn) return;
      const id = btn.getAttribute("data-complete-milestone");
      // Re-read at click time: the page may have been open for a while.
      let milestone;
      try { milestone = await S().milestones.get(id); }
      catch (err) { App.app.toast("Could not load milestone: " + err.message, "danger"); return; }
      if (!milestone) { App.app.toast("This milestone no longer exists.", "danger"); return; }

      const dueNote = milestone.dueDate
        ? ` It was due ${U().esc(U().formatDate(milestone.dueDate))}.` : "";
      App.app.confirmDialog({
        title: "Mark Milestone Complete?",
        message: `Mark "${U().esc(milestone.name)}" complete?${dueNote}`,
        okLabel: "Mark Complete"
      }, async () => {
        btn.disabled = true;
        try {
          await S().milestones.complete(milestone.id);
          App.app.toast("Milestone marked complete.", "success");
          await renderDealDetail(container, dealId);
        } catch (err) {
          btn.disabled = false;
          App.app.toast("Could not save: " + err.message, "danger");
        }
      });
    });
  }

  function renderMilestonesCard(milestones) {
    return `
      <div class="card" data-milestones-card>
        <div class="card-header">
          <div class="card-title">Milestones</div>
          <span class="badge badge-neutral">${milestones.filter(m => m.status === "Complete").length} of ${milestones.length}</span>
        </div>
        <div class="card-body zero">
          ${milestones.length === 0 ? `<div class="empty" style="padding:var(--empty-padding)"><p>No milestones for this deal.</p></div>`
            : milestones.map(m => {
              const ms = D().milestoneStatus(m);
              const isComplete = ms.status === "complete";
              const isOverdue = ms.status === "overdue";
              const badge = isComplete ? '<span class="badge badge-success">Complete</span>'
                          : isOverdue ? `<span class="badge badge-overdue">${ms.daysOverdue} day${ms.daysOverdue === 1 ? '' : 's'} overdue</span>`
                          : ms.status === "due-today" ? '<span class="badge badge-today">Due today</span>'
                          : ms.status === "upcoming" ? '<span class="badge badge-upcoming">Upcoming</span>'
                          : '';
              return `
                <div class="item-row">
                  <div class="icon-slot" style="background:${isComplete?'var(--success-soft)':(isOverdue?'var(--danger-soft)':'var(--accent-soft)')};color:${isComplete?'var(--success)':(isOverdue?'var(--danger)':'var(--accent)')}">
                    ${isComplete ? '✓' : m.order}
                  </div>
                  <div class="body">
                    <div class="title" style="${isComplete?'color:var(--text-muted)':''}">${U().esc(m.name)}</div>
                    <div class="sub">${m.dueDate ? "Due " + U().formatDate(m.dueDate) : "No date set"}${badge ? " · " + badge : ""}</div>
                  </div>
                  ${isComplete ? "" : `<button type="button" class="btn btn-sm" data-complete-milestone="${U().esc(m.id)}">Mark complete</button>`}
                </div>
              `;
            }).join("")}
        </div>
      </div>
    `;
  }

  function activityIcon(type) {
    const t = String(type).toLowerCase();
    if (t.includes("call")) return "📞";
    if (t.includes("text")) return "💬";
    if (t.includes("email")) return "✉️";
    if (t.includes("meet")) return "🤝";
    return "📝";
  }

  function renderRelatedActivitiesCard(activities) {
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Activity Timeline</div>
          <span class="badge badge-neutral">${activities.length}</span>
        </div>
        <div class="card-body zero">
          ${activities.length === 0 ? `<div class="empty" style="padding:var(--empty-padding)"><p>No activities logged for this deal.</p></div>`
            : activities.slice(0,10).map(a => `
              <div class="item-row">
                <div class="icon-slot">${activityIcon(a.type)}</div>
                <div class="body">
                  <div class="title">${U().esc(a.subject || a.type)}</div>
                  <div class="sub">${U().esc(a.type)}${a.notes ? " · " + U().esc(U().truncate(a.notes, 80)) : ""}</div>
                </div>
                <div class="meta-right">${a.date ? U().relativeDayLabel(a.date.slice(0,10)) : "—"}</div>
              </div>
            `).join("")}
        </div>
      </div>
    `;
  }

  function renderRelatedShowingsCard(showings, s) {
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Showings</div>
          <span class="badge badge-neutral">${showings.length}</span>
        </div>
        <div class="card-body zero">
          ${showings.length === 0 ? `<div class="empty" style="padding:var(--empty-padding)"><p>No showings for this deal.</p></div>`
            : showings.map(sh => {
              const c = sh.contactId ? s.contacts.find(x => x.id === sh.contactId) : null;
              const p = sh.propertyId ? s.properties.find(x => x.id === sh.propertyId) : null;
              return `
                <div class="item-row">
                  <div class="icon-slot">${App.app.icon("cal")}</div>
                  <div class="body">
                    <div class="title">${p ? U().esc(p.address) : "—"}</div>
                    <div class="sub">${U().formatDate(sh.date)} · ${U().esc(sh.startTime||"")} · ${c ? U().esc(c.name) : ""}</div>
                  </div>
                </div>
              `;
            }).join("")}
        </div>
      </div>
    `;
  }

  function renderRelatedTasksCard(tasks) {
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Tasks</div>
          <span class="badge badge-neutral">${tasks.filter(t => t.status !== "Completed").length} open</span>
        </div>
        <div class="card-body zero">
          ${tasks.length === 0 ? `<div class="empty" style="padding:var(--empty-padding)"><p>No tasks for this deal.</p></div>`
            : tasks.map(t => {
              const overdue = t.dueDate && t.dueDate < U().todayISO() && t.status !== "Completed";
              return `
                <div class="item-row">
                  <div class="icon-slot" style="background:${t.status==="Completed"?'var(--success-soft)':(overdue?'var(--danger-soft)':'var(--accent-soft)')};color:${t.status==="Completed"?'var(--success)':(overdue?'var(--danger)':'var(--accent)')}">
                    ${App.app.icon("check")}
                  </div>
                  <div class="body">
                    <div class="title" style="${t.status==="Completed"?'text-decoration:line-through;color:var(--text-muted);':''}">${U().esc(t.title)}</div>
                    <div class="sub">${U().esc(t.priority)} · ${U().esc(t.status)}${t.dueDate?' · Due '+U().formatDate(t.dueDate):''}${overdue?' · <span class="badge badge-overdue">Overdue</span>':''}</div>
                  </div>
                </div>
              `;
            }).join("")}
        </div>
      </div>
    `;
  }

  // ==========================================================
  // ADD / EDIT DEAL MODAL
  // ==========================================================

  async function openDealModal(id, prefill) {
    prefill = prefill || {};
    const editing = !!id;
    await S().ensureLoaded(MODAL_DEPS);
    const existing = editing ? S().getState().deals.find(x => x.id === id) : null;
    if (editing && !existing) { App.app.toast("Deal not found.", "danger"); return; }

    const s = S().getState();
    const defaults = s.settings.commissionDefaults;
    const cur = s.settings.currency;
    const defaultStage = S().settings.getDefaultStage();

    const d = existing || Object.assign({
      name: "", contactId: null, propertyId: null,
      side: "Buyer",
      stage: defaultStage ? defaultStage.name : "New",
      probability: defaultStage ? defaultStage.probability : 10,
      offerDate: null, contractDate: null, closeDate: null,
      salePrice: 0,
      commissionRate: defaults.commissionRate,
      teamSplit:      defaults.teamSplit,
      brokerageFee:   defaults.brokerageFee,
      referralFee:    defaults.referralFee,
      taxReserve:     defaults.taxReserve,
      notes: "", lostReason: ""
    }, prefill);

    const contactOptions = s.contacts.slice().sort((a,b) => (a.name||"").localeCompare(b.name||""));
    const propertyOptions = s.properties.slice().sort((a,b) => (a.address||"").localeCompare(b.address||""));
    const stageOptions = s.settings.pipelineStages.slice().sort((a,b) => a.order - b.order);
    const teamMemberOptions = s.teamMembers.filter(m => m.active !== false || m.id === d.assignedToId)
      .sort((a,b) => (a.name||"").localeCompare(b.name||""));

    const body = `
      <form id="dealForm" novalidate>
        <div class="form-grid">
          <div class="form-field full">
            <label for="dfName">Deal Name <span class="req">*</span></label>
            <input type="text" id="dfName" value="${U().esc(d.name)}" placeholder="e.g. John Smith — 123 Oak Street" required autofocus>
            <div class="err">Deal name is required.</div>
          </div>
          <div class="form-field">
            <label for="dfContact">Client (Contact) <span class="req">*</span></label>
            <select id="dfContact" required>
              <option value="">— select —</option>
              ${contactOptions.map(c => `<option value="${c.id}" ${d.contactId===c.id?'selected':''}>${U().esc(c.name)} (${U().esc(c.role)})</option>`).join("")}
            </select>
            <div class="err">Client is required.</div>
          </div>
          <div class="form-field">
            <label for="dfProperty">Property</label>
            <select id="dfProperty">
              <option value="">— none —</option>
              ${propertyOptions.map(p => `<option value="${p.id}" ${d.propertyId===p.id?'selected':''}>${U().esc(p.address)}</option>`).join("")}
            </select>
          </div>
          <div class="form-field">
            <label for="dfSide">Side</label>
            <select id="dfSide">
              ${["Buyer","Seller","Dual"].map(x => `<option value="${x}" ${d.side===x?'selected':''}>${x}</option>`).join("")}
            </select>
          </div>
          <div class="form-field">
            <label for="dfStage">Stage</label>
            <select id="dfStage">
              ${stageOptions.map(st => `<option value="${st.name}" data-prob="${st.probability}" ${d.stage===st.name?'selected':''}>${U().esc(st.name)}</option>`).join("")}
            </select>
          </div>
          <div class="form-field">
            <label for="dfProb">Probability (%)</label>
            <input type="number" id="dfProb" min="0" max="100" step="1" value="${d.probability || 0}">
            <div class="hint">Auto-fills from stage; edit to override.</div>
          </div>
          <div class="form-field">
            <label for="dfSalePrice">Sale Price (${U().currencySymbol(cur)}) <span class="req">*</span></label>
            <input type="number" id="dfSalePrice" min="0" step="1000" value="${d.salePrice || 0}" required>
            <div class="err">Sale price must be greater than zero.</div>
          </div>
          <div class="form-field">
            <label for="dfRate">Commission Rate (%) <span class="req">*</span></label>
            <input type="number" id="dfRate" min="0" max="100" step="0.01" value="${d.commissionRate || 0}" required>
            <div class="err">Commission rate must be greater than zero.</div>
          </div>
          <div class="form-field">
            <label for="dfOffer">Offer Date</label>
            <input type="date" id="dfOffer" value="${d.offerDate || ""}">
          </div>
          <div class="form-field">
            <label for="dfContract">Contract Date</label>
            <input type="date" id="dfContract" value="${d.contractDate || ""}">
          </div>
          <div class="form-field">
            <label for="dfClose">Close Date</label>
            <input type="date" id="dfClose" value="${d.closeDate || ""}">
          </div>
          <div class="form-field">
            <label for="dfTeam">Team Split (%)</label>
            <input type="number" id="dfTeam" min="0" max="100" step="0.01" value="${d.teamSplit || 0}">
          </div>
          <div class="form-field">
            <label for="dfBroker">Brokerage Fee (%)</label>
            <input type="number" id="dfBroker" min="0" max="100" step="0.01" value="${d.brokerageFee || 0}">
          </div>
          <div class="form-field">
            <label for="dfReferral">Referral Fee (%)</label>
            <input type="number" id="dfReferral" min="0" max="100" step="0.01" value="${d.referralFee || 0}">
          </div>
          <div class="form-field">
            <label for="dfTax">Tax Reserve (%)</label>
            <input type="number" id="dfTax" min="0" max="100" step="0.01" value="${d.taxReserve || 0}">
          </div>
          <div class="form-field full">
            <div class="calc-preview" id="calcPreview" aria-live="polite"></div>
          </div>
          <div class="form-field">
            <label for="dfAssignedTo">Assigned To</label>
            <select id="dfAssignedTo">
              <option value="">— unassigned —</option>
              ${teamMemberOptions.map(m => `<option value="${U().esc(m.id)}" ${d.assignedToId===m.id?'selected':''}>${U().esc(m.name)}${m.active===false?' (inactive)':''}</option>`).join("")}
            </select>
          </div>
          <div class="form-field full">
            <label for="dfNotes">Notes</label>
            <textarea id="dfNotes" rows="3">${U().esc(d.notes)}</textarea>
          </div>
        </div>
        ${App.customFieldsUI.renderSection("deal", editing ? id : null)}
      </form>
    `;

    const handle = App.app.openModal({
      title: editing ? "Edit Deal" : "Add Deal",
      wide: true,
      body,
      footer: `
        <button class="btn" data-role="cancel">Cancel</button>
        <button class="btn btn-primary" data-role="save">${editing ? "Save Changes" : "Add Deal"}</button>
      `,
      onOpen: (modal) => {
        modal.querySelector('[data-role="cancel"]').addEventListener("click", () => handle.close());
        modal.querySelector('[data-role="save"]').addEventListener("click", () => submitDealForm(editing, id, handle));

        // Auto-update probability when stage changes (unless user has customized it)
        const stageSel = modal.querySelector("#dfStage");
        const probInput = modal.querySelector("#dfProb");
        stageSel.addEventListener("change", (e) => {
          const opt = e.target.selectedOptions[0];
          if (opt && opt.dataset.prob != null) {
            probInput.value = opt.dataset.prob;
            updateCalcPreview(modal, cur);
          }
        });

        // Live commission preview
        ["dfSalePrice","dfRate","dfTeam","dfBroker","dfReferral","dfTax","dfProb"].forEach(fid => {
          modal.querySelector("#" + fid).addEventListener("input", () => updateCalcPreview(modal, cur));
        });
        updateCalcPreview(modal, cur);
      }
    });
  }

  function updateCalcPreview(modal, cur) {
    const preview = {
      salePrice:      U().num(modal.querySelector("#dfSalePrice").value),
      commissionRate: U().num(modal.querySelector("#dfRate").value),
      teamSplit:      U().num(modal.querySelector("#dfTeam").value),
      brokerageFee:   U().num(modal.querySelector("#dfBroker").value),
      referralFee:    U().num(modal.querySelector("#dfReferral").value),
      taxReserve:     U().num(modal.querySelector("#dfTax").value),
      probability:    U().num(modal.querySelector("#dfProb").value)
    };
    const gross = C().grossGCI(preview);
    const net = C().netGCI(preview);
    const weighted = C().weightedGCI(preview);
    const target = modal.querySelector("#calcPreview");
    target.innerHTML = `
      <div class="calc-preview-inner">
        <div><span class="k">Gross GCI</span><span class="v">${U().formatCurrency(gross, cur)}</span></div>
        <div><span class="k">Net GCI</span><span class="v">${U().formatCurrency(net, cur)}</span></div>
        <div><span class="k">Weighted</span><span class="v">${U().formatCurrency(weighted, cur)}</span></div>
      </div>
    `;
  }

  async function submitDealForm(editing, id, handle) {
    const $ = (sel) => document.querySelector(sel);
    const nameField = $("#dfName").closest(".form-field");
    const contactField = $("#dfContact").closest(".form-field");
    const priceField = $("#dfSalePrice").closest(".form-field");
    const rateField = $("#dfRate").closest(".form-field");
    [nameField, contactField, priceField, rateField].forEach(f => f.classList.remove("has-error"));

    const name = $("#dfName").value.trim();
    const contactId = $("#dfContact").value;
    const salePrice = U().num($("#dfSalePrice").value);
    const rate = U().num($("#dfRate").value);

    let valid = true;
    if (!name)      { nameField.classList.add("has-error"); valid = false; }
    if (!contactId) { contactField.classList.add("has-error"); valid = false; }
    if (salePrice <= 0) { priceField.classList.add("has-error"); valid = false; }
    if (rate <= 0)      { rateField.classList.add("has-error"); valid = false; }
    const missingCustom = App.customFieldsUI.findMissingRequired(document, "deal");
    if (missingCustom.length) {
      App.app.toast(`${missingCustom.join(", ")} ${missingCustom.length === 1 ? "is" : "are"} required.`, "danger");
      valid = false;
    }
    if (!valid) return;

    const patch = {
      name,
      contactId,
      propertyId: $("#dfProperty").value || null,
      assignedToId: $("#dfAssignedTo").value || null,
      side: $("#dfSide").value,
      stage: $("#dfStage").value,
      probability: App.util.clamp(U().num($("#dfProb").value), 0, 100),
      offerDate: $("#dfOffer").value || null,
      contractDate: $("#dfContract").value || null,
      closeDate: $("#dfClose").value || null,
      salePrice,
      commissionRate: rate,
      teamSplit:    U().num($("#dfTeam").value),
      brokerageFee: U().num($("#dfBroker").value),
      referralFee:  U().num($("#dfReferral").value),
      taxReserve:   U().num($("#dfTax").value),
      notes: $("#dfNotes").value
    };
    const customValues = App.customFieldsUI.collectValues(document, "deal");

    const saveBtn = document.querySelector('#dealForm')?.closest(".modal")?.querySelector('[data-role="save"]');
    if (saveBtn) saveBtn.disabled = true;

    let savedId = id;
    try {
      if (editing) {
        await S().deals.update(id, patch);
        App.app.toast("Deal updated.", "success");
      } else {
        const d = await S().deals.create(patch);
        savedId = d.id;
        // Link property back to deal
        if (patch.propertyId) {
          const p = S().getState().properties.find(x => x.id === patch.propertyId);
          if (p && !p.dealId) await S().properties.update(p.id, { dealId: d.id });
        }
        App.app.toast(`Added deal "${d.name}".`, "success");
      }
      await S().customFields.setValues("deal", savedId, customValues);
      handle.close();
      App.app.route();
    } catch (err) {
      App.app.toast("Could not save deal: " + err.message, "danger");
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async function openDeleteDealConfirm(id) {
    await S().ensureLoaded(["deals"]);
    const deal = S().getState().deals.find(x => x.id === id);
    if (!deal) { App.app.toast("Deal not found.", "danger"); return; }
    let preview;
    try {
      preview = await S().deals.delete(id); // { needsConfirmation, impact }
    } catch (err) {
      App.app.toast("Could not check related records: " + err.message, "danger");
      return;
    }
    App.app.confirmDialog({
      title: "Delete Deal?",
      message: `This will permanently remove <strong>${U().esc(deal.name)}</strong>.`,
      impact: preview.impact,
      okLabel: "Delete Deal",
      danger: true
    }, async () => {
      try {
        const r = await S().deals.delete(id, { force: true });
        if (r.deleted) {
          App.app.toast("Deal deleted.", "success");
          App.app.navigate("/pipeline");
        } else {
          App.app.toast("Delete failed.", "danger");
        }
      } catch (err) {
        App.app.toast("Delete failed: " + err.message, "danger");
      }
    });
  }

  return {
    renderPipeline,
    renderDealDetail,
    openDealModal,
    openDeleteDealConfirm
  };
})();

