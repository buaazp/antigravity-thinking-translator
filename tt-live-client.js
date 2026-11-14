'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getStateDir, getDevToolsPort } = require('./tt-asar');
const { PLUGIN_VERSION } = require('./tt-core');

function isTestMode() {
  return process.env.AG_TT_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
}

async function listLivePages() {
  if (isTestMode()) return { running: false, pages: [] };
  const port = getDevToolsPort();
  if (!port) return { running: false, port: null, pages: [] };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { running: false, port, pages: [], error: `HTTP ${res.status}` };
    const pages = await res.json();
    const targets = pages.filter(p => p.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(p.url));
    return { running: true, port, pages: targets };
  } catch (err) {
    return { running: false, port, pages: [], error: err?.message || String(err) };
  }
}

async function evalInPage(wsUrl, expression, timeoutMs = 5000) {
  const ws = new WebSocket(wsUrl);
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', err => { clearTimeout(t); reject(err instanceof Error ? err : new Error('CDP ws error')); }, { once: true });
    });

    const id = 1;
    const result = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP eval timeout')), timeoutMs);
      const handler = ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id === id) {
          clearTimeout(t);
          ws.removeEventListener('message', handler);
          if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
          else if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.text || 'CDP eval exception'));
          else resolve(msg.result?.result?.value);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      }));
    });
    return result;
  } finally {
    try { ws.close(); } catch {}
  }
}

async function queryLiveWindow() {
  const info = await listLivePages();
  if (!info.running) return { running: false, cdpPort: info.port || null, error: info.error };
  const page = info.pages[0];
  if (!page) return { running: true, cdpPort: info.port, pageFound: false };

  const origin = new URL(page.url).origin;
  try {
    const raw = await evalInPage(page.webSocketDebuggerUrl, `JSON.stringify({
      hasIpcBridge: Boolean(window.thinkingTranslatorAPI),
      hasLiveBridge: Boolean(window.__AGThinkingTranslatorLive),
      status: globalThis.__AGThinkingTranslator?.getStatus?.() || null
    })`);
    const parsed = JSON.parse(raw || '{}');
    const st = parsed.status || {};
    return {
      running: true,
      cdpPort: info.port,
      pageFound: true,
      origin,
      active: Boolean(st.active),
      version: st.version || null,
      hasIpcBridge: Boolean(parsed.hasIpcBridge),
      hasLiveBridge: Boolean(parsed.hasLiveBridge),
      enabled: st.enabled ?? null,
      colorTheme: st.colorTheme || null,
      targetLang: st.targetLang || null,
      displayMode: st.displayMode || null,
      model: st.model || null,
      trackedBlocks: st.trackedBlocks ?? 0,
      lastError: st.lastError || null
    };
  } catch (err) {
    return { running: true, cdpPort: info.port, pageFound: true, origin, active: false, error: err?.message || String(err) };
  }
}

function readLiveSessionInfo(stateDir) {
  const sessionPath = path.join(stateDir || getStateDir(), '.live-session.json');
  if (!fs.existsSync(sessionPath)) return { sessionPath, info: null };
  try {
    const info = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    return { sessionPath, info };
  } catch {
    return { sessionPath, info: null };
  }
}

async function ensureLiveBridge(expectedOrigin, options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const { sessionPath, info } = readLiveSessionInfo(stateDir);
  if (
    !options.restart &&
    info &&
    info.pid &&
    info.port &&
    info.token &&
    info.version === PLUGIN_VERSION &&
    (!expectedOrigin || info.origin === expectedOrigin)
  ) {
    try {
      process.kill(info.pid, 0);
      return info;
    } catch {}
  }

  if (info && info.pid) {
    try { process.kill(info.pid, 'SIGTERM'); } catch {}
  }
  try { if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath); } catch {}

  const child = spawn(process.execPath, [path.join(__dirname, 'tt-live-host.js')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, AG_TT_STATE_DIR: stateDir }
  });
  child.unref();

  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 120));
    const snap = readLiveSessionInfo(stateDir);
    if (snap.info && snap.info.port && snap.info.token && (!expectedOrigin || snap.info.origin === expectedOrigin)) {
      return snap.info;
    }
  }
  throw new Error('启动 tt-live-host.js 桥接服务超时');
}

function stopLiveBridge(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const { sessionPath, info } = readLiveSessionInfo(stateDir);
  if (info && info.pid) {
    try { process.kill(info.pid, 'SIGTERM'); } catch {}
  }
  try { if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath); } catch {}
}

async function injectIntoLiveWindows(options = {}) {
  if (isTestMode()) return { injected: false, reason: 'test_mode' };
  const info = await listLivePages();
  if (!info.running || !info.pages.length) {
    return { injected: false, reason: 'no_live_window' };
  }

  const coreCode = fs.readFileSync(path.join(__dirname, 'tt-core.js'), 'utf8');
  const rendererCode = fs.readFileSync(path.join(__dirname, 'tt-renderer.js'), 'utf8');
  const bundle = `${coreCode}\n${rendererCode}\ntrue;`;

  let injectedCount = 0;
  for (const page of info.pages) {
    const origin = new URL(page.url).origin;
    const ipcVersion = await evalInPage(
      page.webSocketDebuggerUrl,
      'window.thinkingTranslatorAPI ? (window.thinkingTranslatorAPI.version || "legacy") : null'
    ).catch(() => null);
    if (!ipcVersion || ipcVersion !== PLUGIN_VERSION) {
      const liveSession = await ensureLiveBridge(origin, options);
      await evalInPage(
        page.webSocketDebuggerUrl,
        `window.__AGThinkingTranslatorLive = ${JSON.stringify({ port: liveSession.port, token: liveSession.token, version: PLUGIN_VERSION })};`
      );
    }
    await evalInPage(page.webSocketDebuggerUrl, bundle);
    injectedCount++;
  }
  return { injected: injectedCount > 0, count: injectedCount };
}

async function disposeFromLiveWindows() {
  if (isTestMode()) return { disposed: 0 };
  const info = await listLivePages();
  if (!info.running || !info.pages.length) return { disposed: 0 };
  let count = 0;
  for (const page of info.pages) {
    try {
      await evalInPage(page.webSocketDebuggerUrl, 'try { globalThis.__AGThinkingTranslator?.dispose?.(); } catch {} true;');
      count++;
    } catch {}
  }
  return { disposed: count };
}

module.exports = {
  queryLiveWindow,
  ensureLiveBridge,
  stopLiveBridge,
  injectIntoLiveWindows,
  disposeFromLiveWindows
};
