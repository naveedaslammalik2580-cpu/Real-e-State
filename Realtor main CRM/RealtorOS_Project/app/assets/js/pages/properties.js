/* ============================================================
   properties.js — Properties list, detail, and modal.
   Depends on: app.js, store.js, derived.js, util.js
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.properties = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;
  const D = () => App.derived;

  let listFilters = { search: "", status: "", side: "", sort: "listing-desc" };

  const DETAIL_DEPS = ["properties", "contacts", "deals", "activities", "showings", "tasks"];

  function statusBadge(status) {
    const map = {
      "Coming Soon":    "badge-info",
      "Active":         "badge-success",
      "Under Contract": "badge-warning",
      "Sold":           "badge-neutral",
      "Off Market":     "badge-neutral"
    };
    return `<span class="badge ${map[status] || "badge-neutral"}">${U().esc(status)}</span>`;
  }
  function renderSafeUrl(raw) {
    const value = String(raw || "").trim();
    if (!value) return '<span style="color:var(--text-soft)">—</span>';
    if (!/^https?:\/\//i.test(value)) {
      return `<span title="Only http:// and https:// links are clickable">${U().esc(U().truncate(value, 40))}</span>`;
    }
    return `<a href="${U().esc(value)}" target="_blank" rel="noopener noreferrer" class="link">${U().esc(U().truncate(value, 40))}</a>`;
  }

  // ---------- LIST ----------

  async function renderList(container) {
    App.app.setBreadcrumbs([{ label: "Properties" }]);
    App.app.setTopActions("");
    container.innerHTML = App.app.loadingHtml();
    await S().ensureLoaded(["properties", "contacts"]);

    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Properties</div>
          <div class="page-desc">Every property tied to your business — active listings, buyer interests, coming-soon, under contract, and sold homes.</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" id="addPropertyBtn">${App.app.icon("plus")} Add Property</button>
        </div>
      </div>

      <div class="filter-bar">
        <div class="search-wrap">
          ${App.app.icon("search")}
          <input type="search" id="pSearch" placeholder="Search address or MLS…" value="${U().esc(listFilters.search)}">
        </div>
        <select id="pStatus" aria-label="Filter by status">
          <option value="">All statuses</option>
          ${["Coming Soon","Active","Under Contract","Sold","Off Market"].map(s =>
            `<option value="${s}" ${listFilters.status===s?"selected":""}>${s}</option>`).join("")}
        </select>
        <select id="pSort" aria-label="Sort by">
          <option value="listing-desc" ${listFilters.sort==="listing-desc"?"selected":""}>Newest Listing</option>
          <option value="listing-asc" ${listFilters.sort==="listing-asc"?"selected":""}>Oldest Listing</option>
          <option value="price-desc" ${listFilters.sort==="price-desc"?"selected":""}>Highest Price</option>
          <option value="price-asc" ${listFilters.sort==="price-asc"?"selected":""}>Lowest Price</option>
          <option value="address-asc" ${listFilters.sort==="address-asc"?"selected":""}>Address (A–Z)</option>
        </select>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title" id="pCountLabel">Loading…</div>
        </div>
        <div class="card-body zero" id="pTableWrap"></div>
      </div>
    `;

    const rerender = () => renderTable();
    document.getElementById("pSearch").addEventListener("input", (e) => { listFilters.search = e.target.value; rerender(); });
    document.getElementById("pStatus").addEventListener("change", (e) => { listFilters.status = e.target.value; rerender(); });
    document.getElementById("pSort").addEventListener("change", (e) => { listFilters.sort = e.target.value; rerender(); });
    document.getElementById("addPropertyBtn").addEventListener("click", () => openPropertyModal(null));

    renderTable();
  }

  function applyFilters(list) {
    let out = list.slice();
    const f = listFilters;
    if (f.search) {
      const q = f.search.toLowerCase();
      out = out.filter(p =>
        (p.address || "").toLowerCase().includes(q) ||
        (p.mls || "").toLowerCase().includes(q)
      );
    }
    if (f.status) out = out.filter(p => p.status === f.status);
    switch (f.sort) {
      case "listing-asc":  out.sort((a,b) => (a.listingDate||"9999").localeCompare(b.listingDate||"9999")); break;
      case "price-desc":   out.sort((a,b) => U().num(b.listPrice) - U().num(a.listPrice)); break;
      case "price-asc":    out.sort((a,b) => U().num(a.listPrice) - U().num(b.listPrice)); break;
      case "address-asc":  out.sort((a,b) => (a.address||"").localeCompare(b.address||"")); break;
      default:             out.sort((a,b) => (b.listingDate||"").localeCompare(a.listingDate||""));
    }
    return out;
  }

  function renderTable() {
    const state = S().getState();
    const all = state.properties;
    const filtered = applyFilters(all);
    const cur = state.settings.currency;
    document.getElementById("pCountLabel").textContent =
      `${filtered.length} of ${all.length} propert${all.length === 1 ? "y" : "ies"}`;

    const wrap = document.getElementById("pTableWrap");
    if (!filtered.length) {
      if (all.length === 0) {
        wrap.innerHTML = `
          <div class="empty">
            <div class="empty-icon">${App.app.icon("home")}</div>
            <h3>No properties yet</h3>
            <p>Add your first property — listings, buyer targets, coming-soon inventory. Properties link back to contacts and deals automatically.</p>
            <button class="btn btn-primary" onclick="App.pages.properties.openPropertyModal(null)">Add Your First Property</button>
          </div>`;
      } else {
        wrap.innerHTML = `<div class="empty"><h3>No matches</h3><p>Try adjusting your filters.</p></div>`;
      }
      return;
    }

    wrap.innerHTML = `
      <div class="table-wrap">
        <table class="tbl tbl-responsive">
          <thead>
            <tr>
              <th>Address</th>
              <th>Status</th>
              <th class="num">List Price</th>
              <th>Beds/Baths</th>
              <th class="num">Sq Ft</th>
              <th>Client</th>
              <th>Days on Market</th>
              <th class="actions">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(p => {
              const contact = p.contactId ? state.contacts.find(c => c.id === p.contactId) : null;
              const dom = D().daysOnMarket(p);
              return `
                <tr class="clickable" data-id="${p.id}">
                  <td data-label="Address" class="primary-cell">
                    <a href="#/properties/${p.id}" class="link">${U().esc(p.address)}</a>
                    ${p.mls ? `<span style="color:var(--text-soft);font-size: var(--font-size-xs);font-weight:500;margin-left:6px;">${U().esc(p.mls)}</span>` : ""}
                  </td>
                  <td data-label="Status">${statusBadge(p.status)}</td>
                  <td class="num" data-label="List Price">${p.listPrice ? U().formatCurrency(p.listPrice, cur) : "—"}</td>
                  <td data-label="Beds/Baths">${p.beds || 0} / ${p.baths || 0}</td>
                  <td class="num" data-label="Sq Ft">${p.sqft ? p.sqft.toLocaleString() : "—"}</td>
                  <td data-label="Client">${contact ? `<a href="#/contacts/${contact.id}" class="link">${U().esc(contact.name)}</a>` : '<span style="color:var(--text-soft)">—</span>'}</td>
                  <td data-label="Days on Market">${dom != null ? dom + "d" : "—"}</td>
                  <td class="actions" data-label="">
                    <button class="btn btn-sm btn-ghost" data-edit="${p.id}" aria-label="Edit">${App.app.icon("edit")}</button>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;

    wrap.querySelectorAll("tr.clickable").forEach(tr => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest("button, a")) return;
        App.app.navigate("/properties/" + tr.getAttribute("data-id"));
      });
    });
    wrap.querySelectorAll("[data-edit]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openPropertyModal(btn.getAttribute("data-edit"));
      });
    });
  }

  // ---------- DETAIL ----------

  async function renderDetail(container, id) {
    container.innerHTML = App.app.loadingHtml();
    await S().ensureLoaded(DETAIL_DEPS);
    const state = S().getState();
    const p = state.properties.find(x => x.id === id);
    if (!p) {
      App.app.setBreadcrumbs([{ label: "Properties", route: "/properties" }, { label: "Not Found" }]);
      container.innerHTML = `<div class="empty"><h3>Property not found</h3><a href="#/properties" class="btn btn-primary">Back to Properties</a></div>`;
      return;
    }

    App.app.setBreadcrumbs([
      { label: "Properties", route: "/properties" },
      { label: p.address || "(no address)" }
    ]);
    App.app.setTopActions(`
      <button class="btn" id="editProp">${App.app.icon("edit")} Edit</button>
      <button class="btn btn-danger" id="delProp">${App.app.icon("trash")} Delete</button>
    `);

    const contact = p.contactId ? state.contacts.find(c => c.id === p.contactId) : null;
    const deal = p.dealId ? state.deals.find(d => d.id === p.dealId) : null;
    const activities = state.activities.filter(a => a.propertyId === id)
                        .sort((a,b) => (b.date||"").localeCompare(a.date||""));
    const showings = state.showings.filter(s => s.propertyId === id)
                        .sort((a,b) => (b.date||"").localeCompare(a.date||""));
    const tasks = state.tasks.filter(t => t.propertyId === id);
    const dom = D().daysOnMarket(p);
    const cur = state.settings.currency;

    container.innerHTML = `
      ${App.app.backLink("/properties", "Properties")}
      <div class="detail-grid">
        <div class="col">
          <div class="card">
            <div class="profile-hero">
              <div class="name">${U().esc(p.address)}</div>
              <div class="subline">
                ${statusBadge(p.status)}
                ${p.mls ? ` <span>·</span> <span>MLS ${U().esc(p.mls)}</span>` : ""}
                ${dom != null ? ` <span>·</span> <span>${dom} day${dom === 1 ? "" : "s"} on market</span>` : ""}
              </div>
            </div>
            <div class="card-body">
              <div class="stat-row" style="margin:0">
                <div class="stat-card"><div class="k">List Price</div><div class="v">${p.listPrice ? U().formatCurrency(p.listPrice, cur) : "—"}</div></div>
                <div class="stat-card"><div class="k">Offer Price</div><div class="v">${p.offerPrice ? U().formatCurrency(p.offerPrice, cur) : "—"}</div></div>
                <div class="stat-card"><div class="k">Beds / Baths</div><div class="v">${p.beds || 0} / ${p.baths || 0}</div></div>
                <div class="stat-card"><div class="k">Sq Ft</div><div class="v">${p.sqft ? p.sqft.toLocaleString() : "—"}</div></div>
              </div>
              <div class="meta" style="margin-top:20px">
                <div><div class="k">Listing Date</div><div class="v">${p.listingDate ? U().formatDate(p.listingDate) : '<span style="color:var(--text-soft)">—</span>'}</div></div>
                <div><div class="k">Target Close</div><div class="v">${p.targetClose ? U().formatDate(p.targetClose) : '<span style="color:var(--text-soft)">—</span>'}</div></div>
                <div><div class="k">URL</div><div class="v">${renderSafeUrl(p.url)}</div></div>
                <div><div class="k">Client</div><div class="v">${contact ? `<a href="#/contacts/${contact.id}" class="link">${U().esc(contact.name)}</a>` : '<span style="color:var(--text-soft)">—</span>'}</div></div>
              </div>
              ${p.notes ? `
                <div style="margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--border);">
                  <div class="k" style="font-size: var(--font-size-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:6px;">Notes</div>
                  <div style="white-space:pre-wrap;">${U().esc(p.notes)}</div>
                </div>` : ""}
            </div>
          </div>

          ${deal ? `
            <div class="card">
              <div class="card-header"><div class="card-title">Deal</div></div>
              <div class="card-body zero">
                <div class="item-row clickable" onclick="location.hash='#/contacts/${deal.contactId}'">
                  <div class="icon-slot">${App.app.icon("dollar")}</div>
                  <div class="body">
                    <div class="title">${U().esc(deal.name)}</div>
                    <div class="sub">${U().esc(deal.stage)} · ${U().esc(deal.side)} side ${deal.closeDate ? " · Close " + U().formatDate(deal.closeDate) : ""}</div>
                  </div>
                  <div class="meta-right">
                    <div style="font-weight:600;color:var(--text)">${deal.salePrice ? U().formatCurrency(deal.salePrice, cur) : "—"}</div>
                    <div style="font-size: var(--font-size-xs);">Net ${U().formatCurrency(App.commission.netGCI(deal), cur)}</div>
                  </div>
                </div>
              </div>
            </div>
          ` : ""}

          <div class="card">
            <div class="card-header"><div class="card-title">Showings</div><span class="badge badge-neutral">${showings.length}</span></div>
            <div class="card-body zero">
              ${showings.length === 0 ? `<div class="empty" style="padding:var(--empty-padding)"><p>No showings scheduled for this property.</p></div>`
                : showings.map(s => {
                    const c = s.contactId ? state.contacts.find(x => x.id === s.contactId) : null;
                    return `
                      <div class="item-row">
                        <div class="icon-slot">${App.app.icon("cal")}</div>
                        <div class="body">
                          <div class="title">${c ? U().esc(c.name) : "—"}</div>
                          <div class="sub">${U().formatDate(s.date)} · ${U().esc(s.startTime||"")} · ${U().esc(s.status)}</div>
                        </div>
                      </div>
                    `;
                  }).join("")}
            </div>
          </div>

          <div class="card">
            <div class="card-header"><div class="card-title">Activity</div><span class="badge badge-neutral">${activities.length}</span></div>
            <div class="card-body zero">
              ${activities.length === 0 ? `<div class="empty" style="padding:var(--empty-padding)"><p>No activity logged for this property.</p></div>`
                : activities.slice(0,10).map(a => `
                    <div class="item-row">
                      <div class="icon-slot">${App.app.icon("activity")}</div>
                      <div class="body">
                        <div class="title">${U().esc(a.subject || a.type)}</div>
                        <div class="sub">${U().esc(a.type)}${a.notes ? " · " + U().esc(U().truncate(a.notes,80)) : ""}</div>
                      </div>
                      <div class="meta-right">${a.date ? U().relativeDayLabel(a.date.slice(0,10)) : "—"}</div>
                    </div>
                  `).join("")}
            </div>
          </div>

        </div>

        <div class="col">
          <div class="card">
            <div class="card-header"><div class="card-title">Quick Actions</div></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:8px;">
              <button class="btn btn-primary btn-block" id="qAddDealP">${App.app.icon("plus")} Create Deal</button>
              <button class="btn btn-block" id="qAddShow">${App.app.icon("plus")} Schedule Showing</button>
              <button class="btn btn-block" id="qAddAct">${App.app.icon("plus")} Log Activity</button>
              <button class="btn btn-block" id="qAddTask">${App.app.icon("plus")} Add Task</button>
            </div>
          </div>
          <!-- Tasks moved into the aside: this column held Quick Actions alone
               against five sections opposite, which left most of it blank. -->
          <div class="card">
            <div class="card-header"><div class="card-title">Tasks</div><span class="badge badge-neutral">${tasks.length}</span></div>
            <div class="card-body zero">
              ${tasks.length === 0 ? `<div class="empty" style="padding:var(--empty-padding)"><p>No tasks linked to this property.</p></div>`
                : tasks.map(t => `
                    <div class="item-row">
                      <div class="icon-slot" style="background:${t.status==="Completed"?"var(--success-soft)":"var(--accent-soft)"};color:${t.status==="Completed"?"var(--success)":"var(--accent)"};">
                        ${App.app.icon("check")}
                      </div>
                      <div class="body">
                        <div class="title" style="${t.status==="Completed"?"text-decoration:line-through;color:var(--text-muted);":""}">${U().esc(t.title)}</div>
                        <div class="sub">${U().esc(t.priority)} · ${U().esc(t.status)}${t.dueDate?" · Due "+U().formatDate(t.dueDate):""}</div>
                      </div>
                    </div>
                  `).join("")}
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById("editProp").addEventListener("click", () => openPropertyModal(id));
    document.getElementById("delProp").addEventListener("click", () => openDeletePropertyConfirm(id));
    document.getElementById("qAddDealP").addEventListener("click", () => {
      const dealName = (contact ? contact.name + " — " : "") + p.address;
      App.pages.deals.openDealModal(null, {
        contactId: p.contactId,
        propertyId: id,
        salePrice: p.listPrice || 0,
        name: dealName
      });
    });
    document.getElementById("qAddShow").addEventListener("click", () =>
      App.pages.contacts.openShowingModal({ propertyId: id, contactId: p.contactId }));
    document.getElementById("qAddAct").addEventListener("click", () =>
      App.pages.contacts.openActivityModal({ contactId: p.contactId }));
    document.getElementById("qAddTask").addEventListener("click", () =>
      App.pages.contacts.openTaskModal({ contactId: p.contactId, propertyId: id }));
  }

  // ---------- PROPERTY MODAL ----------

  async function openPropertyModal(id, prefill) {
    prefill = prefill || {};
    const editing = !!id;
    await S().ensureLoaded(["properties", "contacts"]);
    const existing = editing ? S().getState().properties.find(x => x.id === id) : null;
    if (editing && !existing) { App.app.toast("Property not found.", "danger"); return; }

    const p = existing || Object.assign({
      address: "", mls: "", url: "", status: "Active",
      listPrice: 0, offerPrice: 0, beds: 0, baths: 0, sqft: 0,
      listingDate: null, targetClose: null,
      contactId: null, dealId: null, notes: ""
    }, prefill);

    const cur = S().getState().settings.currency;
    const contactOptions = S().getState().contacts.slice().sort((a,b) => a.name.localeCompare(b.name));

    const body = `
      <form id="propForm" novalidate>
        <div class="form-grid">
          <div class="form-field full">
            <label for="pfAddress">Address <span class="req">*</span></label>
            <input type="text" id="pfAddress" value="${U().esc(p.address)}" required autofocus>
            <div class="err">Address is required.</div>
          </div>
          <div class="form-field">
            <label for="pfMls">MLS</label>
            <input type="text" id="pfMls" value="${U().esc(p.mls)}">
          </div>
          <div class="form-field">
            <label for="pfStatus">Status</label>
            <select id="pfStatus">
              ${["Coming Soon","Active","Under Contract","Sold","Off Market"].map(s =>
                `<option value="${s}" ${p.status===s?"selected":""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="form-field">
            <label for="pfListPrice">List Price (${U().currencySymbol(cur)})</label>
            <input type="number" id="pfListPrice" value="${p.listPrice || 0}" min="0" step="1000">
          </div>
          <div class="form-field">
            <label for="pfOfferPrice">Offer Price (${U().currencySymbol(cur)})</label>
            <input type="number" id="pfOfferPrice" value="${p.offerPrice || 0}" min="0" step="1000">
          </div>
          <div class="form-field">
            <label for="pfBeds">Beds</label>
            <input type="number" id="pfBeds" value="${p.beds || 0}" min="0" step="1">
          </div>
          <div class="form-field">
            <label for="pfBaths">Baths</label>
            <input type="number" id="pfBaths" value="${p.baths || 0}" min="0" step="0.5">
          </div>
          <div class="form-field">
            <label for="pfSqft">Sq Ft</label>
            <input type="number" id="pfSqft" value="${p.sqft || 0}" min="0" step="10">
          </div>
          <div class="form-field">
            <label for="pfListDate">Listing Date</label>
            <input type="date" id="pfListDate" value="${p.listingDate || ""}">
          </div>
          <div class="form-field">
            <label for="pfTargetClose">Target Close</label>
            <input type="date" id="pfTargetClose" value="${p.targetClose || ""}">
          </div>
          <div class="form-field">
            <label for="pfContact">Client</label>
            <select id="pfContact">
              <option value="">— none —</option>
              ${contactOptions.map(c =>
                `<option value="${c.id}" ${p.contactId===c.id?"selected":""}>${U().esc(c.name)}</option>`).join("")}
            </select>
          </div>
          <div class="form-field">
            <label for="pfUrl">URL</label>
            <input type="url" id="pfUrl" value="${U().esc(p.url)}" placeholder="https://…">
          </div>
          <div class="form-field full">
            <label for="pfNotes">Notes</label>
            <textarea id="pfNotes" rows="3">${U().esc(p.notes)}</textarea>
          </div>
        </div>
        ${App.customFieldsUI.renderSection("property", editing ? id : null)}
      </form>
    `;

    const handle = App.app.openModal({
      title: editing ? "Edit Property" : "Add Property",
      body,
      footer: `
        <button class="btn" data-role="cancel">Cancel</button>
        <button class="btn btn-primary" data-role="save">${editing ? "Save Changes" : "Add Property"}</button>
      `,
      onOpen: (modal) => {
        modal.querySelector('[data-role="cancel"]').addEventListener("click", () => handle.close());
        modal.querySelector('[data-role="save"]').addEventListener("click", () => submitPropertyForm(editing, id, handle));
      }
    });
  }

  async function submitPropertyForm(editing, id, handle) {
    const $ = (sel) => document.querySelector(sel);
    const addressField = $("#pfAddress").closest(".form-field");
    addressField.classList.remove("has-error");

    const address = $("#pfAddress").value.trim();
    if (!address) { addressField.classList.add("has-error"); return; }
    const missingCustom = App.customFieldsUI.findMissingRequired(document, "property");
    if (missingCustom.length) {
      App.app.toast(`${missingCustom.join(", ")} ${missingCustom.length === 1 ? "is" : "are"} required.`, "danger");
      return;
    }

    const patch = {
      address: address,
      mls: $("#pfMls").value.trim(),
      status: $("#pfStatus").value,
      listPrice:  U().num($("#pfListPrice").value),
      offerPrice: U().num($("#pfOfferPrice").value),
      beds:  U().num($("#pfBeds").value),
      baths: U().num($("#pfBaths").value),
      sqft:  U().num($("#pfSqft").value),
      listingDate: $("#pfListDate").value || null,
      targetClose: $("#pfTargetClose").value || null,
      contactId: $("#pfContact").value || null,
      url: $("#pfUrl").value.trim(),
      notes: $("#pfNotes").value
    };

    const customValues = App.customFieldsUI.collectValues(document, "property");
    const saveBtn = document.querySelector('#propForm')?.closest(".modal")?.querySelector('[data-role="save"]');
    if (saveBtn) saveBtn.disabled = true;
    let savedId = id;
    try {
      if (editing) {
        await S().properties.update(id, patch);
        App.app.toast("Property updated.", "success");
      } else {
        const p = await S().properties.create(patch);
        savedId = p.id;
        App.app.toast(`Added ${p.address}.`, "success");
      }
      await S().customFields.setValues("property", savedId, customValues);
      handle.close();
      App.app.route();
    } catch (err) {
      App.app.toast("Could not save property: " + err.message, "danger");
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async function openDeletePropertyConfirm(id) {
    await S().ensureLoaded(["properties"]);
    const prop = S().getState().properties.find(x => x.id === id);
    if (!prop) { App.app.toast("Property not found.", "danger"); return; }
    let preview;
    try {
      preview = await S().properties.delete(id);
    } catch (err) {
      App.app.toast("Could not check related records: " + err.message, "danger");
      return;
    }
    App.app.confirmDialog({
      title: "Delete Property?",
      message: `This will permanently remove <strong>${U().esc(prop.address)}</strong>.`,
      impact: preview.impact,
      okLabel: "Delete Property",
      danger: true
    }, async () => {
      try {
        const r = await S().properties.delete(id, { force: true });
        if (r.deleted) {
          App.app.toast("Property deleted.", "success");
          App.app.navigate("/properties");
        } else {
          App.app.toast("Delete failed.", "danger");
        }
      } catch (err) {
        App.app.toast("Delete failed: " + err.message, "danger");
      }
    });
  }

  return { renderList, renderDetail, openPropertyModal };
})();

