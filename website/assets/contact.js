(function () {
  const form = document.getElementById('enquiry-form');
  if (!form) return;
  const prepare = document.getElementById('prepare-enquiry');
  const draft = document.getElementById('enquiry-draft');
  const output = document.getElementById('draft-output');
  const status = document.getElementById('enquiry-status');
  const field = id => document.getElementById(id).value.trim();
  form.addEventListener('submit', event => { event.preventDefault(); });
  form.addEventListener('input', () => {
    output.hidden = true;
    draft.value = '';
    status.textContent = 'Details changed. Prepare your draft again. Nothing has been sent.';
  });
  prepare.disabled = false;
  prepare.addEventListener('click', () => {
    if (!form.reportValidity()) return;
    if (!field('enquiry-message')) {
      status.textContent = 'Please enter a message, not just spaces.';
      document.getElementById('enquiry-message').focus();
      return;
    }
    draft.value = [
      `Enquiry: ${field('enquiry-topic')}`,
      field('enquiry-name') ? `Name: ${field('enquiry-name')}` : '',
      field('enquiry-email') ? `Reply email: ${field('enquiry-email')}` : '',
      '', field('enquiry-message')
    ].filter((line, index) => line || index === 3).join('\n');
    output.hidden = false;
    status.textContent = 'Draft ready to copy. Nothing has been sent. No delivery address is configured yet.';
    draft.focus();
    draft.select();
  });
})();
