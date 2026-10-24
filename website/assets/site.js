
(function(){const toggle=document.querySelector('.menu-toggle'),nav=document.querySelector('.nav');if(toggle&&nav){toggle.addEventListener('click',()=>{const open=nav.classList.toggle('is-open');toggle.setAttribute('aria-expanded',String(open))});document.addEventListener('keydown',e=>{if(e.key==='Escape'){const returnFocus=nav.contains(document.activeElement);nav.classList.remove('is-open');toggle.setAttribute('aria-expanded','false');if(returnFocus)toggle.focus()}})}
})();
