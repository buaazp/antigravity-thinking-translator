#!/usr/bin/env node
'use strict';

let fs;
try {
  fs = require('original-fs');
} catch {
  fs = require('fs');
}
const path = require('path');

const { extractFile, listPackage, getStateDir, getDevToolsPort, findAsarPath } = require('./tt-asar');
const { hasThinkingTranslatorUtilsTrace, hasThinkingTranslatorPreloadTrace } = require('./modular-patcher');
const { resolveAgyExecutable, getSettings } = require('./tt-backend');
const { PLUGIN_VERSION } = require('./tt-core');
const { install, ADDITION_FILES } = require('./install');
const { restore } = require('./restore');
const { queryLiveWindow, injectIntoLiveWindows } = require('./tt-live-client');

function parseArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

function checkAsarPatched(asarPath) {
  try {
    const utils = extractFile(asarPath, 'dist/utils.js').toString('utf8');
    const preload = extractFile(asarPath, 'dist/preload.js').toString('utf8');
    const entries = new Set(listPackage(asarPath).map(e => path.normalize(e.slice(1))));
    const hasAllFiles = ADDITION_FILES.every(f => entries.has(path.normalize(`dist/${f}`)));
    return hasThinkingTranslatorUtilsTrace(utils) && hasThinkingTranslatorPreloadTrace(preload) && hasAllFiles;
  } catch {
    return false;
  }
}

function checkContextViewerCoexistence(asarPath) {
  try {
    const utils = extractFile(asarPath, 'dist/utils.js').toString('utf8');
    return utils.includes('installContextMeter');
  } catch {
    return false;
  }
}

async function cmdCheck(customPath) {
  console.log(`🔍 [Antigravity Thinking Translator v${PLUGIN_VERSION}] 正在执行环境预检...`);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  console.log(`  - Node.js 运行时: ${process.version} (${process.execPath})`);
  if (nodeMajor < 20) {
    throw new Error(`需要 Node.js 20+（推荐 22.4+），当前版本为 ${process.version}`);
  }

  const asarPath = findAsarPath(customPath);
  const pkg = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
  console.log(`  - Antigravity 路径: ${asarPath} (v${pkg.version || 'unknown'})`);

  const agy = resolveAgyExecutable();
  if (!agy.ok) {
    throw new Error(agy.error);
  }
  console.log(`  - Antigravity CLI (agy): ${agy.agyPath}`);

  const cdpPort = getDevToolsPort();
  console.log(`  - 运行中窗口 CDP 状态: ${cdpPort ? `已连接 (端口 ${cdpPort})` : '未检测到运行窗口（仅影响热挂载，不影响磁盘安装）'}`);
  console.log(`  - 状态目录: ${getStateDir()}`);
  console.log('✅ 环境预检通过！');
}

async function cmdStatus(customPath) {
  let asarPath = null;
  let antigravityVersion = null;
  let asarPatched = false;
  let contextViewerCoexists = false;

  try {
    asarPath = findAsarPath(customPath);
    const pkg = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
    antigravityVersion = pkg.version || null;
    asarPatched = checkAsarPatched(asarPath);
    contextViewerCoexists = checkContextViewerCoexistence(asarPath);
  } catch {}

  const agy = resolveAgyExecutable();
  const settingsRes = getSettings();
  const liveWindow = await queryLiveWindow();

  const report = {
    pluginVersion: PLUGIN_VERSION,
    asarPath,
    antigravityVersion,
    asarPatched,
    contextViewerCoexists,
    agyExecutable: agy.ok ? agy.agyPath : null,
    settings: settingsRes.settings,
    liveWindow
  };
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const cmd = process.argv[2] || 'help';
  const customPath = parseArgValue('--path');

  if (cmd === 'check') {
    await cmdCheck(customPath);
    return;
  }

  if (cmd === 'install') {
    const res = await install({ path: customPath });
    console.log(`✅ [Antigravity Thinking Translator v${res.pluginVersion}] 安装完成 (Antigravity v${res.hostVersion})`);
    console.log(`   - ASAR 持久化注入: ${res.asarPath} (校验 ${res.verifiedOriginalFiles} 个原有文件)`);
    console.log(`   - 运行中窗口热挂载: ${res.hotInjected ? '✅ 已即时挂载生效（无需重启）' : '⚪ 未注入运行窗口'}${res.hotError ? ` (${res.hotError})` : ''}`);
    return;
  }

  if (cmd === 'live') {
    const res = await injectIntoLiveWindows();
    if (!res.injected) {
      throw new Error(`未找到可挂载的运行中 Antigravity 窗口 (${res.reason || 'unknown'})`);
    }
    console.log(`✅ 已通过 CDP 热注入运行中的 Antigravity 窗口 (${res.count} 个页面)`);
    return;
  }

  if (cmd === 'status') {
    await cmdStatus(customPath);
    return;
  }

  if (cmd === 'restore') {
    const res = await restore({ path: customPath });
    if (res.mode === 'noop') {
      console.log(`⚪ ${res.message}: ${res.asarPath}`);
    } else {
      console.log(`✅ 已卸载 Thinking Translator (${res.mode === 'surgical' ? '原位无损卸载，保留其他插件' : '快照还原'}): ${res.asarPath}`);
    }
    return;
  }

  console.log([
    `Antigravity Thinking Translator v${PLUGIN_VERSION}`,
    '',
    '用法:',
    '  node cli.js check [--path "<app.asar>"]    环境健康预检',
    '  node cli.js install [--path "<app.asar>"]  ASAR 持久化安装 + 运行窗口热挂载',
    '  node cli.js live                           仅免改盘 CDP 热挂载运行中窗口',
    '  node cli.js status [--path "<app.asar>"]   查看安装状态与运行窗口状态',
    '  node cli.js restore [--path "<app.asar>"]  无损卸载并还原（保留其他插件）'
  ].join('\n'));
}

if (require.main === module) {
  main().catch(err => {
    console.error('❌ 执行失败:', err?.message || err);
    process.exit(1);
  });
}
