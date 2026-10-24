// Working umbrella label, not a registered company identity.
// Change this value to an approved brand when available. RealtorOS stays separate.
window.siteConfig = Object.freeze({ brandName: 'Real Estate Tools' });
(function () {
  const name = window.siteConfig.brandName.trim();
  document.querySelectorAll('[data-brand-name]').forEach(node => { node.textContent = name; });
  document.querySelectorAll('.brand[aria-label]').forEach(node => {
    node.setAttribute('aria-label', `${name}, homepage`);
  });
  document.title = document.title.replace(/Real Estate Tools/g, () => name);
  document.querySelectorAll('meta[property="og:title"], meta[name="twitter:title"]').forEach(node => {
    node.setAttribute('content', document.title);
  });
})();
