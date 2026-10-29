/* U1c: authenticated header actions. Existing services own reads and writes. */
window.App = window.App || {};
App.headerActions = (function () {
  "use strict";
  const ENTITIES = [
    { key: "contacts", label: "Contacts", area: "contacts", route: "/contacts", title: "name", context: ["email", "phone"], detail: true },
    { key: "deals", label: "Deals", area: "deals", route: "/pipeline", title: "name", context: ["stage"], detail: true },
    { key: "properties", label: "Properties", area: "properties", route: "/properties", title: "address", context: ["status", "mls"], detail: true },
    { key: "tasks", label: "Tasks", area: "work", route: "/tasks", title: "title", context: ["status", "dueDate"], detail: false }
  ];
  let showMenu = null,
    dispose = null, closeSearch = null, closeMenu = null, refresh = null, workspaceUserId = null;
  const ready = () => !!(App.cloud && App.cloud.getUser() && App.cloud.getUser().id === workspaceUserId && App.workspace && App.workspace.ready() && App.workspace.id());
  const enabled = route => !!(App.customization && App.customization.isRouteEnabled(route));
  const allowed = e => ready() && enabled(e.route) && App.workspace.canView(e.area);
  const context = () => ready() ? JSON.stringify([App.cloud.getUser().id, App.workspace.id(), App.workspace.permissions(),
    ENTITIES.map(e => allowed(e))]) : "";
  const esc = value => App.util.esc(String(value == null ? "" : value));

  function actions() {
    if (!ready()) return [];
    const w = App.workspace;
    return [
      { id: "contact", label: "Add Contact", route: "/contacts", area: "contacts", run: () => App.quickAdd.open(), supported: !!App.quickAdd },
      { id: "deal", label: "Add Deal", route: "/pipeline", area: "deals", run: () => App.pages.deals.openDealModal(null), supported: !!App.pages.deals },
      { id: "task", label: "Add Task", route: "/tasks", area: "work", run: () => App.pages.tasks.openTaskModal(null), supported: !!App.pages.tasks },
      { id: "showing", label: "Schedule Showing", route: "/calendar", area: "work", run: () => App.pages.contacts.openShowingModal({}),
        supported: !!App.pages.contacts && w.canView("contacts") && w.canView("properties") && enabled("/contacts") && enabled("/properties") },
      { id: "call", label: "Log a Call", route: "/activities", area: "work", run: () => App.pages.activities.openActivityModal(null, { type: "Call" }), supported: !!App.pages.activities }
    ].filter(a => a.supported && enabled(a.route) && w.canCreate(a.area));
  }

  function openSearch() {
    if (!ready() || closeSearch) return;
    if (closeMenu) closeMenu(false);
    const initialContext = context();
    const sources = ENTITIES.filter(allowed);
    let generation = 0, timer, closed = false, request = null, items = [], selected = -1, input, results;
    const stop = () => {
      closed = true; generation++; clearTimeout(timer); items = []; request = null;
      if (results) results.replaceChildren();
      if (input) input.value = "";
    };
    const valid = () => !closed && context() === initialContext;
    const handle = App.app.openModal({
      title: "Search", extraClass: "global-search-modal",
      body: '<label for="globalSearchInput">Search contacts, deals, properties and tasks</label>' +
        '<input id="globalSearchInput" type="search" autocomplete="off" maxlength="200" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="globalSearchResults">' +
        '<p id="globalSearchStatus" role="status">Type at least two characters to search.</p>' +
        '<div id="globalSearchResults" role="listbox" aria-label="Search results"></div>' +
        '<p class="form-help">Search may be incomplete for large workspaces.</p>',
      onClose: () => { stop(); if (closeSearch === close) closeSearch = null; },
      onOpen: modal => {
        input = modal.querySelector("input"); results = modal.querySelector("#globalSearchResults");
        const status = modal.querySelector("#globalSearchStatus");
        const choose = index => {
          if (!valid() || !items[index]) return;
          const item = items[index];
          if (!allowed(item.entity)) return;
          close(); App.app.navigate(item.path);
        };
        const highlight = index => {
          selected = index;
          results.querySelectorAll('[role="option"]').forEach((el, i) => el.setAttribute("aria-selected", String(i === index)));
          if (index >= 0) {
            input.setAttribute("aria-activedescendant", "global-result-" + index);
            const option = results.querySelector("#global-result-" + index);
            if (option && option.scrollIntoView) option.scrollIntoView({ block: "nearest" });
          }
          else input.removeAttribute("aria-activedescendant");
        };
        input.addEventListener("input", () => {
          const version = ++generation; clearTimeout(timer); items = []; results.replaceChildren(); highlight(-1);
          const query = input.value.trim().toLocaleLowerCase();
          if (query.length < 2) { status.textContent = "Type at least two characters to search."; return; }
          status.textContent = "Searching...";
          timer = setTimeout(async () => {
            if (!valid()) { close(); return; }
            try {
              // Fresh RLS reads once per search opening; never reuse an old workspace cache.
              // No service-role calls, storage, or client-side authorization filtering.
              if (!request) request = Promise.all(sources.map(async entity => ({ entity, rows: await App.store[entity.key].list({ force: true, cache: false }) })));
              const groups = await request;
              if (!valid()) { close(); return; }
              if (version !== generation) return;
              const html = groups.map(({ entity, rows }) => {
                const matches = rows.filter(row => [entity.title, ...entity.context].some(key => String(row[key] || "").toLocaleLowerCase().includes(query))).slice(0, 8);
                if (!matches.length) return "";
                const options = matches.map(row => {
                  const index = items.length;
                  items.push({ entity, path: entity.route + (entity.detail ? "/" + encodeURIComponent(row.id) : "") });
                  return '<div role="option" aria-selected="false" id="global-result-' + index + '" data-result="' + index + '"><strong>' + esc(row[entity.title] || "Untitled") + '</strong><span>' + esc(entity.context.map(k => row[k]).filter(Boolean).join(" - ")) + '</span></div>';
                }).join("");
                return '<div role="group" aria-label="' + entity.label + '"><h3>' + entity.label + '</h3>' + options + '</div>';
              }).join("");
              results.innerHTML = html;
              status.textContent = items.length ? "Up to 8 matches per type. Tasks open the Tasks page." : "No matching records.";
              highlight(items.length ? 0 : -1);
            } catch (err) {
              if (!valid() || version !== generation) return;
              request = null; status.textContent = "Search could not load. Type again to retry.";
            }
          }, 200);
        });
        input.addEventListener("keydown", event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (items.length) highlight((selected + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
          } else if (event.key === "Enter") { event.preventDefault(); choose(selected); }
        });
        results.addEventListener("click", event => { const row = event.target.closest("[data-result]"); if (row) choose(Number(row.dataset.result)); });
        input.focus();
      }
    });
    function close() { stop(); handle.close(); }
    closeSearch = close;
    setTimeout(() => { if (valid()) input.focus(); }, 0);
  }

  function mount() {
    if (dispose) dispose();
    const header = document.getElementById("topbar");
    if (!header) return;
    workspaceUserId = App.cloud && App.cloud.getUser() ? App.cloud.getUser().id : null;
    // Quick Add still owns the contact form and mobile FAB.
    const old = document.getElementById("quickAddBtn");
    if (old) old.remove();
    const controls = document.createElement("div"); controls.className = "header-actions";
    controls.innerHTML = '<button type="button" class="btn header-search" id="globalSearchBtn" aria-label="Search (Ctrl or Command K)" aria-keyshortcuts="Control+k Meta+k">Search <kbd>Ctrl K</kbd></button>' +
      '<button type="button" class="btn btn-primary header-new" id="globalNewBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="globalNewMenu">+ New</button>' +
      '<div id="globalNewMenu" role="menu" aria-label="Create new" hidden></div>';
    header.insertBefore(controls, document.getElementById("topActions"));
    const search = controls.querySelector("#globalSearchBtn"), button = controls.querySelector("#globalNewBtn"), menu = controls.querySelector("#globalNewMenu");
    let opener = button;
    const hide = (restore = true) => { menu.hidden = true; opener.setAttribute("aria-expanded", "false"); if (restore) opener.focus(); };
    closeMenu = hide;
    const refreshControls = () => { search.disabled = !ready(); button.hidden = actions().length === 0; const mobile = document.querySelector('[data-tab-action="quickAdd"]'); if (mobile) mobile.disabled = button.hidden; };
    const show = (trigger = button) => {
      hide(false);
      opener = trigger;
      if (closeSearch) closeSearch();
      const entries = actions(); if (!entries.length) return;
      menu.innerHTML = entries.map(a => '<button type="button" role="menuitem" data-action="' + a.id + '">' + a.label + '</button>').join("");
      const rect = opener.getBoundingClientRect();
      const width = Math.min(216, window.innerWidth - 16);
      menu.style.width = width + "px";
      menu.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + "px";
      const above = rect.top > window.innerHeight / 2;
      menu.style.top = above ? "auto" : rect.bottom + 8 + "px";
      menu.style.bottom = above ? Math.max(8, window.innerHeight - rect.top + 8) + "px" : "auto";
      menu.style.maxHeight = Math.max(80, above ? rect.top - 16 : window.innerHeight - rect.bottom - 16) + "px";
      menu.hidden = false; opener.setAttribute("aria-expanded", "true"); menu.querySelector("button").focus();
    };
    showMenu = show;
    search.onclick = openSearch;
    button.onclick = () => menu.hidden ? show() : hide();
    button.onkeydown = event => { if (event.key === "ArrowDown") { event.preventDefault(); show(); } };
    menu.onclick = async event => {
      const el = event.target.closest("[data-action]"); if (!el) return;
      const action = actions().find(a => a.id === el.dataset.action); hide();
      if (!action) return;
      try { await action.run(); } catch (err) { App.app.toast("Could not open this action. Please try again.", "danger"); }
    };
    menu.onkeydown = event => {
      const list = Array.from(menu.querySelectorAll("button")), index = list.indexOf(document.activeElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
        list[next].focus();
      } else if (event.key === "Tab") hide();
    };
    const key = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && ready()) { event.preventDefault(); openSearch(); }
      if (event.key === "Escape" && !menu.hidden) { event.preventDefault(); hide(); }
    };
    const resize = () => hide(false);
    const outside = event => { if (!menu.hidden && !controls.contains(event.target) && !opener.contains(event.target)) hide(false); };
    const changed = () => { hide(false); if (closeSearch) closeSearch(); refreshControls(); };
    document.addEventListener("keydown", key); document.addEventListener("click", outside); window.addEventListener("hashchange", changed); window.addEventListener("resize", resize);
    const unsubscribe = App.workspace && App.workspace.onChange ? App.workspace.onChange(() => {
      workspaceUserId = App.cloud && App.cloud.getUser() ? App.cloud.getUser().id : null;
      changed();
    }) : null;
    refresh = changed;
    const auth = App.cloud && App.cloud.getClient().auth;
    const authListener = auth && auth.onAuthStateChange ? auth.onAuthStateChange(event => {
      if (event === "SIGNED_OUT" || event === "SIGNED_IN" || event === "USER_UPDATED") changed();
    }) : null;
    refreshControls();
    dispose = () => { changed(); controls.remove(); document.removeEventListener("keydown", key); document.removeEventListener("click", outside); window.removeEventListener("hashchange", changed); window.removeEventListener("resize", resize); if (unsubscribe) unsubscribe(); if (authListener) authListener.data.subscription.unsubscribe(); refresh = null; closeMenu = null; showMenu = null; dispose = null; };
  }
  return { mount, openSearch, openNew: trigger => { if (showMenu) showMenu(trigger); }, actions, refresh: () => { if (refresh) refresh(); } };
})();
