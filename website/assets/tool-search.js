// Shared calculator search for the homepage panel and the Tools directory.
// One matching rule, fed by the registry — the single source of truth for
// title, description, category, URL and keywords — so the two searches can
// never drift apart. A tool matches when every word of the query appears in
// its searchable text, which covers full names ("net operating income"),
// abbreviations ("NOI", "CGT"), partial words ("mort") and the registry's
// keyword phrases ("vacancy", "how much house").
(function () {
  'use strict';
  function toolSearchText(tool, extra) {
    return [tool.title, tool.description, tool.category, tool.slug.replace(/-/g, ' '), tool.keywords || '', extra || '']
      .join(' ')
      .toLowerCase();
  }
  function toolMatches(tool, query, extra) {
    const text = toolSearchText(tool, extra);
    return query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .every(token => text.includes(token));
  }
  window.toolSearchText = toolSearchText;
  window.toolMatches = toolMatches;
})();
