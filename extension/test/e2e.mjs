// End-to-end regression test: loads the real built extension (dist/) into
// an actual Chrome instance via Playwright and drives the side panel like a
// user would. Exercises every check the scanner does, including the harder
// cases (shadow DOM, same-origin iframes, icon-only controls, contrast
// behind a background image) so a future change can be verified without
// reinstalling the extension by hand every time.
//
// Run: npm run build && npm run test:e2e
//
// Does NOT assert on the AI caption ("Generate suggestion") result — that
// needs a real network path to Hugging Face's CDN to download model
// weights, which isn't guaranteed in every environment this runs in. It
// only asserts that clicking it doesn't produce the old
// jsdelivr/CSP error.

import { chromium } from "playwright-core";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, "..", "dist");
const PORT = 8777;

const iframeHtml = `<!doctype html>
<html><body>
  <input type="text" name="newsletter_email" placeholder="tucorreo@ejemplo.com">
</body></html>`;

const mainHtml = `<!doctype html>
<html>
<body>
  <img src="https://example.com/nonexistent-but-fine-for-dom-check.jpg" width="200" height="200">
  <p style="color:#000;background:#fff;">Normal contrast paragraph, should not be flagged.</p>
  <p style="color:#999999;background:#ffffff;">Low contrast paragraph, should be flagged.</p>
  <div style="background-image:url(data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7); color:#999;">Text over a background image</div>
  <button aria-label="">
    <svg width="16" height="16"></svg>
  </button>
  <a href="/about">About us</a>
  <a href="/report">Click here</a>
  <div id="shadow-host"></div>
  <iframe src="/iframe" width="300" height="100"></iframe>
  <script>
    const host = document.getElementById('shadow-host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<img src="https://example.com/shadow-photo.jpg" width="100" height="100">' +
      '<button aria-label="Close dialog">X</button>';
  </script>
</body>
</html>`;

function log(label, value) {
  console.log(`${label}:`, JSON.stringify(value));
}

async function main() {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(req.url.startsWith("/iframe") ? iframeHtml : mainHtml);
  });
  await new Promise((resolve) => server.listen(PORT, resolve));

  const userDataDir = path.join("/tmp", `altfix-e2e-profile-${Date.now()}`);
  const launchOptions = {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--headless=new",
      "--no-sandbox",
    ],
  };
  if (process.env.E2E_CHROME_PATH) {
    launchOptions.executablePath = process.env.E2E_CHROME_PATH;
  } else {
    launchOptions.channel = "chrome";
  }

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
    const extensionId = sw.url().split("/")[2];

    const page = await context.newPage();
    await page.goto(`http://localhost:${PORT}/`);

    const panel = await context.newPage();
    const jsdelivrErrors = [];
    panel.on("console", (msg) => {
      if (/jsdelivr|Refused to load/i.test(msg.text())) jsdelivrErrors.push(msg.text());
    });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

    await page.bringToFront();
    await panel.waitForTimeout(300);
    await panel.click("#scan-btn");
    await panel.waitForFunction(
      () => document.getElementById("scan-btn").textContent === "Scan this page",
      { timeout: 15000 }
    );

    const altCount = await panel.textContent("#alt-count");
    const altItems = await panel.$$eval("#alt-results .item-src", (els) => els.map((e) => e.textContent));
    const contrastCount = await panel.textContent("#contrast-count");
    const contrastSuggestions = await panel.$$eval("#contrast-results .item-suggestion", (els) =>
      els.map((e) => e.textContent)
    );
    const labelSuggestion = await panel.textContent("#label-results .item-suggestion");
    const linkCount = await panel.textContent("#link-count");
    const controlCount = await panel.textContent("#control-count");
    const controlItems = await panel.$$eval("#control-results .item-text", (els) => els.map((e) => e.textContent));

    log("alt count", altCount);
    log("alt items", altItems);
    log("contrast count", contrastCount);
    log("contrast suggestions", contrastSuggestions);
    log("label suggestion (from same-origin iframe)", labelSuggestion);
    log("link count", linkCount);
    log("control count", controlCount);
    log("control items", controlItems);

    assert.equal(altCount, "(2)", "expected 2 images missing alt: one in the main doc, one in shadow DOM");
    assert.ok(
      altItems.some((t) => t.includes("shadow-photo")),
      "shadow DOM image should be detected"
    );
    assert.equal(contrastCount, "(2)", "expected 2 low-contrast findings (plain + behind a background image)");
    assert.ok(
      contrastSuggestions.some((t) => t.includes("background image")),
      "the background-image case should carry the uncertainty warning"
    );
    assert.ok(
      contrastSuggestions.every((t) => t.includes("#757575")),
      "both low-contrast cases share the same fix suggestion for #999 on white"
    );
    assert.match(labelSuggestion, /tucorreo@ejemplo\.com/, "label suggestion should come from the same-origin iframe");
    assert.equal(linkCount, "(1)", "only 'Click here' is generic; 'About us' should not be flagged");
    assert.equal(controlCount, "(1)", "only the empty aria-label button should be flagged");
    assert.ok(
      !controlItems.some((t) => t.includes("Close dialog")),
      "the shadow DOM button with a real aria-label must not be flagged"
    );

    // Generate-suggestion click shouldn't hit the old CSP/jsdelivr bug,
    // whatever else happens to it in this environment (network permitting).
    await panel.click("#alt-results .btn-generate >> nth=0");
    await panel.waitForTimeout(5000);
    assert.equal(jsdelivrErrors.length, 0, `jsdelivr/CSP errors should never appear: ${jsdelivrErrors.join("; ")}`);

    console.log("\nAll assertions passed.");
  } finally {
    await context.close();
    server.close();
  }
}

main().catch((err) => {
  console.error("E2E TEST FAILED:", err);
  process.exit(1);
});
