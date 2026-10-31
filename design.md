# Design — Fact Checker

The Sunday Builds premium dark baseline: near-black/navy, a restrained ambient glow, crisp text
and generous space. One spacious conversation in which **the answer is the product**.

## Tokens ([`app/globals.css`](app/globals.css))

| Token | Value | Use |
|---|---|---|
| bg | `#05060a` | page |
| panel / panel-hover | `#0e1119` / `#141826` | cards, controls |
| border / border-strong | `#1c2333` / `#2a3348` | outlines |
| text / muted / faint | `#e8ebf2` / `#9aa3b5` / `#7a8396` | hierarchy |
| accent | `#6d8bff` | primary action, in-progress |
| supported | `#52d49b` | green verdicts |
| contradicted | `#f17c8b` | red verdicts |
| unresolved | `#e8bc72` | amber verdicts, demo label |
| neutral | `#aab3c5` | not fact-checkable, incomplete |

`faint` was raised from the template's `#5d6678` to pass AA.

**Measured contrast** (WCAG ratio). Every text color passes AA (≥ 4.5) on all three surfaces.

| Text color | on bg | on panel | on panel-hover |
|---|---|---|---|
| text | 16.97 | 15.81 | 14.81 |
| muted | 7.99 | 7.44 | 6.97 |
| faint | 5.32 | 4.96 | 4.64 |
| accent | 6.55 | 6.10 | 5.71 |
| supported | 10.85 | 10.11 | 9.47 |
| contradicted | 7.71 | 7.18 | 6.73 |
| unresolved | 11.45 | 10.66 | 9.99 |

The primary button's dark text on accent measures 6.55.

Color is never the only signal: every verdict has a **word** and an **icon** (check, cross,
info, question, minus).

## Type

- Inter Variable for the UI.
- **Instrument Serif** for the hero and the one-sentence finding. It gives an editorial,
  newsroom feel that sets this build apart from other Sunday builds.
- JetBrains Mono for passage ids and offsets.

## Screens

1. **Home:**
   - Minimal header: logo, *Fact Checker*, Sunday Builds chip, and a status pill (local AI and
     coverage) that opens Settings.
   - The serif hero.
   - One oversized composer (≈920 px wide, 230 px tall on desktop).
   - Three labelled samples, each marked Demo · fictional or Live · checked date.
   - One privacy line.
   - No tiles, sidebar or carousel.
2. **Investigating:**
   - The submission becomes a compact turn.
   - A card holds the verdict ring (a quiet turning accent arc), real elapsed time, the
     reference date, a 5-stage rail (stage-based, no fake percentage) and a live activity feed
     of real events.
3. **Answer, in this order:**
   1. Label and serif one-sentence finding.
   2. A short explanation with clickable `P#` chips.
   3. Per-claim cards.
   4. Supporting, conflicting and context passages; copies fold under "N more from the same
      origin".
   5. Still unresolved, limitations and evidence-check notes.
   6. Checked-at, reference date, cache/demo badges and coverage.
   7. Actions.
   8. Collapsible evidence map and sources.
   9. Collapsed activity.
   10. Follow-up composer.
4. **Inspector:**
   - A right drawer on desktop, a bottom sheet on mobile.
   - Shows the exact passage text and offsets, how the passage was used, publication/update/read
     times, access, independence status, related sources and other passages.
   - Opens the source only for safe http(s) URLs.
5. **Settings drawer:** evidence mode, local model and setup commands, sources and coverage,
   privacy and local data reset, about.

## Motion

- While running, the ring arc turns slowly and the active stage breathes.
- On completion the ring draws in the verdict color, the icon settles, and **one** outward pulse
  plays. Then nothing moves.
- Activity rows rise in as events arrive. The answer is never held back for an animation.
- `prefers-reduced-motion`: no rotation, no pulse, instant reveals. Verified by e2e.

## States designed

Empty, oversized input, invalid/blocked URL, PDF, ambiguous relative date (an assumption shown
with *Edit the claim*), Ollama offline or model missing (setup panel), provider warnings,
paywalled/blocked source, no relevant passages, conflicting evidence, derivative-only sources,
stream interrupted, stopped, incomplete, cached and demo.

## Responsive

The main flow has no horizontal overflow at 360 px (e2e). The map defaults to its list view on
narrow screens. The viewport uses `interactive-widget=resizes-content` for on-screen keyboards.
