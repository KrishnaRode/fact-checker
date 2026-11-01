# Fact Checker

**Before you believe it.** Bring a claim. Follow the evidence.

*The Sunday Builds #17 — Free AI. Real Problems. Every Sunday.* · Built by Krishna Rode

People receive alarming headlines, WhatsApp forwards and confident claims. Fact Checker runs a
short, visible investigation. It retrieves sources, picks out the passages that matter, groups
copies of the same story, and has a **local** open-weight model assess the claim against that
evidence. You get an evidence-linked **assessment**: what the evidence supports, contradicts or
leaves unresolved, with every citation clickable.

It is not a truth oracle. Results are assessments *as of the time checked*, within the sources
searched. The tool cannot certify truth, judge intent or guarantee accuracy.

## Quick start

```bash
./run.sh
```

`run.sh` does the following:
- Checks Node.js (20.9+) and npm.
- Installs dependencies from `package-lock.json`.
- Checks that Ollama is running and the model from `app.config.ts` (`qwen3:4b`) is installed. It asks before downloading anything and prints the exact `ollama pull` command.
- Builds the app and serves it on **http://127.0.0.1:3016**. It binds to loopback only; if the port is taken it finds another one, and if Fact Checker is already running it reuses it.

`./run.sh --dev` starts the hot-reload dev server. `FACTCHECK_NO_OPEN=1` skips opening the browser.

npm alternative:

```bash
npm ci
ollama pull qwen3:4b
npm run build && npm start        # or: npm run dev
```

There is no Docker, login or cloud account.

## Chrome extension

Right-click any text on any page → **Fact-check**. The extension has two modes:
- **AI · local:** used when this app is running.
- **Evidence-only · no AI:** used otherwise. It runs fixed rules over a 14-day local index of
  55 news feeds (refreshed every 30 minutes in the background), plus GDELT (≈ 3 months,
  worldwide) and Wikipedia background, with separate, more careful labels.

### Add the extension to Chrome (local install)

You need Google Chrome 116 or newer (also works in Edge, Brave and other Chromium browsers),
plus Node.js for the one-time build.

**1. Build it**

```bash
cd ~/Documents/fact-checker
npm install                # first time only
npm run build:extension    # creates extension/dist
```

You should see `Built extension v0.1.0 → extension/dist`.

**2. Load it into Chrome**

1. Open a new tab and go to `chrome://extensions`.
2. Turn on **Developer mode** (toggle, top-right).
3. Click **Load unpacked** (top-left).
4. Select the folder `fact-checker/extension/dist`. Select the `dist` folder itself, not
   `extension` or the project root; it must contain `manifest.json`.
5. **Fact Checker** appears in the list with ID `jkccdjdinghdfoampelfceigjgkbkdfi`.

**3. Pin it**

Click the puzzle-piece icon in Chrome's toolbar, then the pin next to **Fact Checker**. The
magnifier icon now sits in the toolbar.

**4. Use it**

- **Check text on any page:** select the text, right-click → **Fact-check "…"**. The side panel
  opens and starts checking.
- **Type or paste a claim:** click the toolbar icon to open the side panel, paste, press **Enter**.
- **Mode chip** (top right of the panel):
  - 🟢 **AI · local** means the Fact Checker app is running and does the assessment.
  - 🟡 **Evidence-only · no AI** means the app isn't running; rules compare news reports instead.
  - Click the chip to change the app address, force evidence-only mode, or re-check the
    connection.

**5. Turn on AI mode (optional)**

Start the app in a terminal and leave it running:

```bash
cd ~/Documents/fact-checker && ./run.sh
```

Then click the mode chip → **Re-check connection**. It turns green. In AI mode,
**Open full investigation** opens the same claim in the app with the evidence map and
follow-up questions.

**Updating after code changes**

Run `npm run build:extension` again, then click the circular **reload** arrow on the Fact Checker
card in `chrome://extensions`. Close and reopen the side panel. If you also changed the app,
restart `./run.sh`.

**Removing it:** click **Remove** on the card in `chrome://extensions`.

**Troubleshooting**

| Symptom | Fix |
|---|---|
| "Manifest file is missing or unreadable" | You selected the wrong folder. Choose `extension/dist`, after running `npm run build:extension`. |
| No "Fact-check" item in the right-click menu | Text must be selected first. If it's still missing, reload the extension in `chrome://extensions`. |
| Panel stays on **Evidence-only** while the app runs | Make sure `./run.sh` is running and http://127.0.0.1:3016 opens. Then mode chip → **Re-check connection**. If you changed the port, enter the address in the panel. Restart `./run.sh` if your copy of the app predates the extension (older versions reject the extension). |
| AI mode says the model is missing | `ollama pull qwen3:4b`, then re-check. |
| "Errors" button on the extension card | Click it to read the error, rebuild, and reload the extension. |
| Chrome may warn about "developer mode extensions" | Normal for locally loaded extensions. Click the × to keep it, or publish it via the Chrome Web Store. |

More detail on how each mode decides, privacy and permissions:
[extension/README.md](extension/README.md).

## How it works

With the app running, open **http://127.0.0.1:3016/how-it-works**. It shows:
- the step-by-step pipeline, each step marked **Code** or **Local AI**;
- what the AI does and doesn't do, and the checks that overrule it;
- a **live table of every source** (55 feeds from 11 news publishers and 2 fact-checkers):
  whether each is answering, how many headlines it holds, and its newest item, with a
  **Check all feeds now** button;
- the search services, and the sources evaluated and *not* used, with reasons.

In short:
1. Code finds and reads the evidence from a fixed list of publishers' official feeds.
2. The local AI reads the quotes and proposes a label.
3. Code verifies every quote and applies the evidence rules. It can overrule the AI.
4. Code decides the final verdict.

## Local inference vs online retrieval

| | Where it runs |
|---|---|
| Language model (claim splitting, assessment, follow-ups) | **On your computer**, through Ollama. No cloud LLM and no fallback to one. |
| Finding current information (live mode) | **The internet.** Search terms go to the providers below. |

Local inference does **not** make live investigation offline. **Demo mode** (Settings → Evidence
mode) uses a bundled, fictional corpus with no network access. It is always labelled
**Demo · bundled evidence**.

## Supported inputs

- A pasted claim or short forward, in English. Unicode and original wording are preserved.
  Marathi/Hindi are not advertised: retrieval and assessment quality in those languages has not
  been verified.
- A public HTML news article URL. The article is treated as the *source of the claims*, never as
  corroboration of itself.
- The limit is 12,000 characters. Longer input is rejected with a message, never silently truncated.
- Up to **3 claims** are checked per quick investigation. Further claims are listed as *not checked*.
- PDFs and other non-HTML documents are reported as unsupported. Paste the text instead.

## Sources and coverage

**Core (no keys needed) → "Selected-source coverage"**
- **Selected news feeds:** 11 public RSS/Atom feeds (BBC ×2, The Hindu, Indian Express, Mint,
  NDTV, Guardian, NPR, Al Jazeera, Alt News, FactCheck.org). All were verified reachable on
  31 Oct 2026. Recent items only, kept in a bounded local index refreshed every 20 minutes.
- **Wikipedia** (MediaWiki API): background and entities, with revision ids. It is never the sole
  authority for breaking or contested claims.
- **GDELT DOC API:** worldwide news discovery. It is slow (11–17 s measured) and rate-limited
  (1 request per 5 s), so it runs in parallel and never delays first evidence.

- **Keyword routing:** places (cities, states, countries) and topics (politics, crime/courts,
  religion, technology, business, health, science, environment, sports, education) are extracted
  from the claim. They route the search to up to 6 matching feeds from a catalog of 41 city,
  national and section feeds (TOI/HT/IE city feeds, tech, business, health…). The routing is
  shown in the activity feed and the answer. Professions map to their beat: doctor → health,
  teacher → education.
- **Follow the story:** if a relevant report can't be read (paywall or bot block), its headline is
  searched again to find the same story at other outlets before concluding anything.

**Social media → low-reliability leads only**
- **Mastodon public hashtags** from the claim's keywords, via the official API with no login.
  Posts are labelled *Social lead · low reliability* and **never count toward a verdict or
  evidence strength**. A news link shared in a post is fetched and judged like any article.
- Not used, and why (checked 31 Oct 2026):
  - Reddit: robots.txt disallows all bots, and the API returns 403.
  - Bluesky public search: 403.
  - YouTube channel feeds: robots.txt disallows them.
  - X, Facebook, Instagram, WhatsApp: login or a paid API is required.
- Disable with `FACTCHECK_DISABLE_SOCIAL=1`.

**Optional (bring your own key) → "Broader web search enabled"**
- **Brave Search API:** set `BRAVE_SEARCH_API_KEY`.
- **Google Fact Check Tools:** set `GOOGLE_FACT_CHECK_API_KEY`. Existing fact-checks are
  attributed to their publisher and checked against the *exact* current claim, not adopted.

Copy `.env.example` to `.env.local`. Keys stay server-side and are redacted from errors. Neither
key is required. When a provider fails or is missing, the UI says so; it never presents that as
"zero results".

Fetching follows the safety rules in [ARCHITECTURE.md](ARCHITECTURE.md#network-safety) and
`robots.txt`. Paywalls and sign-in walls are never bypassed: a blocked page is reported as a
coverage limitation.

## Reading a verdict

| Signal | Meaning |
|---|---|
| 🟢 **Supported by the evidence** | A readable article passage directly supports the claim as stated. |
| 🔴 **Contradicted by the evidence** | A readable passage directly contradicts it. |
| 🟠 **Misleading / missing context** | Something real, misplaced in time, place or scope, or missing context. |
| 🟠 **Not enough evidence** | The sources searched don't settle it. *Not finding evidence ≠ false.* |
| ⚪ **Not fact-checkable** | Opinion, value judgement or prediction. |
| 🟠 **Mixed findings** | Claims got different labels, or some were not checked. |
| ⚪ **Investigation incomplete** | The run stopped (time budget, model offline, cancelled). **No verdict.** |

**Evidence strength** (Strong / Moderate / Thin) appears with green, red and missing-context
labels. Code works it out; the model doesn't:
- It is counted in **independent origins**, not websites: 20 copies of one wire story are one
  origin.
- It goes up when an original or fact-checking source is among them.
- It goes down for conflicting evidence, background-only sources (Wikipedia) or quote-only
  support.
- Social posts are listed but never add strength.

It is a labelled level with its reasons, not a probability and not a trust score for any outlet.

Green and red require cited, readable full-text evidence. The server checks this; the model's
proposal alone is not enough. A label changed by these checks shows *"The local model proposed …;
the evidence checks changed it."* Copies of one story count as **one** line of evidence. A quoted
statement shows that something was said, not that it is true.

## Data, cache and reset

- No conversation history is stored.
- `./.data/cache/` (or `FACTCHECK_DATA_DIR`) holds a bounded cache:
  - Fetched page text: up to 400 entries, 6 h.
  - The feed index: 900 items.
  - Validated assessments: up to 200 entries; 6 h, or 15 min for time-sensitive claims.
- Reads never extend expiry. **Refresh** bypasses the assessment cache and revalidates pages
  (conditional GET).
- **Reset:** Settings → *Reset local data*, `curl -X DELETE http://127.0.0.1:3016/api/cache`, or
  delete `.data/`.
- **Export:** Markdown or JSON. Includes timestamps, sources, findings, limitations and the
  live/demo label; never full article bodies.

## Checks

```bash
npm run typecheck && npm run lint && npm test         # 99 unit/integration tests
NEXT_DIST_DIR=.next-verify npm run build && npm run test:e2e   # 7 Playwright flows (real model)
npm run eval:fixtures                                  # semantic quality vs reviewed fixtures (needs Ollama)
npm run benchmark -- --base http://127.0.0.1:3016 --runs 3 --cold
```

## Troubleshooting

| Problem | Fix |
|---|---|
| "Ollama is not running" | `ollama serve` (or open the Ollama app), then Retry. Sources already found stay visible. |
| "qwen3:4b not installed" | `ollama pull qwen3:4b` |
| Many runs end "Investigation incomplete" | Your machine may be slow or under memory pressure (see BENCHMARKS.md). Close heavy apps, or use **Investigate further** for a longer budget. |
| "GDELT … time budget" warnings | Normal. GDELT is slow; set `FACTCHECK_DISABLE_GDELT=1` to skip it. |
| A news link "could not be read" | Paywall, robots.txt or a script-rendered page. Paste the article text. |
| Port busy | `run.sh` picks the next free port; or `PORT=3020 ./run.sh`. |

## Known limitations

- Coverage without keys is limited to selected feeds, Wikipedia and GDELT's recent window.
  Older, local or niche events are often **unresolved**.
- `qwen3:4b` is a small model. On the bundled fixtures it was within reviewed expectations on
  8/8 cases, and exactly matched 6/8. It tends to choose *Not enough evidence* where a reviewer
  chose *Misleading context* or *Contradicted*. Validation stops it from issuing unsupported
  green/red labels, but it cannot prove the model read a passage correctly.
- For twisted political claims, `qwen3:4b` often answers *Not enough evidence* where the evidence
  actually contradicts the claim (see DEMO.md). Guards stop false greens; they cannot create reds.
- Latency depends heavily on the machine; see [BENCHMARKS.md](BENCHMARKS.md).
- English only. No image, video or deepfake analysis. No social-network ingestion.

More: [project.md](project.md) · [design.md](design.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [DEMO.md](DEMO.md) · [BENCHMARKS.md](BENCHMARKS.md)
