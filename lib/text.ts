import { createHash } from "node:crypto";

/** Canonical text form for hashing, offsets and passage storage. Unicode NFC, collapsed spaces. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/ /g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function shortHash(text: string, len = 10): string {
  return sha256(text).slice(0, len);
}

const STOPWORDS = new Set(
  (
    "a an the and or but if then else of to in on at by for from with without into onto over under about as is are was were be been being " +
    "it its this that these those there here he she they them his her their we us our you your i me my mine yours ours theirs " +
    "has have had do does did done doing will would shall should can could may might must not no nor so than too very just also " +
    "what which who whom whose when where why how all any both each few more most other some such only own same up down out off again " +
    "further once now new news breaking share forward forwarded viral please urgent alert message whatsapp fake true false real hoax " +
    "says said say according report reports reported claim claims claimed people everyone anyone someone today yesterday tomorrow " +
    "before after deleted delete sharing friends family group groups send sent did does is was were any anyone somebody something"
  ).split(/\s+/),
);

/** Very light English stemming: plurals and -ing only (predictable, no over-merging). */
export function stem(t: string): string {
  if (t.length <= 4 || /\d/.test(t)) return t;
  if (t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (/(ss|us|is|ous)$/.test(t)) return t;
  if (/(ch|sh|x|z)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith("s")) return t.slice(0, -1);
  if (t.endsWith("ing") && t.length > 6) return t.slice(0, -3);
  return t;
}

/**
 * Small synonym map for everyday news vocabulary (forwards say "lady", reports say "woman").
 * Deliberately conservative: words map to one canonical token only when they are near-equivalent.
 */
const SYNONYMS: Record<string, string> = {};
for (const [canon, words] of Object.entries({
  woman: "woman women lady ladie wife mother housewife",
  child: "child children kid son daughter boy toddler infant minor baby",
  die: "die died dead death killed",
  fall: "fall fell falling jump jumped jumping plunge plunged",
  floor: "floor storey story",
  building: "building tower apartment society highrise high-rise",
  police: "police cop",
  arrest: "arrest arrested detain detained custody",
})) for (const w of words.split(" ")) SYNONYMS[w] = canon;

/** Lower-cased, lightly stemmed content terms, preserving Unicode letters/digits. */
export function terms(text: string): string[] {
  return (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [])
    .map((t) => t.replace(/['’]s$/, "").replace(/^-+|-+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => SYNONYMS[t] ?? SYNONYMS[stem(t)] ?? stem(t));
}

/** Words that look like named entities (capitalised, not sentence-initial filler) and numbers. */
export function salientTerms(text: string): string[] {
  const caps = text.match(/\b[\p{Lu}][\p{L}\p{N}'’-]+(?:\s+(?:of|de|the|and|&)?\s*[\p{Lu}][\p{L}\p{N}'’-]+)*/gu) ?? [];
  const nums = text.match(/\b\d[\d,.:%]*\b/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...caps, ...nums]) {
    const k = t.toLowerCase();
    if (STOPWORDS.has(k) || seen.has(k) || k.length < 2) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

const LOADED_WORDS =
  /\b(breaking|urgent|shocking|exposed|hoax|fake news|share (?:this|before)[^.!?\n]*|forward (?:this|to)[^.!?\n]*|before (?:it'?s )?deleted|must watch|100% (?:true|real)|viral)\b/gi;

/** Strip emotive framing so queries search both directions neutrally. */
export function neutralize(text: string): string {
  return text.replace(LOADED_WORDS, " ").replace(/[!?]{2,}/g, " ").replace(/\s+/g, " ").trim();
}

/** Build a compact neutral search query: entities first, then other content terms. */
export function buildQuery(text: string, maxTerms = 8): string {
  const neutral = neutralize(text);
  const entities = salientTerms(neutral)
    .filter((e) => !/^(today|yesterday|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(e))
    .slice(0, 4);
  const entityWords = new Set(entities.flatMap((e) => terms(e)));
  const rest = terms(neutral).filter((t) => !entityWords.has(t) && !/^\d+$/.test(t));
  const parts = [...entities, ...rest].slice(0, maxTerms);
  return parts.join(" ").slice(0, 120);
}

/* ── Simple BM25 for ranking leads and passages ───────────────────────────── */

export function bm25Scores(query: string[], docs: string[][], k1 = 1.4, b = 0.75): number[] {
  const N = docs.length || 1;
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(query)];
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgdl));
    }
    return s;
  });
}

/** Fraction of distinct query terms present in a document. */
export function coverage(query: string[], doc: string[]): number {
  const q = new Set(query);
  if (!q.size) return 0;
  const d = new Set(doc);
  let hit = 0;
  for (const t of q) if (d.has(t)) hit++;
  return hit / q.size;
}

/* ── Dates ────────────────────────────────────────────────────────────────── */

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** YYYY-MM-DD and weekday for "now" in a timezone. */
export function zonedToday(timeZone: string, now = new Date()): { iso: string; weekday: number; label: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const iso = `${get("year")}-${get("month")}-${get("day")}`;
  const weekday = WEEKDAYS.indexOf(get("weekday").toLowerCase());
  return { iso, weekday, label: formatDay(iso) };
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function formatDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(d);
}

/**
 * Resolve relative time words against a visible reference date. Returns human-readable
 * assumptions; the claim text itself is never rewritten.
 */
export function resolveRelativeDates(text: string, referenceIso: string, referenceWeekday: number, timeZone: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  const tz = timeZone.replace(/_/g, " ");
  if (/\btoday\b|\btonight\b|\bthis morning\b/.test(lower)) out.push(`"today" read as ${formatDay(referenceIso)} (${tz}).`);
  if (/\byesterday\b/.test(lower)) out.push(`"yesterday" read as ${formatDay(addDays(referenceIso, -1))} (${tz}).`);
  if (/\btomorrow\b/.test(lower)) out.push(`"tomorrow" read as ${formatDay(addDays(referenceIso, 1))} (${tz}).`);
  // Match on the original text so the assumption quotes the user's own wording.
  const wd = text.match(/\b(?:(last|this|next|on)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[2]!.toLowerCase());
    const qualifier = wd[1]?.toLowerCase();
    let delta = target - referenceWeekday;
    if (qualifier === "next") delta = delta <= 0 ? delta + 7 : delta;
    else if (qualifier === "last") delta = delta >= 0 ? delta - 7 : delta;
    else if (delta > 0) delta -= 7; // "on Monday" in a news claim usually means the most recent Monday
    out.push(`"${wd[0]}" read as ${formatDay(addDays(referenceIso, delta))} (${tz}). Correct the claim if you meant another week.`);
  }
  return out;
}

export function isVolatileClaim(text: string): boolean {
  return /\b(today|tonight|yesterday|tomorrow|now|currently|breaking|just in|latest|this (?:week|morning|evening)|live|ongoing|right now)\b/i.test(text);
}

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";

/** Explicit years mentioned in text (1900–2099). */
export function explicitYears(text: string): number[] {
  const ys = (text.match(/\b(19|20)\d{2}\b/g) ?? []).map(Number);
  return [...new Set(ys)];
}

/** Explicit calendar-date mentions, for evidence date notes. */
export function explicitDates(text: string): string[] {
  const re = new RegExp(`\\b(\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?\\s+(?:19|20)\\d{2}|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(?:19|20)\\d{2}|(?:19|20)\\d{2}-\\d{2}-\\d{2})\\b`, "gi");
  return [...new Set(text.match(re) ?? [])].slice(0, 6);
}

/** Safe ISO conversion; unknown or invalid dates stay null. */
export function toIso(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 1990 || y > 2100) return null;
  return d.toISOString();
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.7 ? cut.slice(0, sp) : cut) + "…";
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#8217;|&rsquo;/g, "’")
    .replace(/&#8216;|&lsquo;/g, "‘")
    .replace(/&#8220;|&ldquo;/g, "“")
    .replace(/&#8221;|&rdquo;/g, "”")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    const drop = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^mc_[a-z]+$/i, /^ref$/i, /^ref_src$/i, /^cmpid$/i, /^ito$/i, /^at_[a-z]+$/i, /^ns_[a-z]+$/i];
    for (const k of [...u.searchParams.keys()]) if (drop.some((r) => r.test(k))) u.searchParams.delete(k);
    u.searchParams.sort();
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s.replace(/^http:/, "https:");
  } catch {
    return raw;
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
