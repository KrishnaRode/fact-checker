import { FetchError, safeFetch } from "./safe-fetch";

/**
 * Minimal robots.txt support for article fetches: groups for "*" or our product token,
 * longest-match Allow/Disallow with "*" and "$" wildcards. A missing/unreachable robots.txt
 * is treated as allow (standard practice); an explicit Disallow makes the source a coverage
 * limitation, never something to work around.
 */
const PRODUCT_TOKEN = "factchecker";
const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; rules: Rule[] }>();

type Rule = { allow: boolean; pattern: string };

export function parseRobots(text: string): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false;
      if (key === "disallow" && value === "") continue;
      current.rules.push({ allow: key === "allow", pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && PRODUCT_TOKEN.includes(a.replace(/[^a-z]/g, ""))));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

function patternMatch(pattern: string, path: string): number {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp("^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path) ? body.length : -1;
}

export function isAllowed(rules: Rule[], pathWithQuery: string): boolean {
  let best: { len: number; allow: boolean } | null = null;
  for (const r of rules) {
    const len = patternMatch(r.pattern, pathWithQuery);
    if (len < 0) continue;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

export async function robotsAllows(url: string, signal?: AbortSignal): Promise<boolean> {
  const u = new URL(url);
  const origin = u.origin;
  const hit = cache.get(origin);
  let rules: Rule[];
  if (hit && Date.now() - hit.at < TTL_MS) {
    rules = hit.rules;
  } else {
    try {
      const res = await safeFetch(`${origin}/robots.txt`, { signal, timeoutMs: 2_500, maxBytes: 300_000, accept: "text/plain,*/*" });
      rules = parseRobots(res.text);
    } catch (err) {
      if (err instanceof FetchError && err.code === "aborted") throw err;
      rules = [];
    }
    cache.set(origin, { at: Date.now(), rules });
  }
  return isAllowed(rules, u.pathname + u.search);
}
