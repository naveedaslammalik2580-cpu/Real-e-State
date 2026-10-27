
/*
 * NOI Calculator
 * Net Operating Income = Effective Gross Income - Operating Expenses
 *
 * Mortgage payments, depreciation and income tax are excluded.
 */

(function () {
  'use strict';

  const form = document.getElementById('noi-form');
  if (!form) return;

  const $ = id => document.getElementById(id);

  const defaults = {
    'monthly-rent': 2200,
    'vacancy-rate': 5,
    'other-income': 0,
    'property-tax': 4200,
    'home-insurance': 1800,
    'maintenance-cost': 1500,
    'management-rate': 8,
    'hoa-other': 0
  };

  const inputs = Object.keys(defaults);

  const labels = {
    'monthly-rent': 'Monthly rent',
    'vacancy-rate': 'Vacancy rate',
    'other-income': 'Other income',
    'property-tax': 'Property tax',
    'home-insurance': 'Property insurance',
    'maintenance-cost': 'Maintenance and repairs',
    'management-rate': 'Management fee',
    'hoa-other': 'HOA and other costs'
  };

  const outputs = [
    'noi-monthly',
    'tile-monthly',
    'tile-effective',
    'tile-expenses',
    'tile-ratio',
    'row-gross-rent',
    'row-vacancy-loss',
    'row-other-income',
    'row-effective',
    'row-total-expenses',
    'row-noi',
    'lg-tax',
    'lg-ins',
    'lg-maintenance',
    'lg-management',
    'lg-hoa'
  ];

  const money = n =>
    Number.isFinite(n)
      ? new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 2
        }).format(n)
      : '—';

  const signed = n => n < 0 ? '−' + money(-n) : money(n);

  const set = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };

  const width = (id, n) => {
    const el = $(id);
    if (el) {
      el.style.width = Math.max(0, Math.min(100, n)) + '%';
    }
  };

  function calculate() {
    const values = {};
    const errors = [];

    inputs.forEach(id => {
      const el = $(id);
      const raw = el ? String(el.value).trim() : '';
      const n = raw === '' ? NaN : Number(raw);

      const hi =
        id === 'vacancy-rate' || id === 'management-rate'
          ? 100
          : 1e12;

      const invalid =
        !Number.isFinite(n) || n < 0 || n > hi;

      if (invalid) {
        errors.push(
          labels[id] +
          (
            raw === ''
              ? ' is required.'
              : ' must be between 0 and ' +
                hi.toLocaleString('en-US') + '.'
          )
        );
      }

      values[id] = n;

      if (el) {
        el.closest('.input-unit')
          ?.classList.toggle('invalid', invalid);
      }
    });

    set('validation-note', errors.join(' '));
    set('noi-validation', errors.join(' '));

    $('result-body').hidden = errors.length > 0;
    $('result-empty').hidden = errors.length === 0;

    if (errors.length) {
      set('noi-annual', '—');
      set('sticky-value', '—');

      outputs.forEach(id => set(id, '—'));

      [
        'tax',
        'ins',
        'maintenance',
        'management',
        'hoa'
      ].forEach(id => width('bar-' + id, 0));

      return;
    }

    // Income
    const rent = values['monthly-rent'];
    const vacancy = values['vacancy-rate'];
    const other = values['other-income'];

    // Operating expenses
    const tax = values['property-tax'];
    const ins = values['home-insurance'];
    const maintenance = values['maintenance-cost'];
    const hoa = values['hoa-other'];

    // Annual gross rental income
    const gross = rent * 12;

    // Vacancy loss
    const vacancyLoss = gross * vacancy / 100;

    // Effective gross income
    const effective = gross - vacancyLoss + other;

    // Management costs
    const management =
      effective * values['management-rate'] / 100;

    // Total annual operating expenses
    const expenses =
      tax + ins + maintenance + management + hoa;

    // Net operating income
    const noi = effective - expenses;

    // Monthly net operating income
    const monthly = noi / 12;

    // Expense ratio
    const ratio =
      effective > 0
        ? (expenses / effective * 100).toFixed(2) + '%'
        : '—';

    const map = {
      'noi-annual': signed(noi),
      'noi-monthly': signed(monthly),
      'tile-monthly': signed(monthly),
      'tile-effective': money(effective),
      'tile-expenses': money(expenses),
      'tile-ratio': ratio,
      'row-gross-rent': money(gross),
      'row-vacancy-loss': vacancyLoss
        ? '−' + money(vacancyLoss)
        : money(0),
      'row-other-income': money(other),
      'row-effective': money(effective),
      'row-total-expenses': money(expenses),
      'row-noi': signed(noi),
      'lg-tax': money(tax),
      'lg-ins': money(ins),
      'lg-maintenance': money(maintenance),
      'lg-management': money(management),
      'lg-hoa': money(hoa),
      'sticky-value': signed(noi)
    };

    Object.entries(map).forEach(([id, value]) => {
      set(id, value);
    });

    // Update expense distribution
    [
      ['tax', tax],
      ['ins', ins],
      ['maintenance', maintenance],
      ['management', management],
      ['hoa', hoa]
    ].forEach(([id, n]) => {
      width(
        'bar-' + id,
        expenses > 0 ? n / expenses * 100 : 0
      );
    });
  }

  // Prevent form submission
  form.addEventListener('submit', e => {
    e.preventDefault();
  });

  // Synchronize number inputs and sliders
  form.addEventListener('input', e => {
    const target = e.target;

    if (target.type === 'range') {
      const el = $(
        target.id.replace(/-slider$/, '')
      );

      if (el) el.value = target.value;

    } else if (target.type === 'number') {
      const slider = $(target.id + '-slider');

      if (slider && target.value !== '') {
        slider.value = target.value;
      }
    }

    calculate();
  });

  // Reset all fields to sample values
  $('reset-inputs')?.addEventListener('click', () => {
    inputs.forEach(id => {
      $(id).value = defaults[id];

      const slider = $(id + '-slider');

      if (slider) {
        slider.value = defaults[id];
      }
    });

    set('copy-note', '');
    calculate();
  });

  // Copy results to clipboard
  $('copy-results')?.addEventListener('click', async () => {
    if ($('result-body').hidden) {
      set('copy-note', 'Enter valid figures before copying.');
      return;
    }

    const fields = [
      ['Annual NOI', 'noi-annual'],
      ['Monthly NOI', 'noi-monthly'],
      ['Effective income', 'tile-effective'],
      ['Operating expenses', 'tile-expenses'],
      ['Expense ratio', 'tile-ratio']
    ];

    const text = [
      'NOI Calculator',
      ...fields.map(([name, id]) => {
        return name + ': ' + $(id).textContent;
      })
    ].join('\n');

    try {
      await navigator.clipboard.writeText(text);

      set(
        'copy-note',
        'Results copied to clipboard.'
      );
    } catch (err) {
      set(
        'copy-note',
        'Copy is unavailable here. You can use Print / Save PDF instead.'
      );
    }
  });

  // Print or save the report as PDF
  $('print-results')?.addEventListener('click', () => {
    window.print();
  });

  // Run initial calculation
  calculate();

})();
