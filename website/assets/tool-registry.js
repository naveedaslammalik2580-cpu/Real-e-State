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
  }),
  Object.freeze({
    slug: 'home-affordability-calculator',
    title: 'Home Affordability Calculator',
    category: 'Finance & numbers',
    description: 'Estimate the maximum home price from the monthly payment you can afford.',
    status: 'published',
    publicUrl: 'home-affordability-calculator/',
    icon: '⌂'
  })
]);
