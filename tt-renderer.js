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
    CUSTOM_LANG_VALUE,
    SUPPORTED_LANGUAGES,
    FALLBACK_MODELS,
    DEFAULT_SETTINGS,
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
  const HOST_ID = 'ag-thinking-translator';
  const LIVE_STREAM_PAUSE_MS = 1400;
  const STREAM_FRAME_INTERVAL_MS = 32;
  const MAX_CONCURRENT_BATCH_REQUESTS = 2;
  const TITLE_COALESCE_MS = 30;
  const PARA_COALESCE_MS = 45;
  const CLIENT_BATCH_MAX_ITEMS = 12;
  const CLIENT_BATCH_MAX_CHARS = 4200;
  const TRANSLATABLE_TAGS = new Set(['P', 'UL', 'OL', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

  let settings = normalizeSettings(DEFAULT_SETTINGS);
  let models = FALLBACK_MODELS.slice();
  let preferredLevelKey = resolveCascadeSelection(groupModelsForCascade(models), settings.model).levelKey || 'medium';
  let cacheCount = 0;
  let disposed = false;
  let popoverOpen = false;
  let activeTranslations = 0;
  let lastErrorMsg = '';
  let scanTimer = 0;
  let titleSyncRaf = 0;
  let pollTimer = 0;
  let batchFlushTimer = 0;
  let batchFlushAt = 0;
  let rafId = 0;
  let lastAnimTick = 0;
  let themeObserver = null;
  let domObserver = null;
  let titlebarResizeObserver = null;
  let observedTitlebar = null;
  let docClickHandler = null;
  let reqSeq = 0;
  let initialScanDone = false;

  // Wrapper, title & paragraph state tracking
  const blockStates = new WeakMap();
  const trackedWrappers = new Set();
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

  const TT_STYLES = ":host {\n  all: initial;\n  display: inline-flex;\n  align-items: center;\n  position: relative;\n  font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"PingFang SC\", \"Microsoft YaHei\", sans-serif;\n  color: var(--tt-text);\n  -webkit-app-region: no-drag;\n  margin-right: 6px;\n  --tt-bg: rgba(255, 255, 255, 0.94);\n  --tt-bg-elevated: #ffffff;\n  --tt-bg-sub: #f4f5f7;\n  --tt-border: rgba(15, 23, 42, 0.12);\n  --tt-text: #111827;\n  --tt-text-muted: #6b7280;\n  --tt-accent: #6366f1;\n  --tt-accent-soft: rgba(99, 102, 241, 0.12);\n  --tt-accent-text: #4f46e5;\n  --tt-success: #10b981;\n  --tt-warn: #f59e0b;\n  --tt-danger: #ef4444;\n  --tt-shadow: 0 12px 32px rgba(15, 23, 42, 0.16), 0 2px 6px rgba(15, 23, 42, 0.08);\n}\n\n:host([data-theme=\"dark\"]) {\n  --tt-bg: rgba(28, 30, 36, 0.94);\n  --tt-bg-elevated: #1e2028;\n  --tt-bg-sub: #272a34;\n  --tt-border: rgba(255, 255, 255, 0.12);\n  --tt-text: #f3f4f6;\n  --tt-text-muted: #9ca3af;\n  --tt-accent: #818cf8;\n  --tt-accent-soft: rgba(129, 140, 248, 0.16);\n  --tt-accent-text: #a5b4fc;\n  --tt-shadow: 0 14px 36px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.25);\n}\n\n:host([data-dock=\"fixed\"]) {\n  position: fixed;\n  top: 8px;\n  right: 260px;\n  z-index: 9998;\n}\n\n.tt-capsule {\n  display: inline-flex;\n  align-items: center;\n  gap: 5px;\n  height: 24px;\n  padding: 0 9px;\n  border-radius: 999px;\n  border: 1px solid var(--tt-border);\n  background: var(--tt-bg-sub);\n  color: var(--tt-text);\n  font-size: 11.5px;\n  font-weight: 500;\n  line-height: 1;\n  cursor: pointer;\n  user-select: none;\n  transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;\n  white-space: nowrap;\n}\n\n.tt-capsule:hover {\n  border-color: var(--tt-accent);\n  background: var(--tt-accent-soft);\n}\n\n.tt-capsule[aria-expanded=\"true\"] {\n  border-color: var(--tt-accent);\n  background: var(--tt-accent-soft);\n  color: var(--tt-accent-text);\n}\n\n.tt-dot {\n  width: 6px;\n  height: 6px;\n  border-radius: 50%;\n  background: var(--tt-text-muted);\n  flex-shrink: 0;\n}\n\n.tt-capsule[data-state=\"active\"] .tt-dot {\n  background: var(--tt-success);\n}\n\n.tt-capsule[data-state=\"translating\"] .tt-dot {\n  background: var(--tt-accent);\n  animation: tt-pulse 1s ease-in-out infinite;\n}\n\n.tt-capsule[data-state=\"error\"] .tt-dot {\n  background: var(--tt-danger);\n}\n\n@keyframes tt-pulse {\n  0%, 100% { opacity: 1; transform: scale(1); }\n  50% { opacity: 0.45; transform: scale(0.8); }\n}\n\n.tt-popover {\n  position: fixed;\n  top: 42px;\n  right: 16px;\n  width: 344px;\n  max-width: calc(100vw - 24px);\n  background: var(--tt-bg-elevated);\n  border: 1px solid var(--tt-border);\n  border-radius: 12px;\n  box-shadow: var(--tt-shadow);\n  padding: 14px;\n  z-index: 2147483000;\n  display: none;\n  box-sizing: border-box;\n  font-size: 12px;\n  color: var(--tt-text);\n}\n\n.tt-popover[data-open=\"true\"] {\n  display: block;\n}\n\n.tt-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  margin-bottom: 12px;\n  padding-bottom: 8px;\n  border-bottom: 1px solid var(--tt-border);\n}\n\n.tt-title-wrap {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  font-size: 13px;\n  font-weight: 600;\n}\n\n.tt-version {\n  font-size: 10px;\n  padding: 1px 5px;\n  border-radius: 999px;\n  background: var(--tt-accent-soft);\n  color: var(--tt-accent-text);\n  font-weight: 600;\n}\n\n.tt-close {\n  border: none;\n  background: transparent;\n  color: var(--tt-text-muted);\n  cursor: pointer;\n  font-size: 15px;\n  line-height: 1;\n  padding: 2px 5px;\n  border-radius: 6px;\n}\n\n.tt-close:hover {\n  background: var(--tt-bg-sub);\n  color: var(--tt-text);\n}\n\n.tt-row {\n  margin-bottom: 10px;\n}\n\n.tt-row-inline {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n  margin-bottom: 10px;\n}\n\n.tt-label {\n  display: block;\n  font-size: 11px;\n  color: var(--tt-text-muted);\n  margin-bottom: 4px;\n  font-weight: 500;\n}\n\n.tt-label-inline {\n  font-size: 12px;\n  color: var(--tt-text);\n  font-weight: 500;\n}\n\n.tt-row-sub {\n  margin-top: -2px;\n  margin-bottom: 10px;\n}\n\n.tt-label-stack {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  min-width: 0;\n}\n\n.tt-row-sub .tt-label-inline {\n  font-size: 11.5px;\n  font-weight: 400;\n  color: var(--tt-text);\n}\n\n.tt-subhint {\n  font-size: 10.5px;\n  line-height: 1.25;\n  color: var(--tt-text-muted);\n}\n\n.tt-select,\n.tt-input {\n  width: 100%;\n  box-sizing: border-box;\n  padding: 6px 8px;\n  border-radius: 7px;\n  border: 1px solid var(--tt-border);\n  background: var(--tt-bg-sub);\n  color: var(--tt-text);\n  font-size: 12px;\n  outline: none;\n}\n\n.tt-select:focus,\n.tt-input:focus {\n  border-color: var(--tt-accent);\n}\n\n.tt-input-wrap {\n  margin-top: 6px;\n  display: none;\n}\n\n.tt-input-wrap[data-visible=\"true\"] {\n  display: block;\n}\n\n.tt-label-bar {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n  margin-bottom: 4px;\n}\n\n.tt-label-bar .tt-label {\n  margin-bottom: 0;\n}\n\n.tt-link-btn {\n  border: none;\n  background: transparent;\n  padding: 1px 4px;\n  border-radius: 5px;\n  font-size: 11px;\n  font-weight: 500;\n  color: var(--tt-accent-text);\n  cursor: pointer;\n}\n\n.tt-link-btn:hover {\n  background: var(--tt-accent-soft);\n}\n\n.tt-link-btn:disabled {\n  opacity: 0.55;\n  cursor: default;\n}\n\n.tt-model-cascade {\n  display: grid;\n  grid-template-columns: 1.35fr 1fr;\n  gap: 6px;\n  align-items: end;\n}\n\n.tt-cascade-col {\n  display: flex;\n  flex-direction: column;\n  gap: 3px;\n  min-width: 0;\n}\n\n.tt-sublabel {\n  font-size: 10.5px;\n  color: var(--tt-text-muted);\n  line-height: 1.2;\n}\n\n.tt-seg {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 4px;\n  padding: 3px;\n  border-radius: 8px;\n  background: var(--tt-bg-sub);\n  border: 1px solid var(--tt-border);\n}\n\n.tt-seg-btn {\n  border: none;\n  border-radius: 6px;\n  padding: 5px 8px;\n  font-size: 11.5px;\n  font-weight: 500;\n  cursor: pointer;\n  background: transparent;\n  color: var(--tt-text-muted);\n  transition: background-color 120ms ease, color 120ms ease;\n}\n\n.tt-seg-btn[data-active=\"true\"] {\n  background: var(--tt-accent);\n  color: #ffffff;\n}\n\n.tt-switch {\n  position: relative;\n  display: inline-flex;\n  align-items: center;\n  cursor: pointer;\n}\n\n.tt-switch input {\n  position: absolute;\n  opacity: 0;\n  width: 0;\n  height: 0;\n}\n\n.tt-slider {\n  width: 34px;\n  height: 18px;\n  border-radius: 999px;\n  background: var(--tt-border);\n  position: relative;\n  transition: background-color 140ms ease;\n}\n\n.tt-slider::after {\n  content: \"\";\n  position: absolute;\n  top: 2px;\n  left: 2px;\n  width: 14px;\n  height: 14px;\n  border-radius: 50%;\n  background: #ffffff;\n  transition: transform 140ms ease;\n}\n\n.tt-switch input:checked + .tt-slider {\n  background: var(--tt-accent);\n}\n\n.tt-switch input:checked + .tt-slider::after {\n  transform: translateX(16px);\n}\n\n.tt-actions {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 8px;\n  margin-top: 10px;\n}\n\n.tt-btn {\n  padding: 6px 10px;\n  border-radius: 7px;\n  border: 1px solid var(--tt-border);\n  background: var(--tt-bg-sub);\n  color: var(--tt-text);\n  font-size: 11.5px;\n  font-weight: 500;\n  cursor: pointer;\n}\n\n.tt-btn:hover {\n  border-color: var(--tt-accent);\n}\n\n.tt-btn-primary {\n  background: var(--tt-accent);\n  border-color: var(--tt-accent);\n  color: #ffffff;\n}\n\n.tt-btn-primary:hover {\n  filter: brightness(1.06);\n}\n\n.tt-footer {\n  margin-top: 10px;\n  padding-top: 8px;\n  border-top: 1px solid var(--tt-border);\n  font-size: 11px;\n  color: var(--tt-text-muted);\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  gap: 8px;\n}\n";
  const TT_TEMPLATE = "<button id=\"tt-capsule\" class=\"tt-capsule\" type=\"button\" aria-expanded=\"false\" data-state=\"active\" title=\"思考过程自动翻译设置\">\n  <span class=\"tt-dot\"></span>\n  <span id=\"tt-capsule-label\">译 · 简体中文</span>\n</button>\n\n<div id=\"tt-popover\" class=\"tt-popover\" data-open=\"false\" role=\"dialog\" aria-label=\"思考过程自动翻译设置\">\n  <div class=\"tt-header\">\n    <div class=\"tt-title-wrap\">\n      <span>思考过程翻译</span>\n      <span id=\"tt-version\" class=\"tt-version\">v0.3.0</span>\n    </div>\n    <button id=\"tt-close\" class=\"tt-close\" type=\"button\" title=\"关闭\">✕</button>\n  </div>\n\n  <div class=\"tt-row-inline\">\n    <span class=\"tt-label-inline\">自动翻译思考过程</span>\n    <label class=\"tt-switch\">\n      <input id=\"tt-enabled\" type=\"checkbox\" checked>\n      <span class=\"tt-slider\"></span>\n    </label>\n  </div>\n\n  <div class=\"tt-row-inline tt-row-sub\">\n    <div class=\"tt-label-stack\">\n      <span class=\"tt-label-inline\">预译未展开的折叠思考</span>\n      <span class=\"tt-subhint\">关闭可大幅省额度，标题仍优先自动翻译</span>\n    </div>\n    <label class=\"tt-switch\">\n      <input id=\"tt-pretranslate-collapsed\" type=\"checkbox\">\n      <span class=\"tt-slider\"></span>\n    </label>\n  </div>\n\n  <div class=\"tt-row\">\n    <label class=\"tt-label\" for=\"tt-target-lang\">目标语言</label>\n    <select id=\"tt-target-lang\" class=\"tt-select\"></select>\n    <div id=\"tt-custom-lang-wrap\" class=\"tt-input-wrap\" data-visible=\"false\">\n      <input id=\"tt-custom-lang\" class=\"tt-input\" type=\"text\" placeholder=\"输入自定义目标语言，如：粤语 / Arabic\">\n    </div>\n  </div>\n\n  <div class=\"tt-row\">\n    <span class=\"tt-label\">显示方式</span>\n    <div class=\"tt-seg\">\n      <button id=\"tt-mode-bilingual\" class=\"tt-seg-btn\" type=\"button\" data-mode=\"bilingual\" data-active=\"true\">显示原文和译文</button>\n      <button id=\"tt-mode-translation\" class=\"tt-seg-btn\" type=\"button\" data-mode=\"translation_only\" data-active=\"false\">只显示译文</button>\n    </div>\n  </div>\n\n  <div class=\"tt-row\">\n    <div class=\"tt-label-bar\">\n      <label class=\"tt-label\" for=\"tt-model-base\">翻译模型（复用 Antigravity 内置模型）</label>\n      <button id=\"tt-refresh-models\" class=\"tt-link-btn\" type=\"button\" title=\"从 agy models 刷新可用模型\">↻ 刷新</button>\n    </div>\n    <div class=\"tt-model-cascade\">\n      <div class=\"tt-cascade-col\">\n        <span class=\"tt-sublabel\">模型</span>\n        <select id=\"tt-model-base\" class=\"tt-select\" aria-label=\"翻译模型\"></select>\n      </div>\n      <div class=\"tt-cascade-col\">\n        <span class=\"tt-sublabel\">思考等级</span>\n        <select id=\"tt-model-level\" class=\"tt-select\" aria-label=\"思考等级\"></select>\n      </div>\n    </div>\n  </div>\n\n  <div class=\"tt-actions\">\n    <button id=\"tt-translate-now\" class=\"tt-btn tt-btn-primary\" type=\"button\">立即翻译当前思考</button>\n    <button id=\"tt-clear-cache\" class=\"tt-btn\" type=\"button\">清空翻译缓存</button>\n  </div>\n\n  <div class=\"tt-footer\">\n    <span id=\"tt-status-text\">就绪</span>\n    <span id=\"tt-cache-stats\">缓存: 0</span>\n  </div>\n</div>\n";

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
        transition: opacity 120ms ease;
      }
      [data-ag-tt-title-mode="bilingual"] > .ag-tt-header-title-trans,
      [data-ag-tt-title-mode="bilingual"] > .ag-tt-step-title-trans {
        color: #6366f1;
        opacity: 0.92;
      }
      [data-ag-tt-title-mode="bilingual"] > .ag-tt-header-title-trans::before,
      [data-ag-tt-title-mode="bilingual"] > .ag-tt-step-title-trans::before {
        content: "· ";
        opacity: 0.55;
      }
      html.dark [data-ag-tt-title-mode="bilingual"] > .ag-tt-header-title-trans,
      html.dark [data-ag-tt-title-mode="bilingual"] > .ag-tt-step-title-trans,
      body.dark [data-ag-tt-title-mode="bilingual"] > .ag-tt-header-title-trans,
      body.dark [data-ag-tt-title-mode="bilingual"] > .ag-tt-step-title-trans,
      [data-theme="dark"] [data-ag-tt-title-mode="bilingual"] > .ag-tt-header-title-trans,
      [data-theme="dark"] [data-ag-tt-title-mode="bilingual"] > .ag-tt-step-title-trans {
        color: #a5b4fc;
      }
      [data-ag-tt-title-mode="translation_only"] > .ag-tt-header-title-trans,
      [data-ag-tt-title-mode="translation_only"] > .ag-tt-step-title-trans {
        color: inherit;
        opacity: 0.88;
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
        opacity: 0.52;
        font-size: 0.92em;
      }
      [data-ag-tt-wrapper="1"][data-ag-tt-mode="translation_only"] [data-markdown-root] > [data-ag-tt-orig-ready="1"],
      [data-ag-tt-wrapper="1"][data-ag-tt-mode="translation_only"] .ag-tt-fallback-root > [data-ag-tt-orig-ready="1"] {
        display: none !important;
      }
      .ag-tt-trigger-bar {
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
      .ag-tt-trigger-badge {
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
        border: 1px solid rgba(99, 102, 241, 0.24);
        background: rgba(99, 102, 241, 0.11);
        color: #6366f1;
      }
      .ag-tt-mini-btn {
        background: rgba(128, 128, 128, 0.08);
        border-color: rgba(128, 128, 128, 0.24);
        color: inherit;
        opacity: 0.78;
      }
      .ag-tt-mini-btn:hover {
        opacity: 1;
        border-color: #6366f1;
      }
      html.dark .ag-tt-trigger-badge,
      body.dark .ag-tt-trigger-badge,
      [data-theme="dark"] .ag-tt-trigger-badge {
        color: #a5b4fc;
        background: rgba(129, 140, 248, 0.16);
        border-color: rgba(129, 140, 248, 0.3);
      }
      .ag-tt-trigger-badge[data-status="translating"] {
        color: #4f46e5;
        animation: agTtPulse 1.2s ease-in-out infinite;
      }
      html.dark .ag-tt-trigger-badge[data-status="translating"] {
        color: #c7d2fe;
      }
      .ag-tt-trigger-badge[data-status="error"] {
        color: #ef4444;
        background: rgba(239, 68, 68, 0.12);
        border-color: rgba(239, 68, 68, 0.28);
      }
      .ag-tt-trigger-badge[data-status="idle"] {
        opacity: 0.8;
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
        color: inherit;
      }
      [data-ag-tt-wrapper="1"][data-ag-tt-mode="bilingual"] .ag-tt-para-trans {
        border-left: 2px solid rgba(99, 102, 241, 0.48);
        background: rgba(99, 102, 241, 0.045);
        border-radius: 0 6px 6px 0;
        padding: 4px 10px;
        margin: -3px 0 4px 0;
      }
      html.dark [data-ag-tt-wrapper="1"][data-ag-tt-mode="bilingual"] .ag-tt-para-trans,
      body.dark [data-ag-tt-wrapper="1"][data-ag-tt-mode="bilingual"] .ag-tt-para-trans {
        background: rgba(129, 140, 248, 0.075);
        border-left-color: rgba(129, 140, 248, 0.55);
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
        background: #6366f1;
        animation: agTtCaretBlink 0.9s infinite;
      }
      .ag-tt-shimmer-wait {
        font-size: 12px;
        opacity: 0.68;
      }
      .ag-tt-para-error {
        font-size: 12px;
        color: #ef4444;
      }
    `;
    document.head.appendChild(styleEl);
  }

  // =========================================================================
  // Theme & Titlebar Docking
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

  function syncTheme() {
    host.setAttribute('data-theme', detectDarkTheme() ? 'dark' : 'light');
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

  function renderSettingsUI() {
    if (el('tt-version')) el('tt-version').textContent = `v${PLUGIN_VERSION}`;
    const enabledInput = el('tt-enabled');
    if (enabledInput) enabledInput.checked = Boolean(settings.enabled);
    const pretranslateInput = el('tt-pretranslate-collapsed');
    if (pretranslateInput) pretranslateInput.checked = Boolean(settings.pretranslateCollapsed);

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
        statusText.textContent = '已暂停自动翻译';
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

  function resetAllTranslationStates(clearMem = false) {
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
      if (entry.origEl?.isConnected) entry.origEl.removeAttribute('data-ag-tt-title-ready');
      if (entry.transEl?.isConnected) entry.transEl.remove();
      containerEl.removeAttribute('data-ag-tt-title-mode');
      containerEl.removeAttribute('data-ag-tt-title-interactive');
      containerEl.removeAttribute('data-ag-tt-header-wrap');
      titleStates.delete(containerEl);
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
      syncWrapperHeaderUI(wrapper, st);
    }
  }

  async function persistSettings(partial) {
    const prevEnabled = settings.enabled;
    const prevLang = getEffectiveTargetLang(settings);
    const prevModel = settings.model;
    settings = normalizeSettings({ ...settings, ...partial });
    if (prevEnabled && !settings.enabled) {
      clearQueuedTasks();
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
      resetAllTranslationStates(true);
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
      if (props && Array.isArray(props.steps)) {
        const list = [];
        for (const s of props.steps) {
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

  function getOrInitBlockState(wrapper) {
    let st = blockStates.get(wrapper);
    if (!st) {
      st = {
        seenOnInitialScan: false,
        wasStreaming: false,
        hasStartedTranslation: false,
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

  async function prewarmBackendCache(items, targetLang, model) {
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
        scheduleScan();
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

    const prog = precomputedProg || computeWrapperProgress(st);
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

    const visible = settings.enabled || prog.done > 0 || prog.translating > 0 || prog.errorCount > 0;
    bar.style.display = visible ? 'inline-flex' : 'none';
    if (visible) wrapper.setAttribute('data-ag-tt-has-badge', '1');
    else wrapper.removeAttribute('data-ag-tt-has-badge');
    if (visible && showTools) wrapper.setAttribute('data-ag-tt-has-tools', '1');
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
    const { containerEl, origEl, transEl, targetText, status, isRawCodeFallback, hasInteractiveChip, wrapperSt } = entry;
    if (!containerEl?.isConnected || !origEl?.isConnected || !transEl?.isConnected) return;

    const mode = wrapperSt ? getEffectiveWrapperMode(wrapperSt) : settings.displayMode;
    containerEl.setAttribute('data-ag-tt-title-mode', mode);
    if (hasInteractiveChip) containerEl.setAttribute('data-ag-tt-title-interactive', '1');
    else containerEl.removeAttribute('data-ag-tt-title-interactive');

    const liveText = readVisibleDomText(origEl, '').replace(/\s+/g, ' ').trim();
    const isStaleText = Boolean(entry.text && liveText && liveText !== entry.text);
    const allowDisplay = Boolean(settings.enabled || entry.manualRequested || entry.wrapperSt?.hasStartedTranslation);
    const canShow = allowDisplay && !isStaleText && status !== 'skipped' && !isRawCodeFallback;
    if (!canShow) {
      origEl.removeAttribute('data-ag-tt-title-ready');
      transEl.style.display = 'none';
      transEl.textContent = '';
      containerEl.removeAttribute('data-ag-tt-header-wrap');
      return;
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
      if (isStepSlot) containerEl.setAttribute('data-ag-tt-title-slot', '1');

      const info = extractCleanTitleInfo(origEl);
      let entry = titleStates.get(containerEl);

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
        entry.wrapperSt = wrapperSt;
      }

      if (insertBeforeEl && insertBeforeEl.parentElement === containerEl) {
        if (entry.transEl.parentElement !== containerEl || entry.transEl.nextElementSibling !== insertBeforeEl) {
          containerEl.insertBefore(entry.transEl, insertBeforeEl);
        }
      } else if (entry.transEl.parentElement !== containerEl) {
        containerEl.appendChild(entry.transEl);
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

      const allowTitleTranslate = Boolean(settings.enabled || forceAll || entry.manualRequested || entry.wrapperSt?.hasStartedTranslation);
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

      if (forceAll || (settings.enabled && entry.status === 'idle')) {
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
      const autoTrigger = settings.enabled && (!streamingNow || !isTrailingBlock || (now - p.lastGrowthAt >= LIVE_STREAM_PAUSE_MS && text.length >= 40));

      if (forceAll || (wantExpandTranslate && p.status === 'idle') || (autoTrigger && p.status === 'idle')) {
        startDomParaTranslation(wrapper, st, p, targetLang, model, forceAll, 'high');
      } else {
        renderParaTransEl(p);
      }
    }

    syncWrapperModeAndOrigVisibility(wrapper, st);
  }

  function syncCollapsedFiberBlocks(wrapper, st, fiberThinking, streamingNow, isRecentOrLive, targetLang, model, prewarmItems) {
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
      const allowCollapsedBg = Boolean(settings.pretranslateCollapsed || st.hasStartedTranslation);
      const canBgTranslate = settings.enabled && allowCollapsedBg && isRecentOrLive && (!streamingNow || !isTrailing || (now - fb.lastGrowthAt >= LIVE_STREAM_PAUSE_MS && text.length >= 40));
      if (canBgTranslate && fb.status === 'idle') {
        startFiberBlockTranslation(fb, targetLang, model, 'bg', () => {
          syncWrapperHeaderUI(wrapper, st);
        });
      }
      nextBlocks.push(fb);
    }

    st.fiberBlocks = nextBlocks;
    syncWrapperHeaderUI(wrapper, st);
  }

  function scanCollapsedToolGroups(targetLang, model, prewarmItems) {
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

  function scanThinkingBlocks() {
    if (disposed) return;
    ensureGlobalStyles();
    dockToTitlebar();

    const targetLang = getEffectiveTargetLang(settings);
    const model = settings.model || DEFAULT_MODEL;
    const prewarmItems = [];

    // Priority 0: Always translate visible group headers & step titles FIRST
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
      if (elTarget && elTarget.closest && elTarget.closest(`#${HOST_ID}, [data-ag-tt-para], [data-ag-tt-ui], #${GLOBAL_STYLE_ID}`)) {
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

    el('tt-translate-now')?.addEventListener('click', () => {
      const targetLang = getEffectiveTargetLang(settings);
      const model = settings.model || DEFAULT_MODEL;
      scanStepAndHeaderTitles(targetLang, model, [], true);
      for (const wrapper of Array.from(trackedWrappers)) {
        if (!wrapper.isConnected) continue;
        void translateWrapperNow(wrapper, false);
      }
    });

    el('tt-clear-cache')?.addEventListener('click', async () => {
      try {
        await callBridge('/clear-cache', {});
        cacheCount = 0;
        resetAllTranslationStates(true);
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
    window.removeEventListener('resize', positionPopover);

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

    for (const t of document.querySelectorAll('.ag-tt-header-title-trans, .ag-tt-step-title-trans')) t.remove();
    for (const p of document.querySelectorAll('[data-ag-tt-para]')) p.remove();
    trackedWrappers.clear();
    memCache.clear();
    checkedCanonMisses.clear();
    try { document.getElementById(GLOBAL_STYLE_ID)?.remove(); } catch {}
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
