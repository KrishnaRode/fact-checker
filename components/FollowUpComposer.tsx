"use client";

import { ArrowUp, Search } from "lucide-react";
import { useRef, useState } from "react";
import { appConfig } from "@/app.config";
import type { FollowUpResponse, InvestigationResult } from "@/lib/contracts";
import { askFollowUp, HttpError } from "@/lib/client/api";
import { CitedText } from "./ClaimFindings";

type Turn = { id: number; question: string; answer: FollowUpResponse | null; error: string | null };

/**
 * Follow-ups answer only from this run's validated passages. Questions about newer facts or
 * new claims get a "start a new investigation" route instead of an answer from old evidence.
 */
export function FollowUpComposer({ result, onInspect, onInvestigate }: { result: InvestigationResult; onInspect: (id: string) => void; onInvestigate: (claim: string) => void }) {
  const [value, setValue] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const counter = useRef(0);
  const known = new Set(result.passages.map((p) => p.id));
  const abortRef = useRef<AbortController | null>(null);

  const ask = async () => {
    const q = value.trim();
    if (!q || busy || q.length > appConfig.maxFollowUpChars) return;
    const id = ++counter.current;
    setTurns((t) => [...t, { id, question: q, answer: null, error: null }]);
    setValue("");
    setBusy(true);
    abortRef.current = new AbortController();
    try {
      const answer = await askFollowUp(result.id, q, abortRef.current.signal);
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, answer } : x)));
    } catch (err) {
      const msg = err instanceof HttpError ? err.message : (err as Error)?.name === "AbortError" ? "Stopped." : "The follow-up could not be answered. Retry.";
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: msg } : x)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Follow-up questions" className="space-y-4">
      {turns.map((t) => (
        <div key={t.id} className="space-y-3 animate-rise">
          <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md border border-border bg-panel-hover px-4 py-2.5 text-[15px] text-text">{t.question}</p>
          {t.answer ? (
            <div className="rounded-2xl border border-border bg-panel/70 p-4 text-[15px] leading-relaxed text-text-muted">
              <p>
                <CitedText text={t.answer.answer} onInspect={onInspect} known={known} />
              </p>
              {t.answer.citedPassageIds.length > 0 && (
                <p className="mt-2 flex flex-wrap items-center gap-1 text-[12.5px] text-text-faint">
                  Cited:
                  {t.answer.citedPassageIds.map((id) => (
                    <button key={id} type="button" onClick={() => onInspect(id)} className="rounded-md border border-border-strong bg-panel-hover px-1.5 font-mono text-accent-strong hover:text-text">
                      {id}
                    </button>
                  ))}
                </p>
              )}
              {t.answer.notes.map((n) => (
                <p key={n} className="mt-2 text-[12.5px] text-text-faint">
                  {n}
                </p>
              ))}
              {t.answer.kind === "needs_new_investigation" && t.answer.suggestedClaim && (
                <button type="button" onClick={() => onInvestigate(t.answer!.suggestedClaim!)} className="mt-3 inline-flex items-center gap-2 rounded-full border border-accent/50 px-3.5 py-1.5 text-[13.5px] font-medium text-accent-strong hover:bg-accent/10">
                  <Search size={14} aria-hidden /> Investigate “{t.answer.suggestedClaim.length > 60 ? t.answer.suggestedClaim.slice(0, 60) + "…" : t.answer.suggestedClaim}”
                </button>
              )}
              <p className="mt-2 text-[11.5px] text-text-faint">{t.answer.mode === "demo" ? "Demo · bundled evidence" : "From this investigation's live evidence"}</p>
            </div>
          ) : t.error ? (
            <p className="rounded-2xl border border-contradicted/30 bg-contradicted/5 p-4 text-[14px] text-text-muted">{t.error}</p>
          ) : (
            <p className="flex items-center gap-2 px-1 text-[14px] text-text-faint">
              <span className="active-dot inline-block h-2 w-2 rounded-full bg-accent" aria-hidden /> Reading the evidence…
            </p>
          )}
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
        className="flex items-end gap-2 rounded-2xl border border-border bg-panel/80 p-2 pl-4 focus-within:border-accent/60"
      >
        <label htmlFor="follow-up" className="sr-only">
          Ask about the evidence
        </label>
        <textarea
          id="follow-up"
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
          placeholder="Ask about the evidence…"
          className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent py-2 text-[15px] text-text placeholder:text-text-faint focus:outline-none"
        />
        <button type="submit" disabled={!value.trim() || busy || value.length > appConfig.maxFollowUpChars} aria-label="Ask" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent text-bg transition hover:bg-accent-strong disabled:opacity-35">
          <ArrowUp size={17} strokeWidth={2.5} />
        </button>
      </form>
    </section>
  );
}
