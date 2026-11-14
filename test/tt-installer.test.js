'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPackage, extractFile, listPackage } = require('../tt-asar');
const { install, ADDITION_FILES } = require('../install');
const { restore } = require('../restore');
const { verifyHostUtilsStructure } = require('../modular-patcher');

async function buildMockHostAsar(baseDir, withContextViewer = true) {
  const srcDir = path.join(baseDir, 'mock-src');
  const distDir = path.join(srcDir, 'dist');
  const unpackedDir = path.join(distDir, 'unpacked-bin');
  fs.mkdirSync(unpackedDir, { recursive: true });

  fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.32.1' }), 'utf8');

  const meterUtilsHook = withContextViewer
    ? '// --- Antigravity Context Meter utils Injection Start ---\n    require("./meter-main").installContextMeter(win);\n// --- Antigravity Context Meter utils Injection End ---\n'
    : '';
  const utilsContent = [
    '"use strict";',
    'function setupNodeWrapper(env) {',
    '  return env;',
    '}',
    'function createWindow(url) {',
    '  const win = { loadURL: () => {} };',
    meterUtilsHook + '    void win.loadURL(url);',
    '  return win;',
    '}',
    'module.exports = { setupNodeWrapper, createWindow };'
  ].join('\n');

  const preloadContent = [
    '"use strict";',
    'const electron_1 = require("electron");',
    withContextViewer
      ? '// --- Antigravity Context Meter preload Injection Start ---\nelectron_1.contextBridge.exposeInMainWorld("contextMeterAPI", { scan: () => {} });\n// --- Antigravity Context Meter preload Injection End ---'
      : ''
  ].join('\n');

  fs.writeFileSync(path.join(distDir, 'utils.js'), utilsContent, 'utf8');
  fs.writeFileSync(path.join(distDir, 'preload.js'), preloadContent, 'utf8');
  fs.writeFileSync(path.join(distDir, 'host-untouched.txt'), 'original-host-asset-bytes', 'utf8');
  fs.writeFileSync(path.join(unpackedDir, 'helper.txt'), 'unpacked-helper-content', 'utf8');
  if (withContextViewer) {
    fs.writeFileSync(path.join(distDir, 'meter-main.js'), 'exports.installContextMeter = () => {};\n', 'utf8');
  }

  const asarPath = path.join(baseDir, 'app.asar');
  await createPackage(srcDir, asarPath, { unpackedPaths: new Set(['dist/unpacked-bin']) });
  return asarPath;
}

test('install and restore coexist cleanly with antigravity-context-viewer and preserve untouched/unpacked files', async () => {
  const prevTestMode = process.env.AG_TT_TEST_MODE;
  const prevStateDir = process.env.AG_TT_STATE_DIR;
  process.env.AG_TT_TEST_MODE = '1';

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-tt-asar-test-'));
  const stateDir = path.join(tmp, 'state');
  process.env.AG_TT_STATE_DIR = stateDir;

  try {
    const asarPath = await buildMockHostAsar(tmp, true);

    // 1. Install Thinking Translator onto ASAR that already contains Context Viewer
    const res1 = await install({ path: asarPath, stateDir, skipHotInject: true });
    assert.equal(res1.ok, true);
    assert.equal(res1.hostVersion, '2.32.1');

    const utilsAfter1 = extractFile(asarPath, 'dist/utils.js').toString('utf8');
    const preloadAfter1 = extractFile(asarPath, 'dist/preload.js').toString('utf8');
    assert.ok(utilsAfter1.includes('installThinkingTranslator'));
    assert.ok(utilsAfter1.includes('installContextMeter'));
    assert.ok(preloadAfter1.includes('"thinkingTranslatorAPI"'));
    assert.ok(preloadAfter1.includes('checkCache'));
    assert.ok(preloadAfter1.includes('"contextMeterAPI"'));
    assert.equal(verifyHostUtilsStructure(utilsAfter1), true);
    assert.equal(extractFile(asarPath, 'dist/host-untouched.txt').toString('utf8'), 'original-host-asset-bytes');
    assert.equal(extractFile(asarPath, 'dist/unpacked-bin/helper.txt').toString('utf8'), 'unpacked-helper-content');

    const pkgList = new Set(listPackage(asarPath).map(e => path.normalize(e.slice(1))));
    for (const f of ADDITION_FILES) {
      assert.ok(pkgList.has(path.normalize(`dist/${f}`)), `missing dist/${f}`);
    }
    assert.ok(pkgList.has(path.normalize('dist/meter-main.js')));

    // 2. Idempotent reinstall produces no duplicate blocks
    const res2 = await install({ path: asarPath, stateDir, skipHotInject: true });
    assert.equal(res2.ok, true);
    const utilsAfter2 = extractFile(asarPath, 'dist/utils.js').toString('utf8');
    assert.equal(utilsAfter2.split('Antigravity Thinking Translator utils Injection Start').length - 1, 1);

    // 3. Surgical restore removes ONLY Thinking Translator while keeping Context Viewer intact
    const restRes = await restore({ path: asarPath, stateDir, skipHotDispose: true });
    assert.equal(restRes.ok, true);
    assert.equal(restRes.mode, 'surgical');

    const utilsAfterRestore = extractFile(asarPath, 'dist/utils.js').toString('utf8');
    const preloadAfterRestore = extractFile(asarPath, 'dist/preload.js').toString('utf8');
    assert.ok(!utilsAfterRestore.includes('installThinkingTranslator'));
    assert.ok(utilsAfterRestore.includes('installContextMeter'));
    assert.ok(!preloadAfterRestore.includes('"thinkingTranslatorAPI"'));
    assert.ok(preloadAfterRestore.includes('"contextMeterAPI"'));
    assert.equal(verifyHostUtilsStructure(utilsAfterRestore), true);

    const pkgAfterRestore = new Set(listPackage(asarPath).map(e => path.normalize(e.slice(1))));
    for (const f of ADDITION_FILES) {
      assert.ok(!pkgAfterRestore.has(path.normalize(`dist/${f}`)), `dist/${f} should be removed`);
    }
    assert.ok(pkgAfterRestore.has(path.normalize('dist/meter-main.js')));
  } finally {
    if (prevTestMode !== undefined) process.env.AG_TT_TEST_MODE = prevTestMode;
    else delete process.env.AG_TT_TEST_MODE;
    if (prevStateDir !== undefined) process.env.AG_TT_STATE_DIR = prevStateDir;
    else delete process.env.AG_TT_STATE_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
