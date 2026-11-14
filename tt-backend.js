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
  computeCanonicalCacheKey,
  buildTranslationPrompt,
  buildBatchTranslationPrompt,
  cleanModelTranslationOutput,
  parseBatchTranslationStream,
  parseAgyModelsOutput
} = require('./tt-core');

const MAX_CACHE_ENTRIES = 2000;
const WORKER_MAX_TURNS = 24;
const WORKER_MAX_CHARS = 28000;
const WORKER_IDLE_MS = 8 * 60 * 1000;
const TURN_TIMEOUT_MS = 90 * 1000;
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
const LONG_TEXT_THRESHOLD = 5500;
const CHUNK_MAX_CHARS = 4200;
const DEFAULT_MAX_CONCURRENCY = 2;
const MAX_BATCH_ITEMS = 12;
const MAX_BATCH_CHARS = 4500;
const CUSTOM_TRANSLATOR_AGENT_NAME = 'tt-translator';

function prepareIsolatedWorkerDir(prefix) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const agentsDir = path.join(tmpDir, '.agents');
  const translatorAgentDir = path.join(agentsDir, 'agents', CUSTOM_TRANSLATOR_AGENT_NAME);
  fs.mkdirSync(translatorAgentDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'skills.json'), '{"entries":[]}\n', 'utf8');
  fs.writeFileSync(path.join(agentsDir, 'plugins.json'), '{"entries":[]}\n', 'utf8');
  fs.writeFileSync(
    path.join(translatorAgentDir, 'agent.md'),
    [
      '---',
      `name: ${CUSTOM_TRANSLATOR_AGENT_NAME}`,
      'description: Pure text translation engine without tools.',
      'tools: []',
      'mainAgent: true',
      'subagent: false',
      'commandExecutionPolicy: off',
      'mcpServers: []',
      'skills: []',
      'plugins: []',
      '---',
      'You are a faithful technical translator. Follow the user prompt instructions strictly, never invoke tools, and output only the requested translation.',
      ''
    ].join('\n'),
    'utf8'
  );
  const settingsPath = path.join(tmpDir, 'worker-settings.json');
  fs.writeFileSync(
    settingsPath,
    '{"historySize":0,"notifications":false,"showTips":false,"showFeedbackSurvey":false,"disableSlashCommands":true}\n',
    'utf8'
  );
  return { tmpDir, settingsPath, agentName: CUSTOM_TRANSLATOR_AGENT_NAME };
}

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
    this.canonicalIndex = new Map();
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
          if (typeof item.canonicalKey === 'string' && item.canonicalKey) {
            this.canonicalIndex.set(item.canonicalKey, item.key);
          }
        }
      }
      this._prune();
    }
  }

  _prune() {
    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      if (oldest && oldest.canonicalKey && this.canonicalIndex.get(oldest.canonicalKey) === oldestKey) {
        this.canonicalIndex.delete(oldest.canonicalKey);
      }
    }
  }

  _save() {
    try {
      writeJsonAtomic(this.filePath, {
        version: 2,
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

  lookup(text, targetLang, model) {
    this._ensureLoaded();
    const exactKey = computeCacheKey(text, targetLang, model);
    const exactHit = this.get(exactKey);
    if (exactHit) return exactHit;

    const canonKey = computeCanonicalCacheKey(text, targetLang, model);
    const mappedKey = this.canonicalIndex.get(canonKey);
    if (mappedKey) {
      const canonHit = this.get(mappedKey);
      if (canonHit) return canonHit;
      this.canonicalIndex.delete(canonKey);
    }
    return null;
  }

  checkBatch(items, targetLang, model) {
    this._ensureLoaded();
    const hits = {};
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!item || typeof item.id !== 'string' || typeof item.text !== 'string' || !item.text.trim()) continue;
        const entry = this.lookup(item.text, targetLang, model);
        if (entry && typeof entry.translation === 'string') {
          hits[item.id] = entry.translation;
        }
      }
    }
    return {
      ok: true,
      hits,
      cacheStats: this.stats()
    };
  }

  set(key, value, options = {}) {
    this._ensureLoaded();
    const canonicalKey = value.canonicalKey || '';
    if (canonicalKey) {
      const prevKey = this.canonicalIndex.get(canonicalKey);
      if (prevKey && prevKey !== key) {
        this.map.delete(prevKey);
      }
    }
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, {
      key,
      canonicalKey,
      translation: value.translation,
      targetLang: value.targetLang,
      model: value.model,
      updatedAt: Date.now(),
      lastAccessAt: Date.now()
    });
    if (canonicalKey) {
      this.canonicalIndex.set(canonicalKey, key);
    }
    this._prune();
    if (!options.deferSave) {
      this._save();
    }
  }

  flush() {
    if (this._loaded) {
      this._save();
    }
  }

  clear() {
    this._loaded = true;
    this.map.clear();
    this.canonicalIndex.clear();
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
    this.settingsPath = null;
    this.turns = 0;
    this.totalPromptChars = 0;
    this.lastTargetLang = null;
    this.busy = false;
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
      this.turns < WORKER_MAX_TURNS &&
      this.totalPromptChars < WORKER_MAX_CHARS
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
    const iso = prepareIsolatedWorkerDir('ag-tt-worker-');
    this.tmpDir = iso.tmpDir;
    this.settingsPath = iso.settingsPath;
    const args = [
      '--model', this.model,
      '--agent', iso.agentName,
      '--disable-slash-commands',
      '--settings', this.settingsPath,
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
          const finalResp = String(r.response || turn.accumulated || '');
          this.turns++;
          this.totalPromptChars += (turn.promptLen || 0) + finalResp.length;
          if (turn.targetLang) this.lastTargetLang = turn.targetLang;
          this._resetIdleTimer();
          turn.resolve(finalResp);
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

  runTurn(prompt, onDelta, meta = {}) {
    if (this.closing) return Promise.reject(new Error('Worker is closing'));
    if (!this.child) this._spawn();
    if (this.activeTurn) return Promise.reject(new Error('Worker is busy'));

    const promptStr = String(prompt || '');
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
        promptLen: promptStr.length,
        targetLang: meta?.targetLang || null,
        onDelta,
        timer,
        resolve,
        reject
      };

      const payload = JSON.stringify({ event: 'user', message: { content: promptStr } }) + '\n';
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
    this.settingsPath = null;
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
    this.maxConcurrency = Math.max(1, Number(options.maxConcurrency) || DEFAULT_MAX_CONCURRENCY);
    this.cache = new TranslationCache({ stateDir: this.stateDir, maxEntries: options.maxCacheEntries });
    this.inflight = new Map();
    this.workers = [];
    this.waiters = [];
    this.disposed = false;
  }

  _removeWorker(worker) {
    const idx = this.workers.indexOf(worker);
    if (idx !== -1) this.workers.splice(idx, 1);
  }

  _isWorkerRetired(w) {
    return (
      w.closing ||
      (w.child && (w.child.killed || w.child.exitCode !== null)) ||
      w.turns >= WORKER_MAX_TURNS ||
      w.totalPromptChars >= WORKER_MAX_CHARS
    );
  }

  _cleanupDeadWorkers() {
    for (let i = this.workers.length - 1; i >= 0; i--) {
      const w = this.workers[i];
      if (!w.busy && this._isWorkerRetired(w)) {
        this.workers.splice(i, 1);
        try { w.close(); } catch {}
      }
    }
  }

  async _acquireWorker(agyPath, model) {
    while (true) {
      if (this.disposed) throw new Error('Service disposed');
      this._cleanupDeadWorkers();

      // 1. Prefer reusing an idle warm worker with matching model
      const reusable = this.workers.find(w => !w.busy && w.isReusable(model));
      if (reusable) {
        reusable.busy = true;
        return reusable;
      }

      // 2. Retire any idle worker for a different model before spawning a fresh one
      const diffIdle = this.workers.find(w => !w.busy && w.model !== model);
      if (diffIdle) {
        this._removeWorker(diffIdle);
        try { diffIdle.close(); } catch {}
      }

      // 3. Spawn a new worker if within pool capacity
      if (this.workers.length < this.maxConcurrency) {
        const worker = new WarmAgyWorker({
          agyPath,
          model,
          sandbox: this.sandbox,
          turnTimeoutMs: this.turnTimeoutMs,
          idleMs: this.idleMs
        });
        worker.busy = true;
        this.workers.push(worker);
        return worker;
      }

      // 4. Wait until a worker finishes its turn and frees a slot
      await new Promise((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
    }
  }

  _releaseWorker(worker) {
    if (!worker) return;
    worker.busy = false;
    if (this.disposed || this._isWorkerRetired(worker)) {
      this._removeWorker(worker);
      try { worker.close(); } catch {}
    }
    const next = this.waiters.shift();
    if (next) next.resolve();
  }

  async _runOneShot(agyPath, model, prompt) {
    const iso = prepareIsolatedWorkerDir('ag-tt-oneshot-');
    try {
      const args = [
        '--model', model,
        '--agent', iso.agentName,
        '--disable-slash-commands',
        '--settings', iso.settingsPath,
        ...(this.sandbox ? ['--sandbox'] : []),
        '--output-format', 'json',
        `-p=${prompt}`
      ];
      const res = await runCommandAsync(agyPath, args, {
        cwd: iso.tmpDir,
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
      try { fs.rmSync(iso.tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  async _runWorkerPromptWithFallback(agyPath, model, { buildPrompt, onDelta, targetLang }) {
    const worker = await this._acquireWorker(agyPath, model);
    try {
      const useCompact = worker.turns > 0 && Boolean(targetLang) && worker.lastTargetLang === targetLang;
      const workerPrompt = buildPrompt({ compact: useCompact });
      try {
        return await worker.runTurn(workerPrompt, onDelta, { targetLang });
      } catch (err) {
        this._removeWorker(worker);
        try { worker.close(); } catch {}
        // One-shot fallback for models or environments where stream-json fails
        const fullPrompt = buildPrompt({ compact: false });
        const raw = await this._runOneShot(agyPath, model, fullPrompt);
        if (typeof onDelta === 'function') {
          try { onDelta(raw, raw); } catch {}
        }
        return raw;
      }
    } finally {
      this._releaseWorker(worker);
    }
  }

  async _translateSingleChunk(agyPath, model, targetLang, chunkText, onChunkDelta) {
    const raw = await this._runWorkerPromptWithFallback(agyPath, model, {
      targetLang,
      buildPrompt: opts => buildTranslationPrompt(chunkText, targetLang, opts),
      onDelta: onChunkDelta
    });
    return cleanModelTranslationOutput(raw, chunkText);
  }

  async _translateBatchChunk(agyPath, model, targetLang, batchEntries, onBatchUpdate) {
    if (batchEntries.length === 1) {
      const only = batchEntries[0];
      const translated = await this._translateSingleChunk(agyPath, model, targetLang, only.text, partial => {
        if (typeof onBatchUpdate === 'function') {
          const cleaned = cleanModelTranslationOutput(partial, only.text);
          if (cleaned) {
            onBatchUpdate({ completed: {}, activeIndex: 0, activePartialText: cleaned });
          }
        }
      });
      return [translated];
    }

    const sourceTexts = batchEntries.map(e => e.text);
    const raw = await this._runWorkerPromptWithFallback(agyPath, model, {
      targetLang,
      buildPrompt: opts => buildBatchTranslationPrompt(sourceTexts, targetLang, opts),
      onDelta: accumulated => {
        if (typeof onBatchUpdate === 'function') {
          const parsed = parseBatchTranslationStream(accumulated, sourceTexts.length, sourceTexts, false);
          onBatchUpdate(parsed);
        }
      }
    });

    const finalParsed = parseBatchTranslationStream(raw, sourceTexts.length, sourceTexts, true);
    const outputs = new Array(sourceTexts.length);
    for (let idx = 0; idx < sourceTexts.length; idx++) {
      const cand = finalParsed.completed[idx];
      if (typeof cand === 'string' && cand.trim()) {
        outputs[idx] = cand.trim();
      } else {
        // Recover any missing item cleanly without dropping batch members
        outputs[idx] = await this._translateSingleChunk(agyPath, model, targetLang, sourceTexts[idx], null);
      }
    }
    return outputs;
  }

  async _executeChunkedTranslation(agyPath, model, targetLang, text, cacheKey, canonicalKey, listeners) {
    const chunks = splitLongText(text, CHUNK_MAX_CHARS);
    const translatedChunks = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const prefix = translatedChunks.length ? translatedChunks.join('\n\n') + '\n\n' : '';
      const translated = await this._translateSingleChunk(agyPath, model, targetLang, chunk, partial => {
        const cleanedPartial = cleanModelTranslationOutput(partial, chunk);
        const fullPartial = prefix + cleanedPartial;
        for (const cb of listeners) {
          try { cb({ cacheKey, canonicalKey, text: fullPartial, chunkIndex: i, totalChunks: chunks.length }); } catch {}
        }
      });
      translatedChunks.push(translated);
      const progressText = translatedChunks.join('\n\n');
      for (const cb of listeners) {
        try { cb({ cacheKey, canonicalKey, text: progressText, chunkIndex: i, totalChunks: chunks.length }); } catch {}
      }
    }

    const finalTranslation = translatedChunks.join('\n\n').trim();
    this.cache.set(cacheKey, {
      canonicalKey,
      translation: finalTranslation,
      targetLang,
      model
    });

    return {
      ok: true,
      cacheKey,
      canonicalKey,
      translation: finalTranslation,
      model,
      targetLang,
      cached: false
    };
  }

  checkCache(request = {}) {
    const currentSettings = getSettings({ stateDir: this.stateDir }).settings;
    const targetLang = String(request.targetLang || getEffectiveTargetLang(currentSettings)).trim() || '简体中文';
    const model = String(request.model || currentSettings.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    return this.cache.checkBatch(request.items || [], targetLang, model);
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
    const canonicalKey = computeCanonicalCacheKey(text, targetLang, model);

    if (!force) {
      const cached = this.cache.lookup(text, targetLang, model);
      if (cached) {
        return {
          ok: true,
          cacheKey,
          canonicalKey,
          translation: cached.translation,
          model,
          targetLang,
          cached: true
        };
      }

      if (this.inflight.has(canonicalKey)) {
        const existing = this.inflight.get(canonicalKey);
        if (onProgress) existing.listeners.add(onProgress);
        return existing.promise;
      }
    }

    const inflightKey = force ? `force:${cacheKey}:${Date.now()}:${Math.random()}` : canonicalKey;
    const listeners = new Set();
    if (onProgress) listeners.add(onProgress);

    const agy = resolveAgyExecutable(this.agyPathOverride);
    if (!agy.ok) {
      return { ok: false, cacheKey, canonicalKey, error: agy.error };
    }

    const promise = this._executeChunkedTranslation(
      agy.agyPath,
      model,
      targetLang,
      text,
      cacheKey,
      canonicalKey,
      listeners
    ).catch(err => ({
      ok: false,
      cacheKey,
      canonicalKey,
      error: err?.message || String(err)
    })).finally(() => {
      this.inflight.delete(inflightKey);
    });

    this.inflight.set(inflightKey, { promise, listeners });
    return promise;
  }

  async translateBatch(request = {}) {
    if (this.disposed) {
      return { ok: false, error: 'Translation service has been disposed', results: {} };
    }

    const rawItems = Array.isArray(request.items) ? request.items : [];
    const currentSettings = getSettings({ stateDir: this.stateDir }).settings;
    const targetLang = String(request.targetLang || getEffectiveTargetLang(currentSettings)).trim() || '简体中文';
    const model = String(request.model || currentSettings.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const force = request.force === true;
    const onItemProgress = typeof request.onItemProgress === 'function' ? request.onItemProgress : null;
    const emitItem = payload => {
      if (!onItemProgress) return;
      try { onItemProgress(payload); } catch {}
    };

    const results = {};
    const inflightWaiters = [];
    const groupsByKey = new Map();

    for (const item of rawItems) {
      const id = item && typeof item.id === 'string' ? item.id : '';
      const norm = normalizeThinkingText(item?.text || '');
      if (!id || !norm) continue;

      const cacheKey = computeCacheKey(norm, targetLang, model);
      const canonicalKey = computeCanonicalCacheKey(norm, targetLang, model);

      if (!force) {
        const cached = this.cache.lookup(norm, targetLang, model);
        if (cached) {
          results[id] = {
            ok: true,
            cacheKey,
            canonicalKey,
            translation: cached.translation,
            model,
            targetLang,
            cached: true
          };
          emitItem({ id, text: cached.translation, done: true, cached: true });
          continue;
        }
      }

      let group = groupsByKey.get(canonicalKey);
      if (!group && !force && this.inflight.has(canonicalKey)) {
        const existing = this.inflight.get(canonicalKey);
        const relayIds = [id];
        const listener = prog => {
          if (prog && typeof prog.text === 'string') {
            for (const rid of relayIds) {
              emitItem({ id: rid, text: prog.text, done: false, cached: false });
            }
          }
        };
        existing.listeners.add(listener);
        inflightWaiters.push(
          existing.promise.then(res => {
            existing.listeners.delete(listener);
            for (const rid of relayIds) {
              results[rid] = res;
              if (res?.ok && typeof res.translation === 'string') {
                emitItem({ id: rid, text: res.translation, done: true, cached: Boolean(res.cached) });
              }
            }
          })
        );
        // Track relayIds in case duplicate items appear later in the same request
        groupsByKey.set(`relay:${canonicalKey}`, { relayIds });
        continue;
      }

      const existingRelay = groupsByKey.get(`relay:${canonicalKey}`);
      if (!group && existingRelay) {
        existingRelay.relayIds.push(id);
        continue;
      }

      if (!group) {
        group = {
          text: norm,
          cacheKey,
          canonicalKey,
          ids: [id],
          inflightKey: force ? `force:${cacheKey}:${Date.now()}:${Math.random()}` : canonicalKey,
          listeners: new Set(),
          resolveDeferred: null,
          settled: false
        };
        const listeners = group.listeners;
        const p = new Promise(resolve => {
          group.resolveDeferred = val => {
            if (!group.settled) {
              group.settled = true;
              resolve(val);
            }
          };
        });
        this.inflight.set(group.inflightKey, { promise: p, listeners });
        groupsByKey.set(canonicalKey, group);
      } else {
        group.ids.push(id);
      }
    }

    const workEntries = Array.from(groupsByKey.entries())
      .filter(([k]) => !k.startsWith('relay:'))
      .map(([, v]) => v);

    if (workEntries.length === 0) {
      if (inflightWaiters.length > 0) await Promise.all(inflightWaiters);
      return { ok: true, results, model, targetLang, cacheStats: this.cache.stats() };
    }

    const agy = resolveAgyExecutable(this.agyPathOverride);
    if (!agy.ok) {
      for (const entry of workEntries) {
        const failRes = { ok: false, cacheKey: entry.cacheKey, canonicalKey: entry.canonicalKey, error: agy.error };
        this.inflight.delete(entry.inflightKey);
        entry.resolveDeferred(failRes);
        for (const id of entry.ids) results[id] = failRes;
      }
      if (inflightWaiters.length > 0) await Promise.all(inflightWaiters);
      return { ok: false, error: agy.error, results, model, targetLang, cacheStats: this.cache.stats() };
    }

    const finalizeEntrySuccess = (entry, finalText, deferSave = false) => {
      if (entry.settled) return;
      this.cache.set(
        entry.cacheKey,
        { canonicalKey: entry.canonicalKey, translation: finalText, targetLang, model },
        { deferSave }
      );
      const resObj = {
        ok: true,
        cacheKey: entry.cacheKey,
        canonicalKey: entry.canonicalKey,
        translation: finalText,
        model,
        targetLang,
        cached: false
      };
      this.inflight.delete(entry.inflightKey);
      entry.resolveDeferred(resObj);
      for (const id of entry.ids) {
        results[id] = resObj;
        emitItem({ id, text: finalText, done: true, cached: false });
      }
    };

    const finalizeEntryError = (entry, errMsg) => {
      if (entry.settled) return;
      const failRes = {
        ok: false,
        cacheKey: entry.cacheKey,
        canonicalKey: entry.canonicalKey,
        error: errMsg
      };
      this.inflight.delete(entry.inflightKey);
      entry.resolveDeferred(failRes);
      for (const id of entry.ids) {
        results[id] = failRes;
        emitItem({ id, error: errMsg, done: true, ok: false });
      }
    };

    const normalEntries = [];
    const oversizeEntries = [];
    for (const entry of workEntries) {
      if (entry.text.length > CHUNK_MAX_CHARS) oversizeEntries.push(entry);
      else normalEntries.push(entry);
    }

    const subBatches = [];
    let curBatch = [];
    let curChars = 0;
    for (const entry of normalEntries) {
      if (
        curBatch.length >= MAX_BATCH_ITEMS ||
        (curBatch.length > 0 && curChars + entry.text.length > MAX_BATCH_CHARS)
      ) {
        subBatches.push(curBatch);
        curBatch = [];
        curChars = 0;
      }
      curBatch.push(entry);
      curChars += entry.text.length;
    }
    if (curBatch.length > 0) subBatches.push(curBatch);

    const runOversize = oversizeEntries.map(async entry => {
      const relaySet = new Set(entry.listeners);
      relaySet.add(prog => {
        if (prog && typeof prog.text === 'string') {
          for (const id of entry.ids) {
            emitItem({ id, text: prog.text, done: false, cached: false });
          }
        }
      });
      try {
        const res = await this._executeChunkedTranslation(
          agy.agyPath,
          model,
          targetLang,
          entry.text,
          entry.cacheKey,
          entry.canonicalKey,
          relaySet
        );
        this.inflight.delete(entry.inflightKey);
        entry.resolveDeferred(res);
        for (const id of entry.ids) {
          results[id] = res;
          emitItem({ id, text: res.translation, done: true, cached: false });
        }
      } catch (err) {
        finalizeEntryError(entry, err?.message || String(err));
      }
    });

    const runSubBatches = subBatches.map(async batch => {
      const emittedDoneIdx = new Set();
      try {
        const translations = await this._translateBatchChunk(
          agy.agyPath,
          model,
          targetLang,
          batch,
          parsed => {
            if (!parsed) return;
            for (const [idxStr, doneText] of Object.entries(parsed.completed || {})) {
              const idx = Number(idxStr);
              const entry = batch[idx];
              if (!entry || emittedDoneIdx.has(idx) || typeof doneText !== 'string' || !doneText.trim()) continue;
              emittedDoneIdx.add(idx);
              for (const cb of entry.listeners) {
                try { cb({ cacheKey: entry.cacheKey, canonicalKey: entry.canonicalKey, text: doneText, chunkIndex: 0, totalChunks: 1 }); } catch {}
              }
              finalizeEntrySuccess(entry, doneText.trim(), true);
            }
            if (Number.isInteger(parsed.activeIndex) && parsed.activeIndex >= 0 && typeof parsed.activePartialText === 'string' && parsed.activePartialText) {
              const entry = batch[parsed.activeIndex];
              if (entry && !emittedDoneIdx.has(parsed.activeIndex)) {
                for (const cb of entry.listeners) {
                  try { cb({ cacheKey: entry.cacheKey, canonicalKey: entry.canonicalKey, text: parsed.activePartialText, chunkIndex: 0, totalChunks: 1 }); } catch {}
                }
                for (const id of entry.ids) {
                  emitItem({ id, text: parsed.activePartialText, done: false, cached: false });
                }
              }
            }
          }
        );

        for (let idx = 0; idx < batch.length; idx++) {
          const entry = batch[idx];
          if (entry && !entry.settled) {
            finalizeEntrySuccess(entry, String(translations[idx] || '').trim(), true);
          }
        }
      } catch (err) {
        const msg = err?.message || String(err);
        for (const entry of batch) {
          finalizeEntryError(entry, msg);
        }
      }
    });

    await Promise.all([...runSubBatches, ...runOversize, ...inflightWaiters]);
    this.cache.flush();

    return {
      ok: true,
      results,
      model,
      targetLang,
      cacheStats: this.cache.stats()
    };
  }

  dispose() {
    this.disposed = true;
    while (this.waiters.length) {
      const w = this.waiters.shift();
      try { w.reject(new Error('Service disposed')); } catch {}
    }
    while (this.workers.length) {
      const worker = this.workers.pop();
      try { worker.close(); } catch {}
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
