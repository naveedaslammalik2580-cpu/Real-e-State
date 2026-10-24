// Only status: 'published' entries appear in the directory.
// URLs are relative to website/tools/, so subdirectory hosting also works.
window.realEstateTools = Object.freeze([
  Object.freeze({
    slug: 'commission-calculator',
    title: 'Commission Calculator',
    category: 'Finance & numbers',
    description: 'Estimate commission income, earnings, agent splits and transaction fees.',
    status: 'published',
    publicUrl: 'commission-calculator/',
    icon: '%'
  }),
  Object.freeze({
    slug: 'mortgage-calculator',
    title: 'Mortgage Calculator',
    category: 'Finance & numbers',
    description: 'Estimate monthly mortgage principal and interest from home price and loan terms.',
    status: 'published',
    publicUrl: 'mortgage-calculator/',
    icon: '$'
  })
]);
