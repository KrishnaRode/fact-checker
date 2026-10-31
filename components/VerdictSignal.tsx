"use client";

import { Check, CircleSlash, HelpCircle, Info, Minus, Square, X } from "lucide-react";
import type { IconName, Tone } from "@/lib/client/verdicts";

const ICONS: Record<IconName, typeof Check> = {
  check: Check,
  cross: X,
  context: Info,
  question: HelpCircle,
  minus: Minus,
  incomplete: CircleSlash,
  stop: Square,
};

/**
 * The verdict signal. While investigating: a quiet accent arc turns (static with reduced
 * motion). On completion: the ring draws in the verdict color, the icon settles and ONE
 * outward pulse plays, then everything is still. Always paired with a text label nearby.
 */
export function VerdictSignal({ state, tone, icon, size = 76, label }: { state: "running" | "settled"; tone: Tone; icon: IconName | null; size?: number; label: string }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const Icon = icon ? ICONS[icon] : null;
  return (
    <div className={`tone-${state === "running" ? "pending" : tone} relative shrink-0`} style={{ width: size, height: size }} role="img" aria-label={label}>
      {state === "settled" && <span aria-hidden className="signal-pulse absolute inset-0 rounded-full border-2" style={{ borderColor: "var(--tone)" }} />}
      <svg viewBox="0 0 76 76" width={size} height={size} aria-hidden className="absolute inset-0">
        <circle cx="38" cy="38" r={r} fill="none" stroke="var(--color-border)" strokeWidth="3" />
        {state === "running" ? (
          <g className="motion-spin animate-spin-slow" style={{ transformOrigin: "38px 38px" }}>
            <circle cx="38" cy="38" r={r} fill="none" stroke="var(--color-accent)" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${c * 0.22} ${c}`} />
          </g>
        ) : (
          <circle
            key={tone + (icon ?? "")}
            cx="38"
            cy="38"
            r={r}
            fill="color-mix(in oklab, var(--tone) 10%, transparent)"
            stroke="var(--tone)"
            strokeWidth="3"
            className="draw"
            style={{ ["--len" as string]: c, transform: "rotate(-90deg)", transformOrigin: "38px 38px" }}
          />
        )}
      </svg>
      {state === "settled" && Icon && (
        <span key={icon} className="signal-settle absolute inset-0 grid place-items-center" style={{ color: "var(--tone)" }}>
          <Icon size={size * 0.36} strokeWidth={2.4} aria-hidden />
        </span>
      )}
    </div>
  );
}
