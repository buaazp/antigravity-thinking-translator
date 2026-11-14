'use strict';

let fs;
try {
  fs = require('original-fs');
} catch {
  fs = require('fs');
}
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { getStateDir } = require('./tt-asar');
const {
  DEFAULT_MODEL,
  DEFAULT_SETTINGS,
  FALLBACK_MODELS,
  normalizeSettings,
  getEffectiveTargetLang,
  normalizeThinkingText,
  computeCacheKey,
  buildTranslationPrompt,
  cleanModelTranslationOutput,
  parseAgyModelsOutput
} = require('./tt-core');

const MAX_CACHE_ENTRIES = 500;
const WORKER_MAX_TURNS = 10;
const WORKER_IDLE_MS = 8 * 60 * 1000;
const TURN_TIMEOUT_MS = 90 * 1000;
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
const LONG_TEXT_THRESHOLD = 5500;
const CHUNK_MAX_CHARS = 4200;

function buildAugmentedPath() {
  const home = process.env.USERPROFILE || os.homedir();
  const extras = process.platform === 'win32'
    ? [
        path.join(home, '.gemini', 'antigravity', 'bin'),
        path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Antigravity', 'bin'),
        path.join(home, '.local', 'bin')
      ]
    : [
        path.join(home, '.local', 'bin'),
        path.join(home, '.gemini', 'antigravity', 'bin'),
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/local/bin'
      ];
  const existing = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const merged = [];
  const seen = new Set();
  for (const dir of [...extras, ...existing]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }
  return merged.join(path.delimiter);
}

function resolveAgyExecutable(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(String(explicitPath).trim());
  if (process.env.AG_TT_AGY_PATH) candidates.push(String(process.env.AG_TT_AGY_PATH).trim());

  const home = process.env.USERPROFILE || os.homedir();
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    candidates.push(
      path.join(home, '.gemini', 'antigravity', 'bin', 'agy.exe'),
      path.join(home, '.gemini', 'antigravity', 'bin', 'agy.cmd'),
      path.join(appData, 'Antigravity', 'bin', 'agy.exe'),
      path.join(appData, 'Antigravity', 'bin', 'agy.cmd'),
      path.join(localAppData, 'Programs', 'Antigravity', 'bin', 'agy.exe'),
      path.join(home, '.local', 'bin', 'agy.exe')
    );
  } else {
    candidates.push(
      path.join(home, '.local', 'bin', 'agy'),
      path.join(home, '.gemini', 'antigravity', 'bin', 'agy'),
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy'
    );
  }

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
        return { ok: true, agyPath: p };
      }
    } catch {}
  }

  const binNames = process.platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy.bat'] : ['agy'];
  for (const dir of buildAugmentedPath().split(path.delimiter)) {
    for (const bin of binNames) {
      const full = path.join(dir, bin);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return { ok: true, agyPath: full };
        }
      } catch {}
    }
  }

  return {
    ok: false,
    agyPath: null,
    error: '未找到 Antigravity CLI (agy)。请确认已安装 agy 或通过环境变量 AG_TT_AGY_PATH 指定路径。'
  };
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function getSettingsPath(stateDirOverride) {
  return path.join(stateDirOverride || getStateDir(), 'settings.json');
}

function getSettings(options = {}) {
  const filePath = getSettingsPath(options.stateDir);
  const raw = readJsonSafe(filePath, {});
  return {
    ok: true,
    settings: normalizeSettings({ ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) })
  };
}

function saveSettings(partial = {}, options = {}) {
  const filePath = getSettingsPath(options.stateDir);
  const current = getSettings(options).settings;
  const merged = normalizeSettings({ ...current, ...(partial && typeof partial === 'object' ? partial : {}) });
  writeJsonAtomic(filePath, merged);
  return { ok: true, settings: merged };
}

class TranslationCache {
  constructor(options = {}) {
    this.stateDir = options.stateDir || getStateDir();
    this.filePath = path.join(this.stateDir, 'translation-cache.json');
    this.maxEntries = Number(options.maxEntries) > 0 ? Number(options.maxEntries) : MAX_CACHE_ENTRIES;
    this.map = new Map();
    this._loaded = false;
  }

  _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    const raw = readJsonSafe(this.filePath, null);
    if (raw && Array.isArray(raw.entries)) {
      for (const item of raw.entries) {
        if (item && typeof item.key === 'string' && typeof item.translation === 'string') {
          this.map.set(item.key, item);
        }
      }
      this._prune();
    }
  }

  _prune() {
    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }

  _save() {
    try {
      writeJsonAtomic(this.filePath, {
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: Array.from(this.map.values())
      });
    } catch {}
  }

  get(key) {
    this._ensureLoaded();
    const entry = this.map.get(key);
    if (!entry) return null;
    // Refresh LRU recency
    this.map.delete(key);
    this.map.set(key, { ...entry, lastAccessAt: Date.now() });
    return entry;
  }

  set(key, value) {
    this._ensureLoaded();
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, {
      key,
      translation: value.translation,
      targetLang: value.targetLang,
      model: value.model,
      updatedAt: Date.now(),
      lastAccessAt: Date.now()
    });
    this._prune();
    this._save();
  }

  clear() {
    this._loaded = true;
    this.map.clear();
    this._save();
    return { ok: true, count: 0 };
  }

  stats() {
    this._ensureLoaded();
    return { count: this.map.size, maxEntries: this.maxEntries };
  }
}

function splitLongText(text, maxChars = CHUNK_MAX_CHARS) {
  const norm = normalizeThinkingText(text);
  if (norm.length <= LONG_TEXT_THRESHOLD) return [norm];

  const paragraphs = norm.split(/\n{2,}/);
  const chunks = [];
  let buf = '';

  const pushBuf = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = '';
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      pushBuf();
      const lines = para.split('\n');
      let lineBuf = '';
      for (const line of lines) {
        if (line.length > maxChars) {
          if (lineBuf.trim()) {
            chunks.push(lineBuf.trim());
            lineBuf = '';
          }
          for (let i = 0; i < line.length; i += maxChars) {
            chunks.push(line.slice(i, i + maxChars));
          }
        } else if (lineBuf && lineBuf.length + 1 + line.length > maxChars) {
          chunks.push(lineBuf.trim());
          lineBuf = line;
        } else {
          lineBuf = lineBuf ? `${lineBuf}\n${line}` : line;
        }
      }
      if (lineBuf.trim()) chunks.push(lineBuf.trim());
      continue;
    }

    if (buf && buf.length + 2 + para.length > maxChars) {
      pushBuf();
      buf = para;
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  pushBuf();
  return chunks.length ? chunks : [norm];
}

function runCommandAsync(cmd, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, {
      cwd: options.cwd || os.tmpdir(),
      env: options.env || { ...process.env, PATH: buildAugmentedPath() },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill('SIGTERM'); } catch {}
      resolve({ ok: false, code: -1, stdout, stderr: stderr || 'Command timeout' });
    }, options.timeoutMs || 20000);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: err.message });
    });
    child.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function listAvailableModels(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const cachePath = path.join(stateDir, 'models-cache.json');
  if (!options.force) {
    const cached = readJsonSafe(cachePath, null);
    if (cached && Array.isArray(cached.models) && cached.models.length && (Date.now() - Number(cached.updatedAt || 0) < MODELS_CACHE_TTL_MS)) {
      return { ok: true, models: cached.models, source: 'cache' };
    }
  }

  const agy = resolveAgyExecutable(options.agyPath);
  if (!agy.ok) {
    return { ok: true, models: FALLBACK_MODELS, source: 'fallback', warning: agy.error };
  }

  const res = await runCommandAsync(agy.agyPath, ['models'], { timeoutMs: options.timeoutMs || 15000 });
  const parsed = res.ok ? parseAgyModelsOutput(res.stdout) : [];
  if (parsed.length > 0) {
    try {
      writeJsonAtomic(cachePath, { updatedAt: Date.now(), models: parsed });
    } catch {}
    return { ok: true, models: parsed, source: 'agy' };
  }

  const stale = readJsonSafe(cachePath, null);
  if (stale && Array.isArray(stale.models) && stale.models.length) {
    return { ok: true, models: stale.models, source: 'stale_cache' };
  }
  return { ok: true, models: FALLBACK_MODELS, source: 'fallback', warning: res.stderr || 'agy models unavailable' };
}

class WarmAgyWorker {
  constructor({ agyPath, model, sandbox = true, turnTimeoutMs = TURN_TIMEOUT_MS, idleMs = WORKER_IDLE_MS }) {
    this.agyPath = agyPath;
    this.model = model;
    this.sandbox = sandbox;
    this.turnTimeoutMs = turnTimeoutMs;
    this.idleMs = idleMs;
    this.child = null;
    this.rl = null;
    this.tmpDir = null;
    this.turns = 0;
    this.closing = false;
    this.activeTurn = null;
    this.idleTimer = null;
    this.stderrTail = '';
  }

  isReusable(targetModel) {
    return (
      !this.closing &&
      this.child &&
      !this.child.killed &&
      this.child.exitCode === null &&
      this.model === targetModel &&
      this.turns < WORKER_MAX_TURNS
    );
  }

  _resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.close();
    }, this.idleMs);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  _spawn() {
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-tt-worker-'));
    const args = [
      '--model', this.model,
      '--disable-slash-commands',
      ...(this.sandbox ? ['--sandbox'] : []),
      '--input-format', 'stream-json',
      '--output-format', 'stream-json'
    ];
    this.child = spawn(this.agyPath, args, {
      cwd: this.tmpDir,
      env: { ...process.env, PATH: buildAugmentedPath() },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.stderrTail = '';
    this.child.stderr.on('data', chunk => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-1500);
    });

    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on('line', line => {
      if (this.closing || !this.activeTurn || this.activeTurn.settled) return;
      const trimmed = String(line || '').trim();
      if (!trimmed) return;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (obj.event === 'step_update') {
        const su = obj.step_update;
        if (su && su.step_type === 'agent_response' && typeof su.text_delta === 'string' && su.text_delta.length > 0) {
          this.activeTurn.accumulated += su.text_delta;
          if (typeof this.activeTurn.onDelta === 'function') {
            try {
              this.activeTurn.onDelta(this.activeTurn.accumulated, su.text_delta);
            } catch {}
          }
        }
      } else if (obj.event === 'result') {
        const turn = this.activeTurn;
        turn.settled = true;
        this.activeTurn = null;
        clearTimeout(turn.timer);
        const r = obj.result || {};
        if (r.status === 'SUCCESS') {
          this.turns++;
          this._resetIdleTimer();
          turn.resolve(String(r.response || turn.accumulated || ''));
        } else {
          turn.reject(new Error(r.error || `agy stream-json returned status=${r.status || 'ERROR'}`));
        }
      }
    });

    this.child.on('error', err => {
      this._failActiveTurn(err);
      this.close();
    });

    this.child.on('close', code => {
      if (!this.closing) {
        this._failActiveTurn(new Error(`agy worker exited unexpectedly (code=${code}): ${this.stderrTail.trim()}`));
      }
      this._cleanupFiles();
    });
  }

  _failActiveTurn(err) {
    if (this.activeTurn && !this.activeTurn.settled) {
      const turn = this.activeTurn;
      turn.settled = true;
      this.activeTurn = null;
      clearTimeout(turn.timer);
      turn.reject(err);
    }
  }

  runTurn(prompt, onDelta) {
    if (this.closing) return Promise.reject(new Error('Worker is closing'));
    if (!this.child) this._spawn();
    if (this.activeTurn) return Promise.reject(new Error('Worker is busy'));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.activeTurn && !this.activeTurn.settled) {
          const turn = this.activeTurn;
          turn.settled = true;
          this.activeTurn = null;
          this.close();
          turn.reject(new Error(`Translation timed out after ${Math.round(this.turnTimeoutMs / 1000)}s`));
        }
      }, this.turnTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.activeTurn = {
        settled: false,
        accumulated: '',
        onDelta,
        timer,
        resolve,
        reject
      };

      const payload = JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n';
      try {
        this.child.stdin.write(payload);
      } catch (err) {
        this._failActiveTurn(err);
        this.close();
      }
    });
  }

  _cleanupFiles() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    if (this.tmpDir) {
      const dir = this.tmpDir;
      this.tmpDir = null;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  close() {
    if (this.closing) return;
    this.closing = true;
    this._failActiveTurn(new Error('Worker closed'));
    if (this.child) {
      const c = this.child;
      this.child = null;
      try { c.stdin.end(); } catch {}
      try { c.kill('SIGTERM'); } catch {}
    }
    this._cleanupFiles();
  }
}

class AgyTranslationService {
  constructor(options = {}) {
    this.stateDir = options.stateDir || getStateDir();
    this.agyPathOverride = options.agyPath || null;
    this.sandbox = options.sandbox !== false;
    this.turnTimeoutMs = options.turnTimeoutMs || TURN_TIMEOUT_MS;
    this.idleMs = options.idleMs || WORKER_IDLE_MS;
    this.cache = new TranslationCache({ stateDir: this.stateDir, maxEntries: options.maxCacheEntries });
    this.inflight = new Map();
    this.queue = Promise.resolve();
    this.worker = null;
    this.disposed = false;
  }

  _enqueue(fn) {
    const task = this.queue.then(fn, fn);
    this.queue = task.catch(() => {});
    return task;
  }

  async _runOneShot(agyPath, model, prompt) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-tt-oneshot-'));
    try {
      const args = [
        '--model', model,
        '--disable-slash-commands',
        ...(this.sandbox ? ['--sandbox'] : []),
        '--output-format', 'json',
        `-p=${prompt}`
      ];
      const res = await runCommandAsync(agyPath, args, {
        cwd: tmpDir,
        timeoutMs: this.turnTimeoutMs
      });
      if (!res.ok) {
        let msg = res.stderr.trim() || `agy exited with code ${res.code}`;
        try {
          const parsed = JSON.parse(res.stdout);
          if (parsed && parsed.error) msg = parsed.error;
        } catch {}
        throw new Error(msg);
      }
      const parsed = JSON.parse(res.stdout);
      if (parsed.status !== 'SUCCESS') {
        throw new Error(parsed.error || `agy returned status=${parsed.status}`);
      }
      return String(parsed.response || '');
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  async _translateSingleChunk(agyPath, model, targetLang, chunkText, onChunkDelta) {
    const prompt = buildTranslationPrompt(chunkText, targetLang);
    return this._enqueue(async () => {
      if (this.disposed) throw new Error('Service disposed');
      if (!this.worker || !this.worker.isReusable(model)) {
        if (this.worker) {
          this.worker.close();
          this.worker = null;
        }
        this.worker = new WarmAgyWorker({
          agyPath,
          model,
          sandbox: this.sandbox,
          turnTimeoutMs: this.turnTimeoutMs,
          idleMs: this.idleMs
        });
      }

      try {
        const raw = await this.worker.runTurn(prompt, onChunkDelta);
        return cleanModelTranslationOutput(raw, chunkText);
      } catch (err) {
        if (this.worker) {
          this.worker.close();
          this.worker = null;
        }
        // One-shot fallback for models or environments where stream-json fails
        const raw = await this._runOneShot(agyPath, model, prompt);
        if (typeof onChunkDelta === 'function') {
          try { onChunkDelta(raw, raw); } catch {}
        }
        return cleanModelTranslationOutput(raw, chunkText);
      }
    });
  }

  async translate(request = {}) {
    if (this.disposed) {
      return { ok: false, error: 'Translation service has been disposed' };
    }

    const currentSettings = getSettings({ stateDir: this.stateDir }).settings;
    const text = normalizeThinkingText(request.text || '');
    if (!text) {
      return { ok: false, error: '待翻译文本为空' };
    }

    const targetLang = String(request.targetLang || getEffectiveTargetLang(currentSettings)).trim() || '简体中文';
    const model = String(request.model || currentSettings.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const force = request.force === true;
    const onProgress = typeof request.onProgress === 'function' ? request.onProgress : null;
    const cacheKey = computeCacheKey(text, targetLang, model);

    if (!force) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return {
          ok: true,
          cacheKey,
          translation: cached.translation,
          model,
          targetLang,
          cached: true
        };
      }
    }

    if (this.inflight.has(cacheKey)) {
      const existing = this.inflight.get(cacheKey);
      if (onProgress) existing.listeners.add(onProgress);
      return existing.promise;
    }

    const listeners = new Set();
    if (onProgress) listeners.add(onProgress);

    const agy = resolveAgyExecutable(this.agyPathOverride);
    if (!agy.ok) {
      return { ok: false, cacheKey, error: agy.error };
    }

    const promise = (async () => {
      const chunks = splitLongText(text, CHUNK_MAX_CHARS);
      const translatedChunks = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const prefix = translatedChunks.length ? translatedChunks.join('\n\n') + '\n\n' : '';
        const translated = await this._translateSingleChunk(agy.agyPath, model, targetLang, chunk, partial => {
          const cleanedPartial = cleanModelTranslationOutput(partial, chunk);
          const fullPartial = prefix + cleanedPartial;
          for (const cb of listeners) {
            try { cb({ cacheKey, text: fullPartial, chunkIndex: i, totalChunks: chunks.length }); } catch {}
          }
        });
        translatedChunks.push(translated);
        const progressText = translatedChunks.join('\n\n');
        for (const cb of listeners) {
          try { cb({ cacheKey, text: progressText, chunkIndex: i, totalChunks: chunks.length }); } catch {}
        }
      }

      const finalTranslation = translatedChunks.join('\n\n').trim();
      this.cache.set(cacheKey, {
        translation: finalTranslation,
        targetLang,
        model
      });

      return {
        ok: true,
        cacheKey,
        translation: finalTranslation,
        model,
        targetLang,
        cached: false
      };
    })().catch(err => ({
      ok: false,
      cacheKey,
      error: err?.message || String(err)
    })).finally(() => {
      this.inflight.delete(cacheKey);
    });

    this.inflight.set(cacheKey, { promise, listeners });
    return promise;
  }

  dispose() {
    this.disposed = true;
    if (this.worker) {
      this.worker.close();
      this.worker = null;
    }
  }
}

module.exports = {
  buildAugmentedPath,
  resolveAgyExecutable,
  getSettings,
  saveSettings,
  TranslationCache,
  splitLongText,
  listAvailableModels,
  AgyTranslationService
};
