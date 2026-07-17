const statusBanner = document.getElementById("status-banner");
const scanBtn = document.getElementById("scan-btn");
const scanSummary = document.getElementById("scan-summary");
const resultsEl = document.getElementById("results");
const itemTemplate = document.getElementById("result-item-template");

const ALT_TEXT_PROMPT = [
  "You are helping a developer fix web accessibility (WCAG 2.1) issues.",
  "Describe the attached image in one short, concrete sentence (max 15 words) suitable for the HTML alt attribute.",
  "Do not start with 'Image of' or 'Photo of'. Do not add a trailing period.",
  "If the image is purely decorative (an icon, spacer, background pattern, or divider with no informational content),",
  "respond with exactly: DECORATIVE",
].join(" ");

let modelSession = null;

function showBanner(message, kind = "info") {
  statusBanner.hidden = false;
  statusBanner.className = `banner banner-${kind}`;
  statusBanner.textContent = message;
}

function hideBanner() {
  statusBanner.hidden = true;
}

// Injected into the page. Must be fully self-contained (no outer references).
function scanPageForMissingAlt() {
  const MIN_SIZE = 8; // skip tracking pixels / spacers
  const imgs = Array.from(document.querySelectorAll("img"));
  const results = [];

  imgs.forEach((img) => {
    const alt = img.getAttribute("alt");
    const isMissing = alt === null;
    if (!isMissing) return;

    const src = img.currentSrc || img.src;
    if (!src) return;

    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w < MIN_SIZE || h < MIN_SIZE) return;

    const figcaption = img.closest("figure")?.querySelector("figcaption")?.textContent?.trim();

    results.push({
      src,
      width: w,
      height: h,
      nearbyText: (figcaption || img.title || "").slice(0, 200),
    });
  });

  return results;
}

async function checkAvailability() {
  if (!("LanguageModel" in self)) {
    showBanner(
      "Chrome's built-in AI (Prompt API) isn't available in this browser. You need Chrome 138+ on Windows/macOS/Linux/ChromeOS, with enough free disk space (~22GB) and either a GPU with 4GB+ VRAM or 16GB+ RAM / 4+ CPU cores.",
      "error"
    );
    scanBtn.disabled = true;
    return false;
  }

  try {
    const availability = await LanguageModel.availability({
      expectedInputs: [{ type: "image" }],
    });

    if (availability === "unavailable" || availability === "no") {
      showBanner(
        "This device doesn't meet the hardware requirements for Chrome's on-device AI. AltFix AI can't generate suggestions here.",
        "error"
      );
      scanBtn.disabled = true;
      return false;
    }

    if (availability === "downloadable" || availability === "after-download") {
      showBanner(
        "Chrome needs to download the on-device AI model the first time you generate a suggestion (a few GB, one-time). This can take a while depending on your connection.",
        "info"
      );
      return true;
    }

    hideBanner();
    return true;
  } catch (err) {
    showBanner(`Could not check AI availability: ${err.message}`, "error");
    scanBtn.disabled = true;
    return false;
  }
}

async function getSession() {
  if (modelSession) return modelSession;

  modelSession = await LanguageModel.create({
    expectedInputs: [{ type: "image" }],
    initialPrompts: [{ role: "system", content: ALT_TEXT_PROMPT }],
    monitor(m) {
      m.addEventListener("downloadprogress", (e) => {
        const pct = Math.round(e.loaded * 100);
        showBanner(`Downloading on-device AI model… ${pct}%`, "info");
        if (pct >= 100) hideBanner();
      });
    },
  });

  return modelSession;
}

async function generateSuggestion(src) {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`Could not fetch image (HTTP ${response.status})`);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const session = await getSession();
  const result = await session.prompt([
    {
      role: "user",
      content: [
        { type: "text", value: "Suggest alt text for this image." },
        { type: "image", value: bitmap },
      ],
    },
  ]);

  return result.trim();
}

function renderResults(items) {
  resultsEl.innerHTML = "";

  if (items.length === 0) {
    resultsEl.innerHTML = `<p class="empty-state">No images with missing alt text found on this page. ✅</p>`;
    return;
  }

  items.forEach((item) => {
    const node = itemTemplate.content.cloneNode(true);
    const thumb = node.querySelector(".item-thumb");
    const srcEl = node.querySelector(".item-src");
    const suggestionEl = node.querySelector(".item-suggestion");
    const errorEl = node.querySelector(".item-error");
    const generateBtn = node.querySelector(".btn-generate");
    const copyBtn = node.querySelector(".btn-copy");

    thumb.src = item.src;
    srcEl.textContent = item.src;

    generateBtn.addEventListener("click", async () => {
      generateBtn.disabled = true;
      generateBtn.textContent = "Generating…";
      errorEl.hidden = true;

      try {
        const suggestion = await generateSuggestion(item.src);
        const isDecorative = suggestion.toUpperCase() === "DECORATIVE";

        suggestionEl.hidden = false;
        suggestionEl.textContent = isDecorative
          ? 'Decorative image → use alt=""'
          : `alt="${suggestion}"`;

        copyBtn.hidden = false;
        copyBtn.dataset.value = isDecorative ? "" : suggestion;
        generateBtn.textContent = "Regenerate";
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Failed: ${err.message}`;
        generateBtn.textContent = "Retry";
      } finally {
        generateBtn.disabled = false;
      }
    });

    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(copyBtn.dataset.value ?? "");
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
    });

    resultsEl.appendChild(node);
  });
}

async function scanActiveTab() {
  scanBtn.disabled = true;
  scanBtn.textContent = "Scanning…";
  scanSummary.textContent = "";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab.");

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanPageForMissingAlt,
    });

    scanSummary.textContent = `${result.length} image${result.length === 1 ? "" : "s"} missing alt text`;
    renderResults(result);
  } catch (err) {
    showBanner(`Scan failed: ${err.message}. Some pages (chrome:// URLs, the Web Store) can't be scanned.`, "error");
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = "Scan this page";
  }
}

scanBtn.addEventListener("click", scanActiveTab);

checkAvailability();
