import { appConfig } from "@/app.config";
import type { InvestigationResult } from "@/lib/contracts";
import { VERDICT_VIEW, overallView } from "@/lib/client/verdicts";
import { SSEParser } from "@/lib/sse";
import { runEvidenceOnly } from "./evidence";
import type { RuleEvidence, RuleResult } from "./rules";

/**
 * Side panel controller. Two modes:
 *  A — "AI · local": the claim goes to the Fact Checker app on this computer (local model).
 *  C — "Evidence-only · no AI": feeds + articles fetched here, decided by deterministic rules.
 * A is used whenever the app and its model are reachable; otherwise C, automatically.
 * All page text is inserted with textContent — nothing from the web is rendered as HTML.
 */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const claimEl = $<HTMLTextAreaElement>("claim");
const goEl = $<HTMLButtonElement>("go");
const stopEl = $<HTMLButtonElement>("stop");
const progressEl = $("progress");
const resultEl = $("result");
const modeEl = $<HTMLButtonElement>("mode");
const modeLabel = $("mode-label");
const settings = $<HTMLDialogElement>("settings");
const appUrlEl = $<HTMLInputElement>("app-url");
const forceRulesEl = $<HTMLInputElement>("force-rules");
const params = new URLSearchParams(location.search);
const DEMO = params.get("demo") === "1";

const DEFAULT_APP = `http://127.0.0.1:${appConfig.port}`;
let appUrl = DEFAULT_APP;
let forceRules = false;
let aiReady = false;
let aiReason = "";
let running: AbortController | null = null;
/** The in-flight connection check; a check never starts before it settles. */
let detecting: Promise<void> = Promise.resolve();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, opts: { cls?: string; text?: string } = {}, ...children: (Node | null)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (opts.cls) e.className = opts.cls;
  if (opts.text != null) e.textContent = opts.text;
  for (const c of children) if (c) e.appendChild(c);
  return e;
}

function safeLink(url: string, text: string): HTMLElement {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    const a = el("a", { text });
    a.href = u.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow";
    return a;
  } catch {
    return el("span", { text });
  }
}

const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "date unknown");

/* ── Mode detection ───────────────────────────────────────────────────────── */

async function loadSettings() {
  const s = await chrome.storage.local.get(["appUrl", "forceRules"]);
  appUrl = (s.appUrl as string) || DEFAULT_APP;
  forceRules = !!s.forceRules;
  appUrlEl.value = appUrl;
  forceRulesEl.checked = forceRules;
}

function detectMode(): Promise<void> {
  detecting = detectModeNow();
  return detecting;
}

async function detectModeNow() {
  aiReady = false;
  aiReason = "";
  if (!forceRules) {
    try {
      const res = await fetch(`${appUrl}/api/health`, { signal: AbortSignal.timeout(2_000), cache: "no-store" });
      const h = (await res.json()) as { app?: string; ollama?: { reachable: boolean; modelInstalled: boolean; model: string } };
      if (h.app !== appConfig.name) aiReason = "Something else is running at that address.";
      else if (!h.ollama?.reachable) aiReason = "The Fact Checker app is running, but Ollama is not.";
      else if (!h.ollama.modelInstalled) aiReason = `The app is running, but ${h.ollama.model} is not installed.`;
      else aiReady = true;
    } catch {
      aiReason = "The Fact Checker app is not running on this computer.";
    }
  } else {
    aiReason = "You chose evidence-only mode.";
  }
  modeEl.dataset.mode = aiReady ? "ai" : "rules";
  modeLabel.textContent = aiReady ? (DEMO ? "AI · local · demo" : "AI · local") : "Evidence-only · no AI";
  $("mode-explain").textContent = aiReady
    ? "AI mode: your claim is checked by the Fact Checker app on this computer, using a local open-weight model. Nothing goes to a cloud AI."
    : `Evidence-only mode: ${aiReason} Checks use public news feeds and fixed rules that compare names, numbers, places and outcomes — no AI. Start the app (./run.sh) for full AI assessments.`;
}

/* ── Rendering ────────────────────────────────────────────────────────────── */

function setRunning(on: boolean, message = "") {
  goEl.hidden = on;
  stopEl.hidden = !on;
  claimEl.readOnly = on;
  progressEl.textContent = message;
  progressEl.classList.toggle("running", on);
}

const ICON: Record<string, string> = { supported: "✓", contradicted: "✕", unresolved: "?", neutral: "–" };

function header(tone: string, label: string, headline: string, summary: string | null): DocumentFragment {
  const f = document.createDocumentFragment();
  f.appendChild(el("div", { cls: `label tone-${tone}` }, el("span", { cls: "icon", text: ICON[tone] ?? "•" }), el("span", { text: label })));
  f.appendChild(el("p", { cls: "headline", text: headline }));
  if (summary) f.appendChild(el("p", { cls: "muted", text: summary }));
  return f;
}

function evidenceList(title: string, tone: string, items: { publisher: string; title: string; url: string; date: string | null; text: string; detail?: string | null }[]): HTMLElement | null {
  if (!items.length) return null;
  const ul = el("ul", { cls: `ev tone-${tone}` });
  for (const it of items.slice(0, 5)) {
    const meta = el("div", { cls: "meta" }, el("span", { text: it.publisher }), el("span", { text: `· ${fmtDate(it.date)}` }), safeLink(it.url, "Open ↗"));
    const li = el("li", {}, el("p", { text: `“${it.text.length > 320 ? it.text.slice(0, 320) + "…" : it.text}”` }), meta);
    if (it.detail) li.appendChild(el("p", { cls: "small faint", text: it.detail }));
    ul.appendChild(li);
  }
  const wrap = el("div");
  wrap.append(el("h3", { text: title }), ul);
  return wrap;
}

function openInAppButton(claim: string): HTMLElement {
  const b = el("button", { cls: "secondary", text: "Open full investigation" });
  b.type = "button";
  b.onclick = () => chrome.tabs.create({ url: `${appUrl}/?q=${encodeURIComponent(claim)}` });
  return b;
}

function renderAi(r: InvestigationResult, claim: string) {
  resultEl.replaceChildren();
  const v = overallView(r);
  const f = r.findings.length === 1 ? r.findings[0]! : null;
  if (r.mode === "demo") resultEl.appendChild(el("p", { cls: "banner", text: "Demo · bundled fictional evidence" }));
  resultEl.appendChild(header(v.tone, v.label, r.status === "complete" ? r.summary : (r.statusReason ?? v.meaning), r.status === "complete" ? v.meaning : null));
  if (f?.strength) {
    const n = f.strength.level === "strong" ? 3 : f.strength.level === "moderate" ? 2 : 1;
    const bars = el("span", { cls: "bars" });
    for (let i = 1; i <= 3; i++) bars.appendChild(el("i", { cls: i <= n ? "on" : "" }));
    resultEl.appendChild(el("div", { cls: "strength" }, bars, el("span", { text: `${f.strength.level[0]!.toUpperCase()}${f.strength.level.slice(1)} evidence · ${f.strength.independentOrigins} independent origin${f.strength.independentOrigins === 1 ? "" : "s"}` })));
  }
  const pById = new Map(r.passages.map((p) => [p.id, p]));
  const sById = new Map(r.sources.map((s) => [s.id, s]));
  const items = (ids: string[]) =>
    ids.flatMap((id) => {
      const p = pById.get(id);
      const s = p ? sById.get(p.sourceId) : undefined;
      return p && s ? [{ publisher: s.publisher ?? s.title, title: s.title, url: s.url, date: s.publishedAt, text: p.text }] : [];
    });
  for (const finding of r.findings) {
    if (r.findings.length > 1) {
      resultEl.appendChild(el("h3", { text: `${VERDICT_VIEW[finding.verdict].label}` }));
      resultEl.appendChild(el("p", { text: finding.claim }));
    }
    for (const node of [evidenceList("Supporting evidence", "supported", items(finding.supportingPassageIds)), evidenceList("Conflicting evidence", "contradicted", items(finding.contradictingPassageIds))]) if (node) resultEl.appendChild(node);
  }
  if (r.uncheckedClaims.length) resultEl.appendChild(el("p", { cls: "small faint", text: `${r.uncheckedClaims.length} more claim(s) were not checked — open the full investigation.` }));
  const notes = el("ul", { cls: "notes" }, el("li", { text: `AI mode · ${r.model ?? "local model"} on this computer · ${(r.timing.totalMs / 1000).toFixed(1)} s · ${r.origin === "cached_run" ? "cached result" : "fresh"}` }), el("li", { text: "An assessment as of now, within the sources searched — not a certification of truth." }));
  const actions = el("div", { cls: "actions" }, openInAppButton(claim));
  if (r.status !== "complete") {
    const b = el("button", { cls: "secondary", text: "Try evidence-only check" });
    b.type = "button";
    b.onclick = () => void investigate(claim, "rules");
    actions.appendChild(b);
  }
  resultEl.append(notes, actions);
  resultEl.hidden = false;
}

function renderRules(r: RuleResult & { detected: string; elapsedMs: number }, claim: string) {
  resultEl.replaceChildren();
  resultEl.appendChild(el("p", { cls: "banner", text: "Evidence-only mode · no AI. Rules compare names, numbers, places and outcomes in news reports; they do not read for meaning." }));
  resultEl.appendChild(header(r.tone, r.title, r.summary, null));
  if (r.label === "matches") {
    const n = r.independentOrigins >= 3 ? 3 : r.independentOrigins;
    const bars = el("span", { cls: "bars" });
    for (let i = 1; i <= 3; i++) bars.appendChild(el("i", { cls: i <= n ? "on" : "" }));
    resultEl.appendChild(el("div", { cls: "strength" }, bars, el("span", { text: `${r.independentOrigins} independent report${r.independentOrigins === 1 ? "" : "s"}` })));
  }
  const map = (xs: RuleEvidence[]) => xs.map((x) => ({ publisher: x.publisher, title: x.title, url: x.url, date: x.publishedAt, text: x.passage, detail: x.detail }));
  for (const node of [
    evidenceList("Published fact-checks", "contradicted", map(r.factChecks)),
    evidenceList("Reports saying the opposite", "contradicted", map(r.opposites)),
    evidenceList("Reports with the same details", "supported", map(r.matches)),
    evidenceList("Same topic — read carefully", "unresolved", map(r.cautions)),
    evidenceList("Reports mentioning a denial", "unresolved", map(r.denials)),
    evidenceList("Reports that differ on details", "unresolved", map(r.differs)),
  ])
    if (node) resultEl.appendChild(node);
  if (r.unreadable.length) {
    const ul = el("ul", { cls: "ev tone-neutral" });
    for (const u of r.unreadable.slice(0, 3)) ul.appendChild(el("li", {}, el("p", { text: u.title }), el("div", { cls: "meta" }, el("span", { text: `${u.publisher} · could not be read` }), safeLink(u.url, "Open ↗"))));
    resultEl.append(el("h3", { text: "Possibly related, not readable" }), ul);
  }
  const notes = el("ul", { cls: "notes" });
  for (const n of [`Keywords: ${r.detected} · ${(r.elapsedMs / 1000).toFixed(1)} s`, ...r.notes]) notes.appendChild(el("li", { text: n }));
  const actions = el("div", { cls: "actions" });
  if (aiReady) actions.appendChild(openInAppButton(claim));
  else actions.appendChild(el("p", { cls: "small faint", text: "For an AI assessment with the local model, start the Fact Checker app (./run.sh) and re-check the connection." }));
  resultEl.append(notes, actions);
  resultEl.hidden = false;
}

/* ── Runs ─────────────────────────────────────────────────────────────────── */

async function runAi(claim: string, signal: AbortSignal): Promise<InvestigationResult | null> {
  const res = await fetch(`${appUrl}/api/investigate`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ input: claim, mode: DEMO ? "demo" : "live" }),
    signal,
  });
  if (!res.ok || !res.body) {
    const j = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(j?.message ?? `The app answered with HTTP ${res.status}.`);
  }
  let result: InvestigationResult | null = null;
  const parser = new SSEParser((data) => {
    const e = JSON.parse(data) as { type: string; payload: Record<string, unknown> };
    if (e.type === "stage_started") progressEl.textContent = `${String(e.payload.label)}…`;
    else if (e.type === "observation") progressEl.textContent = String(e.payload.message);
    else if (e.type === "result") result = (e.payload as { result: InvestigationResult }).result;
    else if (e.type === "error") throw new Error(String(e.payload.message));
  });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(value);
  }
  parser.end();
  return result;
}

async function investigate(claim: string, force?: "rules") {
  claim = claim.trim();
  if (!claim || running) return;
  running = new AbortController();
  resultEl.hidden = true;
  setRunning(true, "Checking how to run this…");
  await detecting;
  const useAi = aiReady && force !== "rules";
  setRunning(true, useAi ? "Sending to the Fact Checker app on this computer…" : "Starting evidence-only check…");
  try {
    if (useAi) {
      const r = await runAi(claim, running.signal);
      if (r) renderAi(r, claim);
      else throw new Error("The connection to the app ended without a result.");
    } else {
      const r = await runEvidenceOnly(claim, running.signal, (m) => (progressEl.textContent = m));
      renderRules(r, claim);
    }
    setRunning(false, "");
  } catch (err) {
    if (running?.signal.aborted) {
      setRunning(false, "Stopped. Nothing was concluded.");
    } else if (useAi) {
      // The app went away mid-run: fall back honestly to evidence-only mode.
      setRunning(false, `${(err as Error).message} Falling back to evidence-only mode…`);
      running = null;
      await detectMode();
      return void investigate(claim, "rules");
    } else {
      setRunning(false, "The check could not finish. Check your internet connection and retry.");
    }
  } finally {
    running = null;
  }
}

/* ── Wiring ───────────────────────────────────────────────────────────────── */

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  void investigate(claimEl.value);
});
claimEl.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void investigate(claimEl.value);
  }
});
stopEl.addEventListener("click", () => running?.abort());
modeEl.addEventListener("click", () => settings.showModal());
$("recheck").addEventListener("click", () => void detectMode());
settings.addEventListener("close", async () => {
  appUrl = (appUrlEl.value.trim() || DEFAULT_APP).replace(/\/+$/, "");
  forceRules = forceRulesEl.checked;
  await chrome.storage.local.set({ appUrl, forceRules });
  await detectMode();
});

async function takePending() {
  const { pendingClaim } = (await chrome.storage.session.get("pendingClaim")) as { pendingClaim?: { text?: string } };
  if (pendingClaim?.text) {
    claimEl.value = pendingClaim.text;
    await chrome.storage.session.remove("pendingClaim");
    void investigate(pendingClaim.text);
  }
}
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.pendingClaim?.newValue) void takePending();
});

(async () => {
  await loadSettings();
  await detectMode();
  await takePending();
  claimEl.focus();
})();
