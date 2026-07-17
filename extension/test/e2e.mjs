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
  <div style="height:4000px;">spacer to push the next image below the fold</div>
  <img src="https://example.com/lazy-below-the-fold.jpg" loading="lazy">
  <p style="color:#000;background:#fff;">Normal contrast paragraph, should not be flagged.</p>
  <p style="color:#999999;background:#ffffff;">Low contrast paragraph, should be flagged.</p>
  <div style="background-image:url(data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7); color:#999;">Text over a background image</div>
  <button aria-label="">
    <svg width="16" height="16"></svg>
  </button>
  <a href="/about">About us</a>
  <a href="/report">Click here</a>
  <a href="/expand/1" class="cdx-fake-button"><svg width="12" height="12"></svg></a>
  <a href="/expand/2" class="cdx-fake-button"><svg width="12" height="12"></svg></a>
  <a href="/expand/3" class="cdx-fake-button"><svg width="12" height="12"></svg></a>
  <a href="/photo/detail"><img src="https://example.com/link-wrapped-photo.jpg" width="80" height="80"></a>
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
    panel.on("pageerror", (err) => console.log("[panel pageerror]", err.message));
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

    await page.bringToFront();
    await panel.waitForTimeout(300);
    await panel.click("#scan-btn");
    // Check the label span specifically, not the button's whole textContent —
    // the button now wraps a label span + a spinner span, and the
    // whitespace/newlines between those nested elements are themselves part
    // of textContent, so a strict "=== 'Scan this page'" against the button
    // itself never matches even once everything is visually correct.
    await panel.waitForFunction(
      () => document.querySelector("#scan-btn .btn-label").textContent === "Scan this page",
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

    assert.equal(
      altCount,
      "(4)",
      "expected 4: main doc image, a lazy below-the-fold image, one in shadow DOM, one wrapped in a link"
    );
    assert.ok(
      altItems.some((t) => t.includes("lazy-below-the-fold")),
      "an unloaded/lazy image (naturalWidth=0 because it hasn't loaded, not because it's tiny) must still be flagged"
    );
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
    assert.equal(
      controlCount,
      "(2)",
      "the empty aria-label button, plus one grouped entry for the 3 identical cdx-fake-button links " +
        "— the link wrapping the unlabeled photo must NOT show up a third time, it's already in the alt-text category"
    );
    assert.ok(
      controlItems.some((t) => t.includes("appears 3 times")),
      "the 3 identical cdx-fake-button links should collapse into one entry with a count, not 3 near-duplicate cards"
    );
    assert.ok(
      !controlItems.some((t) => t.includes("/photo/detail")),
      "a link whose only content is an image already flagged as missing alt shouldn't be double-reported here"
    );
    assert.ok(
      !controlItems.some((t) => t.includes("Close dialog")),
      "the shadow DOM button with a real aria-label must not be flagged"
    );

    // Generate-suggestion click shouldn't hit the old CSP/jsdelivr bug,
    // whatever else happens to it in this environment (network permitting).
    // It also must never leave the button silently stuck: within a few
    // seconds it should either succeed or show a visible error — the
    // exact complaint that led to the stall-timeout fix was "I click it
    // and nothing happens at all".
    const generateBtn = panel.locator("#alt-results .btn-generate").nth(0);
    const secondGenerateBtn = panel.locator("#alt-results .btn-generate").nth(1);

    await generateBtn.click();

    // Only one caption request should ever run at a time (single shared,
    // single-threaded model) — clicking a second button while the first is
    // in flight used to silently queue it with zero visible indication,
    // which read as "the button just doesn't work" when the wait got long.
    const secondDisabledDuringFirst = await secondGenerateBtn.isDisabled();
    log("second generate button disabled while first is in flight", secondDisabledDuringFirst);
    assert.ok(secondDisabledDuringFirst, "other generate buttons must be disabled while one request is in flight");

    await panel.waitForFunction(
      () => {
        const btn = document.querySelector("#alt-results .btn-generate");
        const err = document.querySelector("#alt-results .item-error");
        return btn && (btn.textContent !== "Generating…" || (err && !err.hidden));
      },
      { timeout: 10000 }
    );

    const secondDisabledAfterFirst = await secondGenerateBtn.isDisabled();
    log("second generate button disabled after first finishes", secondDisabledAfterFirst);
    assert.ok(
      !secondDisabledAfterFirst,
      "other generate buttons must re-enable once the in-flight request finishes"
    );

    const btnTextAfter = await generateBtn.textContent();
    const errorVisible = await panel.locator("#alt-results .item-error").first().isVisible();
    log("generate button text after click", btnTextAfter);
    log("error box visible after click", errorVisible);
    assert.ok(
      btnTextAfter !== "Generating…" || errorVisible,
      "the button must not stay on 'Generating…' with no visible feedback at all"
    );
    assert.equal(jsdelivrErrors.length, 0, `jsdelivr/CSP errors should never appear: ${jsdelivrErrors.join("; ")}`);

    // --- Settings panel: saving/clearing a bring-your-own-key ---
    await panel.click("#settings-toggle");
    const statusBeforeSave = await panel.textContent("#api-key-status");
    log("api key status before save", statusBeforeSave);
    assert.match(statusBeforeSave, /free built-in AI/, "should default to the free local model with no key saved");

    await panel.fill("#api-key-input", "sk-test-fake-key-not-a-real-secret");
    await panel.click("#api-key-save");
    await panel.waitForFunction(
      () => document.getElementById("api-key-status").textContent.includes("your OpenAI key"),
      { timeout: 5000 }
    );
    const statusAfterSave = await panel.textContent("#api-key-status");
    log("api key status after save", statusAfterSave);
    assert.match(statusAfterSave, /your OpenAI key/, "status should reflect a saved key immediately");

    const clearBtnVisibleAfterSave = await panel.locator("#api-key-clear").isVisible();
    assert.ok(clearBtnVisibleAfterSave, "the 'remove key' button should appear once a key is saved");

    await panel.click("#api-key-clear");
    await panel.waitForFunction(
      () => document.getElementById("api-key-status").textContent.includes("free built-in AI"),
      { timeout: 5000 }
    );
    const statusAfterClear = await panel.textContent("#api-key-status");
    log("api key status after clear", statusAfterClear);
    assert.match(statusAfterClear, /free built-in AI/, "clearing the key should revert to the free local model");

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
