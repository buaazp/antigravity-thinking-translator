'use strict';

let fs;
try {
  fs = require('original-fs');
} catch {
  fs = require('fs');
}
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  extractFile,
  statFile,
  listPackage,
  listUnpackedRelPaths,
  extractAll,
  createPackage,
  getStateDir,
  findAsarPath,
  acquireFileLock
} = require('./tt-asar');
const {
  patchUtilsSource,
  patchPreloadSource
} = require('./modular-patcher');
const { PLUGIN_VERSION } = require('./tt-core');
const { injectIntoLiveWindows } = require('./tt-live-client');

const ADDITION_FILES = [
  'tt-asar.js',
  'tt-core.js',
  'tt-backend.js',
  'tt-main.js',
  'tt-renderer.js'
];

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function install(options = {}) {
  const customPathIdx = process.argv.indexOf('--path');
  const customPath = options.path || (customPathIdx >= 0 ? process.argv[customPathIdx + 1] : null);
  const installed = findAsarPath(customPath);
  const stateDir = options.stateDir || getStateDir();

  for (const file of ADDITION_FILES) {
    const src = path.join(__dirname, file);
    if (!fs.existsSync(src)) {
      throw new Error(`缺少必需文件 ${file}，请先执行 npm run build:renderer`);
    }
  }

  const fileLock = acquireFileLock(installed);
  try {
    const hostPkg = JSON.parse(extractFile(installed, 'package.json').toString('utf8'));
    const hostVersion = hostPkg.version || 'unknown';
    const currentUtilsRaw = extractFile(installed, 'dist/utils.js').toString('utf8');
    const currentPreloadRaw = extractFile(installed, 'dist/preload.js').toString('utf8');

    const patchedUtils = patchUtilsSource(currentUtilsRaw);
    const patchedPreload = patchPreloadSource(currentPreloadRaw);

    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
    const snapshotDir = path.join(stateDir, 'backups', 'snapshots');
    fs.mkdirSync(snapshotDir, { recursive: true });
    const preSha = sha256(fs.readFileSync(installed));
    const snapshotFile = path.join(snapshotDir, `app-${hostVersion}-preinstall-${stamp}-${preSha.slice(0, 8)}.asar`);
    fs.copyFileSync(installed, snapshotFile);

    const staging = path.join(os.tmpdir(), `ag-tt-pkg-${stamp}`);
    const packed = path.join(os.tmpdir(), `ag-tt-${stamp}.asar`);

    try {
      fs.mkdirSync(staging, { recursive: true });
      extractAll(installed, staging);

      fs.writeFileSync(path.join(staging, 'dist', 'utils.js'), patchedUtils, 'utf8');
      fs.writeFileSync(path.join(staging, 'dist', 'preload.js'), patchedPreload, 'utf8');

      for (const file of ADDITION_FILES) {
        fs.copyFileSync(path.join(__dirname, file), path.join(staging, 'dist', file));
      }

      const unpackedPaths = listUnpackedRelPaths(installed);
      await createPackage(staging, packed, { unpackedPaths });

      // Integrity check: verify every untouched file in the original ASAR has identical SHA-256
      const origEntries = listPackage(installed);
      const allowedSet = new Set([
        path.normalize('dist/utils.js'),
        path.normalize('dist/preload.js'),
        ...ADDITION_FILES.map(f => path.normalize(`dist/${f}`))
      ]);

      let verifiedCount = 0;
      for (const entry of origEntries) {
        const rel = path.normalize(entry.slice(1));
        const before = statFile(installed, rel);
        if (before.files || before.link) continue;
        const after = statFile(packed, rel);
        if (Boolean(before.unpacked) !== Boolean(after.unpacked)) {
          throw new Error(`Unpack flag mismatch for ${rel}`);
        }
        if (!allowedSet.has(rel)) {
          const bSha = sha256(extractFile(installed, rel));
          const aSha = sha256(extractFile(packed, rel));
          if (bSha !== aSha) {
            throw new Error(`Unexpected file change in ASAR: ${rel}`);
          }
        }
        verifiedCount++;
      }

      const packedSha = sha256(fs.readFileSync(packed));
      const tmpTarget = path.join(path.dirname(installed), `app.asar.tt_tmp_${stamp}`);
      try {
        fs.copyFileSync(packed, tmpTarget);
        if (sha256(fs.readFileSync(tmpTarget)) !== packedSha) {
          throw new Error('临时 ASAR 文件校验不一致，已中止写入');
        }
        try {
          fs.copyFileSync(tmpTarget, installed);
        } catch (err) {
          if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
            throw new Error(`无法写入目标文件 (${installed}): ${err.message}。如果文件被占用或权限不足，请先关闭 Antigravity 客户端或检查权限后重试。`);
          }
          throw err;
        }
      } finally {
        try { if (fs.existsSync(tmpTarget)) fs.unlinkSync(tmpTarget); } catch {}
      }

      const manifest = {
        pluginVersion: PLUGIN_VERSION,
        hostVersion,
        installed,
        snapshotBackup: snapshotFile,
        preInstallSha256: preSha,
        patchedSha256: packedSha,
        verifiedOriginalFiles: verifiedCount,
        added: ADDITION_FILES.map(f => `dist/${f}`),
        modified: ['dist/utils.js', 'dist/preload.js'],
        installedAt: new Date().toISOString()
      };
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'installation.json'), JSON.stringify(manifest, null, 2), 'utf8');

      let hotResult = { injected: false };
      if (!options.skipHotInject) {
        try {
          hotResult = await injectIntoLiveWindows({ stateDir });
        } catch (err) {
          hotResult = { injected: false, error: err?.message || String(err) };
        }
      }

      return {
        ok: true,
        pluginVersion: PLUGIN_VERSION,
        hostVersion,
        asarPath: installed,
        verifiedOriginalFiles: verifiedCount,
        hotInjected: Boolean(hotResult.injected),
        hotError: hotResult.error || null
      };
    } finally {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
      try { if (fs.existsSync(packed)) fs.unlinkSync(packed); } catch {}
      try { if (fs.existsSync(packed + '.unpacked')) fs.rmSync(packed + '.unpacked', { recursive: true, force: true }); } catch {}
    }
  } finally {
    fileLock.release();
  }
}

if (require.main === module) {
  install()
    .then(res => {
      console.log(`✅ [Antigravity Thinking Translator v${res.pluginVersion}] 安装完成 (宿主 v${res.hostVersion})`);
      console.log(`   - ASAR 持久化注入: ${res.asarPath} (校验 ${res.verifiedOriginalFiles} 个原有文件)`);
      console.log(`   - 运行中窗口热挂载: ${res.hotInjected ? '✅ 已即时挂载生效（无需重启）' : '⚪ 未检测到运行窗口或仅磁盘生效'}${res.hotError ? ` (${res.hotError})` : ''}`);
    })
    .catch(err => {
      console.error('❌ 安装失败:', err?.message || err);
      process.exit(1);
    });
}

module.exports = {
  ADDITION_FILES,
  install
};
