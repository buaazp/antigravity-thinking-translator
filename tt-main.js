'use strict';

const fs = require('fs');
const path = require('path');

let ipcMain = null;
let app = null;
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object') {
    ipcMain = electron.ipcMain;
    app = electron.app;
  }
} catch {}

const { PLUGIN_VERSION } = require('./tt-core');
const {
  getSettings,
  saveSettings,
  listAvailableModels,
  AgyTranslationService
} = require('./tt-backend');

const service = new AgyTranslationService();
let ipcRegistered = false;
const boundWindows = new WeakSet();
const boundWebContents = new WeakSet();
const probeTimers = new WeakMap();
const retryTimers = new WeakMap();

function isLocalMainFrameSender(event) {
  try {
    const rawUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1') return null;
    if (event.senderFrame && event.sender?.mainFrame && event.senderFrame !== event.sender.mainFrame) return null;
    return url;
  } catch {
    return null;
  }
}

function getWindowWebContents(win) {
  if (!win || win.isDestroyed?.()) return null;
  try {
    if (win.webContents && !win.webContents.isDestroyed?.()) return win.webContents;
  } catch {}
  try {
    const children = win.contentView?.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (child?.webContents && !child.webContents.isDestroyed?.()) {
          const url = child.webContents.getURL?.() || '';
          if (!url || /^https:\/\/127\.0\.0\.1:\d+\//.test(url)) {
            return child.webContents;
          }
        }
      }
      for (const child of children) {
        if (child?.webContents && !child.webContents.isDestroyed?.()) {
          const url = child.webContents.getURL?.() || '';
          if (!url.startsWith('data:')) {
            return child.webContents;
          }
        }
      }
    }
  } catch {}
  return null;
}

function buildRendererBundle() {
  const coreCode = fs.readFileSync(path.join(__dirname, 'tt-core.js'), 'utf8');
  const rendererCode = fs.readFileSync(path.join(__dirname, 'tt-renderer.js'), 'utf8');
  return `${coreCode}\n${rendererCode}\ntrue;`;
}

async function ensureTranslatorInjected(win, options = {}) {
  const wc = getWindowWebContents(win);
  if (!wc || wc.isDestroyed?.()) return false;

  const url = wc.getURL?.() || '';
  if (!/^https:\/\/127\.0\.0\.1:\d+\//.test(url)) return false;

  try {
    if (!options.force) {
      const alive = await wc.executeJavaScript(
        'Boolean(window.__AGThinkingTranslator && document.getElementById("ag-thinking-translator"))'
      );
      if (alive === true) return true;
    }
    const source = buildRendererBundle();
    await wc.executeJavaScript(source);
    return true;
  } catch (err) {
    const attempt = Number(options.attempt || 0);
    const delays = [400, 1200, 3000];
    if (attempt < delays.length && win && !win.isDestroyed?.()) {
      const prev = retryTimers.get(win);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => {
        retryTimers.delete(win);
        void ensureTranslatorInjected(win, { ...options, attempt: attempt + 1 });
      }, delays[attempt]);
      retryTimers.set(win, t);
    } else {
      console.warn('[Thinking Translator]', err?.message || String(err));
    }
    return false;
  }
}

function registerIpcOnce() {
  if (ipcRegistered || !ipcMain || typeof ipcMain.handle !== 'function') return;
  ipcRegistered = true;

  ipcMain.handle('thinking-translator:get-settings', event => {
    if (!isLocalMainFrameSender(event)) throw new Error('Unauthorized sender');
    return { ...getSettings(), cacheStats: service.cache.stats() };
  });

  ipcMain.handle('thinking-translator:save-settings', (event, payload) => {
    if (!isLocalMainFrameSender(event)) throw new Error('Unauthorized sender');
    return { ...saveSettings(payload || {}), cacheStats: service.cache.stats() };
  });

  ipcMain.handle('thinking-translator:list-models', async (event, opts) => {
    if (!isLocalMainFrameSender(event)) throw new Error('Unauthorized sender');
    return listAvailableModels(opts || {});
  });

  ipcMain.handle('thinking-translator:check-cache', (event, payload) => {
    if (!isLocalMainFrameSender(event)) throw new Error('Unauthorized sender');
    return service.checkCache(payload || {});
  });

  ipcMain.handle('thinking-translator:clear-cache', event => {
    if (!isLocalMainFrameSender(event)) throw new Error('Unauthorized sender');
    service.cache.clear();
    return { ok: true, cacheStats: service.cache.stats() };
  });

  ipcMain.handle('thinking-translator:status', event => {
    if (!isLocalMainFrameSender(event)) throw new Error('Unauthorized sender');
    return { ok: true, version: PLUGIN_VERSION, cacheStats: service.cache.stats() };
  });

  ipcMain.handle('thinking-translator:translate', async (event, payload) => {
    if (!isLocalMainFrameSender(event)) throw new Error('Unauthorized sender');
    const req = payload && typeof payload === 'object' ? payload : {};
    const requestId = req.requestId || null;
    return service.translate({
      text: req.text,
      targetLang: req.targetLang,
      model: req.model,
      force: req.force === true,
      onProgress: prog => {
        try {
          if (!event.sender.isDestroyed?.()) {
            event.sender.send('thinking-translator:progress', {
              requestId,
              ...prog
            });
          }
        } catch {}
      }
    });
  });

  ipcMain.handle('thinking-translator:translate-batch', async (event, payload) => {
    if (!isLocalMainFrameSender(event)) throw new Error('Unauthorized sender');
    const req = payload && typeof payload === 'object' ? payload : {};
    const requestId = req.requestId || null;
    return service.translateBatch({
      items: req.items,
      targetLang: req.targetLang,
      model: req.model,
      force: req.force === true,
      onItemProgress: prog => {
        try {
          if (!event.sender.isDestroyed?.()) {
            event.sender.send('thinking-translator:progress', {
              requestId,
              event: 'item_progress',
              ...prog
            });
          }
        } catch {}
      }
    });
  });
}

function installThinkingTranslator(win) {
  registerIpcOnce();
  if (!win || win.isDestroyed?.()) return;

  if (!boundWindows.has(win)) {
    boundWindows.add(win);
    const onActive = () => {
      void ensureTranslatorInjected(win, { force: false });
    };
    win.on?.('show', onActive);
    win.on?.('restore', onActive);
    win.on?.('focus', onActive);
  }

  const bindWc = wc => {
    if (!wc || boundWebContents.has(wc)) return;
    boundWebContents.add(wc);
    wc.on('did-finish-load', () => {
      void ensureTranslatorInjected(win, { force: true });
    });
    wc.on('dom-ready', () => {
      void ensureTranslatorInjected(win, { force: false });
    });
    wc.on('did-navigate', () => {
      void ensureTranslatorInjected(win, { force: false });
    });
    wc.on('did-navigate-in-page', () => {
      void ensureTranslatorInjected(win, { force: false });
    });
  };

  const wc = getWindowWebContents(win);
  if (wc) {
    bindWc(wc);
  } else {
    const prev = probeTimers.get(win);
    if (prev) clearInterval(prev);
    let retries = 0;
    const timer = setInterval(() => {
      retries++;
      const candidate = getWindowWebContents(win);
      if (candidate) {
        clearInterval(timer);
        probeTimers.delete(win);
        bindWc(candidate);
        void ensureTranslatorInjected(win, { force: false });
      } else if (retries >= 12 || !win || win.isDestroyed?.()) {
        clearInterval(timer);
        probeTimers.delete(win);
      }
    }, 150);
    probeTimers.set(win, timer);
  }
}

try {
  if (app && typeof app.on === 'function') {
    app.on('will-quit', () => {
      service.dispose();
    });
    const onCreated = (_ev, win) => {
      try {
        installThinkingTranslator(win);
        void ensureTranslatorInjected(win, { force: false });
      } catch {}
    };
    app.on('browser-window-created', onCreated);
    app.on('base-window-created', onCreated);
    app.on('activate', () => {
      try {
        const utils = require('./utils');
        const wins = typeof utils.getHubWindows === 'function' ? utils.getHubWindows() : [];
        for (const w of wins) {
          installThinkingTranslator(w);
          void ensureTranslatorInjected(w, { force: true });
        }
      } catch {}
    });
  }
} catch {}

module.exports = {
  installThinkingTranslator,
  ensureTranslatorInjected
};
