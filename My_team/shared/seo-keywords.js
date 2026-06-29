// ---------------------------------------------------------------------------
// Shared SEO keywords, money pages, and cluster map
// Used by: seo-generator, serp-analyzer, cluster-builder, internal-linker
// ---------------------------------------------------------------------------

const KEYWORDS = [
  // --- Existing (already written) ---
  "AI receptionist for dental practices Australia",
  "AI receptionist Melbourne small business",
  "After-hours answering service Australia",
  "AI phone answering service small business",
  "AI receptionist vs answering service Australia",
  "Best AI receptionist for law firms Australia",
  "AI receptionist for physiotherapy clinics",
  "How to never miss a business call Australia",
  // --- Niche verticals ---
  "AI receptionist for trade businesses Australia",
  "AI receptionist for real estate agents Australia",
  "AI receptionist for accounting firms Australia",
  "AI receptionist for veterinary clinics Australia",
  "AI receptionist for beauty salons Australia",
  "AI receptionist for medical clinics Australia",
  // --- Pain-point / long-tail ---
  "How much do missed calls cost small businesses Australia",
  "Best virtual receptionist for after hours Australia",
  "Automated appointment booking for small business",
  "AI answering service vs virtual receptionist comparison",
  "How to reduce missed calls small business Australia",
  "24/7 phone answering for trades and services",
  // --- Competitor / comparison ---
  "Best AI receptionist software Australia 2026",
  "Cheap virtual receptionist alternatives Australia",
  // --- Location ---
  "AI receptionist Sydney small business",
  "AI receptionist Brisbane small business",
  "AI receptionist Perth small business",

  // ===== LOCALIZED KEYWORD CLUSTERS (City x Niche) =====

  // --- Melbourne clusters ---
  "AI receptionist for dentists Melbourne",
  "after hours answering service Melbourne",
  "AI receptionist for law firms Melbourne",
  "virtual receptionist for trades Melbourne",
  "AI phone answering for real estate Melbourne",
  "after hours call handling Melbourne small business",

  // --- Sydney clusters ---
  "AI receptionist for dentists Sydney",
  "after hours answering service Sydney",
  "AI receptionist for law firms Sydney",
  "virtual receptionist for trades Sydney",
  "AI phone answering for real estate Sydney",
  "after hours call handling Sydney small business",

  // --- Brisbane clusters ---
  "AI receptionist for dentists Brisbane",
  "after hours answering service Brisbane",
  "virtual receptionist for small business Brisbane",

  // --- Perth clusters ---
  "AI receptionist for dentists Perth",
  "after hours answering service Perth",
  "virtual receptionist for small business Perth",

  // --- Adelaide clusters ---
  "AI receptionist Adelaide small business",
  "after hours answering service Adelaide",
  "virtual receptionist Adelaide",

  // --- Gold Coast clusters ---
  "AI receptionist Gold Coast small business",
  "after hours answering service Gold Coast",

  // --- Niche x pain point clusters ---
  "how dentists lose patients from missed calls",
  "after hours lead capture for law firms Australia",
  "why plumbers need an AI receptionist",
  "how real estate agents miss leads after hours",
  "AI receptionist for med spas and beauty clinics",
  "electrician missed call cost Australia",
  "cleaning business lead capture after hours",
  "landscaper phone answering service Australia",
  "physiotherapy clinic after hours booking",
  "accounting firm lead capture after hours",

  // --- Seasonal / trend clusters ---
  "best AI tools for small business Australia 2026",
  "how to automate customer service small business",
  "AI chatbot vs AI receptionist for small business",
  "cost of missed calls for Australian businesses",
  "how to get more Google reviews for your business",
  "local SEO tips for small business Australia 2026",

  // ===== COMPETITOR COMPARISON PAGES =====

  // --- "Alternative to" pages (high buyer intent) ---
  "Smith.ai alternative for small business",
  "OfficeHQ alternative Australia",
  "Ruby Receptionist alternative Australia",
  "Hey Jodie alternative AI receptionist",
  "Goodcall alternative AI phone answering",
  "My AI Front Desk alternative",

  // --- "vs" comparison pages ---
  "ReceptFlow vs Smith.ai comparison",
  "ReceptFlow vs Hey Jodie AI receptionist",
  "ReceptFlow vs OfficeHQ virtual receptionist",
  "ReceptFlow vs TransferToAI comparison",
  "ReceptFlow vs Rosie AI receptionist",
  "ReceptFlow vs Dialzara comparison",
  "AI receptionist vs human receptionist cost Australia",
  "AI receptionist vs virtual receptionist service Australia",

  // --- "Best" listicle pages ---
  "best AI receptionist for dentists Australia 2026",
  "best AI receptionist for tradies Australia 2026",
  "best virtual receptionist for law firms Australia 2026",
  "top AI phone answering services Australia 2026",
];

// ---------------------------------------------------------------------------
// Money pages — niche landing pages + matrix (city x niche) pages
// These are the pages we want to build topical authority toward
// ---------------------------------------------------------------------------
const MONEY_PAGES = [
  // 5 niche landing pages
  { slug: "dental", url: "https://www.receptflow.com/dental", niche: "dental", title: "AI Receptionist for Dental Practices", type: "niche" },
  { slug: "law-firms", url: "https://www.receptflow.com/law-firms", niche: "law", title: "AI Receptionist for Law Firms", type: "niche" },
  { slug: "trades", url: "https://www.receptflow.com/trades", niche: "trades", title: "AI Receptionist for Trade Businesses", type: "niche" },
  { slug: "real-estate", url: "https://www.receptflow.com/real-estate", niche: "real estate", title: "AI Receptionist for Real Estate Agents", type: "niche" },
  { slug: "healthcare", url: "https://www.receptflow.com/healthcare", niche: "medical clinic", title: "AI Receptionist for Healthcare", type: "niche" },

  // Matrix pages (city x niche)
  { slug: "ai-receptionist-for-dentists-in-melbourne", url: "https://www.receptflow.com/ai-receptionist-for-dentists-in-melbourne", niche: "dental", city: "Melbourne", title: "AI Receptionist for Dentists in Melbourne", type: "matrix" },
  { slug: "ai-receptionist-for-dentists-in-sydney", url: "https://www.receptflow.com/ai-receptionist-for-dentists-in-sydney", niche: "dental", city: "Sydney", title: "AI Receptionist for Dentists in Sydney", type: "matrix" },
  { slug: "ai-receptionist-for-dentists-in-brisbane", url: "https://www.receptflow.com/ai-receptionist-for-dentists-in-brisbane", niche: "dental", city: "Brisbane", title: "AI Receptionist for Dentists in Brisbane", type: "matrix" },
  { slug: "ai-receptionist-for-dentists-in-perth", url: "https://www.receptflow.com/ai-receptionist-for-dentists-in-perth", niche: "dental", city: "Perth", title: "AI Receptionist for Dentists in Perth", type: "matrix" },
  { slug: "ai-receptionist-for-dentists-in-adelaide", url: "https://www.receptflow.com/ai-receptionist-for-dentists-in-adelaide", niche: "dental", city: "Adelaide", title: "AI Receptionist for Dentists in Adelaide", type: "matrix" },
  { slug: "ai-receptionist-for-law-firms-in-melbourne", url: "https://www.receptflow.com/ai-receptionist-for-law-firms-in-melbourne", niche: "law", city: "Melbourne", title: "AI Receptionist for Law Firms in Melbourne", type: "matrix" },
  { slug: "ai-receptionist-for-law-firms-in-sydney", url: "https://www.receptflow.com/ai-receptionist-for-law-firms-in-sydney", niche: "law", city: "Sydney", title: "AI Receptionist for Law Firms in Sydney", type: "matrix" },
  { slug: "ai-receptionist-for-law-firms-in-brisbane", url: "https://www.receptflow.com/ai-receptionist-for-law-firms-in-brisbane", niche: "law", city: "Brisbane", title: "AI Receptionist for Law Firms in Brisbane", type: "matrix" },
  { slug: "ai-receptionist-for-law-firms-in-perth", url: "https://www.receptflow.com/ai-receptionist-for-law-firms-in-perth", niche: "law", city: "Perth", title: "AI Receptionist for Law Firms in Perth", type: "matrix" },
  { slug: "ai-receptionist-for-law-firms-in-adelaide", url: "https://www.receptflow.com/ai-receptionist-for-law-firms-in-adelaide", niche: "law", city: "Adelaide", title: "AI Receptionist for Law Firms in Adelaide", type: "matrix" },
  { slug: "ai-receptionist-for-plumbers-in-melbourne", url: "https://www.receptflow.com/ai-receptionist-for-plumbers-in-melbourne", niche: "trades", city: "Melbourne", title: "AI Receptionist for Plumbers in Melbourne", type: "matrix" },
  { slug: "ai-receptionist-for-plumbers-in-sydney", url: "https://www.receptflow.com/ai-receptionist-for-plumbers-in-sydney", niche: "trades", city: "Sydney", title: "AI Receptionist for Plumbers in Sydney", type: "matrix" },
  { slug: "ai-receptionist-for-electricians-in-melbourne", url: "https://www.receptflow.com/ai-receptionist-for-electricians-in-melbourne", niche: "trades", city: "Melbourne", title: "AI Receptionist for Electricians in Melbourne", type: "matrix" },
  { slug: "ai-receptionist-for-electricians-in-sydney", url: "https://www.receptflow.com/ai-receptionist-for-electricians-in-sydney", niche: "trades", city: "Sydney", title: "AI Receptionist for Electricians in Sydney", type: "matrix" },
  { slug: "ai-receptionist-for-real-estate-agents-in-melbourne", url: "https://www.receptflow.com/ai-receptionist-for-real-estate-agents-in-melbourne", niche: "real estate", city: "Melbourne", title: "AI Receptionist for Real Estate Agents in Melbourne", type: "matrix" },
  { slug: "ai-receptionist-for-real-estate-agents-in-sydney", url: "https://www.receptflow.com/ai-receptionist-for-real-estate-agents-in-sydney", niche: "real estate", city: "Sydney", title: "AI Receptionist for Real Estate Agents in Sydney", type: "matrix" },
  { slug: "ai-receptionist-for-real-estate-agents-in-brisbane", url: "https://www.receptflow.com/ai-receptionist-for-real-estate-agents-in-brisbane", niche: "real estate", city: "Brisbane", title: "AI Receptionist for Real Estate Agents in Brisbane", type: "matrix" },
  { slug: "ai-receptionist-for-med-spas-in-melbourne", url: "https://www.receptflow.com/ai-receptionist-for-med-spas-in-melbourne", niche: "wellness clinic", city: "Melbourne", title: "AI Receptionist for Med Spas in Melbourne", type: "matrix" },
  { slug: "ai-receptionist-for-med-spas-in-sydney", url: "https://www.receptflow.com/ai-receptionist-for-med-spas-in-sydney", niche: "wellness clinic", city: "Sydney", title: "AI Receptionist for Med Spas in Sydney", type: "matrix" },
  { slug: "ai-receptionist-for-physiotherapists-in-melbourne", url: "https://www.receptflow.com/ai-receptionist-for-physiotherapists-in-melbourne", niche: "physio", city: "Melbourne", title: "AI Receptionist for Physiotherapists in Melbourne", type: "matrix" },
  { slug: "ai-receptionist-for-physiotherapists-in-sydney", url: "https://www.receptflow.com/ai-receptionist-for-physiotherapists-in-sydney", niche: "physio", city: "Sydney", title: "AI Receptionist for Physiotherapists in Sydney", type: "matrix" },
];

// ---------------------------------------------------------------------------
// Existing blog posts for internal linking
// ---------------------------------------------------------------------------
const BLOG_POSTS = [
  { slug: "ai-receptionist-for-dental-practices-australia", title: "AI Receptionist for Dental Practices", niche: "dental" },
  { slug: "ai-receptionist-for-physiotherapy-clinics", title: "AI Receptionist for Physiotherapy Clinics", niche: "physio" },
  { slug: "best-ai-receptionist-for-law-firms-australia", title: "Best AI Receptionist for Law Firms", niche: "law" },
  { slug: "ai-receptionist-for-trade-businesses", title: "AI Receptionist for Trade Businesses", niche: "trades" },
  { slug: "ai-receptionist-for-real-estate-agents", title: "AI Receptionist for Real Estate Agents", niche: "real estate" },
  { slug: "ai-receptionist-vs-answering-service-australia", title: "AI Receptionist vs Answering Service", niche: null },
  { slug: "ai-phone-answering-service-small-business", title: "AI Phone Answering Service for Small Business", niche: null },
  { slug: "after-hours-answering-service-australia", title: "After-Hours Answering Service Australia", niche: null },
  { slug: "ai-receptionist-melbourne-small-business", title: "AI Receptionist Melbourne Small Business", niche: null },
  { slug: "how-to-capture-leads-from-your-website-after-hours", title: "How to Capture Leads After Hours", niche: null },
  { slug: "ai-receptionist-vs-human-receptionist", title: "AI Receptionist vs Human Receptionist", niche: null },
];

// ---------------------------------------------------------------------------
// Cluster map — maps each niche to its keyword group and money page
// Used by cluster-builder to build topical authority for each money page
// ---------------------------------------------------------------------------
const CLUSTER_MAP = {
  dental: {
    moneyPage: "https://www.receptflow.com/dental",
    moneyPageTitle: "AI Receptionist for Dental Practices",
    keywords: KEYWORDS.filter(k => /dental|dentist/i.test(k)),
  },
  law: {
    moneyPage: "https://www.receptflow.com/law-firms",
    moneyPageTitle: "AI Receptionist for Law Firms",
    keywords: KEYWORDS.filter(k => /law\s|lawyer|solicitor|legal/i.test(k)),
  },
  trades: {
    moneyPage: "https://www.receptflow.com/trades",
    moneyPageTitle: "AI Receptionist for Trade Businesses",
    keywords: KEYWORDS.filter(k => /trade|plumb|electri|builder|handyman|landscap|tradie/i.test(k)),
  },
  "real estate": {
    moneyPage: "https://www.receptflow.com/real-estate",
    moneyPageTitle: "AI Receptionist for Real Estate Agents",
    keywords: KEYWORDS.filter(k => /real estate|property|buyer/i.test(k)),
  },
  physio: {
    moneyPage: "https://www.receptflow.com/healthcare",
    moneyPageTitle: "AI Receptionist for Healthcare",
    keywords: KEYWORDS.filter(k => /physio|chiro|allied health/i.test(k)),
  },
  "medical clinic": {
    moneyPage: "https://www.receptflow.com/healthcare",
    moneyPageTitle: "AI Receptionist for Healthcare",
    keywords: KEYWORDS.filter(k => /medical|clinic|GP|healthcare/i.test(k)),
  },
  "wellness clinic": {
    moneyPage: "https://www.receptflow.com/healthcare",
    moneyPageTitle: "AI Receptionist for Healthcare",
    keywords: KEYWORDS.filter(k => /wellness|spa|beauty|med spa/i.test(k)),
  },
  "IT services": {
    moneyPage: null,
    moneyPageTitle: null,
    keywords: KEYWORDS.filter(k => /IT\s|software|tech|web dev/i.test(k)),
  },
  consulting: {
    moneyPage: null,
    moneyPageTitle: null,
    keywords: KEYWORDS.filter(k => /consult|advisory|accounting/i.test(k)),
  },
};

// Niches that have money pages (for prioritization)
const NICHES_WITH_MONEY_PAGES = ["dental", "law", "trades", "real estate", "physio", "medical clinic", "wellness clinic"];

module.exports = {
  KEYWORDS,
  MONEY_PAGES,
  BLOG_POSTS,
  CLUSTER_MAP,
  NICHES_WITH_MONEY_PAGES,
};
