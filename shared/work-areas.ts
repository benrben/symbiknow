/** Fixed labels for the primary work area of a document. */
export const workAreaOptions: Record<string, string> = {
  developers: 'General software development for developers',
  frontend: 'Browser interfaces and frontend code',
  backend: 'Server code and services',
  fullstack: 'Work spanning frontend and backend',
  mobile: 'Cross-platform mobile applications',
  ios: 'Apple mobile applications',
  android: 'Android applications',
  desktop: 'Desktop applications',
  devops: 'Build, deployment, and operations automation',
  infrastructure: 'Computing and network infrastructure',
  cloud: 'Cloud services and architecture',
  platform: 'Internal platform services',
  sre: 'Reliability and incident response',
  observability: 'Logs, metrics, and tracing',
  api_development: 'Designing and building APIs',
  database: 'Database design and administration',
  data_engineering: 'Data pipelines and storage',
  data_science: 'Statistical data analysis',
  machine_learning: 'Machine learning systems',
  ai_research: 'Artificial intelligence research',
  security_engineering: 'Security systems and controls',
  application_security: 'Secure application development',
  qa_testing: 'Quality assurance and test planning',
  automation_testing: 'Automated software tests',
  release_engineering: 'Software releases and versioning',
  developer_experience: 'Developer tools and workflows',
  open_source: 'Open source contribution and maintenance',
  documentation_engineering: 'Developer documentation tooling',
  architecture: 'Software architecture and system design',
  integrations: 'Integrating external systems',
  product_management: 'Managing a product and its outcomes',
  project_planning: 'Planning tasks, timelines, and milestones',
  program_management: 'Coordinating related projects',
  portfolio_management: 'Prioritizing a portfolio of initiatives',
  product_strategy: 'Long-term product direction',
  roadmapping: 'Product roadmap and sequencing',
  requirements: 'Documenting product requirements',
  user_research: 'Studying user needs and behavior',
  ux_design: 'User experience design',
  ui_design: 'Visual interface design',
  content_design: 'Designing product language and content',
  service_design: 'Designing an end-to-end service',
  accessibility: 'Accessible product design and testing',
  prototyping: 'Building prototypes for feedback',
  design_systems: 'Reusable interface patterns and components',
  experimentation: 'Product experiments and A/B tests',
  analytics: 'Product and business analytics',
  growth_product: 'Product-led growth work',
  localization: 'Translations and regional adaptation',
  technical_writing: 'Technical documentation and writing',
  sales: 'General sales work',
  sales_enablement: 'Materials and training for sales teams',
  outbound_sales: 'Prospecting and outbound selling',
  inbound_sales: 'Handling inbound sales leads',
  account_management: 'Managing customer accounts',
  business_development: 'Finding new commercial opportunities',
  partnerships: 'Business and technology partnerships',
  channel_sales: 'Selling through partner channels',
  revenue_operations: 'Sales systems and revenue processes',
  pricing: 'Pricing and packaging decisions',
  marketing: 'General marketing work',
  product_marketing: 'Positioning and launching products',
  content_marketing: 'Marketing articles and content',
  brand: 'Brand identity and messaging',
  demand_generation: 'Generating commercial demand',
  seo: 'Search engine optimization',
  paid_acquisition: 'Paid ads and customer acquisition',
  email_marketing: 'Marketing email campaigns',
  social_media: 'Social media planning and publishing',
  events: 'Events, webinars, and conferences',
  public_relations: 'Press and public relations',
  community: 'Building and supporting a community',
  customer_success: 'Helping customers achieve outcomes',
  customer_onboarding: 'Introducing customers to a product',
  customer_support: 'Solving customer issues',
  operations: 'General business operations',
  process_improvement: 'Improving repeatable processes',
  procurement: 'Purchasing goods and services',
  vendor_management: 'Managing suppliers and vendors',
  supply_chain: 'Coordinating supply networks',
  logistics: 'Shipping, delivery, and fulfillment',
  manufacturing: 'Producing physical goods',
  quality_management: 'Operational quality systems',
  finance: 'Financial planning and analysis',
  accounting: 'Books, reporting, and accounting',
  budgeting: 'Budgets and spending plans',
  billing: 'Invoices, payments, and billing',
  tax: 'Tax planning and filing',
  legal: 'Contracts and legal matters',
  compliance: 'Meeting regulatory or internal requirements',
  privacy: 'Personal data and privacy work',
  risk_management: 'Identifying and managing risks',
  audit: 'Internal or external audits',
  hr: 'People operations and human resources',
  recruiting: 'Hiring and talent acquisition',
  employee_onboarding: 'Introducing new employees',
  learning_development: 'Training and professional learning',
  internal_comms: 'Internal company communications',
  leadership: 'Leading teams and organizations',
  executive_strategy: 'Executive priorities and direction',
  board_reporting: 'Materials for a board of directors',
  fundraising: 'Raising capital or donations',
  investor_relations: 'Communications with investors',
  sustainability: 'Environmental and social sustainability',
  facilities: 'Office space and facilities',
  education: 'Teaching and education programs',
  curriculum: 'Designing learning curricula',
  healthcare: 'Healthcare services and systems',
  clinical_operations: 'Clinical procedures and delivery',
  science: 'Scientific research and methods',
  laboratory: 'Laboratory work and protocols',
  construction: 'Construction projects and sites',
  real_estate: 'Real estate properties and transactions',
  retail: 'Retail operations and stores',
  ecommerce: 'Online commerce operations',
  hospitality: 'Hospitality services and venues',
  travel: 'Travel services and planning',
  nonprofit: 'Nonprofit programs and operations',
  government: 'Government services and administration',
  policy_research: 'Researching public or organizational policy',
  other: 'No listed work area fits this document',
};

/** Built-in work areas grouped by domain. */
export const workAreaDomains = {
  engineering: [
    'developers', 'frontend', 'backend', 'fullstack', 'mobile', 'ios', 'android', 'desktop',
    'devops', 'infrastructure', 'cloud', 'platform', 'sre', 'observability', 'api_development',
    'database', 'data_engineering', 'data_science', 'machine_learning', 'ai_research',
    'security_engineering', 'application_security', 'qa_testing', 'automation_testing',
    'release_engineering', 'developer_experience', 'open_source', 'documentation_engineering',
    'architecture', 'integrations',
  ],
  product_design: [
    'product_management', 'project_planning', 'program_management', 'portfolio_management',
    'product_strategy', 'roadmapping', 'requirements', 'user_research', 'ux_design', 'ui_design',
    'content_design', 'service_design', 'accessibility', 'prototyping', 'design_systems',
    'experimentation', 'analytics', 'growth_product', 'localization', 'technical_writing',
  ],
  sales: [
    'sales', 'sales_enablement', 'outbound_sales', 'inbound_sales', 'account_management',
    'business_development', 'partnerships', 'channel_sales', 'revenue_operations', 'pricing',
  ],
  marketing: [
    'marketing', 'product_marketing', 'content_marketing', 'brand', 'demand_generation', 'seo',
    'paid_acquisition', 'email_marketing', 'social_media', 'events', 'public_relations', 'community',
  ],
  customer: ['customer_success', 'customer_onboarding', 'customer_support'],
  operations: [
    'operations', 'process_improvement', 'procurement', 'vendor_management', 'supply_chain',
    'logistics', 'manufacturing', 'quality_management',
  ],
  finance: ['finance', 'accounting', 'budgeting', 'billing', 'tax'],
  legal_risk: ['legal', 'compliance', 'privacy', 'risk_management', 'audit'],
  people: ['hr', 'recruiting', 'employee_onboarding', 'learning_development', 'internal_comms'],
  leadership: ['leadership', 'executive_strategy', 'board_reporting', 'fundraising', 'investor_relations'],
  industry: [
    'sustainability', 'facilities', 'education', 'curriculum', 'healthcare', 'clinical_operations',
    'science', 'laboratory', 'construction', 'real_estate', 'retail', 'ecommerce', 'hospitality',
    'travel', 'nonprofit', 'government', 'policy_research',
  ],
  workspace: [],
  other: [],
} as const satisfies Record<string, readonly string[]>;

export type WorkAreaDomain = keyof typeof workAreaDomains;

export const workAreaDomainOptions: Record<WorkAreaDomain, string> = {
  engineering: 'Software engineering, infrastructure, data, and technical systems',
  product_design: 'Product planning, research, design, and technical writing',
  sales: 'Sales, partnerships, accounts, and pricing',
  marketing: 'Marketing, brand, demand, events, and community',
  customer: 'Customer onboarding, success, and support',
  operations: 'Business operations, procurement, logistics, and quality',
  finance: 'Finance, accounting, budgets, billing, and tax',
  legal_risk: 'Legal, compliance, privacy, risk, and audits',
  people: 'Hiring, people operations, training, and internal communication',
  leadership: 'Executive direction, boards, fundraising, and investors',
  industry: 'Specialized industry, public sector, and research work',
  workspace: 'A custom work area defined in workspace Settings',
  other: 'General documents or no clearly fitting area',
};

export function workAreaDomainChoices(): Record<string, string> {
  return { ...workAreaDomainOptions };
}

function addCustomAreas(options: Record<string, string>, custom: string): void {
  for (const name of custom.split(/[\n,]/).map(value => value.trim()).filter(Boolean)) {
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
    if (key && !Object.hasOwn(workAreaOptions, key) && !Object.hasOwn(options, key) && Object.keys(options).length < 255) {
      options[key] = `Workspace work area: ${name}`;
    }
  }
}

/** Work areas limited to the selected domain (or top two domains). */
export function workAreaChoicesForDomains(domains: string | readonly string[], custom: string): Record<string, string> {
  const selected = typeof domains === 'string' ? [domains] : domains;
  const options: Record<string, string> = {};
  for (const domain of selected) {
    if (!Object.hasOwn(workAreaDomains, domain)) continue;
    for (const key of workAreaDomains[domain as WorkAreaDomain]) options[key] = workAreaOptions[key];
  }
  options.other = workAreaOptions.other;
  if (selected.includes('workspace')) addCustomAreas(options, custom);
  return options;
}

export function workAreaChoices(custom: string): Record<string, string> {
  const options = { ...workAreaOptions };
  addCustomAreas(options, custom);
  return options;
}

export function workAreaLabel(value: string): string {
  return value.split('/').at(-1)!.replaceAll('_', ' ');
}
