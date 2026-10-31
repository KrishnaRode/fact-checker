"use client";

import { Settings2 } from "lucide-react";
import type { HealthReport, Mode } from "@/lib/contracts";

export function connectionSummary(h: HealthReport | null): { tone: "ok" | "warn" | "bad" | "unknown"; text: string } {
  if (!h) return { tone: "unknown", text: "Checking local AI…" };
  if (!h.ollama.reachable) return { tone: "bad", text: "Ollama offline" };
  if (!h.ollama.modelInstalled) return { tone: "warn", text: `${h.ollama.model} not installed` };
  return { tone: "ok", text: `Local AI ready${h.ollama.warm ? "" : " · model will load on first use"}` };
}

/** Discreet header pill: local model state + coverage scope. Opens the settings drawer. */
export function ConnectionStatus({ health, mode, onOpen }: { health: HealthReport | null; mode: Mode; onOpen: () => void }) {
  const s = connectionSummary(health);
  const dot = s.tone === "ok" ? "bg-supported" : s.tone === "warn" ? "bg-unresolved" : s.tone === "bad" ? "bg-contradicted" : "bg-text-faint";
  const scope = mode === "demo" ? "Demo · bundled evidence" : health?.scope === "broader_web" ? "Broader web search" : "Selected-source coverage";
  return (
    <button type="button" onClick={onOpen} className="group inline-flex min-w-0 items-center gap-2 rounded-full border border-border bg-panel/70 py-1.5 pl-3 pr-2 text-[13px] text-text-muted backdrop-blur transition hover:border-border-strong hover:text-text" aria-label={`${s.text}. ${scope}. Open settings.`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
      <span className="hidden truncate md:inline">{s.text.replace(" · model will load on first use", "")}</span>
      <span className="hidden text-text-faint md:inline">·</span>
      <span className={`truncate ${mode === "demo" ? "text-unresolved" : ""}`}>{scope}</span>
      <Settings2 size={15} className="shrink-0 text-text-faint group-hover:text-text" aria-hidden />
    </button>
  );
}
