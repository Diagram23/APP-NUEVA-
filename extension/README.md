# AltFix AI

Chrome extension that audits a webpage against the 5 most common documented
WCAG failures and drafts fixes for the ones that can be drafted — using a
small AI model that runs **fully inside the browser** via WebAssembly/WebGPU
([transformers.js](https://huggingface.co/docs/transformers.js)) for the one
check that needs it (alt text). No backend, no required API keys, no
per-request cost by default, no OS-level hardware gate.

## Optional: bring your own OpenAI key

The free local model (`Xenova/vit-gpt2-image-captioning`) is a small,
dedicated image captioner — it can miss details or get them wrong,
especially on photos of people or complex scenes (a real limitation, not a
bug — see "Known limitations" below). For users who want noticeably better
descriptions, the ⚙️ settings panel lets them paste an OpenAI API key. When
one is saved, alt-text generation switches to `gpt-4o-mini` (vision-capable,
a fraction of a cent per image) instead of the local model — billed by
OpenAI directly to the user, never to us. The key is stored only in
`chrome.storage.local` and only ever sent to `api.openai.com`. No key set
(the default) keeps everyone on the free, unlimited local path — this is
strictly additive, it doesn't touch the zero-cost default.

## What it checks

1. **Images missing alt text** — `<img>`, `<input type="image">`, and
   `role="img"` elements. AI-drafted suggestion via the in-browser model.
2. **Low-contrast text** — real WCAG relative-luminance contrast math (not
   an approximation), with a suggested fixed color. Flags when the text
   sits over a background *image* (not just a color) as uncertain, since
   the ratio then only accounts for the fallback color.
3. **Form fields without an accessible label** — checks `label[for]`,
   wrapping `<label>`, `aria-label`, `aria-labelledby`; suggests text from
   `placeholder`/`name` when nothing else is available.
4. **Missing page language** (`<html lang="...">`) — flags it and offers a
   best-guess replacement from `og:locale`/`content-language` meta tags or
   the browser's language, explicitly labeled as a guess to verify.
5. **Generic link text** ("click here", "read more", "más información", …
   in English and Spanish) — flagged for manual review; no auto-suggested
   replacement, since the right wording depends on context only a human
   should judge.
6. **Icon-only buttons/links with no accessible name at all** — e.g. a
   hamburger-menu or close button that's just an SVG with nothing a screen
   reader can announce.

Scans the active tab **and same-origin iframes** (`allFrames: true` —
cross-origin iframes are blocked by the browser itself, no way around
that), and walks into **open shadow roots**, so modern component-based
sites (Lit, Stencil, etc.) aren't invisible to it. Closed shadow roots are
unreachable by any script, by design — not something we can work around.

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

## Why `onnxruntime-web` is pinned to 1.24.3 (see `overrides` in package.json)

`@huggingface/transformers` normally pulls in its own pinned dev build of
`onnxruntime-web` (1.26.0-dev at time of writing). That version has a real,
reported regression loading certain quantized model weights: session
creation fails with `Missing required scale ... TransposeDQWeightsForMatMulNBits`
for this model's word-embedding weights specifically — confirmed as a
known onnxruntime issue where "1.25 broke it, 1.24 and older worked fine."
Trying different `dtype` options didn't help, because this specific repo's
exports all hit the same quantized embedding node regardless of overall
precision. The `overrides` field forces the last known-good stable release
instead. If you ever bump `@huggingface/transformers`, re-check whether
this override is still needed — it may get fixed upstream.

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

## Automated regression test

```bash
npm run build && npm run test:e2e
```

Loads the real built extension into an actual Chrome via Playwright and
drives the side panel like a user would — shadow DOM, a same-origin
iframe, an icon-only button, a background-image contrast case, a generic
link, all on one synthetic page — asserting each category finds exactly
what it should (see `test/e2e.mjs`). This is how changes get verified
without a manual reinstall-and-click cycle every time; it doesn't require
Chrome to already be on your PATH under a special name — Playwright will
use your system Chrome (`channel: "chrome"`) unless `E2E_CHROME_PATH` is
set. It does *not* assert on the actual AI caption text (that needs a real
network path to Hugging Face to download model weights) — only that
clicking "Generate suggestion" never reproduces the old CSP/jsdelivr bug.

## Project structure

```
extension/
  package.json / vite.config.js   Build setup (Vite bundles the AI import)
  public/
    manifest.json                  MV3 manifest
    background.js                  Opens the side panel on icon click (no build needed)
    icons/                         Placeholder icons — replace before publishing
    ort-wasm-simd-threaded.asyncify.{wasm,mjs}
                                   ONNX Runtime's own WASM engine, bundled locally on
                                   purpose (see comment in sidepanel.js) so the extension
                                   never needs to fetch it from jsdelivr's CDN at runtime
  src/
    sidepanel.html/css/js          All the actual logic — scan + AI + UI
  test/
    e2e.mjs                        Playwright regression test (see below)
  dist/                            Build output — this is what you load into Chrome (gitignored)
```

## Known limitations (honest, not swept under the rug)

- Only the current tab (+ its same-origin iframes) — no full-site crawl yet.
- Cross-origin iframes are invisible to the scanner; that's a browser
  security boundary, not something we chose to skip.
- Closed shadow roots are invisible to any script, including this one —
  open shadow roots are covered.
- Images that require the page's cookies/auth to load may fail to fetch.
- No persistence — results disappear if you close the panel or reload.
- The free local model can't tell "decorative" from "meaningful" the way an
  instruction-following model could (it's a plain captioner, not a
  chat/vision LLM) — we flag small icon-sized images with a hint instead of
  a hard classification. The optional OpenAI path (see above) *can* make
  this call and returns `alt=""` automatically for decorative images.
- The free local model is a dedicated photo-captioner, trained mostly on
  everyday photos — it does not do OCR (won't read text baked into an
  image) and will produce vague/wrong captions for charts, screenshots,
  infographics, and sometimes gets details wrong on photos of people. Always
  meant to be reviewed before pasting, never applied blind — the panel says
  so directly above every alt-text result. We looked for a better free/local
  model to swap in and didn't find a clearly-safer alternative that wouldn't
  risk reintroducing the onnxruntime compatibility issues we just fixed;
  worth revisiting later, not blocking anything today.
- Contrast math assumes a solid background color; when it detects a
  background *image* behind the text it says so explicitly rather than
  presenting a falsely-confident number.
- Generic-link-text and icon-only-control checks flag the problem but don't
  draft a replacement — the right wording depends on context only a human
  should judge, so we didn't fake a fix there.
- Each result category caps at 30 items per scan (merged across frames) so
  a page with hundreds of issues doesn't freeze the panel; it says how many
  more were found beyond that cap.
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
