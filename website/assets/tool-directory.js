(function () {
  'use strict';
  const grid = document.getElementById('tool-grid');
  if (!grid) return;
  const search = document.getElementById('tool-search');
  const filters = document.getElementById('tool-filters');
  const message = document.getElementById('no-results');
  const summary = document.getElementById('tool-count');
  if (!Array.isArray(window.realEstateTools) || typeof window.toolMatches !== 'function') {
    message.textContent = 'Tools could not be loaded. Please reload this page.';
    message.style.display = 'block';
    search.disabled = true;
    return;
  }
  const tools = window.realEstateTools.filter(tool => tool.status === 'published');
  // Presentation data only (registry stays the source of truth for
  // title, description, URL and order): display category, "You get" line,
  // and whether the tool carries the New badge.
  const DISPLAY = {
    'commission-calculator': { category: 'For agents', youGet: 'Net earnings · Split breakdown', isNew: false },
    'mortgage-calculator': { category: 'Buying', youGet: 'Monthly payment · Total interest', isNew: false },
    'home-affordability-calculator': { category: 'Buying', youGet: 'Max price · Payment breakdown', isNew: false },
    'rent-vs-buy-calculator': { category: 'Buying', youGet: 'Breakeven year · Total cost', isNew: false },
    'cap-rate-calculator': { category: 'Investing', youGet: 'Cap rate · NOI', isNew: false },
    'bridge-loan-calculator': { category: 'Selling', youGet: 'Max loan · Cash left after sale', isNew: false },
    'property-investment-calculator': { category: 'Investing', youGet: 'Cash flow · Cash-on-cash', isNew: false },
    'capital-gains-tax-calculator': { category: 'Tax', youGet: 'Tax due · Net proceeds', isNew: true },
    'roi-calculator': { category: 'Investing', youGet: 'Annualized ROI · Total return', isNew: true },
    'noi-calculator': { category: 'Investing', youGet: 'Annual NOI · Monthly NOI', isNew: true }
  };
  const KNOWN_ORDER = ['Buying', 'Investing', 'Selling', 'Tax', 'For agents'];
  function displayCategory(tool) { return (DISPLAY[tool.slug] && DISPLAY[tool.slug].category) || tool.category; }
  function display(tool) { return DISPLAY[tool.slug] || { category: tool.category, youGet: '', isNew: false }; }
  let category = null;
  const buttons = [];
  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const cards = tools.map(tool => {
    const meta = display(tool);
    const card = element('a', 'listing-card');
    card.href = tool.publicUrl;
    const top = element('div', 'card-top');
    const icon = element('span', 'listing-ico', tool.icon || '+');
    icon.setAttribute('aria-hidden', 'true');
    const tags = element('div', 'card-tags');
    tags.append(element('span', 'tag', displayCategory(tool)));
    if (meta.isNew) tags.append(element('span', 'tag new', 'New'));
    top.append(icon, tags);
    const get = element('div', 'get', 'You get: ');
    if (meta.youGet) get.append(element('b', '', meta.youGet));
    const foot = element('div', 'foot');
    foot.append(element('span', 'open', 'Open tool \u2192'));
    card.append(top, element('h3', '', tool.title), element('p', '', tool.description), get, foot);
    grid.append(card);
    return { tool, card, extra: `${displayCategory(tool)} ${meta.youGet}` };
  });
  function update() {
    const query = search.value.trim();
    let count = 0;
    cards.forEach(({ tool, card, extra }) => {
      const visible = (category === null || displayCategory(tool) === category) && (!query || window.toolMatches(tool, query, extra));
      card.hidden = !visible;
      if (visible) count++;
    });
    buttons.forEach(({ button, value }) => {
      button.classList.toggle('active', category === value);
      button.setAttribute('aria-pressed', String(category === value));
    });
    summary.textContent = `${count} ${count === 1 ? 'tool' : 'tools'} found \u00b7 Sort: Newest first`;
    message.style.display = count ? 'none' : 'block';
    message.textContent = tools.length ? 'No matching tools yet. Try another search.' : 'No tools are published yet.';
  }
  const counts = {};
  tools.forEach(tool => { const c = displayCategory(tool); counts[c] = (counts[c] || 0) + 1; });
  const ordered = KNOWN_ORDER.filter(c => counts[c]);
  Object.keys(counts).forEach(c => { if (!ordered.includes(c)) ordered.push(c); });
  [null, ...ordered].forEach(value => {
    const label = value === null ? `All tools \u00b7 ${tools.length}` : `${value} \u00b7 ${counts[value]}`;
    const button = element('button', 'pill', label);
    button.type = 'button';
    button.addEventListener('click', () => { category = value; update(); });
    buttons.push({ button, value });
    filters.append(button);
  });
  search.addEventListener('input', update);
  update();
})();
