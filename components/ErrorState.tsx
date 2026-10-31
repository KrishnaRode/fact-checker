"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";

const HINTS: Record<string, string> = {
  invalid_input: "Check the text or link and try again.",
  stream_interrupted: "The page lost its connection to the investigation (the server may have restarted). Your text is still in the box.",
  internal: "Something failed on the server. Retrying usually helps; the server log has details.",
  forbidden: "This app only accepts requests from its own page.",
};

/** Request/stream failures (operational problems — never a statement about the claim). */
export function ErrorState({ code, message, retryable, onRetry }: { code: string; message: string; retryable: boolean; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-2xl border border-contradicted/25 bg-contradicted/[0.04] p-5 animate-rise">
      <p className="flex items-center gap-2 text-[15px] font-medium text-text">
        <AlertTriangle size={17} className="text-contradicted" aria-hidden /> {message}
      </p>
      {HINTS[code] && <p className="mt-1.5 text-[14px] text-text-muted">{HINTS[code]}</p>}
      {retryable && (
        <button type="button" onClick={onRetry} className="mt-4 inline-flex items-center gap-2 rounded-full border border-border-strong px-4 py-2 text-[14px] text-text hover:border-text-faint">
          <RotateCcw size={14} aria-hidden /> Retry
        </button>
      )}
    </div>
  );
}
