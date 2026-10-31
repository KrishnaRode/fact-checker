# Fact Checker — Chrome extension

Right-click any text → **Fact-check "…"**. The side panel checks it against the news.

## Two modes, chosen automatically

| | **AI · local** (A) | **Evidence-only · no AI** (C) |
|---|---|---|
| When | The Fact Checker app is running (`./run.sh`) with its model | Otherwise, or if you choose it in the panel |
| Who decides | The app's full pipeline + local Ollama model + validators | Fixed rules in the extension |
| Labels | Supported / Contradicted / Misleading / Not enough evidence / … with evidence strength | Matches independent reports / Reports differ on details / Reports mention a denial / Reports conflict / A fact-checker disputes a similar claim / No matching coverage found |
| Your claim goes to | Only the app on this computer (`127.0.0.1`) | Nowhere. The extension downloads public news feeds and articles to compare locally |

Evidence-only mode reuses the app's own checks:
- keyword and topic routing to city and topic feeds;
- grouping copies of the same story;
- key-term coverage;
- **exact numbers and places** (localities count, so Wakad is in Pune);
- outcome words (acquitted, died, arrested…);
- denial wording;
- published fact-checks (Alt News, FactCheck.org).

Rules compare words, numbers, places and outcomes; they cannot read for meaning, so they never
say "true" or "false". If a matching report can't be read, it searches for the same story
elsewhere. Missing coverage is never treated as falsehood.

## Install (developer mode)

```bash
npm run build:extension
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose `extension/dist`.
3. Pin **Fact Checker**. Click it to open the side panel, or select text on any page and
   right-click → **Fact-check "…"**.

For AI mode, run the app with `./run.sh`. The panel's mode chip turns green (**AI · local**).
If the app runs at a different address, change it in the panel (click the mode chip).

## Privacy and permissions

- **Permissions:** `contextMenus`, `sidePanel`, `storage`. Host access is limited to the news
  publishers in the feed lists (derived from `app.config.ts` at build time) and the local app.
  There's no access to other sites or to your browsing history.
- **Selection:** the selected text stays in the extension's session storage until you check it.
- **Storage:** nothing is stored except your settings and a 20-minute feed cache.
- **App access:** the app accepts calls only from this extension's fixed ID
  (`jkccdjdinghdfoampelfceigjgkbkdfi`, set by the public key in the manifest). A Web Store build
  would get a different ID; add it with `FACTCHECK_EXTENSION_ORIGINS`.

## Tests

`tests/unit/extension-rules.test.ts` covers the rule engine. `tests/e2e/extension.spec.ts`
loads the unpacked extension in Chromium and tests:
- its stable ID;
- AI mode against the app;
- fallback to evidence-only mode with live feeds;
- the right-click handoff.
