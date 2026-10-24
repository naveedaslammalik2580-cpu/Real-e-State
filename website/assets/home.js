// Published registry entries power homepage search.
(function () {
  const search = document.getElementById('home-search');
  const results = document.getElementById('home-search-results');
  const status = document.getElementById('home-search-status');
  if (!search || !results || !status || !Array.isArray(window.realEstateTools)) return;
  const published = window.realEstateTools.filter(tool => tool.status === 'published');
  function node(tag, className, text) {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function update() {
    const query = search.value.trim().toLowerCase();
    const matches = published.filter(tool => [tool.title, tool.description, tool.category, tool.slug].join(' ').toLowerCase().includes(query));
    const links = matches.map(tool => {
      const link = node('a', 'home-quick-card');
      link.setAttribute('data-home-tool', tool.slug);
      link.href = 'tools/' + tool.publicUrl;
      const icon = node('span', 'card-ico', tool.icon || '+');
      icon.setAttribute('aria-hidden', 'true');
      link.append(icon, node('strong', '', tool.title), node('small', '', tool.description));
      return link;
    });
    if (!links.length) links.push(node('p', 'home-search-empty', published.length ? 'No matching tools. Try another search.' : 'No tools are published yet.'));
    results.replaceChildren(...links);
    status.textContent = matches.length + (matches.length === 1 ? ' tool found' : ' tools found');
  }
  search.addEventListener('input', update);
  update();
})();
