import { topicFeeds } from "@/app.config";

/**
 * Claim → keywords → categories → which feeds to scan.
 *
 * A deterministic, inspectable classifier (no model call, so it costs nothing and never delays
 * retrieval). Categories are open-ended: add a lexicon entry here and tag feeds in
 * app.config.ts → `topicFeeds`. Professions map to the topic where they are reported
 * (doctor → health, teacher → education, lawyer → crime/courts…).
 */

export type Classification = {
  places: { name: string; kind: "city" | "state" | "country"; state: string | null }[];
  topics: { name: string; matched: string[] }[];
  region: "india" | "world" | null;
  keywords: string[];
};

/** City → state. Aliases map to the canonical city name. */
const CITIES: Record<string, { city: string; state: string }> = {};
for (const [city, state, aliases] of [
  ["pune", "maharashtra", "pune poona pimpri chinchwad wakad hinjewadi kothrud hadapsar baner"],
  ["mumbai", "maharashtra", "mumbai bombay thane navi-mumbai andheri bandra borivali dadar powai kurla"],
  ["nagpur", "maharashtra", "nagpur"],
  ["nashik", "maharashtra", "nashik"],
  ["delhi", "delhi", "delhi new-delhi ncr noida gurugram gurgaon ghaziabad faridabad"],
  ["bengaluru", "karnataka", "bengaluru bangalore mysuru mysore"],
  ["hyderabad", "telangana", "hyderabad secunderabad"],
  ["chennai", "tamil nadu", "chennai madras coimbatore madurai"],
  ["kolkata", "west bengal", "kolkata calcutta howrah"],
  ["ahmedabad", "gujarat", "ahmedabad surat vadodara"],
  ["jaipur", "rajasthan", "jaipur jodhpur udaipur"],
  ["lucknow", "uttar pradesh", "lucknow kanpur varanasi ayodhya prayagraj agra rampur"],
  ["patna", "bihar", "patna"],
  ["kochi", "kerala", "kochi cochin thiruvananthapuram trivandrum kozhikode"],
  ["bhopal", "madhya pradesh", "bhopal indore"],
  ["chandigarh", "punjab", "chandigarh amritsar ludhiana"],
  ["srinagar", "jammu and kashmir", "srinagar jammu"],
] as const) {
  for (const a of aliases.split(" ")) CITIES[a.replace(/-/g, " ")] = { city, state };
}

const STATES: Record<string, string> = {};
for (const [state, aliases] of [
  ["maharashtra", "maharashtra"],
  ["delhi", "delhi"],
  ["karnataka", "karnataka"],
  ["telangana", "telangana"],
  ["tamil nadu", "tamil-nadu tamilnadu"],
  ["west bengal", "west-bengal bengal"],
  ["gujarat", "gujarat"],
  ["rajasthan", "rajasthan"],
  ["uttar pradesh", "uttar-pradesh up"],
  ["bihar", "bihar"],
  ["kerala", "kerala"],
  ["madhya pradesh", "madhya-pradesh mp"],
  ["punjab", "punjab"],
  ["haryana", "haryana"],
  ["andhra pradesh", "andhra-pradesh andhra"],
  ["odisha", "odisha orissa"],
  ["assam", "assam"],
  ["jammu and kashmir", "kashmir j&k"],
] as const) {
  for (const a of aliases.split(" ")) STATES[a.replace(/-/g, " ")] = state;
}

const COUNTRIES = "india pakistan china bangladesh nepal sri-lanka usa us america uk britain russia ukraine israel gaza iran afghanistan japan canada australia france germany".split(" ").map((c) => c.replace(/-/g, " "));

const TOPICS: Record<string, string> = {
  politics:
    "election elections poll polls vote votes voter voters bjp congress aap tmc sp bsp shiv-sena ncp dmk minister ministers mla mlas mp mps parliament lok-sabha rajya-sabha assembly cm chief-minister pm prime-minister modi rahul-gandhi gandhi kejriwal yogi shah party government opposition governor cabinet manifesto ucc campaign rally",
  crime: "police arrest arrested murder killed court judge high-court supreme-court fir ed cbi bail jail custody suicide accident crash fraud scam theft robbery rape assault probe investigation lawyer advocate",
  religion: "temple mosque church gurdwara hindu hindus muslim muslims christian christians sikh jain buddhist religious religion festival diwali eid navratri ganesh durga puja namaz prayer pilgrimage kumbh hajj communal",
  technology: "ai artificial-intelligence app apps smartphone iphone android google microsoft apple openai chatgpt cyber hack hacked hacker internet 5g software startup crypto bitcoin upi data privacy semiconductor chip engineer engineers",
  business: "rbi rupee gdp inflation sensex nifty stock stocks share shares market markets bank banks tax gst price prices company companies ipo salary salaries jobs layoffs economy budget loan emi petrol diesel gold",
  health: "covid virus vaccine vaccines hospital hospitals doctor doctors nurse disease cancer dengue malaria health medicine medicines drug drugs who aiims patient patients outbreak",
  science: "isro space satellite moon mars nasa scientist scientists research study",
  environment: "climate earthquake monsoon rain rains flood floods cyclone pollution aqi heatwave landslide drought",
  sports: "cricket ipl bcci football hockey olympics match tournament kohli rohit dhoni world-cup medal",
  education: "exam exams neet jee cbse icse upsc ssc school schools college colleges university universities student students teacher teachers result results admission",
};

const TOPIC_WORDS: Record<string, string> = {};
for (const [topic, words] of Object.entries(TOPICS)) for (const w of words.split(" ")) TOPIC_WORDS[w.replace(/-/g, " ")] = topic;

function phrases(text: string): string[] {
  const words = text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}&]+/gu) ?? [];
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    out.push(words[i]!);
    if (i + 1 < words.length) out.push(`${words[i]} ${words[i + 1]}`);
  }
  return out;
}

export function classifyClaim(text: string): Classification {
  const ps = phrases(text);
  const places: Classification["places"] = [];
  const topicHits = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const p of ps) {
    const city = CITIES[p];
    if (city && !seen.has(`city:${city.city}`)) {
      seen.add(`city:${city.city}`);
      places.push({ name: city.city, kind: "city", state: city.state });
    }
    // Short aliases ("up", "mp") only count when written in capitals in the original text.
    const state = STATES[p];
    if (state && !seen.has(`state:${state}`) && (p.length > 2 || new RegExp(`\\b${p.toUpperCase()}\\b`).test(text))) {
      seen.add(`state:${state}`);
      places.push({ name: state, kind: "state", state });
    }
    if (COUNTRIES.includes(p) && !seen.has(`country:${p}`) && (p.length > 2 || new RegExp(`\\b${p.toUpperCase()}\\b`).test(text))) {
      seen.add(`country:${p}`);
      places.push({ name: p, kind: "country", state: null });
    }
    const topic = TOPIC_WORDS[p];
    // Ambiguous two-letter tokens (ed, sp, up, mp, pm, cm) must be capitalised in the text.
    if (topic && (p.length > 2 || new RegExp(`\\b${p.toUpperCase()}\\b`).test(text))) {
      topicHits.set(topic, (topicHits.get(topic) ?? new Set()).add(p));
    }
  }
  const foreign = places.some((p) => p.kind === "country" && p.name !== "india");
  const indian = places.some((p) => p.kind !== "country" || p.name === "india");
  return {
    places,
    topics: [...topicHits.entries()].map(([name, m]) => ({ name, matched: [...m] })).sort((a, b) => b.matched.length - a.matched.length),
    region: indian ? "india" : foreign ? "world" : null,
    keywords: [...new Set([...places.map((p) => p.name), ...[...topicHits.values()].flatMap((s) => [...s])])],
  };
}

/**
 * Choose up to `max` topical feeds. City matches beat state matches beat topic matches;
 * among equals, spread across publishers so one outlet cannot fill the budget.
 */
export function routeFeeds(c: Classification, max: number): { ids: string[]; reasons: string[] } {
  const scored = topicFeeds.map((f) => {
    let score = 0;
    const why: string[] = [];
    const add = (points: number, reason: string) => {
      score += points;
      why.push(reason);
    };
    for (const p of c.places) {
      if (p.kind === "city" && f.tags.includes(`city:${p.name}`)) add(5, p.name);
      else if (p.state && f.tags.includes(`state:${p.state}`)) add(2, p.state);
    }
    for (const t of c.topics) if (f.tags.includes(`topic:${t.name}`)) add(3 + Math.min(2, t.matched.length - 1), t.name);
    if (c.region && f.tags.includes(`region:${c.region}`)) add(1, c.region);
    return { f, score, why };
  });
  const picked: typeof scored = [];
  const perPublisher = new Map<string, number>();
  for (const s of scored.filter((x) => x.score > 1).sort((a, b) => b.score - a.score)) {
    const n = perPublisher.get(s.f.publisher) ?? 0;
    if (n >= 2) continue;
    perPublisher.set(s.f.publisher, n + 1);
    picked.push(s);
    if (picked.length >= max) break;
  }
  return { ids: picked.map((p) => p.f.id), reasons: [...new Set(picked.flatMap((p) => p.why))] };
}

export function describeClassification(c: Classification): string {
  const parts = [
    ...c.places.map((p) => (p.kind === "city" && p.state ? `${cap(p.name)} (${cap(p.state)})` : cap(p.name))),
    ...c.topics.map((t) => t.name),
  ];
  return parts.length ? parts.join(" · ") : "general news";
}

const cap = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase());
