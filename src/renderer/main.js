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
    computeCacheKey,
    shouldTranslateText,
    renderSafeMarkdownHtml
  } = core;

  const GLOBAL_STYLE_ID = 'ag-tt-global-styles';
  const HOST_ID = 'ag-thinking-translator';
  const LIVE_STREAM_PAUSE_MS = 1800;

  let settings = normalizeSettings(DEFAULT_SETTINGS);
  let models = FALLBACK_MODELS.slice();
  let cacheCount = 0;
  let disposed = false;
  let popoverOpen = false;
  let activeTranslations = 0;
  let lastErrorMsg = '';
  let scanTimer = 0;
  let pollTimer = 0;
  let themeObserver = null;
  let domObserver = null;
  let titlebarResizeObserver = null;
  let observedTitlebar = null;
  let docClickHandler = null;
  let reqSeq = 0;

  // WeakMap<wrapperDiv, BlockState>
  const blockStates = new WeakMap();
  const trackedWrappers = new Set();
  const activeTranslateKeys = new Map(); // cacheKey -> Set<wrapper>

  /* @INSERT_STYLES_AND_TEMPLATE */

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-dock', 'fixed');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${TT_STYLES}</style>${TT_TEMPLATE}`;

  const el = id => shadow.getElementById(id);

  // =========================================================================
  // Transport Bridge: Electron preload IPC or Live CDP HTTP NDJSON Bridge
  // =========================================================================
  function getIpcApi() {
    return typeof window !== 'undefined' && window.thinkingTranslatorAPI ? window.thinkingTranslatorAPI : null;
  }

  function getLiveInfo() {
    return typeof window !== 'undefined' && window.__AGThinkingTranslatorLive ? window.__AGThinkingTranslatorLive : null;
  }

  async function callBridge(route, payload = {}) {
    const ipc = getIpcApi();
    if (ipc) {
      if (route === '/get-settings') return ipc.getSettings();
      if (route === '/save-settings') return ipc.saveSettings(payload);
      if (route === '/list-models') return ipc.listModels(payload);
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

    const live = getLiveInfo();
    if (!live || !live.port || !live.token) {
      throw new Error('翻译后端桥接未连接');
    }
    const res = await fetch(`http://127.0.0.1:${live.port}/translate`, {
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

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let obj;
        try { obj = JSON.parse(t); } catch { continue; }
        if (obj.event === 'progress' && typeof onProgress === 'function') {
          onProgress(obj);
        } else if (obj.event === 'result') {
          finalRes = obj.result;
        }
      }
    }
    if (buf.trim()) {
      try {
        const obj = JSON.parse(buf.trim());
        if (obj.event === 'result') finalRes = obj.result;
      } catch {}
    }
    return finalRes || { ok: false, error: '未收到翻译结果' };
  }

  // =========================================================================
  // Global Page CSS (React-Safe Sibling Styling)
  // =========================================================================
  function ensureGlobalStyles() {
    if (!document.head) return;
    let styleEl = document.getElementById(GLOBAL_STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = GLOBAL_STYLE_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `
      [role="group"][data-ag-tt-hide-orig="1"] > div:first-child:not([data-ag-tt-card]) {
        display: none !important;
      }
      html[data-ag-tt-expand="1"] [role="group"][data-ag-tt-has-card="1"] {
        max-height: 440px !important;
      }
      .ag-tt-trigger-badge {
        position: absolute;
        top: 6px;
        right: 28px;
        z-index: 2;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 7px;
        border-radius: 999px;
        font-size: 11px;
        line-height: 1.3;
        font-weight: 500;
        background: rgba(99, 102, 241, 0.12);
        color: #6366f1;
        border: 1px solid rgba(99, 102, 241, 0.25);
        cursor: pointer;
        user-select: none;
        backdrop-filter: blur(4px);
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
        opacity: 0.78;
      }
      @keyframes agTtPulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.55; }
      }
      .ag-tt-card {
        margin: 8px 0 4px 8px;
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid rgba(99, 102, 241, 0.22);
        background: rgba(99, 102, 241, 0.05);
        font-size: 13px;
        line-height: 1.6;
        color: inherit;
      }
      html.dark .ag-tt-card,
      body.dark .ag-tt-card {
        background: rgba(129, 140, 248, 0.08);
        border-color: rgba(129, 140, 248, 0.24);
      }
      .ag-tt-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
        font-size: 11px;
        opacity: 0.85;
      }
      .ag-tt-card-meta {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-weight: 600;
        color: #6366f1;
      }
      html.dark .ag-tt-card-meta,
      body.dark .ag-tt-card-meta {
        color: #a5b4fc;
      }
      .ag-tt-card-actions {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .ag-tt-card-btn {
        border: 1px solid rgba(128, 128, 128, 0.28);
        background: transparent;
        color: inherit;
        border-radius: 5px;
        padding: 1px 6px;
        font-size: 10.5px;
        cursor: pointer;
        opacity: 0.85;
      }
      .ag-tt-card-btn:hover {
        opacity: 1;
        border-color: #6366f1;
      }
      .ag-tt-card-body p {
        margin: 0 0 6px 0;
      }
      .ag-tt-card-body p:last-child {
        margin-bottom: 0;
      }
      .ag-tt-card-body .ag-tt-heading {
        margin: 6px 0 4px 0;
        font-weight: 600;
        font-size: 13px;
      }
      .ag-tt-card-body .ag-tt-list {
        margin: 4px 0 6px 0;
        padding-left: 18px;
      }
      .ag-tt-card-body .ag-tt-list li {
        margin-bottom: 2px;
      }
      .ag-tt-card-body .ag-tt-inline-code {
        padding: 1px 4px;
        border-radius: 4px;
        background: rgba(128, 128, 128, 0.16);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 0.9em;
      }
      .ag-tt-card-body .ag-tt-code-block {
        margin: 6px 0;
        padding: 8px 10px;
        border-radius: 6px;
        background: rgba(0, 0, 0, 0.12);
        overflow-x: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        line-height: 1.45;
      }
    `;
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
  // UI Rendering & Settings Sync
  // =========================================================================
  function getModelLabel(modelId) {
    const found = models.find(m => m.id === modelId);
    return found ? found.label : modelId;
  }

  function renderSettingsUI() {
    if (el('tt-version')) el('tt-version').textContent = `v${PLUGIN_VERSION}`;
    const enabledInput = el('tt-enabled');
    if (enabledInput) enabledInput.checked = Boolean(settings.enabled);

    const autoExpandInput = el('tt-auto-expand');
    if (autoExpandInput) autoExpandInput.checked = Boolean(settings.autoExpandHeight);
    if (settings.autoExpandHeight) {
      document.documentElement.setAttribute('data-ag-tt-expand', '1');
    } else {
      document.documentElement.removeAttribute('data-ag-tt-expand');
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

    const modelSelect = el('tt-model');
    if (modelSelect) {
      const list = models.slice();
      if (settings.model && !list.some(m => m.id === settings.model)) {
        list.unshift({ id: settings.model, label: settings.model });
      }
      modelSelect.innerHTML = '';
      for (const m of list) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label;
        modelSelect.appendChild(opt);
      }
      modelSelect.value = settings.model || DEFAULT_MODEL;
    }

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

  async function persistSettings(partial) {
    const prevLang = getEffectiveTargetLang(settings);
    const prevModel = settings.model;
    settings = normalizeSettings({ ...settings, ...partial });
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

    // Immediately re-render all tracked blocks for displayMode changes or re-translate if lang/model changed
    for (const wrapper of Array.from(trackedWrappers)) {
      if (!wrapper.isConnected) {
        trackedWrappers.delete(wrapper);
        continue;
      }
      const st = blockStates.get(wrapper);
      if (!st) continue;
      if (configChanged) {
        st.status = 'idle';
        st.translation = '';
        st.cacheKey = '';
        st.error = '';
      }
      syncBlockDOM(wrapper, st);
      if (settings.enabled && configChanged && st.lastOrigText && shouldTranslateText(st.lastOrigText, nextLang)) {
        const group = getGroupContainer(wrapper);
        if (group || st.wasStreaming) {
          void translateBlock(wrapper, false);
        }
      }
    }
    renderSettingsUI();
  }

  // =========================================================================
  // Thinking Block Discovery, Observation & React-Safe Rendering
  // =========================================================================
  function getGroupContainer(wrapper) {
    if (!wrapper) return null;
    for (const child of wrapper.children) {
      if (child.getAttribute && child.getAttribute('role') === 'group') {
        return child;
      }
    }
    return null;
  }

  function getOrigContentDiv(group) {
    if (!group) return null;
    for (const child of group.children) {
      if (child.tagName === 'DIV' && !child.hasAttribute('data-ag-tt-card')) {
        return child;
      }
    }
    return null;
  }

  function isTriggerStreaming(trigger) {
    if (!trigger) return false;
    return Boolean(trigger.querySelector('.animate-shimmer-text')) || /^Thinking\b/i.test((trigger.textContent || '').trim());
  }

  function getOrInitBlockState(wrapper) {
    let st = blockStates.get(wrapper);
    if (!st) {
      st = {
        lastOrigText: '',
        lastGrowthAt: 0,
        wasStreaming: false,
        status: 'idle',
        translation: '',
        partialText: '',
        cacheKey: '',
        error: '',
        localViewMode: null
      };
      blockStates.set(wrapper, st);
    }
    trackedWrappers.add(wrapper);
    return st;
  }

  function ensureTriggerBadge(wrapper, st) {
    let badge = null;
    for (const child of wrapper.children) {
      if (child.classList && child.classList.contains('ag-tt-trigger-badge')) {
        badge = child;
        break;
      }
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'ag-tt-trigger-badge';
      badge.setAttribute('role', 'button');
      badge.tabIndex = -1;
      badge.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const trigger = wrapper.querySelector('[data-testid="thinking-collapsible-trigger"]');
        const group = getGroupContainer(wrapper);
        if (!group && trigger) {
          // Expand first so we can read text, then translate
          st.autoTranslateOnExpand = true;
          trigger.click();
          return;
        }
        void translateBlock(wrapper, st.status === 'done');
      });
      wrapper.appendChild(badge);
    }

    badge.setAttribute('data-status', st.status);
    if (st.status === 'translating') {
      badge.textContent = '译中...';
      badge.title = '正在翻译思考过程';
    } else if (st.status === 'done') {
      badge.textContent = `已译 · ${getEffectiveTargetLang(settings)}`;
      badge.title = '点击重新翻译';
    } else if (st.status === 'error') {
      badge.textContent = '译失败';
      badge.title = st.error || '点击重试';
    } else if (st.status === 'skipped') {
      badge.style.display = 'none';
      return;
    } else {
      badge.textContent = '译';
      badge.title = '点击翻译该段思考';
    }
    badge.style.display = settings.enabled || st.status === 'done' || st.status === 'translating' ? 'inline-flex' : 'none';
  }

  function ensureTranslationCard(wrapper, group, st) {
    if (!group) return;
    let card = null;
    for (const child of group.children) {
      if (child.hasAttribute && child.hasAttribute('data-ag-tt-card')) {
        card = child;
        break;
      }
    }

    const shouldShowCard = st.status === 'translating' || st.status === 'done' || st.status === 'error';
    if (!shouldShowCard) {
      if (card) card.remove();
      group.removeAttribute('data-ag-tt-has-card');
      group.removeAttribute('data-ag-tt-hide-orig');
      return;
    }

    if (!card) {
      card = document.createElement('div');
      card.setAttribute('data-ag-tt-card', '1');
      card.className = 'ag-tt-card';
      card.innerHTML = `
        <div class="ag-tt-card-header">
          <span class="ag-tt-card-meta"></span>
          <span class="ag-tt-card-actions">
            <button type="button" class="ag-tt-card-btn" data-act="toggle-orig"></button>
            <button type="button" class="ag-tt-card-btn" data-act="retranslate">重译</button>
            <button type="button" class="ag-tt-card-btn" data-act="copy">复制</button>
          </span>
        </div>
        <div class="ag-tt-card-body"></div>
      `;

      card.querySelector('[data-act="toggle-orig"]').addEventListener('click', ev => {
        ev.stopPropagation();
        const curEffective = st.localViewMode || settings.displayMode;
        st.localViewMode = curEffective === 'translation_only' ? 'bilingual' : 'translation_only';
        syncBlockDOM(wrapper, st);
      });
      card.querySelector('[data-act="retranslate"]').addEventListener('click', ev => {
        ev.stopPropagation();
        void translateBlock(wrapper, true);
      });
      card.querySelector('[data-act="copy"]').addEventListener('click', async ev => {
        ev.stopPropagation();
        const btn = ev.currentTarget;
        const txt = st.translation || st.partialText || '';
        if (!txt) return;
        try {
          await navigator.clipboard.writeText(txt);
          btn.textContent = '已复制';
          setTimeout(() => { if (btn.isConnected) btn.textContent = '复制'; }, 1200);
        } catch {}
      });
      group.appendChild(card);
    }

    const effMode = st.localViewMode || settings.displayMode;
    const displayText = st.status === 'done' ? st.translation : (st.partialText || '');
    const canHideOrig = effMode === 'translation_only' && Boolean(displayText.trim());

    group.setAttribute('data-ag-tt-has-card', '1');
    if (canHideOrig) {
      group.setAttribute('data-ag-tt-hide-orig', '1');
    } else {
      group.removeAttribute('data-ag-tt-hide-orig');
    }

    const metaEl = card.querySelector('.ag-tt-card-meta');
    const toggleBtn = card.querySelector('[data-act="toggle-orig"]');
    const bodyEl = card.querySelector('.ag-tt-card-body');
    const effLang = getEffectiveTargetLang(settings);
    const modelLabel = getModelLabel(settings.model);

    if (metaEl) {
      if (st.status === 'translating') {
        metaEl.textContent = `正在翻译 (${effLang}) · ${modelLabel}...`;
      } else if (st.status === 'error') {
        metaEl.textContent = `翻译失败 (${modelLabel})`;
      } else {
        metaEl.textContent = `译文 (${effLang}) · ${modelLabel}`;
      }
    }

    if (toggleBtn) {
      toggleBtn.textContent = canHideOrig ? '显示原文' : '只看译文';
    }

    if (bodyEl) {
      if (st.status === 'error') {
        bodyEl.innerHTML = `<p style="color:#ef4444">${core.escapeHtml(st.error || '未知错误')}</p>`;
      } else if (displayText) {
        const html = renderSafeMarkdownHtml(displayText);
        if (bodyEl.getAttribute('data-last-src') !== displayText) {
          bodyEl.setAttribute('data-last-src', displayText);
          bodyEl.innerHTML = html;
        }
      } else {
        bodyEl.innerHTML = `<p style="opacity:0.7">正在调用 ${core.escapeHtml(modelLabel)} 翻译...</p>`;
      }
    }
  }

  function syncBlockDOM(wrapper, st) {
    if (!wrapper || !wrapper.isConnected) return;
    ensureTriggerBadge(wrapper, st);
    const group = getGroupContainer(wrapper);
    if (group) {
      ensureTranslationCard(wrapper, group, st);
    }
  }

  async function translateBlock(wrapper, force = false) {
    if (disposed || !wrapper || !wrapper.isConnected) return;
    const st = getOrInitBlockState(wrapper);
    const group = getGroupContainer(wrapper);
    const origDiv = getOrigContentDiv(group);
    if (origDiv) {
      const liveText = normalizeThinkingText(origDiv.innerText || origDiv.textContent || '');
      if (liveText) st.lastOrigText = liveText;
    }

    const sourceText = normalizeThinkingText(st.lastOrigText);
    const targetLang = getEffectiveTargetLang(settings);
    const model = settings.model || DEFAULT_MODEL;

    if (!sourceText) return;
    if (!force && !shouldTranslateText(sourceText, targetLang)) {
      st.status = 'skipped';
      syncBlockDOM(wrapper, st);
      return;
    }

    const key = computeCacheKey(sourceText, targetLang, model);
    if (!force && st.status === 'done' && st.cacheKey === key && st.translation) {
      syncBlockDOM(wrapper, st);
      return;
    }

    let waiters = activeTranslateKeys.get(key);
    if (waiters) {
      waiters.add(wrapper);
      st.status = 'translating';
      st.cacheKey = key;
      syncBlockDOM(wrapper, st);
      return;
    }

    waiters = new Set([wrapper]);
    activeTranslateKeys.set(key, waiters);

    st.status = 'translating';
    st.error = '';
    st.partialText = '';
    st.cacheKey = key;
    activeTranslations++;
    lastErrorMsg = '';
    syncBlockDOM(wrapper, st);
    renderSettingsUI();

    try {
      const res = await callTranslate({ text: sourceText, targetLang, model, force }, prog => {
        if (disposed || !prog || typeof prog.text !== 'string') return;
        for (const w of waiters) {
          if (!w.isConnected) continue;
          const wst = blockStates.get(w);
          if (!wst || wst.cacheKey !== key) continue;
          wst.partialText = prog.text;
          syncBlockDOM(w, wst);
        }
      });

      if (disposed) return;

      if (res && res.ok && typeof res.translation === 'string') {
        if (!res.cached) cacheCount++;
        for (const w of waiters) {
          if (!w.isConnected) continue;
          const wst = blockStates.get(w);
          if (!wst || wst.cacheKey !== key) continue;
          wst.status = 'done';
          wst.translation = res.translation;
          wst.partialText = '';
          wst.error = '';
          syncBlockDOM(w, wst);
        }
      } else {
        const errMsg = res?.error || '翻译失败';
        lastErrorMsg = errMsg;
        for (const w of waiters) {
          if (!w.isConnected) continue;
          const wst = blockStates.get(w);
          if (!wst || wst.cacheKey !== key) continue;
          wst.status = 'error';
          wst.error = errMsg;
          syncBlockDOM(w, wst);
        }
      }
    } catch (err) {
      const errMsg = err?.message || String(err);
      lastErrorMsg = errMsg;
      for (const w of waiters) {
        if (!w.isConnected) continue;
        const wst = blockStates.get(w);
        if (!wst || wst.cacheKey !== key) continue;
        wst.status = 'error';
        wst.error = errMsg;
        syncBlockDOM(w, wst);
      }
    } finally {
      activeTranslateKeys.delete(key);
      activeTranslations = Math.max(0, activeTranslations - 1);
      renderSettingsUI();
    }
  }

  function scanThinkingBlocks() {
    if (disposed) return;
    ensureGlobalStyles();
    dockToTitlebar();

    const triggers = document.querySelectorAll('[data-testid="thinking-collapsible-trigger"]');
    const now = Date.now();
    const targetLang = getEffectiveTargetLang(settings);
    const model = settings.model || DEFAULT_MODEL;

    for (const trigger of triggers) {
      const wrapper = trigger.parentElement;
      if (!wrapper) continue;
      const st = getOrInitBlockState(wrapper);
      const streamingNow = isTriggerStreaming(trigger);
      const group = getGroupContainer(wrapper);
      const origDiv = getOrigContentDiv(group);

      if (origDiv) {
        const text = normalizeThinkingText(origDiv.innerText || origDiv.textContent || '');
        if (text && text !== st.lastOrigText) {
          st.lastOrigText = text;
          st.lastGrowthAt = now;
        }
      }

      if (streamingNow) {
        st.wasStreaming = true;
      }

      const justFinishedStreaming = st.wasStreaming && !streamingNow;
      if (justFinishedStreaming) {
        st.wasStreaming = false;
      }

      const key = st.lastOrigText ? computeCacheKey(st.lastOrigText, targetLang, model) : '';
      const needsTranslation = Boolean(
        settings.enabled &&
        st.lastOrigText &&
        st.cacheKey !== key &&
        st.status !== 'translating' &&
        shouldTranslateText(st.lastOrigText, targetLang)
      );

      if (needsTranslation) {
        const pausedLongEnough = streamingNow && st.lastGrowthAt > 0 && (now - st.lastGrowthAt >= LIVE_STREAM_PAUSE_MS);
        const expandedAndReady = Boolean(group) && !streamingNow;
        if (justFinishedStreaming || expandedAndReady || pausedLongEnough || st.autoTranslateOnExpand) {
          st.autoTranslateOnExpand = false;
          void translateBlock(wrapper, false);
          continue;
        }
      } else if (st.autoTranslateOnExpand && group) {
        st.autoTranslateOnExpand = false;
        void translateBlock(wrapper, false);
        continue;
      }

      syncBlockDOM(wrapper, st);
    }
  }

  function scheduleScan() {
    if (disposed || scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scanThinkingBlocks();
    }, 150);
  }

  function isPluginMutation(mutations) {
    for (const m of mutations) {
      const target = m.target;
      if (!target) continue;
      const elTarget = target.nodeType === 1 ? target : target.parentElement;
      if (!elTarget || !elTarget.closest) continue;
      if (elTarget.closest(`#${HOST_ID}, [data-ag-tt-card], .ag-tt-trigger-badge, #${GLOBAL_STYLE_ID}`)) {
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

    el('tt-auto-expand')?.addEventListener('change', ev => {
      void persistSettings({ autoExpandHeight: ev.target.checked });
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

    el('tt-model')?.addEventListener('change', ev => {
      void persistSettings({ model: ev.target.value });
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
        btn.textContent = '刷新';
        btn.disabled = false;
      }
    });

    el('tt-translate-now')?.addEventListener('click', () => {
      for (const wrapper of Array.from(trackedWrappers)) {
        if (!wrapper.isConnected) continue;
        if (getGroupContainer(wrapper)) {
          void translateBlock(wrapper, false);
        }
      }
    });

    el('tt-clear-cache')?.addEventListener('click', async () => {
      try {
        await callBridge('/clear-cache', {});
        cacheCount = 0;
        for (const wrapper of Array.from(trackedWrappers)) {
          const st = blockStates.get(wrapper);
          if (st) {
            st.status = 'idle';
            st.translation = '';
            st.cacheKey = '';
            syncBlockDOM(wrapper, st);
          }
        }
        renderSettingsUI();
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
        if (!isPluginMutation(mutations)) scheduleScan();
      });
      domObserver.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-expanded', 'class']
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
    if (pollTimer) clearInterval(pollTimer);
    try { themeObserver?.disconnect(); } catch {}
    try { domObserver?.disconnect(); } catch {}
    try { titlebarResizeObserver?.disconnect(); } catch {}
    if (docClickHandler) document.removeEventListener('click', docClickHandler);
    window.removeEventListener('resize', positionPopover);
    for (const wrapper of Array.from(trackedWrappers)) {
      if (!wrapper.isConnected) continue;
      for (const b of wrapper.querySelectorAll(':scope > .ag-tt-trigger-badge')) b.remove();
      const group = getGroupContainer(wrapper);
      if (group) {
        group.removeAttribute('data-ag-tt-has-card');
        group.removeAttribute('data-ag-tt-hide-orig');
        for (const c of group.querySelectorAll(':scope > [data-ag-tt-card]')) c.remove();
      }
    }
    trackedWrappers.clear();
    document.documentElement.removeAttribute('data-ag-tt-expand');
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
      targetLang: getEffectiveTargetLang(settings),
      displayMode: settings.displayMode,
      model: settings.model,
      hasIpcBridge: Boolean(getIpcApi()),
      hasLiveBridge: Boolean(getLiveInfo()),
      trackedBlocks: trackedWrappers.size,
      activeTranslations,
      lastError: lastErrorMsg || null
    }),
    translateAllVisible: () => {
      for (const w of Array.from(trackedWrappers)) {
        if (w.isConnected && getGroupContainer(w)) void translateBlock(w, false);
      }
    }
  };

  void bootstrap();
})();
