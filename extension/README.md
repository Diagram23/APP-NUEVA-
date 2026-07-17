# AltFix AI

Chrome extension that scans a webpage for `<img>` elements missing `alt` text
and drafts WCAG-ready suggestions using Chrome's built-in on-device AI
(Gemini Nano / Prompt API). Everything runs locally in the browser — no
backend, no API keys, no per-request cost.

## Why this exists

- Existing accessibility scanners (axe DevTools, WAVE, Siteimprove) **detect**
  missing alt text but don't draft the replacement — that's still manual work.
- Consumer-facing "overlay widget" tools (accessiBe, UserWay) are legally
  risky and reputationally toxic (FTC fined accessiBe $1M in 2025 for false
  compliance claims). This is deliberately **not** that: it's a developer tool
  that suggests fixes for a human to review and ship in their own code.
- Zero marginal cost: Gemini Nano runs on-device, so there's no OpenAI/Claude
  API bill scaling with usage.

## Requirements to run/test

- Chrome 138+ on Windows 10/11, macOS 13+, Linux, or ChromeOS (Chromebook
  Plus).
- ~22GB free disk space on the Chrome profile volume.
- GPU with >4GB VRAM, **or** 16GB+ RAM and 4+ CPU cores.
- On first use, Chrome downloads the on-device model (a few GB) — the panel
  shows download progress.

If your dev machine doesn't meet these specs, you won't be able to test the
AI part locally — the scan (finding images missing alt text) still works,
only the "Generate suggestion" step needs the model.

## Load it locally

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Click the extension icon on any webpage to open the side panel.
5. Click **Scan this page**, then **Generate suggestion** on any result.

## Project structure

```
extension/
  manifest.json      MV3 manifest (side panel, host_permissions for fetch)
  background.js       Opens the side panel on icon click
  sidepanel.html/css/js   All the actual logic — scan + AI + UI
  icons/               Placeholder icons — replace before publishing
```

No build step, no framework, no dependencies. Kept intentionally boring so
either of us can touch any file without ramp-up.

## Known limitations (MVP)

- Only scans `<img>` tags on the currently active tab, one page at a time —
  no full-site crawl yet.
- Images that require the page's cookies/auth to load may fail to fetch from
  the side panel context.
- No persistence — results disappear if you close the panel or reload.
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
