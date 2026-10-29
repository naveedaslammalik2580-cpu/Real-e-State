/* ============================================================
   buyer.js — Buyer Workspace: aggregates all buyer-side records.
   Read-only view over existing store data.
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.buyer = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;
  const D = () => App.derived;

  const DEPS = ["contacts", "deals", "properties", "showings", "tasks"];

  async function render(container) {
    App.app.setBreadcrumbs([{ label: "Buyer Workspace" }]);
    App.app.setTopActions("");
    container.innerHTML = App.app.loadingHtml();
    await S().ensureLoaded(DEPS);

    const s = S().getState();
    const cur = s.settings.currency;

    // Buyer contacts (Buyer + Investor)
    const buyers = s.contacts.filter(c => c.role === "Buyer" || c.role === "Investor");
    const activeBuyers = buyers.filter(c => !["Past Client","Lost"].includes(c.stage));
    const hotBuyers = activeBuyers.filter(c => c.temperature === "Hot");

    // Buyer-side deals
    const buyerDeals = s.deals.filter(d => d.side === "Buyer");
    const activeBuyerDeals = buyerDeals.filter(d => !D().isTerminalStage(s, d.stage));

    // Buyer contact IDs, used to filter properties/showings
    const buyerContactIds = new Set(buyers.map(c => c.id));
    const buyerProperties = s.properties.filter(p =>
      buyerContactIds.has(p.contactId) && p.status !== "Sold"
    );

    // Upcoming showings (all buyers over next 14 days)
    const today = U().todayISO();
    const in14 = U().addDaysISO(today, 14);
    const upcomingShowings = s.showings.filter(sh =>
      sh.date && sh.date >= today && sh.date <= in14 &&
      sh.status === "Scheduled" &&
      buyerContactIds.has(sh.contactId)
    ).sort((a,b) => a.date.localeCompare(b.date));

    // Follow-ups for buyers
    const followUps = activeBuyers.filter(c =>
      c.nextFollowUp && c.nextFollowUp <= U().addDaysISO(today, 7)
    ).sort((a,b) => a.nextFollowUp.localeCompare(b.nextFollowUp));

    // Buyer tasks (contact-linked to a buyer or deal-linked to a buyer deal)
    const buyerDealIds = new Set(buyerDeals.map(d => d.id));
    const buyerTasks = s.tasks.filter(t =>
      (t.contactId && buyerContactIds.has(t.contactId)) ||
      (t.dealId && buyerDealIds.has(t.dealId))
    ).filter(t => t.status !== "Completed");

    // Metrics
    const totalBuyerPipeline = activeBuyerDeals.reduce((total, d) => total + U().num(d.salePrice), 0);
    const expectedNet = activeBuyerDeals.reduce((total, d) => total + App.commission.netGCI(d), 0);

    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Buyer Workspace</div>
          <div class="page-desc">Every buyer, every active buyer-side deal, and everything on your plate for buyers this week — in one view.</div>
        </div>
        <div class="page-actions">
          <button class="btn" id="bwAddContact">${App.app.icon("plus")} Add Buyer</button>
          <button class="btn" id="bwAddProperty">${App.app.icon("plus")} Add Property</button>
          <button class="btn btn-primary" id="bwAddShowing">${App.app.icon("plus")} Schedule Showing</button>
        </div>
      </div>

      <div class="stat-row">
        <div class="stat-card">
          <div class="k">Active Buyers</div>
          <div class="v">${activeBuyers.length}</div>
          <div class="sub">${hotBuyers.length} hot · ${buyers.length} total</div>
        </div>
        <div class="stat-card">
          <div class="k">Active Buyer Deals</div>
          <div class="v">${activeBuyerDeals.length}</div>
          <div class="sub">of ${buyerDeals.length} total</div>
        </div>
        <div class="stat-card">
          <div class="k">Buyer Pipeline Value</div>
          <div class="v">${U().formatCompact(totalBuyerPipeline, cur)}</div>
          <div class="sub">${U().formatCurrency(totalBuyerPipeline, cur)}</div>
        </div>
        <div class="stat-card">
          <div class="k">Expected Net (Buyers)</div>
          <div class="v">${U().formatCompact(expectedNet, cur)}</div>
          <div class="sub">across active buyer deals</div>
        </div>
      </div>

      <div class="detail-grid">
        <div class="col">
          ${renderActiveBuyersCard(activeBuyers, cur)}
          ${renderBuyerDealsCard(activeBuyerDeals, cur, s)}
          ${renderBuyerPropertiesCard(buyerProperties, cur, s)}
        </div>
        <div class="col">
          ${renderUpcomingShowingsCard(upcomingShowings, s)}
          ${renderFollowUpsCard(followUps, today)}
          ${renderTasksCard(buyerTasks, today)}
        </div>
      </div>
    `;

    document.getElementById("bwAddContact").addEventListener("click", () =>
      App.pages.contacts.openContactModal(null));
    document.getElementById("bwAddProperty").addEventListener("click", () =>
      App.pages.properties.openPropertyModal(null));
    document.getElementById("bwAddShowing").addEventListener("click", () =>
      App.pages.contacts.openShowingModal({}));
  }

  function renderActiveBuyersCard(buyers, cur) {
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Active Buyers</div>
          <span class="badge badge-neutral">${buyers.length}</span>
        </div>
        <div class="card-body zero">
          ${buyers.length === 0 ? `<div class="empty" style="padding:var(--empty-padding)"><p>No active buyers. Add one to get started.</p></div>`
            : buyers.slice(0, 10).map(c => `
              <div class="item-row clickable" onclick="location.hash='#/contacts/${c.id}'">
                <div class="icon-slot">${(c.name||"?").split(" ").map(w => w[0]).slice(0,2).join("").toUpperCase()}</div>
                <div class="body">
                  <div class="title">${U().esc(c.name)}</div>
                  <div class="sub">${U().esc(c.stage)} · ${U().esc(c.temperature)}${c.preferredArea ? " · " + U().esc(c.preferredArea) : ""}</div>
                </div>
                <div class="meta-right">
                  ${c.budget ? `<div style="font-weight:600;color:var(--text)">${U().formatCompact(c.budget, cur)}</div><div style="font-size: var(--font-size-xs)">budget</div>` : ""}
                </div>
              </div>
            `).join("")}
        </div>
      </div>
    `;
  }

  function renderBuyerDealsCard(deals, cur, s) {
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Active Buyer Deals</div>
          <span class="badge badge-neutral">${deals.length}</span>
        </div>
        <div class="card-body zero">
          ${deals.length === 0 ? `<div class="empty" style="padding:var(--empty-padding)"><p>No active buyer deals right now.</p></div>`
            : deals.map(d => {
              const p = d.propertyId ? s.properties.find(x => x.id === d.propertyId) : null;
              const net = App.commission.netGCI(d);
              return `
                <div class="item-row clickable" onclick="location.hash='#/contacts/${d.contactId}'">
                  <div class="icon-slot">${App.app.icon("dollar")}</div>
                  <div class="body">
                    <div class="title">${U().esc(d.name)}</div>
                    <div class="sub">${U().esc(d.stage)}${p ? " · " + U().esc(p.address) : ""}${d.closeDate ? " · Close " + U().formatDate(d.closeDate) : ""}</div>
                  </div>
                  <div class="meta-right">
                    <div style="font-weight:600;color:var(--text)">${U().formatCurrency(d.salePrice, cur)}</div>
                    <div style="font-size: var(--font-size-xs)">Net ${U().formatCurrency(net, cur)}</div>
                  </div>
                </div>
              `;
            }).join("")}
        </div>
      </div>
    `;
  }

  function renderBuyerPropertiesCard(properties, cur, s) {
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Buyer Interest Properties</div>
          <span class="badge badge-neutral">${properties.length}</span>
        </div>
        <div class="card-body zero">
          ${properties.length === 0 ? `<div class="empty" style="padding:var(--empty-padding)"><p>No buyer-interest properties tracked.</p></div>`
            : properties.slice(0, 10).map(p => {
              const c = p.contactId ? s.contacts.find(x => x.id === p.contactId) : null;
              return `
                <div class="item-row clickable" onclick="location.hash='#/properties/${p.id}'">
                  <div class="icon-slot">${App.app.icon("home")}</div>
                  <div class="body">
                    <div class="title">${U().esc(p.address)}</div>
                    <div class="sub">${U().esc(p.status)}${c ? " · for " + U().esc(c.name) : ""}${p.beds ? " · " + p.beds + "bd/" + (p.baths||0) + "ba" : ""}</div>
                  </div>
                  <div class="meta-right">
                    <div style="font-weight:600;color:var(--text)">${p.listPrice ? U().formatCurrency(p.listPrice, cur) : "—"}</div>
                  </div>
                </div>
              `;
            }).join("")}
        </div>
      </div>
    `;
  }

  function renderUpcomingShowingsCard(showings, s) {
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Upcoming Showings (14 days)</div>
          <span class="badge badge-neutral">${showings.length}</span>
        </div>
        <div class="card-body zero">
          ${showings.length === 0 ? `<div class="empty" style="padding:var(--empty-padding)"><p>No upcoming showings.</p></div>`
            : showings.map(sh => {
              const c = sh.contactId ? s.contacts.find(x => x.id === sh.contactId) : null;
              const p = sh.propertyId ? s.properties.find(x => x.id === sh.propertyId) : null;
              return `
                <div class="item-row">
                  <div class="icon-slot">${App.app.icon("cal")}</div>
                  <div class="body">
                    <div class="title">${p ? U().esc(p.address) : "—"}</div>
                    <div class="sub">${c ? U().esc(c.name) : ""} · ${U().esc(sh.startTime || "")}</div>
                  </div>
                  <div class="meta-right">${U().relativeDayLabel(sh.date)}</div>
                </div>
              `;
            }).join("")}
        </div>
      </div>
    `;
  }

  function renderFollowUpsCard(contacts, today) {
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Follow-ups (next 7 days)</div>
          <span class="badge badge-neutral">${contacts.length}</span>
        </div>
        <div class="card-body zero">
          ${contacts.length === 0 ? `<div class="empty" style="padding:var(--empty-padding)"><p>Nothing due this week.</p></div>`
            : contacts.map(c => {
              const overdue = c.nextFollowUp < today;
              return `
                <div class="item-row clickable" onclick="location.hash='#/contacts/${c.id}'">
                  <div class="icon-slot" style="background:${overdue?'var(--danger-soft)':'var(--warning-soft)'};color:${overdue?'var(--danger)':'var(--warning)'}">${App.app.icon("users")}</div>
                  <div class="body">
                    <div class="title">${U().esc(c.name)}</div>
                    <div class="sub">${U().esc(c.stage)}</div>
                  </div>
                  <div class="meta-right">
                    ${overdue ? '<span class="badge badge-overdue">Overdue</span>' : U().relativeDayLabel(c.nextFollowUp)}
                  </div>
                </div>
              `;
            }).join("")}
        </div>
      </div>
    `;
  }

  function renderTasksCard(tasks, today) {
    const sorted = tasks.slice().sort((a,b) => (a.dueDate||"9999").localeCompare(b.dueDate||"9999"));
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Open Buyer Tasks</div>
          <span class="badge badge-neutral">${tasks.length}</span>
        </div>
        <div class="card-body zero">
          ${tasks.length === 0 ? `<div class="empty" style="padding:var(--empty-padding)"><p>You're clear.</p></div>`
            : sorted.slice(0, 10).map(t => {
              const overdue = t.dueDate && t.dueDate < today;
              return `
                <div class="item-row">
                  <div class="icon-slot" style="background:${overdue?'var(--danger-soft)':'var(--accent-soft)'};color:${overdue?'var(--danger)':'var(--accent)'}">${App.app.icon("check")}</div>
                  <div class="body">
                    <div class="title">${U().esc(t.title)}</div>
                    <div class="sub">${U().esc(t.priority)} · ${U().esc(t.status)}</div>
                  </div>
                  <div class="meta-right">${t.dueDate ? U().relativeDayLabel(t.dueDate) : "—"}</div>
                </div>
              `;
            }).join("")}
        </div>
      </div>
    `;
  }

  return { render };
})();

