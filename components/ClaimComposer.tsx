"use client";

import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef } from "react";
import { appConfig } from "@/app.config";

/**
 * The oversized composer. Enter submits, Shift+Enter adds a line, Cmd/Ctrl+Enter also
 * submits; IME composition never submits. Input over the limit is never truncated — the
 * action is disabled and the user is told how much to trim.
 */
export function ClaimComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  running,
  compact = false,
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  running: boolean;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const over = value.length - appConfig.maxInputChars;
  const empty = value.trim().length === 0;

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // Grow with content between the minimum and a viewport-relative maximum.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.max(240, window.innerHeight * 0.5))}px`;
  }, [value, compact]);

  const submit = () => {
    if (running || empty || over > 0) return;
    onSubmit();
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="group relative rounded-[22px] border border-border bg-panel/90 shadow-[0_24px_80px_-32px_rgba(61,87,201,0.45)] backdrop-blur transition-colors focus-within:border-accent/60"
    >
      <label htmlFor="claim-input" className="sr-only">
        Claim, forward or news article URL
      </label>
      <textarea
        id="claim-input"
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Something doesn't sound right? Paste the news, a forward, or a claim here…"
        aria-describedby="composer-hint"
        aria-invalid={over > 0}
        rows={compact ? 2 : 7}
        className={`scroll-thin block w-full resize-none bg-transparent px-5 pt-5 text-[17px] leading-relaxed text-text placeholder:text-text-faint focus:outline-none sm:px-6 sm:pt-6 sm:text-lg ${compact ? "min-h-[84px]" : "min-h-[180px] sm:min-h-[230px]"}`}
      />
      <div className="flex items-center gap-3 px-4 pb-4 pt-2 sm:px-5">
        <p id="composer-hint" className="min-w-0 flex-1 text-[13px] leading-snug text-text-faint">
          {over > 0 ? (
            <span className="text-contradicted">
              {over.toLocaleString("en-IN")} characters over the {appConfig.maxInputChars.toLocaleString("en-IN")} limit — paste the part you want checked.
            </span>
          ) : (
            <>
              <span className="hidden sm:inline">Text, a WhatsApp forward or a news link · </span>
              <kbd className="font-sans">Enter</kbd> to investigate · <kbd className="font-sans">Shift</kbd>+<kbd className="font-sans">Enter</kbd> new line
              {value.length > appConfig.maxInputChars * 0.8 && <span className="ml-2 tabular-nums">{value.length.toLocaleString("en-IN")}/{appConfig.maxInputChars.toLocaleString("en-IN")}</span>}
            </>
          )}
        </p>
        {running ? (
          <button type="button" onClick={onStop} className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full border border-border-strong bg-panel-hover px-4 text-sm font-medium text-text transition hover:border-text-faint active:scale-[0.98]">
            <Square size={14} fill="currentColor" aria-hidden /> Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={empty || over > 0}
            className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-accent px-5 text-[15px] font-semibold text-bg shadow-[0_8px_30px_-8px_rgba(109,139,255,0.7)] transition hover:bg-accent-strong active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            {appConfig.primaryAction} <ArrowUp size={16} strokeWidth={2.5} aria-hidden />
          </button>
        )}
      </div>
    </form>
  );
}
