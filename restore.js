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
  hasThinkingTranslatorUtilsTrace,
  hasThinkingTranslatorPreloadTrace,
  cleanUtilsSource,
  cleanPreloadSource,
  verifyHostUtilsStructure,
  validateSyntax
} = require('./modular-patcher');
const { ADDITION_FILES } = require('./install');
const { disposeFromLiveWindows, stopLiveBridge } = require('./tt-live-client');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function restore(options = {}) {
  const customPathIdx = process.argv.indexOf('--path');
  const customPath = options.path || (customPathIdx >= 0 ? process.argv[customPathIdx + 1] : null);
  const installed = findAsarPath(customPath);
  const stateDir = options.stateDir || getStateDir();
  const manifestPath = path.join(stateDir, 'installation.json');

  const fileLock = acquireFileLock(installed);
  try {
    const currentUtilsRaw = extractFile(installed, 'dist/utils.js').toString('utf8');
    const currentPreloadRaw = extractFile(installed, 'dist/preload.js').toString('utf8');
    const entries = listPackage(installed);
    const additionSet = new Set(ADDITION_FILES.map(f => path.normalize(`dist/${f}`)));
    const hasAdditionFiles = entries.some(e => additionSet.has(path.normalize(e.slice(1))));

    const hasTrace = hasThinkingTranslatorUtilsTrace(currentUtilsRaw) ||
      hasThinkingTranslatorPreloadTrace(currentPreloadRaw) ||
      hasAdditionFiles;

    if (!hasTrace) {
      if (!options.skipHotDispose) {
        await disposeFromLiveWindows().catch(() => {});
        stopLiveBridge({ stateDir });
      }
      return { ok: true, mode: 'noop', asarPath: installed, message: '当前 app.asar 未包含 Thinking Translator 注入痕迹' };
    }

    const cleanedUtils = cleanUtilsSource(currentUtilsRaw);
    const cleanedPreload = cleanPreloadSource(currentPreloadRaw);
    const surgicalOk = verifyHostUtilsStructure(cleanedUtils) && validateSyntax(cleanedPreload, 'dist/preload.js');

    let restoredMode = 'surgical';
    if (surgicalOk) {
      const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
      const staging = path.join(os.tmpdir(), `ag-tt-restore-${stamp}`);
      const packed = path.join(os.tmpdir(), `ag-tt-restore-${stamp}.asar`);

      try {
        fs.mkdirSync(staging, { recursive: true });
        extractAll(installed, staging);

        fs.writeFileSync(path.join(staging, 'dist', 'utils.js'), cleanedUtils, 'utf8');
        fs.writeFileSync(path.join(staging, 'dist', 'preload.js'), cleanedPreload, 'utf8');

        for (const rel of additionSet) {
          const fp = path.join(staging, rel);
          try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
        }

        const unpackedPaths = listUnpackedRelPaths(installed);
        await createPackage(staging, packed, { unpackedPaths });

        const allowedModified = new Set([path.normalize('dist/utils.js'), path.normalize('dist/preload.js')]);
        for (const entry of entries) {
          const rel = path.normalize(entry.slice(1));
          if (additionSet.has(rel)) continue;
          const before = statFile(installed, rel);
          if (before.files || before.link) continue;
          if (!allowedModified.has(rel)) {
            if (sha256(extractFile(installed, rel)) !== sha256(extractFile(packed, rel))) {
              throw new Error(`Restore integrity check failed on ${rel}`);
            }
          }
        }

        const tmpTarget = path.join(path.dirname(installed), `app.asar.tt_restore_${stamp}`);
        try {
          fs.copyFileSync(packed, tmpTarget);
          fs.copyFileSync(tmpTarget, installed);
        } finally {
          try { if (fs.existsSync(tmpTarget)) fs.unlinkSync(tmpTarget); } catch {}
        }
      } finally {
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
        try { if (fs.existsSync(packed)) fs.unlinkSync(packed); } catch {}
        try { if (fs.existsSync(packed + '.unpacked')) fs.rmSync(packed + '.unpacked', { recursive: true, force: true }); } catch {}
      }
    } else {
      // Fallback to recorded pre-install snapshot if surgical clean failed
      if (!fs.existsSync(manifestPath)) {
        throw new Error('外科手术式卸载校验未通过，且未找到 installation.json 备份记录。');
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!manifest.snapshotBackup || !fs.existsSync(manifest.snapshotBackup)) {
        throw new Error('备份快照文件缺失，无法还原。');
      }
      if (manifest.preInstallSha256 && sha256(fs.readFileSync(manifest.snapshotBackup)) !== manifest.preInstallSha256) {
        throw new Error('备份快照 SHA-256 校验不匹配，拒绝还原。');
      }
      fs.copyFileSync(manifest.snapshotBackup, installed);
      restoredMode = 'snapshot';
    }

    try { if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath); } catch {}

    if (!options.skipHotDispose) {
      await disposeFromLiveWindows().catch(() => {});
      stopLiveBridge({ stateDir });
    }

    return { ok: true, mode: restoredMode, asarPath: installed };
  } finally {
    fileLock.release();
  }
}

if (require.main === module) {
  restore()
    .then(res => {
      if (res.mode === 'noop') {
        console.log(`⚪ ${res.message}: ${res.asarPath}`);
      } else {
        console.log(`✅ 已卸载 Thinking Translator (${res.mode === 'surgical' ? '原位无损卸载，保留其他插件' : '快照还原'}): ${res.asarPath}`);
      }
    })
    .catch(err => {
      console.error('❌ 卸载失败:', err?.message || err);
      process.exit(1);
    });
}

module.exports = { restore };
