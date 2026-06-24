// ---------------------------------------------------------------------------
// Niche config — 4 niches per day, 9-niche rotation across AU/NZ/UK
// ---------------------------------------------------------------------------
const DAY_NICHES = {
  1: ["dental", "law", "physio", "trades"],
  2: ["real estate", "IT services", "consulting", "wellness clinic"],
  3: ["medical clinic", "dental", "law", "physio"],
  4: ["trades", "real estate", "IT services", "consulting"],
  5: ["wellness clinic", "medical clinic", "dental", "law"],
};

const CHAIN_INDICATORS = [
  "group", "australia", "national", "pty ltd group",
  "holdings", "international", "global", "corp",
  "franchise", "network", "partners", "collective",
  "corporation", "enterprises", "consolidated",
];

const NICHE_KEYWORDS = {
  dental: ["dental", "dentistry", "dental practice", "dentist", "dental clinic",
    "dental surgery", "cosmetic dentist", "emergency dentist", "family dentist", "dental centre"],
  law: ["law firm", "legal services", "solicitors", "solicitor", "lawyer",
    "legal firm", "legal practice", "family law", "criminal law", "commercial law"],
  physio: ["physiotherapy", "chiropractic", "allied health", "physiotherapist",
    "chiropractor", "osteopath", "sports medicine", "rehabilitation"],
  trades: ["plumbing", "electrical", "carpentry", "landscaping", "building", "construction",
    "plumber", "electrician", "builder", "carpenter", "landscaper", "painter",
    "roofer", "tiler", "handyman", "pest control"],
  "real estate": ["real estate", "property management", "real estate agent", "property agent",
    "real estate agency", "buyers agent", "property developer"],
  "IT services": ["IT services", "software company", "web development", "IT consulting",
    "software development", "tech startup", "IT support", "managed services"],
  consulting: ["management consulting", "business consulting", "strategy consulting",
    "advisory", "business advisory", "consulting firm"],
  "wellness clinic": ["wellness centre", "spa", "wellness clinic", "health centre",
    "yoga studio", "fitness centre", "wellness studio"],
  "medical clinic": ["medical clinic", "GP practice", "medical centre", "family medicine",
    "general practice", "healthcare clinic", "polyclinic"],
};

const NICHE_FALLBACKS = {
  dental: ["orthodontist", "oral surgeon", "dental hygienist", "endodontist", "prosthodontist"],
  law: ["conveyancer", "notary", "migration agent", "mediator", "barrister"],
  physio: ["osteopath", "podiatrist", "myotherapist", "exercise physiologist", "remedial massage"],
  trades: ["gardener", "cleaner", "painter", "tiler", "pest control", "locksmith"],
  "real estate": ["buyers agent", "strata manager", "property valuer", "mortgage broker", "auctioneer"],
  "IT services": ["web designer", "app developer", "cybersecurity", "cloud services", "data analytics"],
  consulting: ["HR consulting", "financial advisory", "tax consulting", "operations consulting"],
  "wellness clinic": ["meditation centre", "pilates studio", "naturopath", "acupuncture"],
  "medical clinic": ["specialist clinic", "pathology", "radiology", "allied health centre"],
};

const COUNTRY_ROTATION = {
  1: "Australia",
  2: "New Zealand",
  3: "United Kingdom",
  4: "Australia",
  5: "New Zealand",
};

const DAY_PRIMARY_CITY = {
  1: "Sydney, New South Wales",
  2: "Auckland",
  3: "London",
  4: "Melbourne, Victoria",
  5: "Wellington",
};

const AU_FALLBACK_CITIES = [
  "Gold Coast, Queensland",
  "Canberra, Australian Capital Territory",
  "Newcastle, New South Wales",
  "Hobart, Tasmania",
  "Geelong, Victoria",
  "Wollongong, New South Wales",
  "Sunshine Coast, Queensland",
  "Townsville, Queensland",
  "Darwin, Northern Territory",
  "Ballarat, Victoria",
  "Bendigo, Victoria",
  "Cairns, Queensland",
  "Toowoomba, Queensland",
  "Launceston, Tasmania",
];

const NZ_FALLBACK_CITIES = [
  "Christchurch",
  "Hamilton",
  "Tauranga",
  "Dunedin",
  "Napier",
  "Palmerston North",
  "Nelson",
  "Rotorua",
  "New Plymouth",
  "Invercargill",
  "Whangarei",
  "Queenstown",
];

const UK_FALLBACK_CITIES = [
  "Manchester",
  "Birmingham",
  "Edinburgh",
  "Bristol",
  "Leeds",
  "Glasgow",
  "Liverpool",
  "Sheffield",
  "Newcastle upon Tyne",
  "Nottingham",
  "Cardiff",
  "Belfast",
  "Leicester",
  "Southampton",
  "Brighton",
  "Cambridge",
  "Oxford",
  "York",
];

const COUNTRY_FALLBACK_CITIES = {
  "Australia": AU_FALLBACK_CITIES,
  "New Zealand": NZ_FALLBACK_CITIES,
  "United Kingdom": UK_FALLBACK_CITIES,
};

const COUNTRY_CITIES = {
  "Australia": ["Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide"],
  "New Zealand": ["Auckland", "Wellington", "Christchurch", "Hamilton", "Tauranga"],
  "United Kingdom": ["London", "Manchester", "Birmingham", "Edinburgh", "Bristol"],
};

const COUNTRY_CONFIG = {
  "Australia": { tone: "casual, direct", spelling: "Australian", currency: "AUD", price: "AUD $49/month", socialProof: "Australian businesses" },
  "New Zealand": { tone: "casual, friendly", spelling: "British/NZ", currency: "NZD", price: "NZD $55/month", socialProof: "New Zealand businesses" },
  "United Kingdom": { tone: "professional but approachable", spelling: "British", currency: "GBP", price: "GBP £35/month", socialProof: "UK businesses" },
};

const NICHE_OVERRIDES = {};

const EXCLUDE_TECHNOLOGY_UIDS = [
  "intercom", "drift", "hubspot_conversations", "tidio",
  "zendesk_chat", "freshchat", "livechat", "tawk_to",
  "crisp", "olark",
];

const NICHE_APOLLO_TAGS = {
  dental: ["dental", "dentist", "dental clinic", "dental practice", "dental surgery"],
  physio: ["physiotherapy", "physiotherapist", "chiropractic", "chiropractor", "allied health", "rehabilitation"],
  law: ["law firm", "solicitor", "lawyer", "legal practice", "conveyancer"],
  trades: ["plumber", "electrician", "builder", "locksmith", "pest control", "carpenter"],
  "real estate": ["real estate", "property management", "buyers agent", "real estate agency"],
  "IT services": ["IT services", "IT support", "managed services", "web development", "software company"],
  consulting: ["management consulting", "business consulting", "business advisory", "consulting firm"],
  "wellness clinic": ["wellness", "spa", "yoga studio", "fitness centre", "wellness clinic"],
  "medical clinic": ["medical clinic", "GP practice", "medical centre", "general practice", "healthcare"],
};

const DECISION_MAKER_TITLES = [
  "owner", "director", "founder", "principal",
  "managing director", "practice owner", "principal dentist",
  "head dentist", "lead physiotherapist",
  "principal solicitor", "managing partner",
];

const NICHE_FEATURES = {
  dental: {
    feature: "AI Voice Receptionist + Google Calendar booking",
    pain: "patients who call after hours get voicemail and book elsewhere",
    proof: "the next practice that answers gets a long-term patient worth $3,000+",
    revenueLoss: "Even 2 missed after-hours calls a week at $3,000 per patient = $24,000/month walking to the clinic down the road",
    demoTranscript: `"Hi, thanks for calling. I can help you book an appointment — are you an existing patient or new?... Great, Dr Patel has availability Thursday at 2pm or Friday at 10am. Which works better?... Perfect, you're booked in. You'll get a confirmation text shortly." That took 40 seconds. No voicemail. No lost patient.`,
  },
  physio: {
    feature: "AI Chat Widget",
    pain: "website enquiries after hours go unanswered until morning",
    proof: "most physio patients book the first practice that responds",
    revenueLoss: "3 unanswered website enquiries a week at $85/session over a treatment plan = $13,000+/year gone",
    demoTranscript: `Website visitor at 9pm: "Do you treat lower back pain?" ReceptFlow replies instantly: "Yes — we have physiotherapists who specialise in lower back pain. I can book you in for an initial assessment. Would tomorrow at 3pm or Thursday at 10am suit?" Booked before they even check your competitor's site.`,
  },
  law: {
    feature: "instant email notification + calendar booking",
    pain: "potential clients fill contact forms at night and hear nothing for 12 hours",
    proof: "by morning they have already called your competitor",
    revenueLoss: "1 lost client enquiry a week at $2,000+ average matter value = $100,000+/year gone",
    demoTranscript: `Potential client fills your contact form at 10pm. ReceptFlow instantly: sends you an email alert, replies to the client with "Thanks for reaching out — I've booked you a 15-minute call with the team tomorrow at 9am. You'll get a calendar invite shortly." By the time your competitor opens at 8:30am, you've already got the appointment.`,
  },
  trades: {
    feature: "AI Voice Receptionist + SMS confirmation",
    pain: "emergency jobs come in while on the tools and cannot be answered",
    proof: "one missed emergency call is $300-800 gone to whoever picks up next",
    revenueLoss: "2 missed emergency calls a week at $500/job = $4,000+/month going to whoever picks up next",
    demoTranscript: `Homeowner calls while you're on a job: "Hi, I've got a burst pipe — can someone come today?" ReceptFlow: "I can help — what's your address?... Got it. I'll get the team to call you back within 30 minutes to confirm a time. You'll get a text shortly." You get an SMS with the job details. No missed call. No lost job.`,
  },
  "real estate": {
    feature: "AI Chat Widget + instant lead capture",
    pain: "buyers enquire on listings Saturday night when agents are offline",
    proof: "the agent who responds first gets the relationship",
    revenueLoss: "1 lost buyer enquiry per weekend = $8,000-15,000 in commission walking to the agent who answered first",
    demoTranscript: `Saturday 9pm, buyer messages about a listing: "Is 42 Smith St still available? Can I inspect tomorrow?" ReceptFlow replies instantly: "Yes, it's still available. I can book you an inspection — would 11am or 1pm tomorrow work?... Done — you'll get a confirmation email. See you tomorrow." You wake up to a booked inspection, not a missed lead.`,
  },
  "IT services": {
    feature: "AI Chat Widget + instant lead capture",
    pain: "potential clients submit contact forms after hours and never hear back quickly enough",
    proof: "businesses choose the IT provider who responds first — speed signals competence",
    revenueLoss: "1 lost managed services lead a month at $2,000/month recurring = $24,000/year gone to a competitor who replied faster",
    demoTranscript: `Business owner at 8pm: "We need help migrating to the cloud — can someone call me?" ReceptFlow replies instantly: "Thanks for reaching out. I'll have one of our team call you first thing tomorrow morning. What time works best — 9am or 10am?" You wake up with a warm lead already expecting your call.`,
  },
  consulting: {
    feature: "AI Chat Widget + calendar booking",
    pain: "prospective clients visit your website outside business hours and leave without engaging",
    proof: "consulting is a trust business — the firm that engages first builds the relationship",
    revenueLoss: "1 lost engagement per quarter at $15,000+ average project value = $60,000/year in missed revenue",
    demoTranscript: `CEO visits your site at 9pm researching advisors: "Do you work with manufacturing businesses?" ReceptFlow: "Yes — we've worked with several manufacturing firms on operational efficiency. I can book you a 30-minute discovery call. Would Thursday at 10am or Friday at 2pm suit?" Booked before they check the next firm.`,
  },
  "wellness clinic": {
    feature: "AI Chat Widget + instant booking",
    pain: "clients want to book treatments in the evening when reception is closed",
    proof: "wellness clients book impulsively — if they can't book now, they won't come back",
    revenueLoss: "2 missed evening bookings a week at $120/treatment = $12,000+/year gone",
    demoTranscript: `Client at 10pm: "Do you have any availability for a massage this Saturday?" ReceptFlow: "Yes — we have openings at 10am, 12pm, and 3pm on Saturday. Which works for you?... Perfect, you're booked in for 12pm. You'll get a confirmation text shortly." Booked while they're still on the couch.`,
  },
  "medical clinic": {
    feature: "AI Voice Receptionist + appointment booking",
    pain: "patients call after hours and get voicemail — then book with another clinic",
    proof: "patients choose the clinic that answers, especially for urgent appointments",
    revenueLoss: "3 missed after-hours calls a week at $80/consultation = $12,000+/year lost to the clinic down the road",
    demoTranscript: `Patient calls at 7pm: "I need to see a doctor tomorrow — do you have any morning appointments?" ReceptFlow: "Let me check... Dr Chen has availability at 8:30am and 11am tomorrow. Which would you prefer?... Great, you're booked in for 8:30am. You'll receive a confirmation text shortly." No voicemail. No lost patient.`,
  },
};

const NICHE_BLOG_POSTS = {
  dental: "https://www.receptflow.com/blog/ai-receptionist-for-dental-practices-australia",
  physio: "https://www.receptflow.com/blog/ai-receptionist-for-physiotherapy-clinics",
  law: "https://www.receptflow.com/blog/best-ai-receptionist-for-law-firms-australia",
  trades: "https://www.receptflow.com/blog/ai-receptionist-for-trade-businesses",
  "real estate": "https://www.receptflow.com/blog/ai-receptionist-for-real-estate-agents",
  "IT services": "",
  consulting: "",
  "wellness clinic": "",
  "medical clinic": "",
};

const INBOX_LIMITS = {
  primary:   80,
  secondary: 80,
};

const TARGET_PER_NICHE = 15;

module.exports = {
  DAY_NICHES,
  CHAIN_INDICATORS,
  NICHE_KEYWORDS,
  NICHE_FALLBACKS,
  COUNTRY_ROTATION,
  DAY_PRIMARY_CITY,
  AU_FALLBACK_CITIES,
  NZ_FALLBACK_CITIES,
  UK_FALLBACK_CITIES,
  COUNTRY_FALLBACK_CITIES,
  COUNTRY_CITIES,
  COUNTRY_CONFIG,
  NICHE_OVERRIDES,
  EXCLUDE_TECHNOLOGY_UIDS,
  NICHE_APOLLO_TAGS,
  DECISION_MAKER_TITLES,
  NICHE_FEATURES,
  NICHE_BLOG_POSTS,
  INBOX_LIMITS,
  TARGET_PER_NICHE,
};
