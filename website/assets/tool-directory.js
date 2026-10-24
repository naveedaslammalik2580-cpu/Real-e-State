(function () {
  'use strict';
  const grid = document.getElementById('tool-grid');
  if (!grid) return;
  const search = document.getElementById('tool-search');
  const filters = document.getElementById('tool-filters');
  const message = document.getElementById('no-results');
  const summary = document.getElementById('tool-count');
  if (!Array.isArray(window.realEstateTools)) {
    message.textContent = 'Tools could not be loaded. Please reload this page.';
    message.style.display = 'block';
    search.disabled = true;
    return;
  }
  const tools = window.realEstateTools.filter(tool => tool.status === 'published');
  let category = null;
  const buttons = [];
  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const cards = tools.map(tool => {
    const card = element('a', 'panel tool-card');
    card.href = tool.publicUrl;
    const chips = element('div', 'chip-row');
    const icon = element('span', 'card-ico', tool.icon || '+');
    icon.setAttribute('aria-hidden', 'true');
    chips.append(icon, element('span', 'live-chip', 'Free tool'));
    card.append(chips, element('h3', '', tool.title), element('p', '', tool.description),
      element('span', 'card-arrow', 'Open tool \u2192'));
    grid.append(card);
    return { tool, card, keywords: `${tool.title} ${tool.description} ${tool.category} ${tool.slug}`.toLowerCase() };
  });
  function update() {
    const query = search.value.trim().toLowerCase();
    let count = 0;
    cards.forEach(({ tool, card, keywords }) => {
      const visible = (category === null || tool.category === category) && keywords.includes(query);
      card.hidden = !visible;
      if (visible) count++;
    });
    buttons.forEach(({ button, value }) => {
      button.classList.toggle('active', category === value);
      button.setAttribute('aria-pressed', String(category === value));
    });
    summary.textContent = `${count} ${count === 1 ? 'tool' : 'tools'} found`;
    message.style.display = count ? 'none' : 'block';
    message.textContent = tools.length ? 'No matching tools yet. Try another search.' : 'No tools are published yet.';
  }
  [null, ...new Set(tools.map(tool => tool.category))].forEach(value => {
    const button = element('button', 'category-filter', value === null ? 'All tools' : value);
    button.type = 'button';
    button.addEventListener('click', () => { category = value; update(); });
    buttons.push({ button, value });
    filters.append(button);
  });
  search.addEventListener('input', update);
  update();
})();
