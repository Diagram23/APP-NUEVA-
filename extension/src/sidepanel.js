import { pipeline, env } from "@huggingface/transformers";

// Always fetch model weights from the Hugging Face Hub (cached by the
// browser's Cache API after the first download) — never bundle multi-GB
// weights into the extension package itself.
env.allowLocalModels = false;

// transformers.js hardcodes its WASM engine to fetch from jsdelivr's CDN
// by default (onnx.js sets this the moment the library is imported, before
// any of our own config runs) — the extension's CSP correctly blocks that
// as a remote script. Point it at the copies we bundle in public/ instead
// (see public/ort-wasm-simd-threaded.asyncify.{wasm,mjs}) and disable the
// worker-proxy path, which needs cross-origin isolation we don't have here.
env.backends.onnx.wasm.wasmPaths = {
  wasm: chrome.runtime.getURL("ort-wasm-simd-threaded.asyncify.wasm"),
  mjs: chrome.runtime.getURL("ort-wasm-simd-threaded.asyncify.mjs"),
};
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.numThreads = 1;

const CAPTION_MODEL = "Xenova/vit-gpt2-image-captioning";
const SMALL_ICON_PX = 48; // below this, nudge the user to consider alt=""
const MAX_LIST_ITEMS = 30; // per category, per frame — keeps huge pages usable

const statusBanner = document.getElementById("status-banner");
const scanBtn = document.getElementById("scan-btn");
const scanBtnLabel = scanBtn.querySelector(".btn-label");
const scanBtnSpinner = scanBtn.querySelector(".spinner");
const introHint = document.getElementById("intro-hint");
const resultsWrapper = document.getElementById("results-wrapper");

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

const controlCount = document.getElementById("control-count");
const controlResults = document.getElementById("control-results");
const controlTemplate = document.getElementById("control-item-template");

let captionerPromise = null;

function showBanner(message, kind = "info") {
  statusBanner.hidden = false;
  statusBanner.className = `banner banner-${kind}`;
  statusBanner.textContent = message;
}

function hideBanner() {
  statusBanner.hidden = true;
}

// Injected into every frame via chrome.scripting.executeScript. Must be
// fully self-contained (no references to anything outside this function
// body) — Chrome serializes the function body and runs it standalone.
function scanPageForA11yIssues() {
  const MIN_IMG_SIZE = 8; // skip tracking pixels / spacers
  const MAX_ITEMS = 30;
  const MAX_ELEMENTS_WALKED = 8000; // safety cap for huge/SPA pages

  function cappedPush(arr, item) {
    if (arr.length < MAX_ITEMS) arr.push(item);
  }

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

  function hasBackgroundImageBetween(el) {
    let node = el;
    while (node) {
      const bgImage = getComputedStyle(node).backgroundImage;
      if (bgImage && bgImage !== "none") return true;
      node = node.parentElement;
    }
    return false;
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

  // Collect every element in the light DOM plus anything nested inside
  // *open* shadow roots (closed shadow roots are invisible to any script,
  // by design — there's no way around that from the outside). Most
  // component libraries (Lit, Stencil, native <template>-based widgets)
  // use open mode, so this covers the common case.
  function collectAllElements(root, out) {
    if (out.length >= MAX_ELEMENTS_WALKED) return out;
    const children = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of children) {
      out.push(el);
      if (out.length >= MAX_ELEMENTS_WALKED) return out;
      if (el.shadowRoot) collectAllElements(el.shadowRoot, out);
    }
    return out;
  }

  function getElementByIdInRoot(root, id) {
    if (root.getElementById) return root.getElementById(id);
    return root.querySelector(`#${CSS.escape(id)}`);
  }

  function isVisible(el) {
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity) !== 0;
  }

  // Best-effort accessible name: aria-label > aria-labelledby > visible
  // text > title > alt text of a contained image. Not a full
  // implementation of the W3C accname spec, but covers the common cases.
  function accessibleNameHint(el) {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const root = el.getRootNode();
      const text = labelledby
        .split(/\s+/)
        .map((id) => getElementByIdInRoot(root, id)?.textContent?.trim() || "")
        .join(" ")
        .trim();
      if (text) return text;
    }

    const text = (el.textContent || "").trim();
    if (text) return text;

    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();

    const innerImgAlt = el.querySelector && el.querySelector("img[alt]")?.getAttribute("alt");
    if (innerImgAlt && innerImgAlt.trim()) return innerImgAlt.trim();

    return "";
  }

  // If this control's only content is an <img> that's already missing alt
  // text, it'll show up separately in the alt-text category too — same
  // root cause, same fix. Skip it here so it isn't reported twice.
  function wrapsImageMissingAlt(el) {
    const img = el.querySelector && el.querySelector("img");
    return !!img && img.getAttribute("alt") === null;
  }

  // Normalizes an element to a "shape" (tag + sorted class list) so that,
  // e.g., 20 near-identical citation-expand buttons on a Wikipedia page
  // collapse into one entry with a count instead of 20 near-duplicate cards.
  function elementShapeKey(el) {
    const classes = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean).sort().join(" ");
    return `${el.tagName}|${classes}`;
  }

  const allElements = collectAllElements(document, []);

  // --- Images missing alt text (<img>, <input type="image">, role="img") ---
  const missingAlt = [];
  let missingAltTotal = 0;
  allElements.forEach((el) => {
    const tag = el.tagName;
    const isImg = tag === "IMG";
    const isImageInput = tag === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "image";
    const isRoleImg = el.getAttribute("role") === "img";
    if (!isImg && !isImageInput && !isRoleImg) return;

    const alt = el.getAttribute("alt");
    const ariaLabel = el.getAttribute("aria-label");
    const hasAccessibleText = isRoleImg ? !!(ariaLabel && ariaLabel.trim()) : alt !== null;
    if (hasAccessibleText) return;

    const src = el.currentSrc || el.src || "";
    if (isImg || isImageInput) {
      if (!src) return;
      const w = el.naturalWidth || el.width || 0;
      const h = el.naturalHeight || el.height || 0;
      // Only skip on the "too small, probably a tracking pixel" heuristic
      // once the browser has actually finished loading the image (img.complete).
      // A lazy-loaded image below the fold reports naturalWidth/Height as 0
      // until it scrolls into view — that's "not loaded yet", not "tiny".
      // Treating those the same used to make every not-yet-loaded image on
      // a long page invisible to the scanner.
      if (el.complete && (w < MIN_IMG_SIZE || h < MIN_IMG_SIZE)) return;
      missingAltTotal++;
      cappedPush(missingAlt, { src, width: w, height: h, kind: isImageInput ? "input[type=image]" : "img" });
    } else {
      // role="img" on an arbitrary element (often an <svg> or <span> with a
      // background-image) — no pixel source we can feed to the captioner,
      // so just flag it for manual review.
      missingAltTotal++;
      cappedPush(missingAlt, { src: null, width: 0, height: 0, kind: `role="img" <${tag.toLowerCase()}>` });
    }
  });

  // --- Low-contrast text ---
  const lowContrast = [];
  let lowContrastTotal = 0;
  const seenContrast = new Set();

  for (const el of allElements) {
    if (!hasDirectText(el)) continue;
    if (!isVisible(el)) continue;

    const style = getComputedStyle(el);
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

    lowContrastTotal++;
    cappedPush(lowContrast, {
      text,
      tag: el.tagName.toLowerCase(),
      foreground: fgHex,
      background: bgHex,
      ratio: Math.round(ratio * 100) / 100,
      required,
      suggested: suggestFixedColor(fg, bg, required),
      uncertain: hasBackgroundImageBetween(el),
    });
  }

  // --- Form fields without an accessible label ---
  const missingLabels = [];
  let missingLabelsTotal = 0;
  const humanize = (s) =>
    s
      .replace(/[_-]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^./, (c) => c.toUpperCase());

  allElements
    .filter((el) => ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName))
    .forEach((field) => {
      const type = (field.getAttribute("type") || "").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image"].includes(type)) return;
      if (!isVisible(field)) return;

      const root = field.getRootNode();
      const id = field.getAttribute("id");
      const hasFor = id && root.querySelector(`label[for="${CSS.escape(id)}"]`);
      const wrappedInLabel = field.closest("label");
      const ariaLabel = field.getAttribute("aria-label");
      const ariaLabelledby = field.getAttribute("aria-labelledby");
      const hasAriaLabelledby =
        ariaLabelledby && ariaLabelledby.split(/\s+/).some((refId) => getElementByIdInRoot(root, refId));

      if (hasFor || wrappedInLabel || (ariaLabel && ariaLabel.trim()) || hasAriaLabelledby) return;

      const placeholder = field.getAttribute("placeholder");
      const name = field.getAttribute("name");
      const suggestion = (placeholder && placeholder.trim()) || (name ? humanize(name) : null);

      missingLabelsTotal++;
      cappedPush(missingLabels, {
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
  let genericLinksTotal = 0;
  allElements
    .filter((el) => el.tagName === "A" && el.hasAttribute("href"))
    .forEach((a) => {
      const text = (a.textContent || "").trim().toLowerCase().replace(/\s+/g, " ");
      if (!text || !GENERIC_LINK_TEXTS.has(text)) return;
      genericLinksTotal++;
      cappedPush(genericLinks, { text: a.textContent.trim(), href: a.href });
    });

  // --- Icon-only buttons/links with no accessible name at all ---
  // Grouped by "shape" (tag + class list) so a page that repeats the same
  // widget many times (e.g. a citation-expand button on every reference)
  // shows one entry with a count instead of a wall of near-duplicates.
  const controlGroups = new Map();
  allElements
    .filter((el) => el.tagName === "BUTTON" || (el.tagName === "A" && el.hasAttribute("href")))
    .forEach((el) => {
      if (!isVisible(el)) return;
      if (accessibleNameHint(el)) return;
      // Same root cause as an already-reported missing-alt image — fixing
      // that image's alt text fixes this control's accessible name too, so
      // don't report the same underlying problem twice.
      if (wrapsImageMissingAlt(el)) return;

      const key = elementShapeKey(el);
      const existing = controlGroups.get(key);
      if (existing) {
        existing.count++;
        return;
      }

      const href = el.tagName === "A" ? el.getAttribute("href") : null;
      const identifier = href || (el.textContent || "").trim() || "(no href or text)";

      controlGroups.set(key, {
        tag: el.tagName.toLowerCase(),
        identifier: identifier.length > 70 ? `${identifier.slice(0, 70)}…` : identifier,
        count: 1,
      });
    });

  const controlGroupList = Array.from(controlGroups.values());
  const unlabeledControls = controlGroupList.slice(0, MAX_ITEMS);

  return {
    missingAlt: { items: missingAlt, truncated: Math.max(0, missingAltTotal - missingAlt.length) },
    lowContrast: { items: lowContrast, truncated: Math.max(0, lowContrastTotal - lowContrast.length) },
    missingLabels: { items: missingLabels, truncated: Math.max(0, missingLabelsTotal - missingLabels.length) },
    missingLang,
    genericLinks: { items: genericLinks, truncated: Math.max(0, genericLinksTotal - genericLinks.length) },
    unlabeledControls: {
      items: unlabeledControls,
      truncated: Math.max(0, controlGroupList.length - unlabeledControls.length),
    },
  };
}

const STALL_TIMEOUT_MS = 45000; // no progress at all for this long = treat as hung, not just slow

// Attempt order for loading the model: first let transformers.js pick its
// own recommended per-component precision (usually the right call), and if
// that fails for any reason — like the "Missing required scale" session
// error some quantized decoder exports can throw — fall back to plain
// fp32 everywhere. Full precision never needs quantization scale metadata
// at all, so it can't hit that class of error; it's just a bigger download.
const DTYPE_ATTEMPTS = [undefined, "fp32"];

function attemptLoadPipeline(dtype, onProgress) {
  const options = { progress_callback: onProgress };
  if (dtype !== undefined) options.dtype = dtype;
  return pipeline("image-to-text", CAPTION_MODEL, options);
}

// Rejects if no progress_callback activity happens for STALL_TIMEOUT_MS —
// deliberately not a flat overall timeout, since a genuinely slow (but
// working) connection can legitimately take minutes to pull ~200-300MB.
// Without this, a hung fetch (bad network, blocked host, etc.) left the
// button stuck on "Generating…" forever with no feedback at all — which is
// indistinguishable from the button being broken.
function loadCaptionerWithStallGuard() {
  return new Promise((resolve, reject) => {
    let lastActivity = Date.now();
    const stallInterval = setInterval(() => {
      if (Date.now() - lastActivity > STALL_TIMEOUT_MS) {
        clearInterval(stallInterval);
        reject(
          new Error(
            "Download stalled — no progress for 45+ seconds. Check your internet connection and try again."
          )
        );
      }
    }, 2000);

    const onProgress = (progress) => {
      lastActivity = Date.now();
      if (progress.status === "progress" && progress.total) {
        const pct = Math.round((progress.loaded / progress.total) * 100);
        showBanner(`Downloading AI model… ${pct}%`, "info");
      }
    };

    (async () => {
      let lastError;
      for (const dtype of DTYPE_ATTEMPTS) {
        try {
          const captioner = await attemptLoadPipeline(dtype, onProgress);
          clearInterval(stallInterval);
          resolve(captioner);
          return;
        } catch (err) {
          lastError = err;
          // Try the next, safer fallback instead of giving up immediately.
        }
      }
      clearInterval(stallInterval);
      reject(lastError);
    })();
  });
}

function getCaptioner() {
  if (!captionerPromise) {
    showBanner(
      "Loading the AI model — first run downloads it once (a few hundred MB) and caches it in the browser.",
      "info"
    );

    captionerPromise = loadCaptionerWithStallGuard()
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

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function generateAltSuggestion(item) {
  if (!item.src) throw new Error("No image source to analyze — needs manual review.");
  const captioner = await getCaptioner();
  const output = await withTimeout(
    captioner(item.src),
    30000,
    "Timed out analyzing the image after 30s — the image host may be slow or unreachable. Try again."
  );
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

function countLabel(total, truncated) {
  return truncated > 0 ? `(${total}, showing first ${total - truncated})` : `(${total})`;
}

// Disables (or re-enables) every "Generate suggestion" button except the
// one currently running, so it's visually obvious only one caption request
// runs at a time — the model is a single shared, single-threaded instance,
// so a second click never actually ran in parallel, it just waited
// invisibly until now.
function setOtherAltButtonsDisabled(exceptBtn, disabled) {
  altResults.querySelectorAll(".btn-generate").forEach((btn) => {
    if (btn === exceptBtn) return;
    if (btn.dataset.permanentlyDisabled === "true") return;
    btn.disabled = disabled;
  });
}

function renderAltResults({ items, truncated }) {
  altCount.textContent = countLabel(items.length + truncated, truncated);
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

    if (item.src) {
      thumb.src = item.src;
    } else {
      thumb.remove();
    }
    srcEl.textContent = item.src ? `${item.kind}: ${item.src}` : `${item.kind} — no image source, needs manual review`;

    if (!item.src) {
      generateBtn.disabled = true;
      generateBtn.textContent = "No suggestion available";
      generateBtn.dataset.permanentlyDisabled = "true";
    }

    generateBtn.addEventListener("click", async () => {
      const previousLabel = generateBtn.textContent;
      generateBtn.disabled = true;
      generateBtn.textContent = "Generating…";
      errorEl.hidden = true;
      // Only one caption can actually run at a time (single shared,
      // single-threaded model) — clicking several buttons in a row used to
      // silently queue them behind each other with no indication why the
      // later ones seemed stuck. Make that explicit instead.
      setOtherAltButtonsDisabled(generateBtn, true);

      try {
        const caption = await generateAltSuggestion(item);
        const isSmallIcon = item.width <= SMALL_ICON_PX && item.height <= SMALL_ICON_PX;
        const attrValue = `alt="${caption}"`;

        suggestionEl.hidden = false;
        suggestionEl.textContent = isSmallIcon
          ? `${attrValue} — small icon-sized image; if purely decorative, use alt="" instead`
          : attrValue;

        // Copies the ready-to-paste attribute, not the bare caption text —
        // drop it straight into the <img> tag, no manual wrapping needed.
        copyBtn.hidden = false;
        copyBtn.textContent = "Copy";
        copyBtn.dataset.value = attrValue;
        generateBtn.textContent = "Regenerate";
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Failed: ${err.message}`;
        generateBtn.textContent = "Retry";
      } finally {
        generateBtn.disabled = false;
        setOtherAltButtonsDisabled(generateBtn, false);
      }
    });

    copyBtn.addEventListener("click", () => copyToClipboard(copyBtn, copyBtn.dataset.value));

    altResults.appendChild(node);
  });
}

function renderContrastResults({ items, truncated }) {
  contrastCount.textContent = countLabel(items.length + truncated, truncated);
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

    const uncertainNote = item.uncertain
      ? " ⚠️ There's a background image behind this text — the ratio above only accounts for the fallback color, verify manually."
      : "";

    if (item.suggested) {
      suggestionEl.textContent = `Suggested text color: ${item.suggested}${uncertainNote}`;
      // Copies a ready-to-paste CSS declaration, not the bare hex value.
      copyBtn.hidden = false;
      copyBtn.textContent = "Copy CSS";
      copyBtn.dataset.value = `color: ${item.suggested};`;
      copyBtn.addEventListener("click", () => copyToClipboard(copyBtn, copyBtn.dataset.value));
    } else {
      suggestionEl.textContent = `Couldn't fix by adjusting text color alone — try a different background.${uncertainNote}`;
    }

    contrastResults.appendChild(node);
  });
}

function renderLabelResults({ items, truncated }) {
  labelCount.textContent = countLabel(items.length + truncated, truncated);
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
      const attrValue = `aria-label="${item.suggestion}"`;
      suggestionEl.textContent = `Suggested: ${attrValue}`;
      // Copies the ready-to-paste attribute — drop it straight onto the
      // existing <input>/<select>/<textarea> tag, no new <label> element needed.
      copyBtn.hidden = false;
      copyBtn.textContent = "Copy aria-label";
      copyBtn.dataset.value = attrValue;
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

function renderLinkResults({ items, truncated }) {
  linkCount.textContent = countLabel(items.length + truncated, truncated);
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

function renderControlResults({ items, truncated }) {
  controlCount.textContent = countLabel(items.length + truncated, truncated);
  controlResults.innerHTML = "";

  if (items.length === 0) {
    controlResults.innerHTML = `<p class="empty-state">None found. ✅</p>`;
    return;
  }

  items.forEach((item) => {
    const node = controlTemplate.content.cloneNode(true);
    const textEl = node.querySelector(".item-text");
    const suggestionEl = node.querySelector(".item-suggestion");

    const countNote = item.count > 1 ? ` — appears ${item.count} times with this exact markup` : "";
    textEl.textContent = `<${item.tag}> ${item.identifier}${countNote}`;
    suggestionEl.textContent =
      "No text, aria-label, or title found — a screen reader can't tell what this does. Add an aria-label describing the action (e.g. aria-label=\"Close menu\").";

    controlResults.appendChild(node);
  });
}

// Merge same-shaped { items, truncated } results collected from multiple
// frames (main document + same-origin iframes) into one capped list.
function mergeListResults(perFrameResults, maxItems) {
  const allItems = [];
  let totalTruncated = 0;
  for (const r of perFrameResults) {
    if (!r) continue;
    allItems.push(...r.items);
    totalTruncated += r.truncated;
  }
  const items = allItems.slice(0, maxItems);
  const truncated = totalTruncated + Math.max(0, allItems.length - items.length);
  return { items, truncated };
}

async function scanActiveTab() {
  scanBtn.disabled = true;
  scanBtnLabel.textContent = "Scanning…";
  scanBtnSpinner.hidden = false;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab.");

    // allFrames also reaches same-origin iframes (cross-origin ones are
    // blocked by the browser regardless — Chrome just silently skips
    // injecting into those, no error surfaces for them individually).
    const frameResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: scanPageForA11yIssues,
    });

    const mainFrame = frameResults.find((f) => f.frameId === 0) ?? frameResults[0];
    const results = frameResults.map((f) => f.result).filter(Boolean);

    introHint.hidden = true;
    resultsWrapper.hidden = false;

    renderAltResults(mergeListResults(results.map((r) => r.missingAlt), MAX_LIST_ITEMS));
    renderContrastResults(mergeListResults(results.map((r) => r.lowContrast), MAX_LIST_ITEMS));
    renderLabelResults(mergeListResults(results.map((r) => r.missingLabels), MAX_LIST_ITEMS));
    renderLinkResults(mergeListResults(results.map((r) => r.genericLinks), MAX_LIST_ITEMS));
    renderControlResults(mergeListResults(results.map((r) => r.unlabeledControls), MAX_LIST_ITEMS));
    // Page language is a top-frame concept — a same-origin iframe missing
    // its own lang is a much lower-priority, noisier signal, so we only
    // report it for the main document.
    renderLangResult(mainFrame?.result?.missingLang ?? null);
  } catch (err) {
    showBanner(`Scan failed: ${err.message}. Some pages (chrome:// URLs, the Web Store) can't be scanned.`, "error");
  } finally {
    scanBtn.disabled = false;
    scanBtnLabel.textContent = "Scan this page";
    scanBtnSpinner.hidden = true;
  }
}

scanBtn.addEventListener("click", scanActiveTab);
