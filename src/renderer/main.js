(function () {
  'use strict';
  if (location.protocol !== 'https:' || location.hostname !== '127.0.0.1') return;

  try {
    globalThis.__AGThinkingTranslator?.dispose?.();
  } catch {}

  const core = globalThis.__AGThinkingTranslatorCore;
  if (!core) return;

  const {
    PLUGIN_VERSION,
    DEFAULT_MODEL,
    DEFAULT_COLOR_THEME,
    COLOR_THEMES,
    CUSTOM_LANG_VALUE,
    SUPPORTED_LANGUAGES,
    FALLBACK_MODELS,
    DEFAULT_SETTINGS,
    getColorThemeTokens,
    normalizeSettings,
    getEffectiveTargetLang,
    normalizeThinkingText,
    computeCanonicalCacheKey,
    splitMarkdownIntoBlocks,
    groupModelsForCascade,
    resolveCascadeSelection,
    shouldTranslateText,
    shouldTranslateTitle,
    translateBoilerplateTitle,
    renderSafeMarkdownHtml,
    renderStreamingMarkdownHtml,
    escapeHtml
  } = core;

  const GLOBAL_STYLE_ID = 'ag-tt-global-styles';
  const THEME_VARS_STYLE_ID = 'ag-tt-theme-vars';
  const HOST_ID = 'ag-thinking-translator';
  const LIVE_STREAM_PAUSE_MS = 1400;
  const STREAM_FRAME_INTERVAL_MS = 32;
  const HOVER_DWELL_MS = 380;
  const MAX_CONCURRENT_BATCH_REQUESTS = 2;
  const TITLE_COALESCE_MS = 30;
  const PARA_COALESCE_MS = 45;
  const CLIENT_BATCH_MAX_ITEMS = 12;
  const CLIENT_BATCH_MAX_CHARS = 4200;
  const HOVER_HEADER_SELECTOR = 'button[data-testid="thinking-collapsible-trigger"], button[data-testid="tool-group-collapsible"], button[data-testid="worked-for-collapsible"], button[data-testid="progress-updates-collapsible"]';
  const TRANSLATABLE_TAGS = new Set(['P', 'UL', 'OL', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

  let settings = normalizeSettings(DEFAULT_SETTINGS);
  let models = FALLBACK_MODELS.slice();
  let preferredLevelKey = resolveCascadeSelection(groupModelsForCascade(models), settings.model).levelKey || 'medium';
  let cacheCount = 0;
  let disposed = false;
  let popoverOpen = false;
  let activeTranslations = 0;
  let lastErrorMsg = '';
  let lastAppliedThemeKey = '';
  let scanTimer = 0;
  let titleSyncRaf = 0;
  let pollTimer = 0;
  let batchFlushTimer = 0;
  let batchFlushAt = 0;
  let rafId = 0;
  let lastAnimTick = 0;
  let hoverDwellTimer = 0;
  let hoveredHeaderBtn = null;
  let hoverBtnEl = null;
  let activeHoverHost = null;
  let activeHoverTarget = null;
  let themeObserver = null;
  let domObserver = null;
  let titlebarResizeObserver = null;
  let observedTitlebar = null;
  let docClickHandler = null;
  let docMouseOverHandler = null;
  let docMouseOutHandler = null;
  let reqSeq = 0;
  let initialScanDone = false;

  // Wrapper, title, group & paragraph state tracking
  const blockStates = new WeakMap();
  const trackedWrappers = new Set();
  const trackedManualGroups = new Set();
  const manualGroupStates = new WeakMap();
  const titleStates = new Map(); // containerEl -> TitleEntry
  const seenToolGroups = new WeakMap(); // buttonEl -> last thinking fingerprint
  const historicalToolGroups = new WeakSet();
  const toolGroupStates = new WeakMap(); // buttonEl -> Array<FiberBlockState>

  // Client-side canonical memory cache (canonKey -> translation) & negative check cache
  const memCache = new Map();
  const checkedCanonMisses = new Set();

  // 3-tier coalescing batch scheduler: Priority 0 titles > Priority 1 expanded/live prose > Priority 2 bg prose
  let activeBatchCount = 0;
  const titleQueue = [];
  const highQueue = [];
  const bgQueue = [];
  const activeTasks = new Map(); // taskKey -> Task

  /* @INSERT_STYLES_AND_TEMPLATE */

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-dock', 'fixed');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${TT_STYLES}</style>${TT_TEMPLATE}`;

  const el = id => shadow.getElementById(id);

  // =========================================================================
  // Transport Bridge: Electron Preload IPC or Live CDP HTTP NDJSON Bridge
  // =========================================================================
  function getLiveInfo() {
    return typeof window !== 'undefined' && window.__AGThinkingTranslatorLive ? window.__AGThinkingTranslatorLive : null;
  }

  function getIpcApi() {
    const ipc = typeof window !== 'undefined' && window.thinkingTranslatorAPI ? window.thinkingTranslatorAPI : null;
    if (!ipc) return null;
    const live = getLiveInfo();
    if (live && live.version === PLUGIN_VERSION && ipc.version !== PLUGIN_VERSION) {
      return null;
    }
    return ipc;
  }

  async function callBridge(route, payload = {}) {
    const ipc = getIpcApi();
    if (ipc) {
      if (route === '/get-settings') return ipc.getSettings();
      if (route === '/save-settings') return ipc.saveSettings(payload);
      if (route === '/list-models') return ipc.listModels(payload);
      if (route === '/check-cache' && typeof ipc.checkCache === 'function') return ipc.checkCache(payload);
      if (route === '/clear-cache') return ipc.clearCache();
      if (route === '/status') return ipc.getStatus();
    }
    const live = getLiveInfo();
    if (!live || !live.port || !live.token) {
      throw new Error('翻译后端桥接未连接');
    }
    const res = await fetch(`http://127.0.0.1:${live.port}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AG-TT-Token': live.token
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      throw new Error(`桥接请求失败 (HTTP ${res.status})`);
    }
    return res.json();
  }

  async function consumeNdjsonPost(route, payload, onLine) {
    const live = getLiveInfo();
    if (!live || !live.port || !live.token) {
      throw new Error('翻译后端桥接未连接');
    }
    const res = await fetch(`http://127.0.0.1:${live.port}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AG-TT-Token': live.token
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok || !res.body) {
      throw new Error(`翻译请求失败 (HTTP ${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finalRes = null;

    const handleLine = raw => {
      const t = raw.trim();
      if (!t) return;
      let obj;
      try { obj = JSON.parse(t); } catch { return; }
      if (obj.event === 'result') {
        finalRes = obj.result;
      } else if (typeof onLine === 'function') {
        onLine(obj);
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) handleLine(line);
    }
    if (buf.trim()) handleLine(buf);
    return finalRes || { ok: false, error: '未收到翻译结果' };
  }

  async function callTranslate(payload, onProgress) {
    const ipc = getIpcApi();
    if (ipc && typeof ipc.translate === 'function') {
      const requestId = `tt-${Date.now()}-${++reqSeq}`;
      let unsubscribe = null;
      if (typeof ipc.onProgress === 'function') {
        unsubscribe = ipc.onProgress(ev => {
          if (ev && ev.requestId === requestId && typeof onProgress === 'function') {
            onProgress(ev);
          }
        });
      }
      try {
        return await ipc.translate({ ...payload, requestId });
      } finally {
        try { unsubscribe?.(); } catch {}
      }
    }

    return consumeNdjsonPost('/translate', payload, obj => {
      if (obj.event === 'progress' && typeof onProgress === 'function') {
        onProgress(obj);
      }
    });
  }

  async function callTranslateBatch(payload, onItemProgress) {
    const ipc = getIpcApi();
    if (ipc && typeof ipc.translateBatch === 'function') {
      const requestId = `ttb-${Date.now()}-${++reqSeq}`;
      let unsubscribe = null;
      if (typeof ipc.onProgress === 'function') {
        unsubscribe = ipc.onProgress(ev => {
          if (ev && ev.requestId === requestId && ev.event === 'item_progress' && typeof onItemProgress === 'function') {
            onItemProgress(ev);
          }
        });
      }
      try {
        return await ipc.translateBatch({ ...payload, requestId });
      } finally {
        try { unsubscribe?.(); } catch {}
      }
    }

    const live = getLiveInfo();
    if (live && live.port && live.token) {
      return consumeNdjsonPost('/translate-batch', payload, obj => {
        if (obj.event === 'item_progress' && typeof onItemProgress === 'function') {
          onItemProgress(obj);
        }
      });
    }

    // Legacy single-item fallback if older preload lacks translateBatch
    const items = Array.isArray(payload.items) ? payload.items : [];
    const results = {};
    for (const item of items) {
      const res = await callTranslate(
        { text: item.text, targetLang: payload.targetLang, model: payload.model, force: payload.force },
        prog => {
          if (prog && typeof prog.text === 'string' && typeof onItemProgress === 'function') {
            onItemProgress({ id: item.id, text: prog.text, done: false, cached: false });
          }
        }
      );
      results[item.id] = res;
      if (res?.ok && typeof res.translation === 'string' && typeof onItemProgress === 'function') {
        onItemProgress({ id: item.id, text: res.translation, done: true, cached: Boolean(res.cached) });
      }
    }
    return { ok: true, results };
  }

  // =========================================================================
  // Global Page CSS (Zero-[role="group"] Oscillation, One-Time Injection)
  // =========================================================================
  function ensureGlobalStyles() {
    if (!document.head || document.getElementById(GLOBAL_STYLE_ID)) return;
    const styleEl = document.createElement('style');
    styleEl.id = GLOBAL_STYLE_ID;
    styleEl.textContent = `
      [data-ag-tt-wrapper="1"][data-ag-tt-mode="bilingual"][data-ag-tt-active="1"] > button[data-testid="thinking-collapsible-trigger"] + div.overflow-y-auto {
        max-height: 360px !important;
      }
      [data-ag-tt-wrapper="1"][data-ag-tt-has-badge="1"] > button[data-testid="thinking-collapsible-trigger"] {
        padding-right: 92px;
      }
      [data-ag-tt-wrapper="1"][data-ag-tt-has-tools="1"] > button[data-testid="thinking-collapsible-trigger"] {
        padding-right: 196px;
      }
      [data-ag-tt-manual-group="1"],
      [data-ag-tt-hover-host="1"] {
        position: relative;
      }
      [data-ag-tt-manual-group="1"][data-ag-tt-has-group-badge="1"] > button[data-testid] {
        padding-right: 96px;
      }
      [data-ag-tt-hover-host="1"] > button[data-testid] {
        padding-right: 68px;
      }
      [data-ag-tt-title-mode="translation_only"] > [data-ag-tt-title-ready="1"] {
        display: none !important;
      }
      .ag-tt-header-title-trans,
      .ag-tt-step-title-trans {
        overflow-anchor: none;
        font-size: inherit;
        line-height: 1.35;
        min-width: 0;
        word-break: break-word;
        transition: opacity 120ms ease, color 140ms ease;
      }
      [data-ag-tt-title-mode="bilingual"] > .ag-tt-header-title-trans,
      [data-ag-tt-title-mode="bilingual"] > .ag-tt-step-title-trans {
        color: var(--ag-tt-accent-text, #2f6f68);
        opacity: 0.94;
      }
      [data-ag-tt-title-mode="bilingual"] > .ag-tt-header-title-trans::before,
      [data-ag-tt-title-mode="bilingual"] > .ag-tt-step-title-trans::before {
        content: "· ";
        opacity: 0.55;
      }
      [data-ag-tt-title-mode="translation_only"] > .ag-tt-header-title-trans,
      [data-ag-tt-title-mode="translation_only"] > .ag-tt-step-title-trans {
        color: var(--ag-tt-accent-text, #2f6f68);
        opacity: 0.94;
      }
      [data-ag-tt-title-mode="translation_only"][data-ag-tt-title-interactive="1"] > .ag-tt-header-title-trans::before,
      [data-ag-tt-title-mode="translation_only"][data-ag-tt-title-interactive="1"] > .ag-tt-step-title-trans::before {
        content: "· ";
        opacity: 0.55;
      }
      [data-ag-tt-title-slot="1"] {
        flex-wrap: wrap;
        row-gap: 1px;
        column-gap: 5px;
      }
      [data-ag-tt-title-slot="1"] > :first-child {
        min-width: 0;
        max-width: 100%;
      }
      button[data-ag-tt-header-wrap="1"] {
        flex-wrap: wrap;
        row-gap: 1px;
      }
      .ag-tt-title-pending {
        opacity: 0.62;
        font-size: 0.92em;
      }
      [data-ag-tt-wrapper="1"][data-ag-tt-mode="translation_only"] [data-markdown-root] > [data-ag-tt-orig-ready="1"],
      [data-ag-tt-wrapper="1"][data-ag-tt-mode="translation_only"] .ag-tt-fallback-root > [data-ag-tt-orig-ready="1"] {
        display: none !important;
      }
      .ag-tt-trigger-bar,
      .ag-tt-group-bar {
        position: absolute;
        top: 5px;
        right: 26px;
        z-index: 2;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        user-select: none;
      }
      .ag-tt-mini-btn,
      .ag-tt-trigger-badge,
      .ag-tt-group-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 7px;
        border-radius: 999px;
        font-size: 11px;
        line-height: 1.3;
        font-weight: 500;
        cursor: pointer;
        user-select: none;
        backdrop-filter: blur(4px);
        border: 1px solid var(--ag-tt-badge-border, rgba(67, 135, 128, 0.28));
        background: var(--ag-tt-accent-soft, rgba(67, 135, 128, 0.12));
        color: var(--ag-tt-accent-text, #2f6f68);
        transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
      }
      .ag-tt-mini-btn {
        background: rgba(128, 128, 128, 0.08);
        border-color: rgba(128, 128, 128, 0.24);
        color: inherit;
        opacity: 0.8;
      }
      .ag-tt-mini-btn:hover {
        opacity: 1;
        border-color: var(--ag-tt-accent, #438780);
        color: var(--ag-tt-accent-text, #2f6f68);
      }
      .ag-tt-trigger-badge[data-status="translating"],
      .ag-tt-group-badge[data-status="translating"] {
        color: var(--ag-tt-accent-strong, #245953);
        animation: agTtPulse 1.2s ease-in-out infinite;
      }
      .ag-tt-trigger-badge[data-status="error"],
      .ag-tt-group-badge[data-status="error"] {
        color: #ef4444;
        background: rgba(239, 68, 68, 0.12);
        border-color: rgba(239, 68, 68, 0.28);
      }
      .ag-tt-trigger-badge[data-status="idle"],
      .ag-tt-group-badge[data-status="idle"] {
        opacity: 0.85;
      }
      .ag-tt-hover-translate-btn {
        position: absolute;
        top: 5px;
        right: 26px;
        z-index: 3;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 9px;
        border-radius: 999px;
        font-size: 11px;
        line-height: 1.35;
        font-weight: 500;
        cursor: pointer;
        user-select: none;
        backdrop-filter: blur(6px);
        border: 1px solid var(--ag-tt-badge-border, rgba(67, 135, 128, 0.28));
        background: var(--ag-tt-accent-soft, rgba(67, 135, 128, 0.12));
        color: var(--ag-tt-accent-text, #2f6f68);
        box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
        animation: agTtHoverIn 140ms ease-out both;
        transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      .ag-tt-hover-translate-btn:hover {
        background: var(--ag-tt-accent, #438780);
        border-color: var(--ag-tt-accent, #438780);
        color: #ffffff;
      }
      @keyframes agTtHoverIn {
        from { opacity: 0; transform: scale(0.95); }
        to { opacity: 1; transform: scale(1); }
      }
      @keyframes agTtPulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.58; }
      }
      @keyframes agTtTokenFade {
        from { opacity: 0.12; }
        to { opacity: 1; }
      }
      @keyframes agTtCaretBlink {
        0%, 49% { opacity: 0.9; }
        50%, 100% { opacity: 0.18; }
      }
      .ag-tt-para-trans {
        overflow-anchor: none;
        word-break: break-word;
        font-size: 13.5px;
        line-height: 1.6;
        color: var(--ag-tt-para-text, #1f423e);
      }
      [data-ag-tt-wrapper="1"][data-ag-tt-mode="bilingual"] .ag-tt-para-trans {
        border-left: 2px solid var(--ag-tt-para-border, rgba(67, 135, 128, 0.48));
        background: var(--ag-tt-para-bg, rgba(67, 135, 128, 0.05));
        border-radius: 0 6px 6px 0;
        padding: 4px 10px;
        margin: -3px 0 4px 0;
      }
      [data-ag-tt-wrapper="1"][data-ag-tt-mode="translation_only"] .ag-tt-para-trans {
        border-left: none;
        background: transparent;
        padding: 0;
        margin: 0;
      }
      .ag-tt-para-trans p {
        margin: 0 0 4px 0;
      }
      .ag-tt-para-trans p:last-child {
        margin-bottom: 0;
      }
      .ag-tt-para-trans .ag-tt-heading {
        margin: 4px 0 3px 0;
        font-weight: 600;
        font-size: 13.5px;
      }
      .ag-tt-para-trans .ag-tt-list {
        margin: 2px 0 4px 0;
        padding-left: 18px;
      }
      .ag-tt-para-trans .ag-tt-list li {
        margin-bottom: 2px;
      }
      .ag-tt-para-trans .ag-tt-inline-code {
        padding: 1px 4px;
        border-radius: 4px;
        background: rgba(128, 128, 128, 0.16);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 0.9em;
      }
      .ag-tt-para-trans .ag-tt-code-block {
        margin: 4px 0;
        padding: 6px 8px;
        border-radius: 6px;
        background: rgba(0, 0, 0, 0.12);
        overflow-x: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        line-height: 1.45;
      }
      .ag-tt-token-in {
        animation: agTtTokenFade 0.2s ease-out both;
      }
      .ag-tt-stream-caret {
        display: inline-block;
        width: 5px;
        height: 0.9em;
        margin-left: 3px;
        vertical-align: -0.1em;
        border-radius: 1px;
        background: var(--ag-tt-accent, #438780);
        animation: agTtCaretBlink 0.9s infinite;
      }
      .ag-tt-shimmer-wait {
        font-size: 12px;
        color: var(--ag-tt-accent-text, #2f6f68);
        opacity: 0.78;
      }
      .ag-tt-para-error {
        font-size: 12px;
        color: #ef4444;
      }
    `;
    document.head.appendChild(styleEl);
  }

  // =========================================================================
  // Theme, Morandi Palette & Titlebar Docking
  // =========================================================================
  function detectDarkTheme() {
    try {
      const rootCls = (document.documentElement.className || '') + ' ' + (document.body?.className || '');
      if (/\bdark\b/i.test(rootCls)) return true;
      if (document.documentElement.getAttribute('data-theme') === 'dark') return true;
      const bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
      const m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const lum = 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]);
        return lum < 128;
      }
    } catch {}
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches || false;
  }

  function applyColorTheme() {
    const isDark = detectDarkTheme();
    const tokens = getColorThemeTokens(settings.colorTheme || DEFAULT_COLOR_THEME, isDark);

    host.style.setProperty('--tt-accent', tokens.accent);
    host.style.setProperty('--tt-accent-soft', tokens.accentSoft);
    host.style.setProperty('--tt-accent-text', tokens.accentText);

    const themeKey = `${tokens.id}:${isDark ? 'dark' : 'light'}`;
    if (themeKey === lastAppliedThemeKey && document.getElementById(THEME_VARS_STYLE_ID)) {
      return;
    }
    lastAppliedThemeKey = themeKey;

    if (!document.head) return;
    let varsEl = document.getElementById(THEME_VARS_STYLE_ID);
    if (!varsEl) {
      varsEl = document.createElement('style');
      varsEl.id = THEME_VARS_STYLE_ID;
      document.head.appendChild(varsEl);
    }
    varsEl.textContent = `
      :root {
        --ag-tt-accent: ${tokens.accent};
        --ag-tt-accent-text: ${tokens.accentText};
        --ag-tt-accent-strong: ${tokens.accentStrong};
        --ag-tt-accent-soft: ${tokens.accentSoft};
        --ag-tt-badge-border: ${tokens.badgeBorder};
        --ag-tt-para-border: ${tokens.paraBorder};
        --ag-tt-para-bg: ${tokens.paraBg};
        --ag-tt-para-text: ${tokens.paraText};
      }
    `;
  }

  function syncTheme() {
    host.setAttribute('data-theme', detectDarkTheme() ? 'dark' : 'light');
    applyColorTheme();
  }

  function findHostTitlebar() {
    try {
      return document.querySelector('[class*="@container/titlebar"]');
    } catch {
      return null;
    }
  }

  function dockToTitlebar() {
    if (disposed) return;
    const titlebar = findHostTitlebar();
    if (titlebar) {
      let target = titlebar;
      try {
        const rightGroup = titlebar.querySelector(':scope > div.shrink-0') || titlebar.lastElementChild;
        if (rightGroup && rightGroup !== titlebar.firstElementChild) {
          target = rightGroup;
        }
      } catch {}
      if (host.parentElement !== target) {
        const meterEl = document.getElementById('ag-context-meter');
        if (meterEl && meterEl.parentElement === target) {
          target.insertBefore(host, meterEl);
        } else if (target.firstChild && target !== titlebar) {
          target.insertBefore(host, target.firstChild);
        } else {
          target.appendChild(host);
        }
      }
      host.setAttribute('data-dock', 'flow');
      if (observedTitlebar !== titlebar && titlebarResizeObserver) {
        observedTitlebar = titlebar;
        titlebarResizeObserver.disconnect();
        titlebarResizeObserver.observe(titlebar);
      }
    } else {
      const fallbackParent = document.body || document.documentElement;
      if (fallbackParent && host.parentElement !== fallbackParent) {
        fallbackParent.appendChild(host);
      }
      host.setAttribute('data-dock', 'fixed');
    }
    positionPopover();
  }

  function positionPopover() {
    if (!popoverOpen) return;
    const pop = el('tt-popover');
    const cap = el('tt-capsule');
    if (!pop || !cap) return;
    const rect = cap.getBoundingClientRect();
    const right = Math.max(12, window.innerWidth - rect.right);
    const top = Math.max(36, Math.round(rect.bottom + 8));
    pop.style.top = `${top}px`;
    pop.style.right = `${right}px`;
  }

  // =========================================================================
  // UI Rendering & Cascading Model Settings Sync
  // =========================================================================
  function getEffectiveModelsList() {
    const list = models.slice();
    if (settings.model && !list.some(m => m.id === settings.model)) {
      list.unshift({ id: settings.model, label: settings.model });
    }
    return list;
  }

  function getModelLabel(modelId) {
    const found = getEffectiveModelsList().find(m => m.id === modelId);
    return found ? found.label : modelId;
  }

  function renderModelCascadeSelects() {
    const baseSelect = el('tt-model-base');
    const levelSelect = el('tt-model-level');
    if (!baseSelect || !levelSelect) return;

    const groups = groupModelsForCascade(getEffectiveModelsList());
    const sel = resolveCascadeSelection(groups, settings.model || DEFAULT_MODEL);
    if (sel.levelKey) {
      preferredLevelKey = sel.levelKey;
    }

    baseSelect.innerHTML = '';
    for (const g of groups) {
      const opt = document.createElement('option');
      opt.value = g.baseKey;
      opt.textContent = g.baseLabel;
      baseSelect.appendChild(opt);
    }
    baseSelect.value = sel.baseKey;

    levelSelect.innerHTML = '';
    for (const o of sel.group.options) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.levelDisplay;
      levelSelect.appendChild(opt);
    }
    levelSelect.value = sel.modelId;
    levelSelect.disabled = sel.group.options.length <= 1;
  }

  function renderColorSwatches() {
    const wrap = el('tt-color-swatches');
    if (!wrap || !Array.isArray(COLOR_THEMES)) return;
    if (!wrap.children.length) {
      for (const preset of COLOR_THEMES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tt-swatch-btn';
        btn.setAttribute('role', 'radio');
        btn.setAttribute('data-color-theme', preset.id);
        btn.title = preset.title || preset.label;

        const dot = document.createElement('span');
        dot.className = 'tt-swatch-dot';
        dot.style.backgroundColor = preset.swatch;

        const text = document.createElement('span');
        text.textContent = preset.label;

        btn.appendChild(dot);
        btn.appendChild(text);
        btn.addEventListener('click', () => {
          if (settings.colorTheme !== preset.id) {
            void persistSettings({ colorTheme: preset.id });
          }
        });
        wrap.appendChild(btn);
      }
    }
    const activeId = settings.colorTheme || DEFAULT_COLOR_THEME;
    for (const btn of wrap.children) {
      const isSelected = btn.getAttribute('data-color-theme') === activeId;
      btn.setAttribute('data-active', isSelected ? 'true' : 'false');
      btn.setAttribute('aria-checked', isSelected ? 'true' : 'false');
    }
  }

  function renderSettingsUI() {
    applyColorTheme();
    if (el('tt-version')) el('tt-version').textContent = `v${PLUGIN_VERSION}`;
    const enabledInput = el('tt-enabled');
    if (enabledInput) enabledInput.checked = Boolean(settings.enabled);
    const pretranslateInput = el('tt-pretranslate-collapsed');
    if (pretranslateInput) {
      pretranslateInput.checked = Boolean(settings.pretranslateCollapsed);
      pretranslateInput.disabled = !settings.enabled;
    }
    const pretranslateRow = el('tt-pretranslate-row');
    if (pretranslateRow) {
      pretranslateRow.setAttribute('data-disabled', settings.enabled ? 'false' : 'true');
    }

    const langSelect = el('tt-target-lang');
    if (langSelect) {
      if (!langSelect.options.length) {
        for (const item of SUPPORTED_LANGUAGES) {
          const opt = document.createElement('option');
          opt.value = item.value;
          opt.textContent = item.label;
          langSelect.appendChild(opt);
        }
      }
      langSelect.value = settings.targetLang;
    }

    const customWrap = el('tt-custom-lang-wrap');
    const customInput = el('tt-custom-lang');
    if (customWrap) {
      customWrap.setAttribute('data-visible', settings.targetLang === CUSTOM_LANG_VALUE ? 'true' : 'false');
    }
    if (customInput && document.activeElement !== customInput) {
      customInput.value = settings.customTargetLang || '';
    }

    const modeBi = el('tt-mode-bilingual');
    const modeTr = el('tt-mode-translation');
    if (modeBi) modeBi.setAttribute('data-active', settings.displayMode === 'bilingual' ? 'true' : 'false');
    if (modeTr) modeTr.setAttribute('data-active', settings.displayMode === 'translation_only' ? 'true' : 'false');

    renderColorSwatches();
    renderModelCascadeSelects();

    const cap = el('tt-capsule');
    const capLabel = el('tt-capsule-label');
    const effLang = getEffectiveTargetLang(settings);
    if (capLabel) {
      capLabel.textContent = settings.enabled ? `译 · ${effLang}` : '译 · 已暂停';
    }
    if (cap) {
      let stateAttr = settings.enabled ? 'active' : 'off';
      if (activeTranslations > 0) stateAttr = 'translating';
      else if (lastErrorMsg) stateAttr = 'error';
      cap.setAttribute('data-state', stateAttr);
    }

    const statusText = el('tt-status-text');
    if (statusText) {
      if (activeTranslations > 0) {
        statusText.textContent = `正在翻译 (${activeTranslations}) · ${getModelLabel(settings.model)}`;
      } else if (lastErrorMsg) {
        statusText.textContent = `最近错误: ${lastErrorMsg.slice(0, 48)}`;
      } else if (!settings.enabled) {
        statusText.textContent = '已暂停自动翻译（悬停标题右侧可手动翻译）';
      } else {
        statusText.textContent = `就绪 · ${getModelLabel(settings.model)}`;
      }
    }

    const cacheStats = el('tt-cache-stats');
    if (cacheStats) {
      cacheStats.textContent = `缓存: ${cacheCount}`;
    }
  }

  function clearQueuedTasks() {
    if (batchFlushTimer) {
      clearTimeout(batchFlushTimer);
      batchFlushTimer = 0;
      batchFlushAt = 0;
    }
    for (const q of [titleQueue, highQueue, bgQueue]) {
      while (q.length) {
        const task = q.shift();
        if (task && !task.running) {
          task.cancelled = true;
          activeTasks.delete(task.taskKey);
        }
      }
    }
  }

  function resetAllTranslationStates(opts = false) {
    const clearMem = typeof opts === 'boolean' ? opts : Boolean(opts?.clearMem);
    const clearManual = typeof opts === 'object' && opts !== null ? Boolean(opts.clearManual) : false;

    if (clearMem) {
      memCache.clear();
      checkedCanonMisses.clear();
    }
    clearQueuedTasks();

    for (const [containerEl, entry] of Array.from(titleStates.entries())) {
      if (!containerEl.isConnected) {
        titleStates.delete(containerEl);
        continue;
      }
      entry.status = 'idle';
      entry.targetText = '';
      entry.canonKey = '';
      entry.error = '';
      entry.fromCache = false;
      if (clearManual) entry.manualRequested = false;
      if (entry.origEl?.isConnected) entry.origEl.removeAttribute('data-ag-tt-title-ready');
      if (entry.transEl?.isConnected) entry.transEl.remove();
      containerEl.removeAttribute('data-ag-tt-title-mode');
      containerEl.removeAttribute('data-ag-tt-title-interactive');
      containerEl.removeAttribute('data-ag-tt-title-slot');
      containerEl.removeAttribute('data-ag-tt-header-wrap');
      titleStates.delete(containerEl);
    }

    for (const gw of Array.from(trackedManualGroups)) {
      if (!gw.isConnected || clearManual) {
        if (gw.isConnected) {
          gw.removeAttribute('data-ag-tt-manual-group');
          gw.removeAttribute('data-ag-tt-has-group-badge');
          for (const bar of gw.querySelectorAll(':scope > .ag-tt-group-bar')) {
            bar.remove();
          }
        }
        manualGroupStates.delete(gw);
        trackedManualGroups.delete(gw);
      } else {
        const grpState = manualGroupStates.get(gw);
        if (grpState) {
          grpState.fiberBlocks = [];
          syncManualGroupBar(gw, grpState);
        }
      }
    }

    for (const wrapper of Array.from(trackedWrappers)) {
      if (!wrapper.isConnected) {
        trackedWrappers.delete(wrapper);
        continue;
      }
      const st = blockStates.get(wrapper);
      if (!st) continue;
      st.fiberBlocks = [];
      st.hasStartedTranslation = false;
      if (clearManual) st.manualActivated = false;
      st.autoTranslateOnExpand = false;
      st.forceTranslateOnExpand = false;
      for (const p of st.domParas.values()) {
        p.status = 'idle';
        p.targetText = '';
        p.revealedLen = 0;
        p.lastHtmlLen = -1;
        p.fromCache = false;
        p.error = '';
        p.canonKey = '';
        if (p.origEl?.isConnected) p.origEl.removeAttribute('data-ag-tt-orig-ready');
        if (p.transEl?.isConnected) p.transEl.remove();
      }
      st.domParas.clear();
      st.orderedOrigEls = [];
      for (const stray of wrapper.querySelectorAll('[data-ag-tt-para]')) {
        stray.remove();
      }
      for (const orig of wrapper.querySelectorAll('[data-ag-tt-orig-ready]')) {
        orig.removeAttribute('data-ag-tt-orig-ready');
      }
      if (!isRegionAllowed(wrapper, st)) {
        wrapper.removeAttribute('data-ag-tt-mode');
        wrapper.removeAttribute('data-ag-tt-active');
      }
      syncWrapperHeaderUI(wrapper, st);
    }
  }

  function deactivateAllToVanilla() {
    hideHoverTranslateButton();
    resetAllTranslationStates({ clearMem: false, clearManual: true });
  }

  async function persistSettings(partial) {
    const prevEnabled = settings.enabled;
    const prevLang = getEffectiveTargetLang(settings);
    const prevModel = settings.model;
    settings = normalizeSettings({ ...settings, ...partial });
    if (prevEnabled && !settings.enabled) {
      deactivateAllToVanilla();
    } else if (!prevEnabled && settings.enabled) {
      hideHoverTranslateButton();
      for (const gw of Array.from(trackedManualGroups)) {
        if (gw.isConnected) {
          gw.removeAttribute('data-ag-tt-manual-group');
          gw.removeAttribute('data-ag-tt-has-group-badge');
          for (const bar of gw.querySelectorAll(':scope > .ag-tt-group-bar')) bar.remove();
        }
        manualGroupStates.delete(gw);
      }
      trackedManualGroups.clear();
    }
    renderSettingsUI();

    try {
      const res = await callBridge('/save-settings', settings);
      if (res && res.ok && res.settings) {
        settings = normalizeSettings(res.settings);
      }
    } catch (err) {
      lastErrorMsg = err?.message || String(err);
    }

    const nextLang = getEffectiveTargetLang(settings);
    const configChanged = prevLang !== nextLang || prevModel !== settings.model;

    if (configChanged) {
      resetAllTranslationStates({ clearMem: true, clearManual: false });
    } else if (!settings.enabled && prevEnabled) {
      deactivateAllToVanilla();
    } else {
      for (const wrapper of Array.from(trackedWrappers)) {
        if (!wrapper.isConnected) {
          trackedWrappers.delete(wrapper);
          continue;
        }
        const st = blockStates.get(wrapper);
        if (st) syncWrapperModeAndOrigVisibility(wrapper, st);
      }
      for (const entry of titleStates.values()) {
        if (entry?.containerEl?.isConnected) syncTitleEntryUI(entry);
      }
    }

    renderSettingsUI();
    scheduleScan();
  }

  // =========================================================================
  // React Fiber Inspection & DOM Helpers
  // =========================================================================
  function getReactFiber(domEl) {
    if (!domEl || typeof domEl !== 'object') return null;
    try {
      for (const key of Object.keys(domEl)) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          return domEl[key];
        }
      }
    } catch {}
    return null;
  }

  function isTriggerStreaming(trigger) {
    if (!trigger) return false;
    return Boolean(trigger.querySelector('.animate-shimmer-text')) || /^Thinking\b/i.test((trigger.textContent || '').trim());
  }

  function extractThinkingFromFiber(trigger) {
    let cur = getReactFiber(trigger);
    for (let i = 0; i < 15 && cur; i++) {
      const props = cur.memoizedProps;
      if (props && typeof props.thinking === 'string' && props.thinking.trim()) {
        return props.thinking;
      }
      cur = cur.return;
    }
    return '';
  }

  function extractToolGroupThinkingsFromFiber(buttonEl) {
    let cur = getReactFiber(buttonEl);
    for (let i = 0; i < 12 && cur; i++) {
      const props = cur.memoizedProps;
      const steps = Array.isArray(props?.steps)
        ? props.steps
        : (Array.isArray(props?.segment?.steps) ? props.segment.steps : null);
      if (steps) {
        const list = [];
        for (const s of steps) {
          const val = s?.step?.value;
          const th = val?.rawThinking || val?.thinking;
          if (typeof th === 'string' && th.trim()) {
            list.push(th);
          }
        }
        return list;
      }
      cur = cur.return;
    }
    return [];
  }

  function extractBlockSourceText(blockEl) {
    if (!blockEl) return '';
    let cur = getReactFiber(blockEl);
    for (let i = 0; i < 4 && cur; i++) {
      const props = cur.memoizedProps;
      if (props && typeof props.text === 'string' && Array.isArray(props.remarkPlugins) && props.text.trim()) {
        return normalizeThinkingText(props.text);
      }
      cur = cur.return;
    }
    if (blockEl.tagName === 'UL' || blockEl.tagName === 'OL') {
      const items = [];
      for (const li of blockEl.children) {
        if (li.tagName === 'LI') {
          const t = (li.innerText || li.textContent || '').trim();
          if (t) items.push(blockEl.tagName === 'OL' ? `1. ${t}` : `- ${t}`);
        }
      }
      if (items.length) return normalizeThinkingText(items.join('\n'));
    }
    return normalizeThinkingText(blockEl.innerText || blockEl.textContent || '');
  }

  function getViewportContainer(wrapper, trigger) {
    if (!wrapper) return null;
    for (const child of wrapper.children) {
      if (child !== trigger && !child.hasAttribute('data-ag-tt-ui') && child.tagName === 'DIV') {
        if (child.classList.contains('overflow-y-auto') || child.querySelector('[data-markdown-root]')) {
          return child;
        }
      }
    }
    return null;
  }

  function findMarkdownRoot(viewport) {
    if (!viewport) return null;
    const explicit = viewport.querySelector('[data-markdown-root]');
    if (explicit) return explicit;
    const fallback = viewport.querySelector('.cursor-edit > div') || viewport.querySelector('.cursor-edit');
    if (fallback && !fallback.classList.contains('ag-tt-fallback-root')) {
      fallback.classList.add('ag-tt-fallback-root');
    }
    return fallback || null;
  }

  function collectTranslatableDomBlocks(markdownRoot) {
    if (!markdownRoot) return [];
    const blocks = [];
    for (const child of markdownRoot.children) {
      if (child.nodeType !== 1) continue;
      if (child.hasAttribute('data-ag-tt-para')) continue;
      if (!TRANSLATABLE_TAGS.has(child.tagName)) continue;
      const txt = extractBlockSourceText(child);
      if (txt) {
        blocks.push({ origEl: child, text: txt });
      }
    }
    return blocks;
  }

  function isRegionAllowed(node, wrapperSt = null) {
    if (settings.enabled) return true;
    if (wrapperSt && wrapperSt.manualActivated) return true;
    if (node && typeof node.closest === 'function' && node.closest('[data-ag-tt-manual-group="1"]')) {
      return true;
    }
    return false;
  }

  function getOrInitBlockState(wrapper) {
    let st = blockStates.get(wrapper);
    if (!st) {
      st = {
        seenOnInitialScan: false,
        wasStreaming: false,
        hasStartedTranslation: false,
        manualActivated: false,
        autoTranslateOnExpand: false,
        forceTranslateOnExpand: false,
        localViewMode: null,
        domParas: new Map(), // origEl -> ParaState
        orderedOrigEls: [],
        fiberBlocks: [] // [{ text, canonKey, lastGrowthAt, status, targetText, fromCache, error }]
      };
      blockStates.set(wrapper, st);
    }
    trackedWrappers.add(wrapper);
    wrapper.setAttribute('data-ag-tt-wrapper', '1');
    return st;
  }

  // =========================================================================
  // 3-Tier Coalescing Batch Scheduler (Priority 0 Titles > Expanded > Bg)
  // =========================================================================
  const PRIORITY_RANK = { title: 0, high: 1, bg: 2 };

  function getQueueByPriority(priority) {
    if (priority === 'title') return titleQueue;
    if (priority === 'high') return highQueue;
    return bgQueue;
  }

  function scheduleBatchFlush(delayMs) {
    if (disposed) return;
    const wait = Math.max(0, Number(delayMs) || 0);
    const targetAt = Date.now() + wait;
    if (batchFlushTimer) {
      if (targetAt + 4 >= batchFlushAt) return;
      clearTimeout(batchFlushTimer);
      batchFlushTimer = 0;
    }
    batchFlushAt = targetAt;
    batchFlushTimer = setTimeout(() => {
      batchFlushTimer = 0;
      batchFlushAt = 0;
      flushSchedulerBatches();
    }, wait);
  }

  function popNextCoalescedBatch() {
    const orderedQueues = [titleQueue, highQueue, bgQueue];
    for (const queue of orderedQueues) {
      while (queue.length > 0 && (queue[0].done || queue[0].cancelled)) {
        queue.shift();
      }
      if (!queue.length) continue;

      const first = queue.shift();
      const batch = [first];
      let totalChars = first.text.length;

      // Keep oversize single items standalone so they chunk cleanly; otherwise pack matching tasks
      if (totalChars <= CLIENT_BATCH_MAX_CHARS) {
        let idx = 0;
        while (idx < queue.length && batch.length < CLIENT_BATCH_MAX_ITEMS) {
          const cand = queue[idx];
          if (!cand || cand.done || cand.cancelled) {
            queue.splice(idx, 1);
            continue;
          }
          if (cand.targetLang === first.targetLang && cand.model === first.model && cand.force === first.force) {
            if (cand.text.length <= CLIENT_BATCH_MAX_CHARS && totalChars + cand.text.length <= CLIENT_BATCH_MAX_CHARS) {
              queue.splice(idx, 1);
              batch.push(cand);
              totalChars += cand.text.length;
              continue;
            }
          }
          idx++;
        }
      }
      return batch;
    }
    return null;
  }

  function flushSchedulerBatches() {
    if (disposed) return;

    while (activeBatchCount < MAX_CONCURRENT_BATCH_REQUESTS) {
      const batch = popNextCoalescedBatch();
      if (!batch || !batch.length) break;
      runScheduledBatch(batch);
    }
  }

  function runScheduledBatch(batch) {
    activeBatchCount++;
    activeTranslations += batch.length;
    const first = batch[0];
    const taskById = new Map();

    for (const task of batch) {
      task.running = true;
      task.settled = false;
      taskById.set(task.taskKey, task);
      for (const sub of task.subscribers) {
        sub.onStart?.();
      }
    }
    renderSettingsUI();

    void callTranslateBatch(
      {
        items: batch.map(t => ({ id: t.taskKey, text: t.text })),
        targetLang: first.targetLang,
        model: first.model,
        force: first.force
      },
      prog => {
        if (disposed || !prog || !prog.id) return;
        const task = taskById.get(prog.id);
        if (!task || task.settled) return;

        if (prog.done) {
          task.settled = true;
          if (prog.ok === false || typeof prog.text !== 'string') {
            const errMsg = prog.error || '翻译失败';
            lastErrorMsg = errMsg;
            for (const sub of task.subscribers) {
              sub.onError?.(errMsg);
            }
            return;
          }
          if (!prog.cached) cacheCount++;
          memCache.set(task.canonKey, prog.text);
          checkedCanonMisses.delete(task.canonKey);
          for (const sub of task.subscribers) {
            sub.onDone?.(prog.text, Boolean(prog.cached));
          }
        } else if (typeof prog.text === 'string') {
          task.lastPartial = prog.text;
          for (const sub of task.subscribers) {
            sub.onProgress?.(prog.text);
          }
        }
      }
    ).then(res => {
      if (disposed) return;
      if (res?.cacheStats && typeof res.cacheStats.count === 'number') {
        cacheCount = res.cacheStats.count;
      }
      for (const task of batch) {
        if (task.settled) continue;
        task.settled = true;
        const itemRes = res?.results?.[task.taskKey];
        if (itemRes && itemRes.ok && typeof itemRes.translation === 'string') {
          if (!itemRes.cached && !res?.cacheStats) cacheCount++;
          memCache.set(task.canonKey, itemRes.translation);
          checkedCanonMisses.delete(task.canonKey);
          for (const sub of task.subscribers) {
            sub.onDone?.(itemRes.translation, Boolean(itemRes.cached));
          }
        } else {
          const errMsg = itemRes?.error || res?.error || '翻译失败';
          lastErrorMsg = errMsg;
          for (const sub of task.subscribers) {
            sub.onError?.(errMsg);
          }
        }
      }
    }).catch(err => {
      if (disposed) return;
      const errMsg = err?.message || String(err);
      lastErrorMsg = errMsg;
      for (const task of batch) {
        if (task.settled) continue;
        task.settled = true;
        for (const sub of task.subscribers) {
          sub.onError?.(errMsg);
        }
      }
    }).finally(() => {
      for (const task of batch) {
        task.done = true;
        task.running = false;
        activeTasks.delete(task.taskKey);
      }
      activeBatchCount = Math.max(0, activeBatchCount - 1);
      activeTranslations = Math.max(0, activeTranslations - batch.length);
      renderSettingsUI();
      if (!disposed && (titleQueue.length || highQueue.length || bgQueue.length)) {
        const nextDelay = titleQueue.length ? 8 : 12;
        scheduleBatchFlush(nextDelay);
      }
    });
  }

  function enqueueTranslationTask({ text, targetLang, model, force = false, priority = 'high', subscriber }) {
    const canonKey = computeCanonicalCacheKey(text, targetLang, model);
    if (!force && memCache.has(canonKey)) {
      const hit = memCache.get(canonKey);
      subscriber.onDone?.(hit, true);
      return;
    }

    const taskKey = force ? `force:${canonKey}:${++reqSeq}` : canonKey;
    const existing = force ? null : activeTasks.get(canonKey);

    if (!existing) {
      const task = {
        taskKey,
        canonKey,
        text,
        targetLang,
        model,
        force,
        priority,
        running: false,
        settled: false,
        done: false,
        cancelled: false,
        lastPartial: '',
        subscribers: new Set([subscriber])
      };
      activeTasks.set(taskKey, task);
      getQueueByPriority(priority).push(task);
      scheduleBatchFlush(priority === 'title' ? TITLE_COALESCE_MS : PARA_COALESCE_MS);
      return;
    }

    // Attach to existing inflight/queued task and upgrade priority lane if needed
    existing.subscribers.add(subscriber);
    if (existing.running) {
      subscriber.onStart?.();
      if (existing.lastPartial) subscriber.onProgress?.(existing.lastPartial);
    } else if (PRIORITY_RANK[priority] < PRIORITY_RANK[existing.priority]) {
      const oldQueue = getQueueByPriority(existing.priority);
      const idx = oldQueue.indexOf(existing);
      if (idx !== -1) oldQueue.splice(idx, 1);
      existing.priority = priority;
      const newQueue = getQueueByPriority(priority);
      if (!newQueue.includes(existing)) newQueue.push(existing);
      scheduleBatchFlush(priority === 'title' ? TITLE_COALESCE_MS : PARA_COALESCE_MS);
    }
  }

  async function prewarmBackendCache(items, targetLang, model, opts = {}) {
    const unqueried = [];
    const seenKeys = new Set();
    for (const item of items) {
      const ck = computeCanonicalCacheKey(item.text, targetLang, model);
      if (memCache.has(ck) || checkedCanonMisses.has(ck) || seenKeys.has(ck)) continue;
      seenKeys.add(ck);
      unqueried.push({ id: ck, text: item.text });
    }
    if (!unqueried.length) return;

    try {
      const res = await callBridge('/check-cache', { items: unqueried, targetLang, model });
      if (res && res.ok && res.hits) {
        for (const q of unqueried) {
          if (typeof res.hits[q.id] === 'string') {
            memCache.set(q.id, res.hits[q.id]);
          } else {
            checkedCanonMisses.add(q.id);
          }
        }
        if (res.cacheStats && typeof res.cacheStats.count === 'number') {
          cacheCount = res.cacheStats.count;
        }
        renderSettingsUI();
        if (!opts.skipScan) scheduleScan();
      }
    } catch {}
  }

  // =========================================================================
  // Smooth RequestAnimationFrame Streaming Renderer & Per-Paragraph DOM Sync
  // =========================================================================
  function clampCodePointBoundary(text, nextLen) {
    if (nextLen <= 0 || nextLen >= text.length) return nextLen;
    const code = text.charCodeAt(nextLen - 1);
    if (code >= 0xd800 && code <= 0xdbff && nextLen < text.length) {
      return nextLen + 1;
    }
    return nextLen;
  }

  function renderParaTransEl(p) {
    if (!p.transEl || !p.transEl.isConnected) return;

    if (p.status === 'error') {
      if (p.lastRenderState !== `err:${p.error}`) {
        p.lastRenderState = `err:${p.error}`;
        p.transEl.innerHTML = `<div class="ag-tt-para-error">${escapeHtml(p.error || '翻译失败')}</div>`;
      }
      if (p.origEl?.isConnected) p.origEl.removeAttribute('data-ag-tt-orig-ready');
      return;
    }

    if (p.status === 'idle' || p.status === 'skipped') {
      if (p.lastRenderState !== 'empty') {
        p.lastRenderState = 'empty';
        p.transEl.innerHTML = '';
      }
      if (p.origEl?.isConnected) p.origEl.removeAttribute('data-ag-tt-orig-ready');
      return;
    }

    const totalLen = p.targetText ? p.targetText.length : 0;
    if (p.fromCache || (p.status === 'done' && p.revealedLen >= totalLen)) {
      p.revealedLen = totalLen;
    }

    if (p.revealedLen === 0) {
      if (p.status === 'translating' || p.status === 'queued') {
        if (p.lastRenderState !== 'waiting') {
          p.lastRenderState = 'waiting';
          p.transEl.innerHTML = '<span class="ag-tt-shimmer-wait">正在翻译...</span>';
        }
      }
      // Keep original visible until first characters appear to avoid height collapse!
      if (p.origEl?.isConnected) p.origEl.removeAttribute('data-ag-tt-orig-ready');
      return;
    }

    const slice = p.targetText.slice(0, p.revealedLen);
    const isActivelyStreaming = p.status === 'translating' || (p.status === 'done' && p.revealedLen < totalLen);
    const renderKey = `${isActivelyStreaming ? 's' : 'd'}:${p.revealedLen}:${totalLen}:${p.canonKey}`;

    if (p.lastRenderState !== renderKey) {
      const prevLen = Math.max(0, p.lastHtmlLen);
      p.lastHtmlLen = p.revealedLen;
      p.lastRenderState = renderKey;
      p.transEl.innerHTML = renderStreamingMarkdownHtml(slice, prevLen, isActivelyStreaming);
    }

    if (p.origEl?.isConnected) {
      p.origEl.setAttribute('data-ag-tt-orig-ready', '1');
    }
  }

  function hasPendingAnimations() {
    for (const wrapper of trackedWrappers) {
      if (!wrapper.isConnected) continue;
      const st = blockStates.get(wrapper);
      if (!st) continue;
      for (const p of st.domParas.values()) {
        if (!p.fromCache && p.targetText && p.revealedLen < p.targetText.length) {
          return true;
        }
      }
    }
    return false;
  }

  function ensureAnimationLoop() {
    if (disposed || rafId) return;
    if (!hasPendingAnimations()) return;

    const tick = now => {
      rafId = 0;
      if (disposed) return;

      let stillPending = false;
      const shouldStep = now - lastAnimTick >= STREAM_FRAME_INTERVAL_MS;
      if (shouldStep) lastAnimTick = now;

      for (const wrapper of Array.from(trackedWrappers)) {
        if (!wrapper.isConnected) {
          trackedWrappers.delete(wrapper);
          continue;
        }
        const st = blockStates.get(wrapper);
        if (!st) continue;

        for (const p of st.domParas.values()) {
          if (p.fromCache || !p.targetText) continue;
          const targetLen = p.targetText.length;
          if (p.revealedLen < targetLen) {
            stillPending = true;
            if (shouldStep) {
              const remaining = targetLen - p.revealedLen;
              const step = Math.max(2, Math.ceil(remaining * 0.25));
              p.revealedLen = clampCodePointBoundary(p.targetText, Math.min(targetLen, p.revealedLen + step));
              renderParaTransEl(p);
            }
          } else if (p.status === 'done' && p.lastRenderState?.startsWith('s:')) {
            renderParaTransEl(p);
          }
        }
      }

      if (stillPending && !disposed) {
        rafId = requestAnimationFrame(tick);
      }
    };

    rafId = requestAnimationFrame(tick);
  }

  // =========================================================================
  // Wrapper Trigger UI & Display Mode Synchronization
  // =========================================================================
  function getEffectiveWrapperMode(st) {
    return st.localViewMode || settings.displayMode;
  }

  function computeWrapperProgress(st) {
    let total = 0;
    let done = 0;
    let translating = 0;
    let errorCount = 0;
    let hasTranslatedContent = false;

    if (st.orderedOrigEls.length > 0) {
      for (const origEl of st.orderedOrigEls) {
        const p = st.domParas.get(origEl);
        if (!p || p.status === 'skipped') continue;
        total++;
        if (p.status === 'done') {
          done++;
          if (p.targetText) hasTranslatedContent = true;
        } else if (p.status === 'translating' || p.status === 'queued') {
          translating++;
          if (p.targetText) hasTranslatedContent = true;
        } else if (p.status === 'error') {
          errorCount++;
        }
      }
    } else if (st.fiberBlocks.length > 0) {
      for (const fb of st.fiberBlocks) {
        if (fb.status === 'skipped') continue;
        total++;
        if (fb.status === 'done') {
          done++;
          if (fb.targetText) hasTranslatedContent = true;
        } else if (fb.status === 'translating' || fb.status === 'queued') {
          translating++;
        } else if (fb.status === 'error') {
          errorCount++;
        }
      }
    }

    let overallStatus = 'idle';
    if (translating > 0) overallStatus = 'translating';
    else if (errorCount > 0 && done === 0) overallStatus = 'error';
    else if (total > 0 && done === total) overallStatus = 'done';
    else if (done > 0) overallStatus = 'partial';

    return { total, done, translating, errorCount, overallStatus, hasTranslatedContent };
  }

  function syncWrapperModeAndOrigVisibility(wrapper, st) {
    const allowed = isRegionAllowed(wrapper, st);
    if (!allowed) {
      wrapper.removeAttribute('data-ag-tt-mode');
      wrapper.removeAttribute('data-ag-tt-active');
      syncWrapperHeaderUI(wrapper, st, { total: 0, done: 0, translating: 0, errorCount: 0, overallStatus: 'idle', hasTranslatedContent: false });
      return;
    }
    const mode = getEffectiveWrapperMode(st);
    wrapper.setAttribute('data-ag-tt-mode', mode);
    const prog = computeWrapperProgress(st);
    if (prog.hasTranslatedContent || prog.translating > 0) {
      wrapper.setAttribute('data-ag-tt-active', '1');
    } else {
      wrapper.removeAttribute('data-ag-tt-active');
    }
    syncWrapperHeaderUI(wrapper, st, prog);
  }

  function syncWrapperHeaderUI(wrapper, st, precomputedProg) {
    if (!wrapper || !wrapper.isConnected) return;
    let bar = null;
    for (const child of wrapper.children) {
      if (child.classList && child.classList.contains('ag-tt-trigger-bar')) {
        bar = child;
        break;
      }
    }

    const allowed = isRegionAllowed(wrapper, st);
    const prog = precomputedProg || computeWrapperProgress(st);
    const visible = allowed && (settings.enabled || st.manualActivated || prog.done > 0 || prog.translating > 0 || prog.errorCount > 0);

    if (!visible) {
      if (bar) bar.style.display = 'none';
      wrapper.removeAttribute('data-ag-tt-has-badge');
      wrapper.removeAttribute('data-ag-tt-has-tools');
      return;
    }

    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'ag-tt-trigger-bar';
      bar.setAttribute('data-ag-tt-ui', '1');

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'ag-tt-mini-btn';
      toggleBtn.setAttribute('data-act', 'toggle-orig');
      toggleBtn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const cur = getEffectiveWrapperMode(st);
        st.localViewMode = cur === 'translation_only' ? 'bilingual' : 'translation_only';
        syncWrapperModeAndOrigVisibility(wrapper, st);
        for (const entry of titleStates.values()) {
          if (entry && entry.wrapperSt === st) syncTitleEntryUI(entry);
        }
      });

      const retranslateBtn = document.createElement('button');
      retranslateBtn.type = 'button';
      retranslateBtn.className = 'ag-tt-mini-btn';
      retranslateBtn.setAttribute('data-act', 'retranslate');
      retranslateBtn.textContent = '重译';
      retranslateBtn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        void translateWrapperNow(wrapper, true);
      });

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'ag-tt-mini-btn';
      copyBtn.setAttribute('data-act', 'copy');
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', async ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const btn = ev.currentTarget;
        const text = collectWrapperTranslationText(st);
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = '已复制';
          setTimeout(() => { if (btn.isConnected) btn.textContent = '复制'; }, 1200);
        } catch {}
      });

      const badge = document.createElement('span');
      badge.className = 'ag-tt-trigger-badge';
      badge.setAttribute('role', 'button');
      badge.tabIndex = -1;
      badge.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const trigger = wrapper.querySelector('[data-testid="thinking-collapsible-trigger"]');
        const viewport = getViewportContainer(wrapper, trigger);
        const progNow = computeWrapperProgress(st);
        if (!viewport && trigger) {
          st.autoTranslateOnExpand = true;
          st.forceTranslateOnExpand = progNow.overallStatus === 'done';
          trigger.click();
          return;
        }
        void translateWrapperNow(wrapper, progNow.overallStatus === 'done');
      });

      bar.appendChild(toggleBtn);
      bar.appendChild(retranslateBtn);
      bar.appendChild(copyBtn);
      bar.appendChild(badge);
      wrapper.appendChild(bar);
    }

    const trigger = wrapper.querySelector('[data-testid="thinking-collapsible-trigger"]');
    const isExpanded = Boolean(getViewportContainer(wrapper, trigger));
    const showTools = isExpanded && (prog.translating > 0 || prog.done > 0);
    const effMode = getEffectiveWrapperMode(st);
    const effLang = getEffectiveTargetLang(settings);

    const toggleBtn = bar.querySelector('[data-act="toggle-orig"]');
    const retranslateBtn = bar.querySelector('[data-act="retranslate"]');
    const copyBtn = bar.querySelector('[data-act="copy"]');
    const badge = bar.querySelector('.ag-tt-trigger-badge');

    if (toggleBtn) {
      toggleBtn.style.display = showTools ? 'inline-flex' : 'none';
      toggleBtn.textContent = effMode === 'translation_only' ? '显示原文' : '只看译文';
    }
    if (retranslateBtn) {
      retranslateBtn.style.display = showTools ? 'inline-flex' : 'none';
    }
    if (copyBtn) {
      copyBtn.style.display = showTools && prog.hasTranslatedContent ? 'inline-flex' : 'none';
    }

    if (badge) {
      badge.setAttribute('data-status', prog.overallStatus);
      if (prog.overallStatus === 'translating') {
        badge.textContent = prog.total > 1 ? `译中 ${prog.done}/${prog.total}` : '译中...';
        badge.title = '正在流式翻译思考段落';
      } else if (prog.overallStatus === 'done') {
        badge.textContent = `已译 · ${effLang}`;
        badge.title = '点击重新翻译';
      } else if (prog.overallStatus === 'partial') {
        badge.textContent = `已译 ${prog.done}/${prog.total}`;
        badge.title = '点击继续翻译剩余段落';
      } else if (prog.overallStatus === 'error') {
        badge.textContent = '译失败';
        badge.title = '点击重试翻译';
      } else {
        badge.textContent = '译';
        badge.title = '点击翻译该段思考';
      }
    }

    bar.style.display = 'inline-flex';
    wrapper.setAttribute('data-ag-tt-has-badge', '1');
    if (showTools) wrapper.setAttribute('data-ag-tt-has-tools', '1');
    else wrapper.removeAttribute('data-ag-tt-has-tools');
  }

  function collectWrapperTranslationText(st) {
    const parts = [];
    if (st.orderedOrigEls.length > 0) {
      for (const origEl of st.orderedOrigEls) {
        const p = st.domParas.get(origEl);
        if (p && p.targetText) parts.push(p.targetText);
      }
    } else if (st.fiberBlocks.length > 0) {
      for (const fb of st.fiberBlocks) {
        if (fb.targetText) parts.push(fb.targetText);
      }
    }
    return parts.join('\n\n').trim();
  }

  // =========================================================================
  // Per-Paragraph, Header/Step Title (Priority 0) & Background Orchestration
  // =========================================================================
  const ICON_LIGATURE_CLASS_RE = /(?:^|\s)(?:material-symbols[^\s]*|material-icons[^\s]*|codicon[^\s]*)(?=\s|$)/;
  const GAP_FLEX_CLASS_RE = /(?:^|\s)gap-(?:x-)?(?:\d|px|\[)/;

  function readVisibleDomText(node, skipSelector = '') {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    if (
      node.tagName === 'SVG' ||
      node.tagName === 'STYLE' ||
      node.tagName === 'SCRIPT' ||
      node.tagName === 'NOSCRIPT'
    ) {
      return '';
    }
    if (
      node.hasAttribute('data-ag-tt-ui') ||
      node.hasAttribute('data-ag-tt-para') ||
      node.hasAttribute('data-slot-out') ||
      node.getAttribute('aria-hidden') === 'true'
    ) {
      return '';
    }
    const cls = typeof node.className === 'string' ? node.className : '';
    if (cls && ICON_LIGATURE_CLASS_RE.test(cls)) return '';
    if (skipSelector && node.matches?.(skipSelector)) return '';

    const parts = [];
    for (const child of node.childNodes) {
      const txt = readVisibleDomText(child, skipSelector);
      if (txt) parts.push(txt);
    }
    if (!parts.length) return '';

    const isHorizontalGapFlex = /\bflex\b/.test(cls) && !/\bflex-col\b/.test(cls) && GAP_FLEX_CLASS_RE.test(cls);
    if (isHorizontalGapFlex) {
      return parts.map(s => s.trim()).filter(Boolean).join(' ');
    }
    return parts.join('');
  }

  function extractCleanTitleInfo(origEl) {
    const fullText = readVisibleDomText(origEl, '').replace(/\s+/g, ' ').trim();
    const hasCodeEl = Boolean(origEl.querySelector?.('.font-mono, code, pre'));
    let isRawCodeFallback = false;
    if (hasCodeEl) {
      const nonCode = readVisibleDomText(origEl, '.font-mono, code, pre')
        .replace(/\b(?:Run|Running|Ran|Waiting|Canceled|Cancelled|Rejected)\b/gi, ' ')
        .replace(/·?\s*Exited with code\s*-?\d+/gi, ' ')
        .replace(/[?·—-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!/[A-Za-z]{3,}/.test(nonCode)) {
        isRawCodeFallback = true;
      }
    }
    const hasInteractiveChip = Boolean(
      origEl.querySelector?.('a, button, [role="button"], .cursor-pointer, [data-tooltip-id]')
    );
    return { fullText, isRawCodeFallback, hasInteractiveChip };
  }

  function syncTitleEntryUI(entry) {
    const { containerEl, origEl, transEl, insertBeforeEl, isStepSlot, targetText, status, isRawCodeFallback, hasInteractiveChip, wrapperSt } = entry;
    if (!containerEl?.isConnected || !origEl?.isConnected || !transEl) return;

    const liveText = readVisibleDomText(origEl, '').replace(/\s+/g, ' ').trim();
    const isStaleText = Boolean(entry.text && liveText && liveText !== entry.text);
    const allowDisplay = Boolean(isRegionAllowed(containerEl, wrapperSt) || entry.manualRequested);
    const canShow = allowDisplay && !isStaleText && status !== 'skipped' && !isRawCodeFallback;
    if (!canShow) {
      origEl.removeAttribute('data-ag-tt-title-ready');
      if (transEl.isConnected) {
        transEl.style.display = 'none';
        transEl.textContent = '';
      }
      containerEl.removeAttribute('data-ag-tt-title-mode');
      containerEl.removeAttribute('data-ag-tt-title-interactive');
      containerEl.removeAttribute('data-ag-tt-title-slot');
      containerEl.removeAttribute('data-ag-tt-header-wrap');
      return;
    }

    if (isStepSlot) containerEl.setAttribute('data-ag-tt-title-slot', '1');
    const mode = wrapperSt ? getEffectiveWrapperMode(wrapperSt) : settings.displayMode;
    containerEl.setAttribute('data-ag-tt-title-mode', mode);
    if (hasInteractiveChip) containerEl.setAttribute('data-ag-tt-title-interactive', '1');
    else containerEl.removeAttribute('data-ag-tt-title-interactive');

    if (insertBeforeEl && insertBeforeEl.parentElement === containerEl) {
      if (transEl.parentElement !== containerEl || transEl.nextElementSibling !== insertBeforeEl) {
        containerEl.insertBefore(transEl, insertBeforeEl);
      }
    } else if (transEl.parentElement !== containerEl) {
      containerEl.appendChild(transEl);
    }

    if (targetText) {
      transEl.style.display = '';
      transEl.classList.remove('ag-tt-title-pending');
      transEl.textContent = targetText;
      if (containerEl.tagName === 'BUTTON') {
        containerEl.setAttribute('data-ag-tt-header-wrap', '1');
      }
      if (mode === 'translation_only' && !hasInteractiveChip) {
        origEl.setAttribute('data-ag-tt-title-ready', '1');
      } else {
        origEl.removeAttribute('data-ag-tt-title-ready');
      }
    } else if (status === 'translating' || status === 'queued') {
      origEl.removeAttribute('data-ag-tt-title-ready');
      transEl.style.display = '';
      transEl.classList.add('ag-tt-title-pending');
      transEl.textContent = '译中...';
      containerEl.removeAttribute('data-ag-tt-header-wrap');
    } else {
      origEl.removeAttribute('data-ag-tt-title-ready');
      transEl.style.display = 'none';
      transEl.textContent = '';
      containerEl.removeAttribute('data-ag-tt-header-wrap');
    }
  }

  function startTitleTranslation(entry, targetLang, model, force = false) {
    const activeCanon = entry.canonKey;
    entry.status = 'queued';
    if (force) {
      entry.targetText = '';
      entry.fromCache = false;
      entry.error = '';
    }
    syncTitleEntryUI(entry);

    enqueueTranslationTask({
      text: entry.text,
      targetLang,
      model,
      force,
      priority: 'title',
      subscriber: {
        onStart: () => {
          if (disposed || entry.canonKey !== activeCanon || !entry.containerEl?.isConnected) return;
          entry.status = 'translating';
          syncTitleEntryUI(entry);
        },
        onProgress: partialText => {
          if (disposed || entry.canonKey !== activeCanon || !entry.containerEl?.isConnected) return;
          entry.status = 'translating';
          entry.fromCache = false;
          entry.targetText = partialText;
          syncTitleEntryUI(entry);
        },
        onDone: (finalText, cached) => {
          if (disposed || entry.canonKey !== activeCanon || !entry.containerEl?.isConnected) return;
          entry.status = 'done';
          entry.targetText = finalText;
          entry.fromCache = Boolean(cached);
          entry.error = '';
          syncTitleEntryUI(entry);
        },
        onError: errMsg => {
          if (disposed || entry.canonKey !== activeCanon || !entry.containerEl?.isConnected) return;
          entry.status = 'error';
          entry.error = errMsg;
          syncTitleEntryUI(entry);
        }
      }
    });
  }

  function collectTitleTargets() {
    const targets = [];
    const seenContainers = new Set();
    const excludeSelector = '#ag-thinking-translator, #ag-context-meter, [role="dialog"], [role="menu"], [role="listbox"], [contenteditable="true"], [data-markdown-root], .ag-tt-fallback-root';

    const headerBtns = document.querySelectorAll(
      'button[data-testid="thinking-collapsible-trigger"], button[data-testid="tool-group-collapsible"], button[data-testid="worked-for-collapsible"], button[data-testid="progress-updates-collapsible"]'
    );
    for (const btn of headerBtns) {
      if (btn.classList.contains('hidden') || btn.closest(excludeSelector)) continue;
      const nonUi = Array.from(btn.children).filter(c => !c.hasAttribute('data-ag-tt-ui'));
      const origEl = nonUi[0];
      if (!origEl) continue;
      const chevronEl = nonUi.length >= 2 ? nonUi[nonUi.length - 1] : null;
      const isThinkingTrig = btn.getAttribute('data-testid') === 'thinking-collapsible-trigger';
      const wrapperSt = isThinkingTrig && btn.parentElement ? getOrInitBlockState(btn.parentElement) : null;
      seenContainers.add(btn);
      targets.push({
        containerEl: btn,
        origEl,
        insertBeforeEl: chevronEl,
        className: 'ag-tt-header-title-trans',
        isStepSlot: false,
        wrapperSt
      });
    }

    const ephNodes = document.querySelectorAll('div[data-testid="ephemeral-tool-status"]');
    for (const div of ephNodes) {
      if (div.closest(excludeSelector) || seenContainers.has(div)) continue;
      const origEl = Array.from(div.children).find(c => !c.hasAttribute('data-ag-tt-ui'));
      if (!origEl) continue;
      seenContainers.add(div);
      targets.push({
        containerEl: div,
        origEl,
        insertBeforeEl: null,
        className: 'ag-tt-header-title-trans',
        isStepSlot: false,
        wrapperSt: null
      });
    }

    const stepRows = document.querySelectorAll('div.group.flex.w-full.min-w-0.items-center.min-h-8.select-none');
    for (const row of stepRows) {
      if (row.closest(excludeSelector)) continue;
      const titleSlot = row.children[0];
      if (!titleSlot || titleSlot.tagName !== 'DIV' || !titleSlot.classList.contains('min-w-0')) continue;
      if (seenContainers.has(titleSlot)) continue;
      const origEl = Array.from(titleSlot.children).find(c => !c.hasAttribute('data-ag-tt-ui'));
      if (!origEl) continue;
      seenContainers.add(titleSlot);
      targets.push({
        containerEl: titleSlot,
        origEl,
        insertBeforeEl: null,
        className: 'ag-tt-step-title-trans',
        isStepSlot: true,
        wrapperSt: null
      });
    }

    return targets;
  }

  function scanStepAndHeaderTitles(targetLang, model, prewarmItems, forceAll = false) {
    for (const [containerEl] of Array.from(titleStates.entries())) {
      if (!containerEl.isConnected) titleStates.delete(containerEl);
    }

    const targets = collectTitleTargets();
    for (const t of targets) {
      const { containerEl, origEl, insertBeforeEl, className, isStepSlot, wrapperSt } = t;
      let entry = titleStates.get(containerEl);
      const regionAllowed = isRegionAllowed(containerEl, wrapperSt);

      if (!forceAll && !regionAllowed && (!entry || !entry.manualRequested)) {
        if (entry) syncTitleEntryUI(entry);
        continue;
      }

      const info = extractCleanTitleInfo(origEl);

      if (!entry) {
        let transEl = Array.from(containerEl.children).find(
          c => c.hasAttribute('data-ag-tt-ui') && (c.classList.contains('ag-tt-header-title-trans') || c.classList.contains('ag-tt-step-title-trans'))
        );
        if (!transEl) {
          transEl = document.createElement('span');
          transEl.className = className;
          transEl.setAttribute('data-ag-tt-ui', '1');
        }
        entry = {
          containerEl,
          origEl,
          transEl,
          insertBeforeEl,
          isStepSlot,
          wrapperSt,
          text: '',
          canonKey: '',
          isRawCodeFallback: false,
          hasInteractiveChip: false,
          manualRequested: false,
          status: 'idle',
          targetText: '',
          fromCache: false,
          error: ''
        };
        titleStates.set(containerEl, entry);
      } else {
        entry.origEl = origEl;
        entry.insertBeforeEl = insertBeforeEl;
        entry.isStepSlot = isStepSlot;
        entry.wrapperSt = wrapperSt;
      }

      entry.isRawCodeFallback = info.isRawCodeFallback;
      entry.hasInteractiveChip = info.hasInteractiveChip;

      if (!info.fullText) {
        entry.text = '';
        entry.canonKey = '';
        entry.status = 'skipped';
        entry.targetText = '';
        entry.manualRequested = false;
        syncTitleEntryUI(entry);
        continue;
      }

      const canonKey = computeCanonicalCacheKey(info.fullText, targetLang, model);
      if (entry.canonKey !== canonKey) {
        entry.text = info.fullText;
        entry.canonKey = canonKey;
        entry.status = 'idle';
        entry.targetText = '';
        entry.fromCache = false;
        entry.error = '';
        entry.manualRequested = false;
      }

      if (info.isRawCodeFallback) {
        entry.status = 'skipped';
        syncTitleEntryUI(entry);
        continue;
      }

      if (forceAll) {
        entry.manualRequested = true;
      }

      const allowTitleTranslate = Boolean(isRegionAllowed(containerEl, wrapperSt) || forceAll || entry.manualRequested);
      if (!allowTitleTranslate) {
        syncTitleEntryUI(entry);
        continue;
      }

      // 0ms / 0-token local translation for standard Antigravity status headers & file chips
      const boilerHit = translateBoilerplateTitle(info.fullText, targetLang);
      if (boilerHit) {
        entry.status = 'done';
        entry.targetText = boilerHit;
        entry.fromCache = true;
        entry.error = '';
        syncTitleEntryUI(entry);
        continue;
      }

      if (!shouldTranslateTitle(info.fullText, targetLang)) {
        entry.status = 'skipped';
        entry.targetText = '';
        syncTitleEntryUI(entry);
        continue;
      }

      if (!forceAll && memCache.has(canonKey)) {
        entry.status = 'done';
        entry.targetText = memCache.get(canonKey);
        entry.fromCache = true;
        entry.error = '';
        syncTitleEntryUI(entry);
        continue;
      }

      prewarmItems.push({ text: info.fullText });

      if (forceAll || (allowTitleTranslate && entry.status === 'idle')) {
        startTitleTranslation(entry, targetLang, model, forceAll);
      } else {
        syncTitleEntryUI(entry);
      }
    }
  }

  function startDomParaTranslation(wrapper, st, p, targetLang, model, force, priority) {
    const activeCanon = p.canonKey;
    st.hasStartedTranslation = true;
    p.status = 'queued';
    if (force) {
      p.targetText = '';
      p.revealedLen = 0;
      p.lastHtmlLen = -1;
      p.fromCache = false;
      p.error = '';
    }
    renderParaTransEl(p);
    syncWrapperModeAndOrigVisibility(wrapper, st);

    enqueueTranslationTask({
      text: p.text,
      targetLang,
      model,
      force,
      priority,
      subscriber: {
        onStart: () => {
          if (disposed || p.canonKey !== activeCanon || !p.transEl?.isConnected) return;
          p.status = 'translating';
          renderParaTransEl(p);
          syncWrapperModeAndOrigVisibility(wrapper, st);
        },
        onProgress: partialText => {
          if (disposed || p.canonKey !== activeCanon || !p.transEl?.isConnected) return;
          p.status = 'translating';
          p.fromCache = false;
          p.targetText = partialText;
          ensureAnimationLoop();
        },
        onDone: (finalText, cached) => {
          if (disposed || p.canonKey !== activeCanon || !p.transEl?.isConnected) return;
          p.status = 'done';
          p.targetText = finalText;
          p.error = '';
          if (cached) {
            p.fromCache = true;
            p.revealedLen = finalText.length;
            renderParaTransEl(p);
          } else if (p.revealedLen >= finalText.length) {
            renderParaTransEl(p);
          } else {
            p.fromCache = false;
            ensureAnimationLoop();
          }
          syncWrapperModeAndOrigVisibility(wrapper, st);
        },
        onError: errMsg => {
          if (disposed || p.canonKey !== activeCanon || !p.transEl?.isConnected) return;
          p.status = 'error';
          p.error = errMsg;
          renderParaTransEl(p);
          syncWrapperModeAndOrigVisibility(wrapper, st);
        }
      }
    });
  }

  function startFiberBlockTranslation(fb, targetLang, model, priority, onStateChange) {
    const activeCanon = fb.canonKey;
    fb.status = 'queued';
    onStateChange?.();

    enqueueTranslationTask({
      text: fb.text,
      targetLang,
      model,
      force: false,
      priority,
      subscriber: {
        onStart: () => {
          if (disposed || fb.canonKey !== activeCanon) return;
          fb.status = 'translating';
          onStateChange?.();
        },
        onProgress: partialText => {
          if (disposed || fb.canonKey !== activeCanon) return;
          fb.status = 'translating';
          fb.targetText = partialText;
        },
        onDone: (finalText, cached) => {
          if (disposed || fb.canonKey !== activeCanon) return;
          fb.status = 'done';
          fb.targetText = finalText;
          fb.fromCache = cached;
          fb.error = '';
          onStateChange?.();
        },
        onError: errMsg => {
          if (disposed || fb.canonKey !== activeCanon) return;
          fb.status = 'error';
          fb.error = errMsg;
          onStateChange?.();
        }
      }
    });
  }

  function translateWrapperNow(wrapper, force = false) {
    if (disposed || !wrapper || !wrapper.isConnected) return;
    const st = getOrInitBlockState(wrapper);
    const trigger = wrapper.querySelector('[data-testid="thinking-collapsible-trigger"]');
    const viewport = getViewportContainer(wrapper, trigger);
    const targetLang = getEffectiveTargetLang(settings);
    const model = settings.model || DEFAULT_MODEL;

    if (viewport && st.orderedOrigEls.length > 0) {
      for (const origEl of st.orderedOrigEls) {
        const p = st.domParas.get(origEl);
        if (!p) continue;
        if (!shouldTranslateText(p.text, targetLang)) {
          p.status = 'skipped';
          continue;
        }
        if (force || p.status === 'idle' || p.status === 'error') {
          startDomParaTranslation(wrapper, st, p, targetLang, model, force, 'high');
        }
      }
      return;
    }

    if (st.fiberBlocks.length > 0) {
      for (const fb of st.fiberBlocks) {
        if (!shouldTranslateText(fb.text, targetLang)) {
          fb.status = 'skipped';
          continue;
        }
        if (force || fb.status === 'idle' || fb.status === 'error') {
          startFiberBlockTranslation(fb, targetLang, model, 'high', () => {
            syncWrapperHeaderUI(wrapper, st);
          });
        }
      }
    }
  }

  function syncExpandedMarkdownBlocks(wrapper, st, markdownRoot, streamingNow, targetLang, model, prewarmItems) {
    const allowed = isRegionAllowed(wrapper, st);
    if (!allowed) {
      for (const p of st.domParas.values()) {
        if (p.origEl?.isConnected) p.origEl.removeAttribute('data-ag-tt-orig-ready');
        if (p.transEl?.isConnected) p.transEl.remove();
      }
      st.domParas.clear();
      st.orderedOrigEls = [];
      for (const stray of markdownRoot.querySelectorAll(':scope > [data-ag-tt-para]')) {
        stray.remove();
      }
      for (const orig of markdownRoot.querySelectorAll(':scope > [data-ag-tt-orig-ready]')) {
        orig.removeAttribute('data-ag-tt-orig-ready');
      }
      syncWrapperModeAndOrigVisibility(wrapper, st);
      return;
    }

    const domBlocks = collectTranslatableDomBlocks(markdownRoot);
    const activeOrigSet = new Set(domBlocks.map(b => b.origEl));
    const now = Date.now();

    // Remove stale paragraph entries that React unmounted
    for (const [origEl, p] of Array.from(st.domParas.entries())) {
      if (!origEl.isConnected || !activeOrigSet.has(origEl)) {
        if (p.transEl?.isConnected) p.transEl.remove();
        st.domParas.delete(origEl);
      }
    }

    st.orderedOrigEls = domBlocks.map(b => b.origEl);
    const forceAll = st.autoTranslateOnExpand && st.forceTranslateOnExpand;
    const wantExpandTranslate = st.autoTranslateOnExpand;
    st.autoTranslateOnExpand = false;
    st.forceTranslateOnExpand = false;

    for (let i = 0; i < domBlocks.length; i++) {
      const { origEl, text } = domBlocks[i];
      const canonKey = computeCanonicalCacheKey(text, targetLang, model);
      let p = st.domParas.get(origEl);

      if (!p) {
        const transEl = document.createElement('div');
        transEl.className = 'ag-tt-para-trans';
        transEl.setAttribute('data-ag-tt-para', '1');
        p = {
          wrapper,
          origEl,
          transEl,
          text,
          canonKey,
          lastGrowthAt: now,
          status: 'idle',
          targetText: '',
          revealedLen: 0,
          lastHtmlLen: -1,
          lastRenderState: '',
          fromCache: false,
          error: ''
        };
        st.domParas.set(origEl, p);
      } else if (p.canonKey !== canonKey) {
        p.text = text;
        p.canonKey = canonKey;
        p.lastGrowthAt = now;
        p.status = 'idle';
        p.targetText = '';
        p.revealedLen = 0;
        p.lastHtmlLen = -1;
        p.lastRenderState = '';
        p.fromCache = false;
        p.error = '';
      }

      if (origEl.nextElementSibling !== p.transEl) {
        markdownRoot.insertBefore(p.transEl, origEl.nextSibling);
      }

      if (!shouldTranslateText(text, targetLang)) {
        p.status = 'skipped';
        renderParaTransEl(p);
        continue;
      }

      // Instant 0ms restore from client memory cache (populated by background pre-translation or /check-cache)
      if (!forceAll && memCache.has(canonKey)) {
        const hit = memCache.get(canonKey);
        if (p.status !== 'done' || p.targetText !== hit) {
          p.status = 'done';
          p.targetText = hit;
          p.fromCache = true;
          p.revealedLen = hit.length;
          p.error = '';
          renderParaTransEl(p);
        }
        continue;
      }

      prewarmItems.push({ text });

      const isTrailingBlock = i === domBlocks.length - 1;
      const autoTrigger = allowed && (!streamingNow || !isTrailingBlock || (now - p.lastGrowthAt >= LIVE_STREAM_PAUSE_MS && text.length >= 40));

      if (forceAll || (wantExpandTranslate && p.status === 'idle') || (autoTrigger && p.status === 'idle')) {
        startDomParaTranslation(wrapper, st, p, targetLang, model, forceAll, 'high');
      } else {
        renderParaTransEl(p);
      }
    }

    syncWrapperModeAndOrigVisibility(wrapper, st);
  }

  function syncCollapsedFiberBlocks(wrapper, st, fiberThinking, streamingNow, isRecentOrLive, targetLang, model, prewarmItems) {
    const allowed = isRegionAllowed(wrapper, st);
    if (!allowed) {
      st.fiberBlocks = [];
      syncWrapperModeAndOrigVisibility(wrapper, st);
      return;
    }

    const rawBlocks = splitMarkdownIntoBlocks(fiberThinking).filter(b => b.type === 'prose');
    const now = Date.now();
    const prevByCanon = new Map();
    for (const prev of st.fiberBlocks) {
      prevByCanon.set(prev.canonKey, prev);
    }

    const nextBlocks = [];
    for (let i = 0; i < rawBlocks.length; i++) {
      const text = rawBlocks[i].text;
      const canonKey = computeCanonicalCacheKey(text, targetLang, model);
      let fb = prevByCanon.get(canonKey);
      if (!fb) {
        fb = {
          text,
          canonKey,
          lastGrowthAt: now,
          status: 'idle',
          targetText: '',
          fromCache: false,
          error: ''
        };
      }

      if (!shouldTranslateText(text, targetLang)) {
        fb.status = 'skipped';
        nextBlocks.push(fb);
        continue;
      }

      if (memCache.has(canonKey)) {
        fb.status = 'done';
        fb.targetText = memCache.get(canonKey);
        fb.fromCache = true;
        fb.error = '';
        nextBlocks.push(fb);
        continue;
      }

      prewarmItems.push({ text });

      const isTrailing = i === rawBlocks.length - 1;
      const manualScope = Boolean(st.manualActivated || wrapper.closest('[data-ag-tt-manual-group="1"]'));
      const allowCollapsedBg = Boolean(settings.pretranslateCollapsed || st.hasStartedTranslation || manualScope);
      const eligibleRecency = isRecentOrLive || manualScope;
      const canBgTranslate = allowed && allowCollapsedBg && eligibleRecency && (!streamingNow || !isTrailing || (now - fb.lastGrowthAt >= LIVE_STREAM_PAUSE_MS && text.length >= 40));
      if (canBgTranslate && fb.status === 'idle') {
        startFiberBlockTranslation(fb, targetLang, model, manualScope ? 'high' : 'bg', () => {
          syncWrapperHeaderUI(wrapper, st);
        });
      }
      nextBlocks.push(fb);
    }

    st.fiberBlocks = nextBlocks;
    syncWrapperHeaderUI(wrapper, st);
  }

  function scanCollapsedToolGroups(targetLang, model, prewarmItems) {
    if (!settings.enabled) return;
    const buttons = document.querySelectorAll('button[data-testid="tool-group-collapsible"]');
    for (const btn of buttons) {
      const isExpanded = btn.getAttribute('aria-expanded') === 'true';
      if (isExpanded) continue;

      const thinkings = extractToolGroupThinkingsFromFiber(btn);
      if (!thinkings.length) {
        if (!initialScanDone && !seenToolGroups.has(btn)) {
          seenToolGroups.set(btn, '');
        }
        continue;
      }

      const combined = thinkings.join('\n\n---\n\n');
      const hadSeenBefore = seenToolGroups.has(btn);
      const prevFingerprint = seenToolGroups.get(btn) || '';

      if (!initialScanDone) {
        seenToolGroups.set(btn, combined);
        historicalToolGroups.add(btn);
        // On initial mount of existing history, only warm local cache without triggering fresh agy calls
        for (const th of thinkings) {
          for (const blk of splitMarkdownIntoBlocks(th)) {
            if (blk.type === 'prose' && shouldTranslateText(blk.text, targetLang)) {
              prewarmItems.push({ text: blk.text });
            }
          }
        }
        continue;
      }

      if (historicalToolGroups.has(btn) && combined === prevFingerprint) {
        continue;
      }
      historicalToolGroups.delete(btn);

      if (!hadSeenBefore || combined !== prevFingerprint) {
        seenToolGroups.set(btn, combined);
      }

      const stateList = toolGroupStates.get(btn) || [];
      const prevMap = new Map(stateList.map(item => [item.canonKey, item]));
      const nextList = [];

      for (const th of thinkings) {
        const blocks = splitMarkdownIntoBlocks(th).filter(b => b.type === 'prose');
        for (const blk of blocks) {
          const canonKey = computeCanonicalCacheKey(blk.text, targetLang, model);
          if (!shouldTranslateText(blk.text, targetLang)) continue;
          if (memCache.has(canonKey)) continue;
          prewarmItems.push({ text: blk.text });
          let entry = prevMap.get(canonKey);
          if (!entry) {
            entry = { text: blk.text, canonKey, status: 'idle', targetText: '', fromCache: false, error: '' };
          }
          if (settings.enabled && settings.pretranslateCollapsed && entry.status === 'idle') {
            startFiberBlockTranslation(entry, targetLang, model, 'bg', null);
          }
          nextList.push(entry);
        }
      }
      toolGroupStates.set(btn, nextList);
    }
  }

  function syncManualGroupBar(groupWrapper, grpState) {
    if (!groupWrapper || !groupWrapper.isConnected || !grpState) return;
    if (settings.enabled || !groupWrapper.hasAttribute('data-ag-tt-manual-group')) {
      groupWrapper.removeAttribute('data-ag-tt-has-group-badge');
      for (const old of groupWrapper.querySelectorAll(':scope > .ag-tt-group-bar')) old.remove();
      return;
    }

    let bar = null;
    for (const child of groupWrapper.children) {
      if (child.classList && child.classList.contains('ag-tt-group-bar')) {
        bar = child;
        break;
      }
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'ag-tt-group-bar';
      bar.setAttribute('data-ag-tt-ui', '1');
      const badge = document.createElement('span');
      badge.className = 'ag-tt-group-badge';
      badge.setAttribute('role', 'button');
      badge.tabIndex = -1;
      badge.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const btn = grpState.targetBtn;
        if (!btn || !btn.isConnected) return;
        if (btn.getAttribute('aria-expanded') !== 'true') {
          btn.click();
          return;
        }
        void triggerManualRegionTranslation(btn, true);
      });
      bar.appendChild(badge);
      groupWrapper.appendChild(bar);
    }

    let total = 0;
    let done = 0;
    let translating = 0;
    let errorCount = 0;

    const targetBtn = grpState.targetBtn;
    const isExpanded = targetBtn?.getAttribute('aria-expanded') === 'true';

    if (!isExpanded && grpState.fiberBlocks.length > 0) {
      for (const fb of grpState.fiberBlocks) {
        if (fb.status === 'skipped') continue;
        total++;
        if (fb.status === 'done') done++;
        else if (fb.status === 'translating' || fb.status === 'queued') translating++;
        else if (fb.status === 'error') errorCount++;
      }
    } else {
      for (const trig of groupWrapper.querySelectorAll('button[data-testid="thinking-collapsible-trigger"]')) {
        const w = trig.parentElement;
        const st = w ? blockStates.get(w) : null;
        if (!st) continue;
        const p = computeWrapperProgress(st);
        total += p.total;
        done += p.done;
        translating += p.translating;
        errorCount += p.errorCount;
      }
    }

    let titlesTranslating = 0;
    for (const entry of titleStates.values()) {
      if (entry?.containerEl?.isConnected && (entry.containerEl === targetBtn || groupWrapper.contains(entry.containerEl))) {
        if (entry.status === 'translating' || entry.status === 'queued') titlesTranslating++;
      }
    }

    let status = 'done';
    if (translating > 0 || (total === 0 && titlesTranslating > 0)) status = 'translating';
    else if (errorCount > 0 && done === 0) status = 'error';
    else if (total > 0 && done < total) status = 'partial';

    const effLang = getEffectiveTargetLang(settings);
    const badge = bar.querySelector('.ag-tt-group-badge');
    if (badge) {
      badge.setAttribute('data-status', status);
      if (status === 'translating') {
        badge.textContent = total > 1 ? `译中 ${done}/${total}` : '译中...';
        badge.title = '正在翻译该区域标题与思考详情';
      } else if (status === 'error') {
        badge.textContent = '译失败';
        badge.title = '点击重试翻译';
      } else if (status === 'partial') {
        badge.textContent = `已译 ${done}/${total}`;
        badge.title = isExpanded ? '点击重译' : '点击展开查看详情';
      } else {
        badge.textContent = `已译 · ${effLang}`;
        badge.title = isExpanded ? '点击重新翻译该区域' : '点击展开查看译文';
      }
    }

    bar.style.display = 'inline-flex';
    groupWrapper.setAttribute('data-ag-tt-has-group-badge', '1');
  }

  function hideHoverTranslateButton() {
    if (hoverDwellTimer) {
      clearTimeout(hoverDwellTimer);
      hoverDwellTimer = 0;
    }
    hoveredHeaderBtn = null;
    activeHoverTarget = null;
    if (activeHoverHost && activeHoverHost.isConnected) {
      activeHoverHost.removeAttribute('data-ag-tt-hover-host');
    }
    activeHoverHost = null;
    if (hoverBtnEl && hoverBtnEl.isConnected) {
      hoverBtnEl.remove();
    }
  }

  function isHeaderAlreadyActivated(btn) {
    if (!btn || !btn.isConnected) return true;
    const isThinkingTrig = btn.getAttribute('data-testid') === 'thinking-collapsible-trigger';
    const wrapper = btn.parentElement;
    const st = isThinkingTrig && wrapper ? blockStates.get(wrapper) : null;
    return isRegionAllowed(wrapper || btn, st);
  }

  function showHoverTranslateButton(headerBtn) {
    if (disposed || settings.enabled || !headerBtn || !headerBtn.isConnected) return;
    if (isHeaderAlreadyActivated(headerBtn)) return;
    const hostEl = headerBtn.parentElement;
    if (!hostEl || !hostEl.isConnected) return;

    if (!hoverBtnEl) {
      hoverBtnEl = document.createElement('button');
      hoverBtnEl.type = 'button';
      hoverBtnEl.className = 'ag-tt-hover-translate-btn';
      hoverBtnEl.setAttribute('data-ag-tt-ui', '1');
      hoverBtnEl.textContent = '翻译';
      hoverBtnEl.title = '手动翻译该区域内的标题和思考详情';
      hoverBtnEl.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const target = activeHoverTarget;
        hideHoverTranslateButton();
        if (target && target.isConnected) {
          void triggerManualRegionTranslation(target, false);
        }
      });
    }

    if (activeHoverHost && activeHoverHost !== hostEl && activeHoverHost.isConnected) {
      activeHoverHost.removeAttribute('data-ag-tt-hover-host');
    }
    activeHoverHost = hostEl;
    activeHoverTarget = headerBtn;
    hostEl.setAttribute('data-ag-tt-hover-host', '1');
    if (hoverBtnEl.parentElement !== hostEl) {
      hostEl.appendChild(hoverBtnEl);
    }
  }

  function resolveHoverHeaderButton(node) {
    if (!node || node.nodeType !== 1) return null;
    if (node.closest('#ag-thinking-translator, #ag-context-meter, [role="dialog"], [role="menu"], [role="listbox"], .ag-tt-trigger-bar, .ag-tt-group-bar')) {
      return null;
    }
    if (node.closest('.ag-tt-hover-translate-btn')) {
      return activeHoverTarget || hoveredHeaderBtn;
    }
    return node.closest(HOVER_HEADER_SELECTOR);
  }

  async function triggerManualRegionTranslation(targetBtn, force = false) {
    if (disposed || !targetBtn || !targetBtn.isConnected) return;
    const targetLang = getEffectiveTargetLang(settings);
    const model = settings.model || DEFAULT_MODEL;
    const testId = targetBtn.getAttribute('data-testid');

    const collectBtnWarmTitle = (btn, list) => {
      const firstChild = Array.from(btn.children).find(c => !c.hasAttribute('data-ag-tt-ui'));
      if (!firstChild) return;
      const info = extractCleanTitleInfo(firstChild);
      if (info.fullText && !info.isRawCodeFallback && !translateBoilerplateTitle(info.fullText, targetLang) && shouldTranslateTitle(info.fullText, targetLang)) {
        list.push({ text: info.fullText });
      }
    };

    if (testId === 'thinking-collapsible-trigger') {
      const wrapper = targetBtn.parentElement;
      if (!wrapper) return;
      const st = getOrInitBlockState(wrapper);
      st.manualActivated = true;
      st.hasStartedTranslation = true;
      const trigEntry = titleStates.get(targetBtn);
      if (trigEntry) trigEntry.manualRequested = true;

      const warmItems = [];
      if (!force) {
        collectBtnWarmTitle(targetBtn, warmItems);
        const vp = getViewportContainer(wrapper, targetBtn);
        const mdRoot = vp ? findMarkdownRoot(vp) : null;
        if (mdRoot) {
          for (const blk of collectTranslatableDomBlocks(mdRoot)) {
            if (shouldTranslateText(blk.text, targetLang)) warmItems.push({ text: blk.text });
          }
        } else {
          const ft = extractThinkingFromFiber(targetBtn);
          if (ft) {
            for (const blk of splitMarkdownIntoBlocks(ft)) {
              if (blk.type === 'prose' && shouldTranslateText(blk.text, targetLang)) warmItems.push({ text: blk.text });
            }
          }
        }
        if (warmItems.length > 0) {
          await prewarmBackendCache(warmItems, targetLang, model, { skipScan: true });
        }
        if (disposed || !wrapper.isConnected) return;
      }

      scanStepAndHeaderTitles(targetLang, model, [], false);
      const viewportNow = getViewportContainer(wrapper, targetBtn);
      const markdownRootNow = viewportNow ? findMarkdownRoot(viewportNow) : null;
      if (markdownRootNow) {
        syncExpandedMarkdownBlocks(wrapper, st, markdownRootNow, isTriggerStreaming(targetBtn), targetLang, model, []);
        translateWrapperNow(wrapper, force);
      } else {
        const fiberThinking = extractThinkingFromFiber(targetBtn);
        if (fiberThinking) {
          syncCollapsedFiberBlocks(wrapper, st, fiberThinking, isTriggerStreaming(targetBtn), true, targetLang, model, []);
          translateWrapperNow(wrapper, force);
        } else {
          st.autoTranslateOnExpand = true;
          st.forceTranslateOnExpand = force;
          syncWrapperModeAndOrigVisibility(wrapper, st);
          targetBtn.click();
        }
      }
      return;
    }

    // Group headers (`worked-for-collapsible`, `tool-group-collapsible`, `progress-updates-collapsible`)
    const groupWrapper = targetBtn.parentElement;
    if (!groupWrapper) return;
    groupWrapper.setAttribute('data-ag-tt-manual-group', '1');
    trackedManualGroups.add(groupWrapper);

    let grpState = manualGroupStates.get(groupWrapper);
    if (!grpState) {
      grpState = { targetBtn, fiberBlocks: [] };
      manualGroupStates.set(groupWrapper, grpState);
    } else {
      grpState.targetBtn = targetBtn;
    }

    const warmItems = [];
    if (!force) collectBtnWarmTitle(targetBtn, warmItems);

    for (const stepRow of groupWrapper.querySelectorAll('div.group.flex.w-full.min-w-0.items-center.min-h-8.select-none')) {
      const slot = stepRow.children[0];
      const orig = slot ? Array.from(slot.children).find(c => !c.hasAttribute('data-ag-tt-ui')) : null;
      if (orig && !force) {
        const info = extractCleanTitleInfo(orig);
        if (info.fullText && !info.isRawCodeFallback && !translateBoilerplateTitle(info.fullText, targetLang) && shouldTranslateTitle(info.fullText, targetLang)) {
          warmItems.push({ text: info.fullText });
        }
      }
    }

    const innerTriggers = Array.from(groupWrapper.querySelectorAll('button[data-testid="thinking-collapsible-trigger"]'));
    for (const trig of innerTriggers) {
      if (!force) collectBtnWarmTitle(trig, warmItems);
      const w = trig.parentElement;
      if (!w) continue;
      const st = getOrInitBlockState(w);
      st.manualActivated = true;
      st.hasStartedTranslation = true;
      if (!force) {
        const vp = getViewportContainer(w, trig);
        const mdRoot = vp ? findMarkdownRoot(vp) : null;
        if (mdRoot) {
          for (const blk of collectTranslatableDomBlocks(mdRoot)) {
            if (shouldTranslateText(blk.text, targetLang)) warmItems.push({ text: blk.text });
          }
        } else {
          const ft = extractThinkingFromFiber(trig);
          if (ft) {
            for (const blk of splitMarkdownIntoBlocks(ft)) {
              if (blk.type === 'prose' && shouldTranslateText(blk.text, targetLang)) warmItems.push({ text: blk.text });
            }
          }
        }
      }
    }

    const fiberThinkings = targetBtn.getAttribute('aria-expanded') === 'true' ? [] : extractToolGroupThinkingsFromFiber(targetBtn);
    const nextGroupFiberBlocks = [];
    for (const th of fiberThinkings) {
      for (const blk of splitMarkdownIntoBlocks(th)) {
        if (blk.type === 'prose' && shouldTranslateText(blk.text, targetLang)) {
          const ck = computeCanonicalCacheKey(blk.text, targetLang, model);
          if (!force) warmItems.push({ text: blk.text });
          nextGroupFiberBlocks.push({ text: blk.text, canonKey: ck, status: 'idle', targetText: '', fromCache: false, error: '' });
        }
      }
    }

    if (warmItems.length > 0) {
      await prewarmBackendCache(warmItems, targetLang, model, { skipScan: true });
    }
    if (disposed || !groupWrapper.isConnected) return;

    for (const fb of nextGroupFiberBlocks) {
      if (!force && memCache.has(fb.canonKey)) {
        fb.status = 'done';
        fb.targetText = memCache.get(fb.canonKey);
        fb.fromCache = true;
      }
    }
    grpState.fiberBlocks = nextGroupFiberBlocks;

    scanStepAndHeaderTitles(targetLang, model, [], force);

    for (const trig of innerTriggers) {
      const w = trig.parentElement;
      if (!w || !w.isConnected) continue;
      const st = getOrInitBlockState(w);
      const vp = getViewportContainer(w, trig);
      const mdRoot = vp ? findMarkdownRoot(vp) : null;
      if (mdRoot) {
        syncExpandedMarkdownBlocks(w, st, mdRoot, isTriggerStreaming(trig), targetLang, model, []);
      } else {
        const ft = extractThinkingFromFiber(trig);
        if (ft) syncCollapsedFiberBlocks(w, st, ft, isTriggerStreaming(trig), true, targetLang, model, []);
      }
      translateWrapperNow(w, force);
    }

    syncManualGroupBar(groupWrapper, grpState);
    for (const fb of grpState.fiberBlocks) {
      if (force || fb.status === 'idle' || fb.status === 'error') {
        startFiberBlockTranslation(fb, targetLang, model, 'high', () => {
          syncManualGroupBar(groupWrapper, grpState);
        });
      }
    }
  }

  function scanThinkingBlocks() {
    if (disposed) return;
    ensureGlobalStyles();
    applyColorTheme();
    dockToTitlebar();

    const targetLang = getEffectiveTargetLang(settings);
    const model = settings.model || DEFAULT_MODEL;
    const prewarmItems = [];

    // Priority 0: Always translate allowed group headers & step titles FIRST
    scanStepAndHeaderTitles(targetLang, model, prewarmItems, false);

    const triggers = Array.from(document.querySelectorAll('[data-testid="thinking-collapsible-trigger"]'));
    const total = triggers.length;

    for (let idx = 0; idx < total; idx++) {
      const trigger = triggers[idx];
      const wrapper = trigger.parentElement;
      if (!wrapper) continue;

      const isNew = !blockStates.has(wrapper);
      const st = getOrInitBlockState(wrapper);
      if (isNew && !initialScanDone) {
        st.seenOnInitialScan = true;
      }

      const streamingNow = isTriggerStreaming(trigger);
      if (streamingNow) st.wasStreaming = true;
      else if (st.wasStreaming) st.wasStreaming = false;

      const viewport = getViewportContainer(wrapper, trigger);
      const markdownRoot = viewport ? findMarkdownRoot(viewport) : null;

      if (markdownRoot) {
        st.fiberBlocks = [];
        syncExpandedMarkdownBlocks(wrapper, st, markdownRoot, streamingNow, targetLang, model, prewarmItems);
      } else {
        // Clear stale DOM maps if collapsed
        if (st.domParas.size > 0) {
          for (const p of st.domParas.values()) {
            if (p.transEl?.isConnected) p.transEl.remove();
          }
          st.domParas.clear();
          st.orderedOrigEls = [];
        }
        const fiberThinking = extractThinkingFromFiber(trigger);
        if (fiberThinking) {
          const isRecentOrLive = !st.seenOnInitialScan || streamingNow || st.wasStreaming || idx >= total - 2;
          syncCollapsedFiberBlocks(wrapper, st, fiberThinking, streamingNow, isRecentOrLive, targetLang, model, prewarmItems);
        } else {
          syncWrapperModeAndOrigVisibility(wrapper, st);
        }
      }
    }

    for (const gw of Array.from(trackedManualGroups)) {
      if (!gw.isConnected) {
        trackedManualGroups.delete(gw);
        manualGroupStates.delete(gw);
        continue;
      }
      syncManualGroupBar(gw, manualGroupStates.get(gw));
    }

    scanCollapsedToolGroups(targetLang, model, prewarmItems);

    if (!initialScanDone) {
      initialScanDone = true;
    }

    if (prewarmItems.length > 0) {
      void prewarmBackendCache(prewarmItems, targetLang, model);
    }
  }

  function scheduleFastTitleSync() {
    if (disposed || titleSyncRaf) return;
    titleSyncRaf = requestAnimationFrame(() => {
      titleSyncRaf = 0;
      if (disposed) return;
      scanStepAndHeaderTitles(getEffectiveTargetLang(settings), settings.model || DEFAULT_MODEL, [], false);
    });
  }

  function scheduleScan() {
    if (disposed || scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scanThinkingBlocks();
    }, 150);
  }

  function isPluginNode(node) {
    if (!node || node.nodeType !== 1) return false;
    return (
      node.id === HOST_ID ||
      node.id === GLOBAL_STYLE_ID ||
      node.id === THEME_VARS_STYLE_ID ||
      node.hasAttribute('data-ag-tt-para') ||
      node.hasAttribute('data-ag-tt-ui') ||
      node.classList?.contains('ag-tt-token-in') ||
      node.classList?.contains('ag-tt-stream-caret')
    );
  }

  function isPluginMutation(mutations) {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName && m.attributeName.startsWith('data-ag-tt-')) {
        continue;
      }
      if (m.type === 'childList') {
        const addedOk = Array.from(m.addedNodes).every(n => n.nodeType !== 1 || isPluginNode(n));
        const removedOk = Array.from(m.removedNodes).every(n => n.nodeType !== 1 || isPluginNode(n));
        if (addedOk && removedOk && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
          continue;
        }
      }
      const target = m.target;
      if (!target) continue;
      const elTarget = target.nodeType === 1 ? target : target.parentElement;
      if (elTarget && elTarget.closest && elTarget.closest(`#${HOST_ID}, [data-ag-tt-para], [data-ag-tt-ui], #${GLOBAL_STYLE_ID}, #${THEME_VARS_STYLE_ID}`)) {
        continue;
      }
      return false;
    }
    return true;
  }

  // =========================================================================
  // Event Binding & Lifecycle
  // =========================================================================
  function bindEvents() {
    const cap = el('tt-capsule');
    const pop = el('tt-popover');
    const closeBtn = el('tt-close');

    const setPopover = open => {
      popoverOpen = Boolean(open);
      if (cap) cap.setAttribute('aria-expanded', popoverOpen ? 'true' : 'false');
      if (pop) pop.setAttribute('data-open', popoverOpen ? 'true' : 'false');
      if (popoverOpen) positionPopover();
    };

    cap?.addEventListener('click', ev => {
      ev.stopPropagation();
      setPopover(!popoverOpen);
    });
    closeBtn?.addEventListener('click', () => setPopover(false));

    docClickHandler = ev => {
      if (!popoverOpen) return;
      const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
      if (!path.includes(host)) setPopover(false);
    };
    document.addEventListener('click', docClickHandler);

    el('tt-enabled')?.addEventListener('change', ev => {
      void persistSettings({ enabled: ev.target.checked });
    });

    el('tt-pretranslate-collapsed')?.addEventListener('change', ev => {
      void persistSettings({ pretranslateCollapsed: ev.target.checked });
    });

    el('tt-target-lang')?.addEventListener('change', ev => {
      const val = ev.target.value;
      void persistSettings({ targetLang: val });
      if (val === CUSTOM_LANG_VALUE) {
        setTimeout(() => el('tt-custom-lang')?.focus(), 50);
      }
    });

    const commitCustomLang = () => {
      const val = (el('tt-custom-lang')?.value || '').trim();
      if (val !== settings.customTargetLang) {
        void persistSettings({ targetLang: CUSTOM_LANG_VALUE, customTargetLang: val });
      }
    };
    el('tt-custom-lang')?.addEventListener('change', commitCustomLang);
    el('tt-custom-lang')?.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commitCustomLang();
      }
    });

    el('tt-mode-bilingual')?.addEventListener('click', () => {
      void persistSettings({ displayMode: 'bilingual' });
    });
    el('tt-mode-translation')?.addEventListener('click', () => {
      void persistSettings({ displayMode: 'translation_only' });
    });

    el('tt-model-base')?.addEventListener('change', ev => {
      const groups = groupModelsForCascade(getEffectiveModelsList());
      const resolved = resolveCascadeSelection(groups, settings.model, ev.target.value, preferredLevelKey);
      if (resolved.levelKey) preferredLevelKey = resolved.levelKey;
      void persistSettings({ model: resolved.modelId });
    });

    el('tt-model-level')?.addEventListener('change', ev => {
      const chosenId = ev.target.value;
      const groups = groupModelsForCascade(getEffectiveModelsList());
      const resolved = resolveCascadeSelection(groups, chosenId);
      if (resolved.levelKey) preferredLevelKey = resolved.levelKey;
      void persistSettings({ model: chosenId });
    });

    el('tt-refresh-models')?.addEventListener('click', async ev => {
      const btn = ev.currentTarget;
      btn.textContent = '刷新中...';
      btn.disabled = true;
      try {
        const res = await callBridge('/list-models', { force: true });
        if (res && Array.isArray(res.models) && res.models.length) {
          models = res.models;
        }
        renderSettingsUI();
      } catch (err) {
        lastErrorMsg = err?.message || String(err);
        renderSettingsUI();
      } finally {
        btn.textContent = '↻ 刷新';
        btn.disabled = false;
      }
    });

    docMouseOverHandler = ev => {
      if (disposed || settings.enabled) return;
      const target = ev.target && ev.target.nodeType === 1 ? ev.target : ev.target?.parentElement;
      const btn = resolveHoverHeaderButton(target);
      if (!btn || isHeaderAlreadyActivated(btn)) {
        if (hoveredHeaderBtn && btn !== hoveredHeaderBtn) {
          hideHoverTranslateButton();
        }
        return;
      }
      if (btn === activeHoverTarget) return;
      if (btn === hoveredHeaderBtn && hoverDwellTimer) return;

      hideHoverTranslateButton();
      hoveredHeaderBtn = btn;
      hoverDwellTimer = setTimeout(() => {
        hoverDwellTimer = 0;
        if (disposed || settings.enabled || hoveredHeaderBtn !== btn || !btn.isConnected) return;
        showHoverTranslateButton(btn);
      }, HOVER_DWELL_MS);
    };

    docMouseOutHandler = ev => {
      if (disposed || (!hoveredHeaderBtn && !activeHoverTarget)) return;
      const rel = ev.relatedTarget && ev.relatedTarget.nodeType === 1 ? ev.relatedTarget : ev.relatedTarget?.parentElement;
      const nextBtn = resolveHoverHeaderButton(rel);
      if (nextBtn === hoveredHeaderBtn || (activeHoverTarget && nextBtn === activeHoverTarget)) {
        return;
      }
      hideHoverTranslateButton();
    };

    document.addEventListener('mouseover', docMouseOverHandler, true);
    document.addEventListener('mouseout', docMouseOutHandler, true);

    el('tt-translate-now')?.addEventListener('click', () => {
      const targetLang = getEffectiveTargetLang(settings);
      const model = settings.model || DEFAULT_MODEL;
      if (!settings.enabled) {
        hideHoverTranslateButton();
        for (const btn of document.querySelectorAll('button[data-testid="worked-for-collapsible"], button[data-testid="tool-group-collapsible"], button[data-testid="progress-updates-collapsible"]')) {
          if (btn.parentElement) {
            btn.parentElement.setAttribute('data-ag-tt-manual-group', '1');
            trackedManualGroups.add(btn.parentElement);
            if (!manualGroupStates.has(btn.parentElement)) {
              manualGroupStates.set(btn.parentElement, { targetBtn: btn, fiberBlocks: [] });
            }
          }
        }
        for (const wrapper of Array.from(trackedWrappers)) {
          if (!wrapper.isConnected) continue;
          const st = blockStates.get(wrapper);
          if (st) {
            st.manualActivated = true;
            st.hasStartedTranslation = true;
          }
        }
      }
      scanStepAndHeaderTitles(targetLang, model, [], true);
      scanThinkingBlocks();
      for (const wrapper of Array.from(trackedWrappers)) {
        if (!wrapper.isConnected) continue;
        void translateWrapperNow(wrapper, false);
      }
    });

    el('tt-clear-cache')?.addEventListener('click', async () => {
      try {
        await callBridge('/clear-cache', {});
        cacheCount = 0;
        resetAllTranslationStates({ clearMem: true, clearManual: !settings.enabled });
        renderSettingsUI();
        scheduleScan();
      } catch (err) {
        lastErrorMsg = err?.message || String(err);
        renderSettingsUI();
      }
    });

    window.addEventListener('resize', positionPopover);
  }

  async function bootstrap() {
    ensureGlobalStyles();
    syncTheme();
    bindEvents();
    (document.body || document.documentElement).appendChild(host);
    dockToTitlebar();
    renderSettingsUI();

    try {
      const res = await callBridge('/get-settings', {});
      if (res && res.ok && res.settings) {
        settings = normalizeSettings(res.settings);
      }
      if (res && res.cacheStats && typeof res.cacheStats.count === 'number') {
        cacheCount = res.cacheStats.count;
      }
    } catch {}

    if (!settings.enabled) {
      deactivateAllToVanilla();
    }

    try {
      const mRes = await callBridge('/list-models', { force: false });
      if (mRes && Array.isArray(mRes.models) && mRes.models.length) {
        models = mRes.models;
      }
    } catch {}

    renderSettingsUI();

    if (typeof ResizeObserver !== 'undefined') {
      titlebarResizeObserver = new ResizeObserver(() => positionPopover());
    }
    if (typeof MutationObserver !== 'undefined') {
      themeObserver = new MutationObserver(() => syncTheme());
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
      if (document.body) {
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
      }
      domObserver = new MutationObserver(mutations => {
        if (!isPluginMutation(mutations)) {
          scheduleFastTitleSync();
          scheduleScan();
        }
      });
      domObserver.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-expanded']
      });
    }

    pollTimer = setInterval(() => {
      if (!disposed) scanThinkingBlocks();
    }, 900);

    scanThinkingBlocks();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    hideHoverTranslateButton();
    if (scanTimer) clearTimeout(scanTimer);
    if (titleSyncRaf) cancelAnimationFrame(titleSyncRaf);
    if (pollTimer) clearInterval(pollTimer);
    if (batchFlushTimer) clearTimeout(batchFlushTimer);
    if (rafId) cancelAnimationFrame(rafId);
    titleQueue.length = 0;
    highQueue.length = 0;
    bgQueue.length = 0;
    try { themeObserver?.disconnect(); } catch {}
    try { domObserver?.disconnect(); } catch {}
    try { titlebarResizeObserver?.disconnect(); } catch {}
    if (docClickHandler) document.removeEventListener('click', docClickHandler);
    if (docMouseOverHandler) document.removeEventListener('mouseover', docMouseOverHandler, true);
    if (docMouseOutHandler) document.removeEventListener('mouseout', docMouseOutHandler, true);
    window.removeEventListener('resize', positionPopover);

    for (const gw of Array.from(trackedManualGroups)) {
      if (gw.isConnected) {
        gw.removeAttribute('data-ag-tt-manual-group');
        gw.removeAttribute('data-ag-tt-has-group-badge');
        for (const bar of gw.querySelectorAll(':scope > .ag-tt-group-bar, :scope > [data-ag-tt-ui]')) {
          bar.remove();
        }
      }
    }
    trackedManualGroups.clear();

    for (const [containerEl, entry] of Array.from(titleStates.entries())) {
      if (entry.origEl?.isConnected) entry.origEl.removeAttribute('data-ag-tt-title-ready');
      if (entry.transEl?.isConnected) entry.transEl.remove();
      if (containerEl?.isConnected) {
        containerEl.removeAttribute('data-ag-tt-title-mode');
        containerEl.removeAttribute('data-ag-tt-title-interactive');
        containerEl.removeAttribute('data-ag-tt-title-slot');
        containerEl.removeAttribute('data-ag-tt-header-wrap');
      }
    }
    titleStates.clear();

    for (const wrapper of Array.from(trackedWrappers)) {
      if (!wrapper.isConnected) continue;
      wrapper.removeAttribute('data-ag-tt-wrapper');
      wrapper.removeAttribute('data-ag-tt-mode');
      wrapper.removeAttribute('data-ag-tt-active');
      wrapper.removeAttribute('data-ag-tt-has-badge');
      wrapper.removeAttribute('data-ag-tt-has-tools');
      for (const bar of wrapper.querySelectorAll(':scope > .ag-tt-trigger-bar, :scope > [data-ag-tt-ui]')) {
        bar.remove();
      }
      for (const p of wrapper.querySelectorAll('[data-ag-tt-para]')) {
        p.remove();
      }
      for (const orig of wrapper.querySelectorAll('[data-ag-tt-orig-ready]')) {
        orig.removeAttribute('data-ag-tt-orig-ready');
      }
    }

    for (const hostNode of document.querySelectorAll('[data-ag-tt-hover-host]')) {
      hostNode.removeAttribute('data-ag-tt-hover-host');
    }
    for (const t of document.querySelectorAll('.ag-tt-header-title-trans, .ag-tt-step-title-trans, .ag-tt-hover-translate-btn, .ag-tt-group-bar')) t.remove();
    for (const p of document.querySelectorAll('[data-ag-tt-para]')) p.remove();
    trackedWrappers.clear();
    memCache.clear();
    checkedCanonMisses.clear();
    try { document.getElementById(GLOBAL_STYLE_ID)?.remove(); } catch {}
    try { document.getElementById(THEME_VARS_STYLE_ID)?.remove(); } catch {}
    try { host.remove(); } catch {}
  }

  globalThis.__AGThinkingTranslator = {
    version: PLUGIN_VERSION,
    dispose,
    getStatus: () => ({
      active: !disposed && Boolean(host.isConnected),
      version: PLUGIN_VERSION,
      enabled: settings.enabled,
      pretranslateCollapsed: settings.pretranslateCollapsed,
      colorTheme: settings.colorTheme,
      targetLang: getEffectiveTargetLang(settings),
      displayMode: settings.displayMode,
      model: settings.model,
      hasIpcBridge: Boolean(getIpcApi()),
      hasLiveBridge: Boolean(getLiveInfo()),
      trackedBlocks: trackedWrappers.size,
      trackedTitles: titleStates.size,
      activeTranslations,
      lastError: lastErrorMsg || null
    }),
    translateAllVisible: () => {
      const targetLang = getEffectiveTargetLang(settings);
      const model = settings.model || DEFAULT_MODEL;
      scanStepAndHeaderTitles(targetLang, model, [], false);
      for (const w of Array.from(trackedWrappers)) {
        if (w.isConnected) void translateWrapperNow(w, false);
      }
    }
  };

  void bootstrap();
})();
