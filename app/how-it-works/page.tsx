import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Bot, Code2, ShieldCheck } from "lucide-react";
import { appConfig, budgets, feeds, seriesLabel, topicFeeds } from "@/app.config";
import { SourceStatus } from "@/components/SourceStatus";

export const metadata: Metadata = {
  title: `How it works — ${appConfig.name}`,
  description: "Where Fact Checker gets its evidence, what the local AI does, and what code checks around it.",
};

const PIPELINE: { step: string; who: "code" | "ai" | "both"; what: string }[] = [
  { step: "Understand", who: "both", what: "Short claims are split by code. Long forwards and articles: the local AI lists the separate claims (≤ 3 checked, the rest shown as not checked). Code resolves “today/yesterday” to a visible date and spots opinions and predictions." },
  { step: "Route", who: "code", what: "Keywords → places (Pune, Wakad, Mumbai…) and topics (politics, crime, sports, business…). These choose which city and topic feeds to scan, on top of the general ones." },
  { step: "Search", who: "code", what: "Recent headlines from the feeds below, plus Wikipedia, GDELT and (as low-reliability leads) Mastodon. Optional Brave Search / Google Fact Check with your own keys." },
  { step: "Read", who: "code", what: `The best few articles (≤ ${budgets.quick.fetchCount} per check, more when following a blocked story) are opened, robots.txt respected, and only the readable article text kept.` },
  { step: "Link", who: "code", what: "Copies of the same story are grouped (identical text, near-identical text, shared links or attributions) so 20 copies count as one. The paragraphs most relevant to the claim are picked, as exact quotes." },
  { step: "Assess", who: "ai", what: "The local AI reads those quotes and proposes, per claim: which quotes support or contradict it, a label, and a one-line finding. It cannot fetch anything or invent sources." },
  { step: "Check", who: "code", what: "Code verifies every citation and offset, then enforces the evidence rules below — it can downgrade the AI's label or, when a quote explicitly says the opposite, turn it into Contradicted. The overall verdict and evidence strength are computed by code." },
  { step: "Show", who: "code", what: "Verdict, reasons, clickable quotes, evidence map, source dates and coverage — so you can check any result in seconds." },
];

const AI_DOES = [
  "Reads meaning: “not closing permanently”, “below the safety limit”, “free for children under 12” vs “free for everyone”.",
  "Decides whether a quote supports or contradicts the claim — the direction, not just shared words.",
  "Splits long forwards and articles into separate checkable claims; handles questions and messy wording.",
  "Answers follow-up questions (“what was changed in the forward?”) from the same quotes.",
];
const AI_DOESNT = [
  "Search, open websites or choose sources — code does that, and the AI's text can't trigger any of it.",
  "Decide the final overall verdict or the evidence strength — code derives both.",
  "Use its own memory as evidence — only the quotes it is given count.",
  "Run in the cloud — it is an open-weight model on this computer (via Ollama). Without it, checks still run in evidence-only mode.",
];
const CHECKS = [
  "Every cited quote must exist and match the article text exactly.",
  "Green or red needs readable article text — not a headline, snippet, social post or the submitted article itself.",
  "Numbers and places must match exactly (Wakad counts as Pune); outcome words (acquitted, died, arrested…) must appear.",
  "Opposite wording overrules: “not permanently”, “without rain”, “B beat A”, “interim bail” vs “acquitted”.",
  "Copies of one story count once; Wikipedia is background only; a quote proves someone said it, not that it's true.",
  "Old or undated reports can't confirm a “today” claim; predictions and opinions are “not fact-checkable”.",
  "Text in a source that tries to instruct the AI is flagged and can never decide the label.",
  "Nothing found → “Not enough evidence”, never “false”.",
];

function Who({ who }: { who: "code" | "ai" | "both" }) {
  const map = { code: ["Code", "border-border-strong text-text-muted"], ai: ["Local AI", "border-accent/50 text-accent-strong"], both: ["Code + AI", "border-unresolved/40 text-unresolved"] } as const;
  const [t, cls] = map[who];
  return <span className={`inline-block w-[84px] shrink-0 rounded-full border px-2 py-0.5 text-center text-[11.5px] ${cls}`}>{t}</span>;
}

export default function HowItWorks() {
  return (
    <div className="mx-auto w-full max-w-[920px] px-4 pb-20 sm:px-6">
      <header className="flex items-center justify-between py-5">
        <Link href="/" className="inline-flex items-center gap-2 text-[14px] text-text-muted hover:text-text">
          <ArrowLeft size={15} aria-hidden /> {appConfig.name}
        </Link>
        <span className="rounded-full border border-border px-2 py-0.5 text-[11.5px] text-text-faint">{seriesLabel}</span>
      </header>

      <h1 className="font-display mt-4 text-[44px] leading-[1.05] text-text sm:text-[56px]">How it works</h1>
      <p className="mt-3 max-w-[640px] text-[17px] leading-relaxed text-text-muted">
        Where the evidence comes from, what the local AI does — and the code that checks it. Fact Checker gives evidence-linked assessments as of the time checked; it does not certify truth.
      </p>

      <section className="mt-12" aria-labelledby="pipeline">
        <h2 id="pipeline" className="text-[13px] font-semibold uppercase tracking-[0.1em] text-text-faint">From claim to answer</h2>
        <ol className="mt-4 space-y-2">
          {PIPELINE.map((p, i) => (
            <li key={p.step} className="flex gap-3 rounded-2xl border border-border bg-panel/60 p-4">
              <span className="w-6 shrink-0 font-mono text-[13px] text-text-faint">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-[15px] font-medium text-text">
                  <Who who={p.who} /> {p.step}
                </p>
                <p className="mt-1 text-[14px] leading-relaxed text-text-muted">{p.what}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-12 grid gap-4 md:grid-cols-2" aria-label="The AI's role">
        <div className="rounded-2xl border border-accent/30 bg-accent/[0.05] p-5">
          <h2 className="flex items-center gap-2 text-[16px] font-semibold text-text"><Bot size={17} className="text-accent-strong" aria-hidden /> What the local AI does</h2>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[14px] leading-relaxed text-text-muted">{AI_DOES.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
        <div className="rounded-2xl border border-border bg-panel/60 p-5">
          <h2 className="flex items-center gap-2 text-[16px] font-semibold text-text"><Code2 size={17} className="text-text-muted" aria-hidden /> What the AI does not do</h2>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[14px] leading-relaxed text-text-muted">{AI_DOESNT.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
        <div className="rounded-2xl border border-border bg-panel/60 p-5 md:col-span-2">
          <h2 className="flex items-center gap-2 text-[16px] font-semibold text-text"><ShieldCheck size={17} className="text-supported" aria-hidden /> Checks that apply to every answer (AI or not)</h2>
          <ul className="mt-3 grid list-disc gap-x-8 gap-y-1.5 pl-5 text-[14px] leading-relaxed text-text-muted md:grid-cols-2">{CHECKS.map((x) => <li key={x}>{x}</li>)}</ul>
          <p className="mt-4 text-[13px] text-text-faint">
            Model: {appConfig.defaultModel} through Ollama, on this computer. The AI only proposes; code decides. When the AI is unavailable, the Chrome extension still checks claims in evidence-only mode using the same rules, with more careful labels (“Same details in independent reports”, “Reports say the opposite”, “Same topic — read carefully”).
          </p>
        </div>
      </section>

      <section className="mt-12" aria-labelledby="sources">
        <h2 id="sources" className="text-[13px] font-semibold uppercase tracking-[0.1em] text-text-faint">Where the evidence comes from — live</h2>
        <p className="mt-2 mb-5 max-w-[700px] text-[14px] leading-relaxed text-text-muted">
          A fixed, hand-verified list: {feeds.length} general feeds read for every check, and {topicFeeds.length} city and topic feeds chosen by the claim&apos;s keywords. These are the publishers&apos; official RSS feeds; individual articles are then opened to read the relevant paragraphs. A link you paste, or a source an article cites, may also be read.
        </p>
        <SourceStatus />
      </section>

      <section className="mt-12 grid gap-4 md:grid-cols-2" aria-label="Limits and privacy">
        <div className="rounded-2xl border border-border bg-panel/60 p-5">
          <h2 className="text-[16px] font-semibold text-text">Limits</h2>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[14px] leading-relaxed text-text-muted">
            <li>If credible outlets are all wrong (early breaking news), the answer is wrong too — it checks agreement with reporting, not reality itself.</li>
            <li>Feeds list recent items only (hours to weeks); older stories rely on GDELT (≈ 3 months) and the extension&apos;s 14-day index.</li>
            <li>Paywalled, script-only or regional-language articles may be unreadable — reported as such.</li>
            <li>The source list is a judgment: established outlets with editors and corrections policies.</li>
          </ul>
        </div>
        <div className="rounded-2xl border border-border bg-panel/60 p-5">
          <h2 className="text-[16px] font-semibold text-text">Privacy</h2>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[14px] leading-relaxed text-text-muted">
            <li>The AI runs on this computer; no cloud AI, no account.</li>
            <li>Search words go to the services above (feeds, Wikipedia, GDELT, Mastodon, and any keys you add).</li>
            <li>No conversation history is kept; a few hours of cached pages and results can be deleted in Settings.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
