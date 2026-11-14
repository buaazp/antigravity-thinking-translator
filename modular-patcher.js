'use strict';

const vm = require('vm');
const { PLUGIN_VERSION } = require('./tt-core');

const TAGS = {
  UTILS_START: '// --- Antigravity Thinking Translator utils Injection Start ---',
  UTILS_END: '// --- Antigravity Thinking Translator utils Injection End ---',
  PRELOAD_START: '// --- Antigravity Thinking Translator preload Injection Start ---',
  PRELOAD_END: '// --- Antigravity Thinking Translator preload Injection End ---'
};

const LOAD_URL_MARKER = '    void win.loadURL(url);';
const SETUP_NODE_MARKER = 'function setupNodeWrapper(env) {';

function validateSyntax(code, filename = 'script.js') {
  if (typeof code !== 'string') return false;
  try {
    new vm.Script(code, { filename });
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasThinkingTranslatorUtilsTrace(source) {
  if (!source || typeof source !== 'string') return false;
  return source.includes(TAGS.UTILS_START) || source.includes('installThinkingTranslator');
}

function hasThinkingTranslatorPreloadTrace(source) {
  if (!source || typeof source !== 'string') return false;
  return source.includes(TAGS.PRELOAD_START) || source.includes('"thinkingTranslatorAPI"');
}

function cleanUtilsSource(source) {
  if (!source || typeof source !== 'string') return source;
  const tagRegex = new RegExp(
    `\\n?${escapeRegExp(TAGS.UTILS_START)}[\\s\\S]*?${escapeRegExp(TAGS.UTILS_END)}\\n?`,
    'g'
  );
  let code = source.replace(tagRegex, '\n');
  code = code.replace(/\n?[ \t]*try\s*\{\s*require\("\.\/tt-main"\)\.installThinkingTranslator\(win\);\s*\}\s*catch\s*\{\}\n?/g, '\n');
  return code;
}

function cleanPreloadSource(source) {
  if (!source || typeof source !== 'string') return source;
  const tagRegex = new RegExp(
    `\\n?${escapeRegExp(TAGS.PRELOAD_START)}[\\s\\S]*?${escapeRegExp(TAGS.PRELOAD_END)}\\n?`,
    'g'
  );
  return source.replace(tagRegex, '\n');
}

function verifyHostUtilsStructure(utilsSource) {
  if (!utilsSource || typeof utilsSource !== 'string') return false;
  const loadUrlCount = utilsSource.split(LOAD_URL_MARKER).length - 1;
  const hasSetupNode = utilsSource.includes(SETUP_NODE_MARKER);
  return loadUrlCount === 1 && hasSetupNode && validateSyntax(utilsSource, 'dist/utils.js');
}

function patchUtilsSource(source) {
  const cleaned = cleanUtilsSource(source);
  if (!verifyHostUtilsStructure(cleaned)) {
    throw new Error('dist/utils.js 缺少标准宿主加载标记或语法校验未通过，为保护客户端已中止写入。');
  }
  const hookBlock = [
    TAGS.UTILS_START,
    '    try { require("./tt-main").installThinkingTranslator(win); } catch {}',
    TAGS.UTILS_END
  ].join('\n');

  const patched = cleaned.replace(LOAD_URL_MARKER, `${hookBlock}\n${LOAD_URL_MARKER}`);
  if (!verifyHostUtilsStructure(patched)) {
    throw new Error('注入 Thinking Translator 后的 dist/utils.js 结构或语法校验失败。');
  }
  return patched;
}

function generatePreloadSnippet() {
  return [
    '',
    TAGS.PRELOAD_START,
    'electron_1.contextBridge.exposeInMainWorld("thinkingTranslatorAPI", {',
    `  version: ${JSON.stringify(PLUGIN_VERSION)},`,
    '  getSettings: () => electron_1.ipcRenderer.invoke("thinking-translator:get-settings"),',
    '  saveSettings: (payload) => electron_1.ipcRenderer.invoke("thinking-translator:save-settings", payload),',
    '  listModels: (opts) => electron_1.ipcRenderer.invoke("thinking-translator:list-models", opts),',
    '  checkCache: (payload) => electron_1.ipcRenderer.invoke("thinking-translator:check-cache", payload),',
    '  translate: (payload) => electron_1.ipcRenderer.invoke("thinking-translator:translate", payload),',
    '  translateBatch: (payload) => electron_1.ipcRenderer.invoke("thinking-translator:translate-batch", payload),',
    '  clearCache: () => electron_1.ipcRenderer.invoke("thinking-translator:clear-cache"),',
    '  getStatus: () => electron_1.ipcRenderer.invoke("thinking-translator:status"),',
    '  onProgress: (cb) => {',
    '    if (typeof cb !== "function") return () => {};',
    '    const handler = (_event, data) => cb(data);',
    '    electron_1.ipcRenderer.on("thinking-translator:progress", handler);',
    '    return () => electron_1.ipcRenderer.removeListener("thinking-translator:progress", handler);',
    '  }',
    '});',
    TAGS.PRELOAD_END,
    ''
  ].join('\n');
}

function patchPreloadSource(source) {
  const cleaned = cleanPreloadSource(source);
  if (!cleaned.includes('electron_1.contextBridge')) {
    throw new Error('dist/preload.js 缺少预期的 electron_1.contextBridge 符号，已中止写入。');
  }
  const patched = cleaned + generatePreloadSnippet();
  if (!validateSyntax(patched, 'dist/preload.js')) {
    throw new Error('注入 Thinking Translator 后的 dist/preload.js 语法校验失败。');
  }
  return patched;
}

module.exports = {
  TAGS,
  LOAD_URL_MARKER,
  SETUP_NODE_MARKER,
  validateSyntax,
  hasThinkingTranslatorUtilsTrace,
  hasThinkingTranslatorPreloadTrace,
  cleanUtilsSource,
  cleanPreloadSource,
  verifyHostUtilsStructure,
  patchUtilsSource,
  patchPreloadSource
};
