# AltFix AI

Chrome extension that scans a webpage for `<img>` elements missing `alt` text
and drafts WCAG-ready suggestions using a small AI model that runs **fully
inside the browser** via WebAssembly/WebGPU ([transformers.js](https://huggingface.co/docs/transformers.js)).
No backend, no API keys, no per-request cost, no OS-level hardware gate.

## Why this exists

- Existing accessibility scanners (axe DevTools, WAVE, Siteimprove) **detect**
  missing alt text but don't draft the replacement — that's still manual work.
- Consumer-facing "overlay widget" tools (accessiBe, UserWay) are legally
  risky and reputationally toxic (FTC fined accessiBe $1M in 2025 for false
  compliance claims). This is deliberately **not** that: it's a developer tool
  that suggests fixes for a human to review and ship in their own code.
- Zero marginal cost: inference runs in the browser tab, so there's no
  OpenAI/Claude API bill scaling with usage.

## Why not Chrome's built-in Prompt API (v0.1 used it, this version doesn't)

The first version of this extension used Chrome's native `LanguageModel`
(Gemini Nano). We dropped it after checking the real requirements against our
own dev machine and the numbers didn't hold up:

- **Hardware gate excludes a lot of real users.** It requires 16GB+ RAM and
  4+ CPU cores, *or* a GPU with 4GB+ VRAM, plus ~22GB free disk. A 12GB RAM
  i7 laptop — a completely normal professional machine — doesn't qualify.
  Even among developers specifically (a segment that skews high-end), a real
  chunk still runs less than that; among the broader set of people who'd use
  an accessibility tool (marketers, content editors, small agencies), the
  exclusion is bigger.
- **Platform risk.** Chrome shipped the Prompt API in May 2026 over formal
  objections from Mozilla, Apple/WebKit, Microsoft, and the W3C TAG. Betting
  the whole product on a single-vendor, contested API is a bad trade for two
  people who can't afford to redo this later.
- **Reported reliability issues** even on qualifying hardware (slow
  first-run inference, several GB of forced download).

`transformers.js` runs a much smaller model (a few hundred MB, not several
GB) via WebAssembly everywhere, and via WebGPU automatically when available
for a speed boost — no Chrome version check, no OS-level RAM/GPU gate, and
it isn't tied to one browser vendor's roadmap. Trade-off: the model
(`Xenova/vit-gpt2-image-captioning`) is a dedicated image-captioning model,
not a general instruction-following LLM like Gemini Nano — it always
generates a caption rather than reasoning about "is this decorative", so we
handle that with a simple size heuristic instead (see `sidepanel.js`).

## Requirements to run/test

Any reasonably modern computer with a reasonably modern Chrome (or
Chromium-based browser). No specific RAM/GPU/disk minimum enforced by the
browser. First "Generate suggestion" click downloads the caption model
(~200-300MB) once; the browser caches it after that.

## Build & load it locally

```bash
cd extension
npm install
npm run build
```

Then:

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/dist/` folder
   (not `extension/` itself — that's the source, `dist/` is the built
   output).
4. Click the extension icon on any webpage to open the side panel.
5. Click **Scan this page**, then **Generate suggestion** on any result.

Re-run `npm run build` after any change to `src/` and reload the extension
from `chrome://extensions` (the reload icon on the card).

## Project structure

```
extension/
  package.json / vite.config.js   Build setup (Vite bundles the AI import)
  public/
    manifest.json                  MV3 manifest
    background.js                  Opens the side panel on icon click (no build needed)
    icons/                         Placeholder icons — replace before publishing
  src/
    sidepanel.html/css/js          All the actual logic — scan + AI + UI
  dist/                            Build output — this is what you load into Chrome (gitignored)
```

## Known limitations (MVP)

- Only scans `<img>` tags on the currently active tab, one page at a time —
  no full-site crawl yet.
- Images that require the page's cookies/auth to load may fail to fetch.
- No persistence — results disappear if you close the panel or reload.
- The captioning model can't tell "decorative" from "meaningful" the way an
  instruction-following LLM could — we flag small icon-sized images with a
  hint instead of a hard classification. Good enough for a human-reviewed
  suggestion, not perfect.
- No packaging/monetization yet. Deliberately: validate that people actually
  want this before building billing.

## Roadmap (only after we see real signal)

1. Ship this MVP, publish to the Chrome Web Store ($5 one-time developer
   registration fee), list it around "accessibility checker", "alt text
   generator", "WCAG audit".
2. Post in relevant communities (r/webdev, r/accessibility, agency
   Slack/Discord groups) — no ad spend.
3. If people install it and use it: add site-wide crawl + scheduled
   re-scans + exportable report as a paid tier (Stripe + Cloudflare Workers
   free tier, still no fixed hosting cost).
4. Only then worry about growth. Don't build the paywall before confirming
   anyone wants the free version.
