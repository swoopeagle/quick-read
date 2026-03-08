/* =============================================================
   Split-Screen RSVP Reader — content.js
   All extension logic. No frameworks, no background worker.
   ============================================================= */

(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────
  const WPM_DEFAULT = 300;
  const WPM_MIN     = 100;
  const WPM_MAX     = 1000;
  const WPM_STEP    = 25;
  const SESSION_KEY = 'rsvp-ribbon-state';

  // Noise selectors applied to extracted article HTML.
  // Intentionally precise — avoid broad substrings like [class*="ad"]
  // which match "reader", "loading", "gradient", "badge", etc.
  const NOISE_SELECTORS = [
    'nav', 'header', 'footer', 'aside', 'iframe', 'script', 'style',
    // Ads — precise word-boundary patterns only
    '[class~="ad"]', '[id~="ad"]',
    '[class^="ad-"]', '[class*="-ad-"]', '[class$="-ad"]',
    '[id^="ad-"]',   '[id*="-ad-"]',   '[id$="-ad"]',
    '[class*="advertisement"]', '[class*="sponsored-content"]',
    'ins.adsbygoogle', '[data-ad-unit]', '[data-ad-slot]',
    // Layout noise
    '[class*="sidebar"]',  '[id*="sidebar"]',
    '[class*="related"]',  '[id*="related"]',
    '[class*="newsletter"]',
    '[class*="share-bar"]', '[class*="share-buttons"]',
    '[class*="comment"]',  '[id*="comment"]',
    '[class*="social-links"]',
    '[class*="subscription-wall"]', '[class*="paywall"]',
    '[class*="promo"]',
  ];

  // ── State ────────────────────────────────────────────────────
  let wpm           = WPM_DEFAULT;
  let words         = [];          // array of string | ImageSentinel
  let wordSpans     = [];          // cached DOM spans (1:1 with string entries)
  let currentIndex  = 0;
  let prevIndex     = null;
  let rafId         = null;
  let startTime     = null;
  let isPlaying     = false;
  let shadowRoot    = null;
  let ribbonStateBeforeFullscreen = null;

  // ── Shadow DOM host ──────────────────────────────────────────
  let shadowHost = null;

  // ── Ribbon & Pill elements (main document) ───────────────────
  let ribbon = null;
  let pill   = null;

  /* =============================================================
     RIBBON & PILL INJECTION
     ============================================================= */

  function getRibbonState() {
    return sessionStorage.getItem(SESSION_KEY) || 'expanded';
  }

  function setRibbonState(state) {
    sessionStorage.setItem(SESSION_KEY, state);
  }

  function createRibbon() {
    ribbon = document.createElement('div');
    ribbon.id = 'rsvp-ribbon';
    ribbon.innerHTML = `
      <span class="ribbon-logo">⚡</span>
      <span class="ribbon-text">Enter fullscreen to speed read</span>
      <button class="cta">Enter Fullscreen</button>
      <button class="minimize">—</button>
    `;

    ribbon.querySelector('button.cta').addEventListener('click', () => {
      document.documentElement.requestFullscreen().catch(() => {});
    });

    ribbon.querySelector('button.minimize').addEventListener('click', () => {
      minimizeRibbon();
    });

    document.body.appendChild(ribbon);
  }

  function createPill() {
    pill = document.createElement('div');
    pill.id = 'rsvp-pill';
    pill.innerHTML = `<span>⚡</span><span class="tooltip">Open Speed Reader</span>`;
    pill.style.display = 'none';

    pill.addEventListener('click', () => {
      restoreRibbon();
    });

    document.body.appendChild(pill);
  }

  function minimizeRibbon() {
    ribbon.style.transform = 'translateY(-100%)';
    ribbon.style.opacity = '0';
    setTimeout(() => {
      ribbon.style.display = 'none';
      pill.style.display = 'flex';
    }, 300);
    setRibbonState('minimized');
  }

  function restoreRibbon() {
    pill.style.display = 'none';
    ribbon.style.display = 'flex';
    // Force reflow before re-animating in
    ribbon.getBoundingClientRect();
    ribbon.style.transform = 'translateY(0)';
    ribbon.style.opacity = '1';
    setRibbonState('expanded');
  }

  function hideRibbonAndPill() {
    ribbon.style.display = 'none';
    pill.style.display = 'none';
  }

  function restoreRibbonToPreviousState() {
    if (ribbonStateBeforeFullscreen === 'minimized') {
      ribbon.style.display = 'none';
      pill.style.display = 'flex';
    } else {
      pill.style.display = 'none';
      ribbon.style.transform = 'translateY(0)';
      ribbon.style.opacity = '1';
      ribbon.style.display = 'flex';
    }
  }

  function initRibbonAndPill() {
    createRibbon();
    createPill();

    const savedState = getRibbonState();
    if (savedState === 'minimized') {
      // Show pill directly, skip ribbon animation
      ribbon.style.display = 'none';
      pill.style.display = 'flex';
    } else {
      ribbon.style.transform = 'translateY(0)';
      ribbon.style.opacity = '1';
      ribbon.style.display = 'flex';
    }
  }

  /* =============================================================
     ARTICLE EXTRACTION (Readability — runs at fullscreenchange)
     ============================================================= */

  function extractArticle() {
    // Try Readability first
    try {
      const documentClone = document.cloneNode(true);
      // charThreshold:0 disables Readability's internal 500-char minimum
      // so paywalled excerpts still get returned; we apply our own floor below.
      const article = new Readability(documentClone, { charThreshold: 0 }).parse();
      if (article && article.textContent.trim().length >= 100) {
        console.debug('[RSVP] Readability OK — words:', article.textContent.trim().split(/\s+/).length);
        return article;
      }
      console.debug('[RSVP] Readability returned:', article
        ? `${article.textContent.trim().length} chars (too short)`
        : 'null');
    } catch (e) {
      console.debug('[RSVP] Readability threw:', e.message);
    }

    // Fallback: grab the first recognisable article container directly
    return manualExtract();
  }

  // Ordered from most to least specific. Works well on Economist, NYT, WSJ.
  const ARTICLE_SELECTORS = [
    '[itemprop="articleBody"]',
    '[data-component="article-body"]',
    '[data-testid="article-body"]',
    'article .article__body',
    'article .body-content',
    'article .content',
    'article',
    '[role="article"]',
    'main .article-body',
    'main .post-content',
    'main .entry-content',
    'main .story-body',
    'main',
  ];

  function manualExtract() {
    for (const sel of ARTICLE_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const text = el.innerText || el.textContent || '';
      if (text.trim().length >= 100) {
        console.debug(`[RSVP] Manual extract via "${sel}" — ${text.trim().split(/\s+/).length} words`);
        return {
          title:       document.title,
          content:     el.innerHTML,
          textContent: text,
        };
      }
    }
    console.debug('[RSVP] All extraction methods failed.');
    return null;
  }

  /* =============================================================
     TOKENIZER
     Traverses article HTML and produces a flat array:
       words[] = [ ...string | ImageSentinel ]
     ImageSentinel = { type: 'image', src, alt, caption }
     ============================================================= */

  function tokenize(articleHTML) {
    const container = document.createElement('div');
    container.innerHTML = articleHTML;

    NOISE_SELECTORS.forEach(sel => {
      try { container.querySelectorAll(sel).forEach(el => el.remove()); }
      catch (_) {} // ignore invalid selectors on older engines
    });

    const result = [];
    walkNode(container, result);
    return result;
  }

  function walkNode(node, result) {
    for (const child of Array.from(node.childNodes)) {
      const tag = child.nodeType === Node.ELEMENT_NODE
        ? child.tagName.toLowerCase()
        : null;

      if (child.nodeType === Node.TEXT_NODE) {
        // Only process text if it has a meaningful block ancestor
        const tokens = child.textContent.split(/\s+/).filter(t => t.length > 0);
        tokens.forEach(t => result.push(t));

      } else if (tag === 'img') {
        const sentinel = makeImageSentinel(child);
        if (sentinel) result.push(sentinel);

      } else if (tag === 'figure') {
        const img = child.querySelector('img');
        const caption = child.querySelector('figcaption');
        if (img) {
          result.push({
            type: 'image',
            src: img.src || img.getAttribute('data-src') || '',
            alt: img.alt || '',
            caption: caption ? caption.textContent.trim() : ''
          });
        }
        // Also walk text inside figure (e.g. figcaption words)
        // — skip: captions are shown in image display mode

      } else if (['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                  'li', 'blockquote', 'td', 'th', 'div', 'section',
                  'article', 'main', 'span', 'a', 'strong', 'em',
                  'b', 'i', 'u'].includes(tag)) {
        walkNode(child, result);

      } else if (tag) {
        // Unknown element — still walk it for text
        walkNode(child, result);
      }
    }
  }

  function makeImageSentinel(imgEl) {
    const src = imgEl.src || imgEl.getAttribute('data-src') || '';
    if (!src) return null;
    return {
      type: 'image',
      src,
      alt: imgEl.alt || '',
      caption: ''
    };
  }

  /* =============================================================
     LEFT PANEL BUILDER
     Renders article HTML with <span class="word"> wrapping,
     interleaves image figure elements for visual context.
     Returns the list of word spans in DOM order.
     ============================================================= */

  function buildLeftPanel(articleHTML, wordTokens, shadow) {
    const panel = shadow.querySelector('#left-panel');

    const container = document.createElement('div');
    container.innerHTML = articleHTML;

    NOISE_SELECTORS.forEach(sel => {
      try { container.querySelectorAll(sel).forEach(el => el.remove()); }
      catch (_) {}
    });

    // Walk and wrap words, keep images in-place
    wrapWords(container);

    panel.appendChild(container);

    // Collect spans in order — 1:1 with string entries in wordTokens
    return Array.from(panel.querySelectorAll('.word'));
  }

  function wrapWords(node) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent;
        if (!text.trim()) continue;

        const frag = document.createDocumentFragment();
        const parts = text.split(/(\s+)/);
        parts.forEach(part => {
          if (/^\s+$/.test(part)) {
            frag.appendChild(document.createTextNode(part));
          } else if (part.length > 0) {
            const span = document.createElement('span');
            span.className = 'word';
            span.textContent = part;
            frag.appendChild(span);
          }
        });
        child.parentNode.replaceChild(frag, child);

      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        // Don't descend into images/figures — leave them intact
        if (tag !== 'img' && tag !== 'figure' && tag !== 'picture') {
          wrapWords(child);
        }
      }
    }
  }

  /* =============================================================
     FOCAL LETTER SPLIT
     Splits a word string into pre / focal / post spans.
     Focal index ≈ 30% into the word.
     ============================================================= */

  function renderFocalWord(word, container) {
    container.innerHTML = '';

    if (word.length <= 1) {
      const span = document.createElement('span');
      span.className = 'focal-letter';
      span.textContent = word;
      container.appendChild(span);
      return;
    }

    const focalIdx = Math.max(0, Math.floor(word.length * 0.3));

    const pre  = word.slice(0, focalIdx);
    const focal = word[focalIdx];
    const post = word.slice(focalIdx + 1);

    if (pre) {
      container.appendChild(document.createTextNode(pre));
    }
    const focalSpan = document.createElement('span');
    focalSpan.className = 'focal-letter';
    focalSpan.textContent = focal;
    container.appendChild(focalSpan);
    if (post) {
      container.appendChild(document.createTextNode(post));
    }
  }

  /* =============================================================
     HIGHLIGHT & SCROLL (O(1))
     ============================================================= */

  function highlightWord(index, shadow) {
    const panel = shadow.querySelector('#left-panel');
    if (!panel) return;

    if (prevIndex !== null && wordSpans[prevIndex]) {
      wordSpans[prevIndex].classList.remove('highlighted');
    }
    if (wordSpans[index]) {
      wordSpans[index].classList.add('highlighted');
      scrollToWord(wordSpans[index], panel);
    }
    prevIndex = index;
  }

  function scrollToWord(span, panel) {
    const panelRect = panel.getBoundingClientRect();
    const spanRect  = span.getBoundingClientRect();
    const target = panel.scrollTop
      + (spanRect.top - panelRect.top)
      - (panelRect.height / 2);
    panel.scrollTo({ top: target, behavior: 'smooth' });
  }

  /* =============================================================
     RAF-BASED RSVP ENGINE (drift-corrected)
     ============================================================= */

  function msPerWord() {
    return 60000 / wpm;
  }

  function startReader(shadow) {
    if (rafId) cancelAnimationFrame(rafId);
    isPlaying = true;
    updatePlayPauseButton(shadow);

    // Recalculate startTime so that currentIndex maps to "now"
    startTime = performance.now() - (currentIndex * msPerWord());
    rafId = requestAnimationFrame(() => tick(shadow));
  }

  function pauseReader(shadow) {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    isPlaying = false;
    updatePlayPauseButton(shadow);
  }

  function stopReader(shadow) {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    isPlaying = false;
  }

  function tick(shadow) {
    const now     = performance.now();
    const elapsed = now - startTime;
    const expected = Math.floor(elapsed / msPerWord());

    if (expected >= words.length) {
      stopReader(shadow);
      showDone(shadow);
      return;
    }

    if (expected !== currentIndex) {
      currentIndex = expected;
      const token = words[currentIndex];

      if (token && typeof token === 'object' && token.type === 'image') {
        pauseReader(shadow);
        showImageMode(token, shadow);
        return;
      }

      const rsvpWord = shadow.querySelector('#rsvp-word');
      if (rsvpWord) renderFocalWord(String(token), rsvpWord);

      highlightWord(currentIndex, shadow);
    }

    rafId = requestAnimationFrame(() => tick(shadow));
  }

  /* =============================================================
     IMAGE DISPLAY MODE
     ============================================================= */

  function showImageMode(sentinel, shadow) {
    const overlay = shadow.querySelector('#reader-overlay');
    overlay.classList.add('image-mode');

    // Hide left + right panels
    const leftPanel  = shadow.querySelector('#left-panel');
    const rightPanel = shadow.querySelector('#right-panel');
    leftPanel.style.display  = 'none';
    rightPanel.style.display = 'none';

    const display = document.createElement('div');
    display.id = 'image-display';

    const img = document.createElement('img');
    img.src = sentinel.src;
    img.alt = sentinel.alt || '';
    display.appendChild(img);

    if (sentinel.caption) {
      const cap = document.createElement('div');
      cap.className = 'img-caption';
      cap.textContent = sentinel.caption;
      display.appendChild(cap);
    }

    const btn = document.createElement('button');
    btn.id = 'btn-continue';
    btn.textContent = 'Continue Reading →';
    btn.addEventListener('click', () => {
      // Restore two-column layout
      overlay.classList.remove('image-mode');
      display.remove();
      leftPanel.style.display  = '';
      rightPanel.style.display = '';

      // Advance past this image sentinel and resume
      currentIndex++;
      if (currentIndex < words.length) {
        const nextToken = words[currentIndex];
        if (typeof nextToken === 'string') {
          const rsvpWord = shadow.querySelector('#rsvp-word');
          if (rsvpWord) renderFocalWord(nextToken, rsvpWord);
          highlightWord(currentIndex, shadow);
        }
      }
      startReader(shadow);
    });
    display.appendChild(btn);

    overlay.appendChild(display);
  }

  /* =============================================================
     DONE STATE
     ============================================================= */

  function showDone(shadow) {
    const rsvpWord = shadow.querySelector('#rsvp-word');
    if (rsvpWord) {
      rsvpWord.innerHTML = '✓ Done';
      rsvpWord.classList.add('done');
    }
    updatePlayPauseButton(shadow, true);
  }

  function clearDone(shadow) {
    const rsvpWord = shadow.querySelector('#rsvp-word');
    if (rsvpWord) rsvpWord.classList.remove('done');
  }

  /* =============================================================
     CONTROLS
     ============================================================= */

  function updatePlayPauseButton(shadow, forcePaused) {
    const btn = shadow.querySelector('#btn-playpause');
    if (!btn) return;
    if (forcePaused || !isPlaying) {
      btn.textContent = '▶';
    } else {
      btn.textContent = '⏸';
    }
  }

  function updateWpmInput(shadow) {
    const input = shadow.querySelector('#wpm-input');
    if (input) input.value = wpm;
  }

  function attachControls(shadow) {
    const btnSlower   = shadow.querySelector('#btn-slower');
    const btnFaster   = shadow.querySelector('#btn-faster');
    const btnPlayPause = shadow.querySelector('#btn-playpause');
    const wpmInput    = shadow.querySelector('#wpm-input');

    btnSlower.addEventListener('click', () => {
      wpm = Math.max(WPM_MIN, wpm - WPM_STEP);
      updateWpmInput(shadow);
      if (isPlaying) startReader(shadow); // restart with new interval
    });

    btnFaster.addEventListener('click', () => {
      wpm = Math.min(WPM_MAX, wpm + WPM_STEP);
      updateWpmInput(shadow);
      if (isPlaying) startReader(shadow);
    });

    btnPlayPause.addEventListener('click', () => {
      if (isPlaying) {
        pauseReader(shadow);
      } else {
        // If at end, restart from beginning
        if (currentIndex >= words.length) {
          currentIndex = 0;
          prevIndex = null;
          clearDone(shadow);
          // Pre-load first word
          preloadFirst(shadow);
        }
        startReader(shadow);
      }
    });

    // WPM input
    function applyWpmInput() {
      const raw = parseInt(wpmInput.value, 10);
      if (isNaN(raw)) {
        wpmInput.value = wpm; // revert
        return;
      }
      wpm = Math.min(WPM_MAX, Math.max(WPM_MIN, raw));
      wpmInput.value = wpm;
      if (isPlaying) startReader(shadow);
    }

    wpmInput.addEventListener('blur', applyWpmInput);
    wpmInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        applyWpmInput();
        wpmInput.blur();
      }
    });
  }

  /* =============================================================
     PRELOAD FIRST WORD
     ============================================================= */

  function preloadFirst(shadow) {
    if (words.length === 0) return;

    // Skip leading image sentinels for initial display
    let firstWordIdx = 0;
    while (firstWordIdx < words.length &&
           typeof words[firstWordIdx] !== 'string') {
      firstWordIdx++;
    }
    if (firstWordIdx >= words.length) return;

    currentIndex = firstWordIdx;
    const rsvpWord = shadow.querySelector('#rsvp-word');
    if (rsvpWord) renderFocalWord(words[firstWordIdx], rsvpWord);
    highlightWord(firstWordIdx, shadow);
  }

  /* =============================================================
     OVERLAY BUILD
     ============================================================= */

  function buildOverlay(article) {
    // Reset state
    words        = [];
    wordSpans    = [];
    currentIndex = 0;
    prevIndex    = null;
    rafId        = null;
    isPlaying    = false;
    wpm          = WPM_DEFAULT;

    // Create Shadow DOM host if not present
    if (!shadowHost) {
      shadowHost = document.createElement('div');
      shadowHost.id = 'rsvp-host';
      document.body.appendChild(shadowHost);
      shadowRoot = shadowHost.attachShadow({ mode: 'open' });

      // Inject styles into shadow root
      const styleLink = document.createElement('link');
      styleLink.rel  = 'stylesheet';
      styleLink.href = chrome.runtime.getURL('styles.css');
      shadowRoot.appendChild(styleLink);
    } else {
      // Clean up previous overlay if any
      const old = shadowRoot.querySelector('#reader-overlay');
      if (old) old.remove();
    }

    // Build overlay DOM
    const overlay = document.createElement('div');
    overlay.id = 'reader-overlay';

    // Left panel
    const leftPanel = document.createElement('div');
    leftPanel.id = 'left-panel';
    overlay.appendChild(leftPanel);

    // Right panel
    const rightPanel = document.createElement('div');
    rightPanel.id = 'right-panel';
    rightPanel.innerHTML = `
      <div id="rsvp-display">
        <div id="rsvp-word"></div>
      </div>
      <div id="controls">
        <button id="btn-slower" title="Slower (−${WPM_STEP} WPM)">−</button>
        <div class="wpm-group">
          <input id="wpm-input" type="number" min="${WPM_MIN}" max="${WPM_MAX}" value="${wpm}" />
          <span class="wpm-label">WPM</span>
        </div>
        <button id="btn-faster" title="Faster (+${WPM_STEP} WPM)">+</button>
        <button id="btn-playpause">▶</button>
      </div>
    `;
    overlay.appendChild(rightPanel);

    shadowRoot.appendChild(overlay);

    // Tokenize article
    words = tokenize(article.content);

    if (words.length === 0) {
      showExtractionError(shadowRoot);
      return;
    }

    // Build left panel with wrapped word spans
    wordSpans = buildLeftPanel(article.content, words, shadowRoot);

    // Attach controls
    attachControls(shadowRoot);

    // Pre-load first word (paused state)
    preloadFirst(shadowRoot);

    // Make host pointer-events active
    shadowHost.style.pointerEvents = 'all';
    shadowHost.style.width  = '100vw';
    shadowHost.style.height = '100vh';
  }

  function showExtractionError(shadow) {
    const rsvpWord = shadow.querySelector('#rsvp-word');
    if (rsvpWord) {
      rsvpWord.textContent = 'Could not extract article content from this page.';
      rsvpWord.style.fontSize = '1.4rem';
      rsvpWord.style.fontWeight = 'normal';
      rsvpWord.style.color = '#A1A1AA';
    }
  }

  /* =============================================================
     OVERLAY TEARDOWN
     ============================================================= */

  function teardownOverlay() {
    stopReader(null);
    if (shadowHost) {
      const overlay = shadowRoot.querySelector('#reader-overlay');
      if (overlay) overlay.remove();
      shadowHost.style.width  = '0';
      shadowHost.style.height = '0';
      shadowHost.style.pointerEvents = 'none';
    }
    // Restore page scroll
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }

  /* =============================================================
     FULLSCREEN LISTENER
     ============================================================= */

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
      // Record ribbon state before hiding
      ribbonStateBeforeFullscreen = getRibbonState();
      hideRibbonAndPill();

      // Suppress page scroll during overlay
      document.documentElement.style.overflow = 'hidden';

      // Extract and build (at this exact moment — SPA-safe)
      const article = extractArticle();
      if (article) {
        buildOverlay(article);
      } else {
        // Build empty overlay with error
        buildEmptyOverlayWithError();
      }
    } else {
      // Fullscreen exited
      teardownOverlay();
      restoreRibbonToPreviousState();
    }
  });

  function buildEmptyOverlayWithError() {
    if (!shadowHost) {
      shadowHost = document.createElement('div');
      shadowHost.id = 'rsvp-host';
      document.body.appendChild(shadowHost);
      shadowRoot = shadowHost.attachShadow({ mode: 'open' });

      const styleLink = document.createElement('link');
      styleLink.rel  = 'stylesheet';
      styleLink.href = chrome.runtime.getURL('styles.css');
      shadowRoot.appendChild(styleLink);
    }

    const overlay = document.createElement('div');
    overlay.id = 'reader-overlay';

    const leftPanel = document.createElement('div');
    leftPanel.id = 'left-panel';
    overlay.appendChild(leftPanel);

    const rightPanel = document.createElement('div');
    rightPanel.id = 'right-panel';
    rightPanel.innerHTML = `
      <div id="rsvp-display">
        <div id="rsvp-word" style="font-size:1.4rem;font-weight:normal;color:#A1A1AA;text-align:center;padding:2rem;">
          Could not extract article content from this page.
        </div>
      </div>
    `;
    overlay.appendChild(rightPanel);

    shadowRoot.appendChild(overlay);
    shadowHost.style.pointerEvents = 'all';
    shadowHost.style.width  = '100vw';
    shadowHost.style.height = '100vh';
  }

  /* =============================================================
     INIT
     ============================================================= */

  initRibbonAndPill();

})();
