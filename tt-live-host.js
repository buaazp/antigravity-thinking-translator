'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { getStateDir, getDevToolsPort } = require('./tt-asar');
const { PLUGIN_VERSION } = require('./tt-core');
const {
  getSettings,
  saveSettings,
  listAvailableModels,
  AgyTranslationService
} = require('./tt-backend');

const MAX_BODY_BYTES = 1024 * 1024;
const ALLOWED_ROUTES = ['/get-settings', '/save-settings', '/list-models', '/check-cache', '/clear-cache', '/status', '/translate'];

async function detectLiveOrigin() {
  const port = getDevToolsPort();
  if (!port) throw new Error('未检测到运行中的 Antigravity DevToolsActivePort');
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`DevTools 请求失败 (HTTP ${res.status})`);
  const pages = await res.json();
  const page = pages.find(p => p.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(p.url));
  if (!page) throw new Error('未找到运行中的 Antigravity 聊天窗口');
  return new URL(page.url).origin;
}

function writeCorsHeaders(res, allowedOrigin) {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Vary', 'Origin');
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function startLiveHost(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const allowedOrigin = options.origin || await detectLiveOrigin();
  const secret = options.token || crypto.randomBytes(32).toString('hex');
  const service = new AgyTranslationService({
    stateDir,
    agyPath: options.agyPath,
    sandbox: options.sandbox
  });

  const server = http.createServer(async (req, res) => {
    const reqOrigin = req.headers.origin;
    if (reqOrigin !== allowedOrigin) {
      res.writeHead(403);
      res.end();
      return;
    }
    writeCorsHeaders(res, allowedOrigin);

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-AG-TT-Token');
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST' || !ALLOWED_ROUTES.includes(req.url) || req.headers['x-ag-tt-token'] !== secret) {
      res.writeHead(403);
      res.end();
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch (err) {
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }

    try {
      if (req.url === '/get-settings') {
        const result = { ...getSettings({ stateDir }), cacheStats: service.cache.stats() };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.url === '/save-settings') {
        const result = { ...saveSettings(payload, { stateDir }), cacheStats: service.cache.stats() };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.url === '/list-models') {
        const result = await listAvailableModels({ stateDir, agyPath: options.agyPath, force: Boolean(payload.force) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.url === '/check-cache') {
        const result = service.checkCache(payload || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.url === '/clear-cache') {
        service.cache.clear();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cacheStats: service.cache.stats() }));
        return;
      }
      if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: PLUGIN_VERSION, cacheStats: service.cache.stats() }));
        return;
      }
      if (req.url === '/translate') {
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        const result = await service.translate({
          text: payload.text,
          targetLang: payload.targetLang,
          model: payload.model,
          force: payload.force === true,
          onProgress: prog => {
            try {
              if (!res.writableEnded) {
                res.write(JSON.stringify({ event: 'progress', ...prog }) + '\n');
              }
            } catch {}
          }
        });
        if (!res.writableEnded) {
          res.write(JSON.stringify({ event: 'result', result }) + '\n');
          res.end();
        }
        return;
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      } else if (!res.writableEnded) {
        res.write(JSON.stringify({ event: 'result', result: { ok: false, error: err?.message || String(err) } }) + '\n');
        res.end();
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address();
  const stampPath = path.join(stateDir, '.live-session.json');
  const sessionInfo = {
    pid: process.pid,
    port: addr.port,
    token: secret,
    origin: allowedOrigin,
    version: PLUGIN_VERSION,
    startedAt: new Date().toISOString()
  };

  if (options.writeSessionFile !== false) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stampPath, JSON.stringify(sessionInfo, null, 2), 'utf8');
  }

  return {
    port: addr.port,
    token: secret,
    origin: allowedOrigin,
    server,
    service,
    close() {
      service.dispose();
      try { server.close(); } catch {}
      if (options.writeSessionFile !== false) {
        try {
          if (fs.existsSync(stampPath)) {
            const cur = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
            if (cur.pid === process.pid) fs.unlinkSync(stampPath);
          }
        } catch {}
      }
    }
  };
}

if (require.main === module) {
  let instance = null;
  const shutdown = () => {
    try { instance?.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  startLiveHost()
    .then(inst => { instance = inst; })
    .catch(err => {
      console.error('[tt-live-host] Failed to start:', err?.message || err);
      process.exit(1);
    });
}

module.exports = {
  startLiveHost,
  detectLiveOrigin
};
