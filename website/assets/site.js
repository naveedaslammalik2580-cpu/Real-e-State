
(function(){const toggle=document.querySelector('.menu-toggle'),nav=document.querySelector('.nav');if(toggle&&nav){toggle.addEventListener('click',()=>{const open=nav.classList.toggle('is-open');toggle.setAttribute('aria-expanded',String(open))});document.addEventListener('keydown',e=>{if(e.key==='Escape'){const returnFocus=nav.contains(document.activeElement);nav.classList.remove('is-open');toggle.setAttribute('aria-expanded','false');if(returnFocus)toggle.focus()}})}
  /* Stop the mouse wheel / trackpad from changing a focused number input.
     One delegated listener, so it also covers fields shown later (for example
     inside collapsible sections). blur() is used instead of preventDefault()
     so the page keeps scrolling normally; the listener is passive for the
     same reason. Keyboard stepping (Arrow Up / Down) is untouched, and range
     sliders are not covered: in Chromium the wheel neither changes a focused
     slider's value nor blocks page scrolling, so blurring one would only
     take keyboard focus away for no benefit. No calculator has a blur
     handler, and calculators recalculate on 'input' events, so blurring
     without a value change cannot produce a wrong result or a validation
     error; the value, selection properties and validity of the field are
     left exactly as they were. */
  document.addEventListener('wheel', function (e) {
    var el = document.activeElement;
    if (el && el.tagName === 'INPUT' && el.type === 'number' && e.target === el) {
      el.blur();
    }
  }, { passive: true });
})();

/* RealtorOS links: anchors marked data-crm-link get their href from the
   central site config, so the CRM origin is configured in exactly one
   place (assets/site-config.js) instead of being hardcoded per anchor.
   Without a configured base URL the anchors keep their in-page fallback
   href, so nothing breaks if the config is ever removed. */
(function () {
  var base = window.siteConfig && window.siteConfig.crmBaseUrl;
  if (!base) return;
  base = String(base).replace(/\/+$/, '');
  document.querySelectorAll('[data-crm-link]').forEach(function (a) {
    var kind = a.getAttribute('data-crm-link');
    if (kind === 'signup') a.href = base + '/index.html?mode=create';
    else if (kind === 'login') a.href = base + '/index.html';
  });
})();
