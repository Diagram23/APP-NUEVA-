import { pipeline, env } from "@huggingface/transformers";

// Always fetch model weights from the Hugging Face Hub (cached by the
// browser's Cache API after the first download) — never bundle multi-GB
// weights into the extension package itself.
env.allowLocalModels = false;

// Force the plain single-threaded WASM backend instead of the
// multi-threaded one. The threaded variant tries to dynamically import an
// extra loader script from jsdelivr's CDN at runtime, which the extension's
// CSP (script-src 'self') correctly blocks — that's the
// "Failed to fetch dynamically imported module" error. Single-threaded is
// slower but loads entirely from the files we already bundled locally.
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.numThreads = 1;

const CAPTION_MODEL = "Xenova/vit-gpt2-image-captioning";
const SMALL_ICON_PX = 48; // below this, nudge the user to consider alt=""

const statusBanner = document.getElementById("status-banner");
const scanBtn = document.getElementById("scan-btn");

const altCount = document.getElementById("alt-count");
const altResults = document.getElementById("alt-results");
const altTemplate = document.getElementById("alt-item-template");

const contrastCount = document.getElementById("contrast-count");
const contrastResults = document.getElementById("contrast-results");
const contrastTemplate = document.getElementById("contrast-item-template");

const labelCount = document.getElementById("label-count");
const labelResults = document.getElementById("label-results");
const labelTemplate = document.getElementById("label-item-template");

const langCount = document.getElementById("lang-count");
const langResults = document.getElementById("lang-results");
const langTemplate = document.getElementById("lang-item-template");

const linkCount = document.getElementById("link-count");
const linkResults = document.getElementById("link-results");
const linkTemplate = document.getElementById("link-item-template");

let captionerPromise = null;

function showBanner(message, kind = "info") {
  statusBanner.hidden = false;
  statusBanner.className = `banner banner-${kind}`;
  statusBanner.textContent = message;
}

function hideBanner() {
  statusBanner.hidden = true;
}

// Injected into the page via chrome.scripting.executeScript. Must be fully
// self-contained (no references to anything outside this function body).
function scanPageForA11yIssues() {
  const MIN_IMG_SIZE = 8; // skip tracking pixels / spacers
  const MAX_CONTRAST_ITEMS = 25; // cap noise on huge pages

  function toRgb(colorStr) {
    const m = colorStr && colorStr.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  function relLuminance({ r, g, b }) {
    const chan = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  }

  function contrastRatio(rgb1, rgb2) {
    const l1 = relLuminance(rgb1);
    const l2 = relLuminance(rgb2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function effectiveBackground(el) {
    let node = el;
    while (node) {
      const bg = toRgb(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) return bg;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  function hasDirectText(el) {
    return Array.from(el.childNodes).some(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0
    );
  }

  function rgbToHex({ r, g, b }) {
    const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return `#${h(r)}${h(g)}${h(b)}`;
  }

  function rgbToHsl({ r, g, b }) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = (g - b) / d + (g < b ? 6 : 0);
          break;
        case g:
          h = (b - r) / d + 2;
          break;
        default:
          h = (r - g) / d + 4;
      }
      h /= 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
  }

  function hslToRgb({ h, s, l }) {
    h /= 360;
    s /= 100;
    l /= 100;
    if (s === 0) {
      const v = l * 255;
      return { r: v, g: v, b: v };
    }
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      r: hue2rgb(p, q, h + 1 / 3) * 255,
      g: hue2rgb(p, q, h) * 255,
      b: hue2rgb(p, q, h - 1 / 3) * 255,
    };
  }

  function suggestFixedColor(fg, bg, targetRatio) {
    const bgL = relLuminance(bg);
    const hsl = rgbToHsl(fg);
    const darken = bgL > 0.18; // light background -> darken text, dark background -> lighten text
    for (let i = 0; i <= 100; i++) {
      const l = darken ? Math.max(0, hsl.l - i) : Math.min(100, hsl.l + i);
      const candidate = hslToRgb({ h: hsl.h, s: hsl.s, l });
      if (contrastRatio(candidate, bg) >= targetRatio) return rgbToHex(candidate);
    }
    return null;
  }

  // --- Images missing alt text ---
  const missingAlt = [];
  Array.from(document.querySelectorAll("img")).forEach((img) => {
    if (img.getAttribute("alt") !== null) return;
    const src = img.currentSrc || img.src;
    if (!src) return;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w < MIN_IMG_SIZE || h < MIN_IMG_SIZE) return;
    missingAlt.push({ src, width: w, height: h });
  });

  // --- Low-contrast text ---
  const lowContrast = [];
  const seenContrast = new Set();
  const allEls = [document.body, ...document.body.querySelectorAll("*")];

  for (const el of allEls) {
    if (lowContrast.length >= MAX_CONTRAST_ITEMS) break;
    if (!el || !hasDirectText(el)) continue;

    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (parseFloat(style.opacity) === 0) continue;

    const fg = toRgb(style.color);
    if (!fg) continue;
    const bg = effectiveBackground(el);

    const fontSize = parseFloat(style.fontSize) || 16;
    const fontWeight = parseInt(style.fontWeight, 10) || 400;
    const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
    const required = isLarge ? 3 : 4.5;

    const ratio = contrastRatio(fg, bg);
    if (ratio >= required) continue;

    const text = el.textContent.trim().slice(0, 60);
    if (!text) continue;

    const fgHex = rgbToHex(fg);
    const bgHex = rgbToHex(bg);
    const key = `${text}|${fgHex}|${bgHex}`;
    if (seenContrast.has(key)) continue;
    seenContrast.add(key);

    lowContrast.push({
      text,
      tag: el.tagName.toLowerCase(),
      foreground: fgHex,
      background: bgHex,
      ratio: Math.round(ratio * 100) / 100,
      required,
      suggested: suggestFixedColor(fg, bg, required),
    });
  }

  // --- Form fields without an accessible label ---
  const missingLabels = [];
  const humanize = (s) =>
    s
      .replace(/[_-]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^./, (c) => c.toUpperCase());

  Array.from(document.querySelectorAll("input, select, textarea")).forEach((field) => {
    const type = (field.getAttribute("type") || "").toLowerCase();
    if (["hidden", "submit", "button", "reset", "image"].includes(type)) return;

    const style = getComputedStyle(field);
    if (style.display === "none" || style.visibility === "hidden") return;

    const id = field.getAttribute("id");
    const hasFor = id && document.querySelector(`label[for="${CSS.escape(id)}"]`);
    const wrappedInLabel = field.closest("label");
    const ariaLabel = field.getAttribute("aria-label");
    const ariaLabelledby = field.getAttribute("aria-labelledby");
    const hasAriaLabelledby =
      ariaLabelledby && ariaLabelledby.split(/\s+/).some((refId) => document.getElementById(refId));

    if (hasFor || wrappedInLabel || (ariaLabel && ariaLabel.trim()) || hasAriaLabelledby) return;

    const placeholder = field.getAttribute("placeholder");
    const name = field.getAttribute("name");
    const suggestion = (placeholder && placeholder.trim()) || (name ? humanize(name) : null);

    missingLabels.push({
      tag: field.tagName.toLowerCase(),
      type: type || "text",
      name: name || "",
      suggestion,
    });
  });

  // --- Missing page language ---
  const htmlLang = document.documentElement.getAttribute("lang");
  let missingLang = null;
  if (!htmlLang || !htmlLang.trim()) {
    const ogLocale = document.querySelector('meta[property="og:locale"]')?.getAttribute("content");
    const metaLang = document
      .querySelector('meta[http-equiv="content-language" i]')
      ?.getAttribute("content");
    const guess = (ogLocale || metaLang || navigator.language || "en").split(/[-_]/)[0];
    missingLang = { guess };
  }

  // --- Generic / non-descriptive link text ---
  const GENERIC_LINK_TEXTS = new Set([
    "click here", "here", "read more", "more", "learn more", "link", "click",
    "this link", "more info", "details", "continue", "more details",
    "clic aquí", "click aquí", "aquí", "leer más", "ver más", "más información", "más info",
  ]);

  const genericLinks = [];
  Array.from(document.querySelectorAll("a[href]")).forEach((a) => {
    if (genericLinks.length >= MAX_CONTRAST_ITEMS) return;
    const text = (a.textContent || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!text || !GENERIC_LINK_TEXTS.has(text)) return;
    genericLinks.push({ text: a.textContent.trim(), href: a.href });
  });

  return { missingAlt, lowContrast, missingLabels, missingLang, genericLinks };
}

function getCaptioner() {
  if (!captionerPromise) {
    showBanner(
      "Loading the AI model — first run downloads it once (a few hundred MB) and caches it in the browser.",
      "info"
    );

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

async function generateAltSuggestion(item) {
  const captioner = await getCaptioner();
  const output = await captioner(item.src);
  const first = Array.isArray(output) ? output[0] : output;
  const caption = first?.generated_text?.trim();
  if (!caption) throw new Error("The model returned an empty caption.");
  return caption;
}

async function copyToClipboard(button, value) {
  await navigator.clipboard.writeText(value ?? "");
  const original = button.textContent;
  button.textContent = "Copied!";
  setTimeout(() => (button.textContent = original), 1200);
}

function renderAltResults(items) {
  altCount.textContent = `(${items.length})`;
  altResults.innerHTML = "";

  if (items.length === 0) {
    altResults.innerHTML = `<p class="empty-state">None found. ✅</p>`;
    return;
  }

  items.forEach((item) => {
    const node = altTemplate.content.cloneNode(true);
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
        const caption = await generateAltSuggestion(item);
        const isSmallIcon = item.width <= SMALL_ICON_PX && item.height <= SMALL_ICON_PX;

        suggestionEl.hidden = false;
        suggestionEl.textContent = isSmallIcon
          ? `alt="${caption}" — small icon-sized image; if purely decorative, use alt="" instead`
          : `alt="${caption}"`;

        copyBtn.hidden = false;
        copyBtn.textContent = "Copy";
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

    copyBtn.addEventListener("click", () => copyToClipboard(copyBtn, copyBtn.dataset.value));

    altResults.appendChild(node);
  });
}

function renderContrastResults(items) {
  contrastCount.textContent = `(${items.length})`;
  contrastResults.innerHTML = "";

  if (items.length === 0) {
    contrastResults.innerHTML = `<p class="empty-state">None found. ✅</p>`;
    return;
  }

  items.forEach((item) => {
    const node = contrastTemplate.content.cloneNode(true);
    const fgSwatch = node.querySelector(".swatch-fg");
    const bgSwatch = node.querySelector(".swatch-bg");
    const textEl = node.querySelector(".item-text");
    const metaEl = node.querySelector(".item-meta");
    const suggestionEl = node.querySelector(".item-suggestion");
    const copyBtn = node.querySelector(".btn-copy");

    fgSwatch.style.backgroundColor = item.foreground;
    bgSwatch.style.backgroundColor = item.background;
    textEl.textContent = `<${item.tag}> "${item.text}"`;
    metaEl.textContent = `${item.foreground} on ${item.background} — ratio ${item.ratio}:1 (needs ${item.required}:1)`;

    if (item.suggested) {
      suggestionEl.textContent = `Suggested text color: ${item.suggested}`;
      copyBtn.hidden = false;
      copyBtn.dataset.value = item.suggested;
      copyBtn.addEventListener("click", () => copyToClipboard(copyBtn, copyBtn.dataset.value));
    } else {
      suggestionEl.textContent = "Couldn't fix by adjusting text color alone — try a different background.";
    }

    contrastResults.appendChild(node);
  });
}

function renderLabelResults(items) {
  labelCount.textContent = `(${items.length})`;
  labelResults.innerHTML = "";

  if (items.length === 0) {
    labelResults.innerHTML = `<p class="empty-state">None found. ✅</p>`;
    return;
  }

  items.forEach((item) => {
    const node = labelTemplate.content.cloneNode(true);
    const srcEl = node.querySelector(".item-src");
    const suggestionEl = node.querySelector(".item-suggestion");
    const copyBtn = node.querySelector(".btn-copy");

    srcEl.textContent = `<${item.tag}${item.name ? ` name="${item.name}"` : ""} type="${item.type}">`;

    if (item.suggestion) {
      suggestionEl.textContent = `Suggested label: "${item.suggestion}"`;
      copyBtn.hidden = false;
      copyBtn.dataset.value = item.suggestion;
      copyBtn.addEventListener("click", () => copyToClipboard(copyBtn, copyBtn.dataset.value));
    } else {
      suggestionEl.textContent = "No placeholder or name attribute to suggest from — needs manual review.";
    }

    labelResults.appendChild(node);
  });
}

function renderLangResult(issue) {
  langCount.textContent = issue ? "(1)" : "(0)";
  langResults.innerHTML = "";

  if (!issue) {
    langResults.innerHTML = `<p class="empty-state">Page declares a language. ✅</p>`;
    return;
  }

  const node = langTemplate.content.cloneNode(true);
  const suggestionEl = node.querySelector(".item-suggestion");
  const copyBtn = node.querySelector(".btn-copy");
  const value = `lang="${issue.guess}"`;

  suggestionEl.textContent = `Best guess: ${value} — verify this matches the page's actual content language before using it.`;
  copyBtn.hidden = false;
  copyBtn.dataset.value = value;
  copyBtn.addEventListener("click", () => copyToClipboard(copyBtn, copyBtn.dataset.value));

  langResults.appendChild(node);
}

function renderLinkResults(items) {
  linkCount.textContent = `(${items.length})`;
  linkResults.innerHTML = "";

  if (items.length === 0) {
    linkResults.innerHTML = `<p class="empty-state">None found. ✅</p>`;
    return;
  }

  items.forEach((item) => {
    const node = linkTemplate.content.cloneNode(true);
    const textEl = node.querySelector(".item-text");
    const metaEl = node.querySelector(".item-meta");
    const suggestionEl = node.querySelector(".item-suggestion");

    textEl.textContent = `"${item.text}"`;
    metaEl.textContent = item.href;
    suggestionEl.textContent =
      "Needs manual review — replace with text describing the destination (e.g. \"Download the 2026 report\" instead of \"click here\").";

    linkResults.appendChild(node);
  });
}

async function scanActiveTab() {
  scanBtn.disabled = true;
  scanBtn.textContent = "Scanning…";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab.");

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanPageForA11yIssues,
    });

    renderAltResults(result.missingAlt);
    renderContrastResults(result.lowContrast);
    renderLabelResults(result.missingLabels);
    renderLangResult(result.missingLang);
    renderLinkResults(result.genericLinks);
  } catch (err) {
    showBanner(`Scan failed: ${err.message}. Some pages (chrome:// URLs, the Web Store) can't be scanned.`, "error");
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = "Scan this page";
  }
}

scanBtn.addEventListener("click", scanActiveTab);
