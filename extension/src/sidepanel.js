import { pipeline, env } from "@huggingface/transformers";

// Always fetch model weights from the Hugging Face Hub (cached by the
// browser's Cache API after the first download) — never bundle multi-GB
// weights into the extension package itself.
env.allowLocalModels = false;

const CAPTION_MODEL = "Xenova/vit-gpt2-image-captioning";
const SMALL_ICON_PX = 48; // below this, nudge the user to consider alt=""

const statusBanner = document.getElementById("status-banner");
const scanBtn = document.getElementById("scan-btn");
const scanSummary = document.getElementById("scan-summary");
const resultsEl = document.getElementById("results");
const itemTemplate = document.getElementById("result-item-template");

let captionerPromise = null;

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

    results.push({ src, width: w, height: h });
  });

  return results;
}

function getCaptioner() {
  if (!captionerPromise) {
    showBanner("Loading the AI model — first run downloads it once (a few hundred MB) and caches it in the browser.", "info");

    captionerPromise = pipeline("image-to-text", CAPTION_MODEL, {
      dtype: "q8",
      progress_callback: (progress) => {
        if (progress.status === "progress" && progress.total) {
          const pct = Math.round((progress.loaded / progress.total) * 100);
          showBanner(`Downloading AI model… ${pct}%`, "info");
        }
      },
    })
      .then((captioner) => {
        hideBanner();
        return captioner;
      })
      .catch((err) => {
        captionerPromise = null; // allow retry on next click
        throw err;
      });
  }
  return captionerPromise;
}

async function generateSuggestion(item) {
  const captioner = await getCaptioner();
  const output = await captioner(item.src);
  const first = Array.isArray(output) ? output[0] : output;
  const caption = first?.generated_text?.trim();
  if (!caption) throw new Error("The model returned an empty caption.");
  return caption;
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
        const caption = await generateSuggestion(item);
        const isSmallIcon = item.width <= SMALL_ICON_PX && item.height <= SMALL_ICON_PX;

        suggestionEl.hidden = false;
        suggestionEl.textContent = isSmallIcon
          ? `alt="${caption}" — this is a small icon-sized image; if it's purely decorative, use alt="" instead`
          : `alt="${caption}"`;

        copyBtn.hidden = false;
        copyBtn.dataset.value = caption;
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
