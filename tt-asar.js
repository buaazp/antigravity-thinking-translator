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

const BLOCK_SIZE = 4 * 1024 * 1024;

function readHeader(archivePath) {
  const fd = fs.openSync(archivePath, 'r');
  try {
    const pre = Buffer.alloc(16);
    fs.readSync(fd, pre, 0, 16, 0);
    const jsonSize = pre.readUInt32LE(12);
    const padding = (4 - (jsonSize % 4)) % 4;
    const jsonBuf = Buffer.alloc(jsonSize);
    fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    return { header, baseOffset: 16 + jsonSize + padding };
  } finally {
    fs.closeSync(fd);
  }
}

function getNode(header, relPath) {
  const parts = String(relPath).replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean);
  let cur = header;
  for (const part of parts) {
    if (!cur || !cur.files || !Object.prototype.hasOwnProperty.call(cur.files, part)) {
      throw new Error(`File not found in ASAR: ${relPath}`);
    }
    cur = cur.files[part];
  }
  return cur;
}

function extractFile(archivePath, relPath) {
  const { header, baseOffset } = readHeader(archivePath);
  const node = getNode(header, relPath);
  if (node.unpacked) {
    return fs.readFileSync(path.join(archivePath + '.unpacked', relPath));
  }
  const buf = Buffer.alloc(node.size);
  const fd = fs.openSync(archivePath, 'r');
  try {
    fs.readSync(fd, buf, 0, node.size, baseOffset + Number(node.offset));
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function statFile(archivePath, relPath) {
  const { header } = readHeader(archivePath);
  return getNode(header, relPath);
}

function listPackage(archivePath) {
  const { header } = readHeader(archivePath);
  const list = [];
  function walk(tree, prefix) {
    for (const [name, info] of Object.entries(tree.files || {})) {
      const cur = `${prefix}/${name}`;
      list.push(cur);
      if (info.files) walk(info, cur);
    }
  }
  walk(header, '');
  return list;
}

function listUnpackedRelPaths(archivePath) {
  const { header } = readHeader(archivePath);
  const set = new Set();
  function walk(tree, relPosix) {
    for (const [name, info] of Object.entries(tree.files || {})) {
      const childPosix = relPosix ? `${relPosix}/${name}` : name;
      if (info.unpacked) set.add(childPosix);
      if (info.files) walk(info, childPosix);
    }
  }
  walk(header, '');
  return set;
}

function extractAll(archivePath, destDir) {
  const { header, baseOffset } = readHeader(archivePath);
  const fd = fs.openSync(archivePath, 'r');
  try {
    function walk(tree, currentDir, relDir) {
      fs.mkdirSync(currentDir, { recursive: true });
      for (const [name, info] of Object.entries(tree.files || {})) {
        const targetPath = path.join(currentDir, name);
        const relPath = relDir ? path.join(relDir, name) : name;
        if (info.files) {
          walk(info, targetPath, relPath);
        } else if (info.link) {
          try {
            fs.symlinkSync(info.link, targetPath);
          } catch {}
        } else if (info.unpacked) {
          const unpackedSrc = path.join(archivePath + '.unpacked', relPath);
          if (fs.existsSync(unpackedSrc)) {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.copyFileSync(unpackedSrc, targetPath);
          }
        } else {
          const buf = Buffer.alloc(info.size);
          fs.readSync(fd, buf, 0, info.size, baseOffset + Number(info.offset));
          fs.writeFileSync(targetPath, buf);
        }
      }
    }
    walk(header, destDir, '');
  } finally {
    fs.closeSync(fd);
  }
}

function computeIntegrity(buf) {
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const blocks = [];
  for (let i = 0; i < buf.length; i += BLOCK_SIZE) {
    blocks.push(crypto.createHash('sha256').update(buf.subarray(i, i + BLOCK_SIZE)).digest('hex'));
  }
  if (blocks.length === 0) {
    blocks.push(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  }
  return { algorithm: 'SHA256', hash, blockSize: BLOCK_SIZE, blocks };
}

async function createPackage(srcDir, destAsar, options = {}) {
  const unpackedPaths = options.unpackedPaths instanceof Set ? options.unpackedPaths : new Set();
  const isUnpackedPath = relPosix => {
    if (unpackedPaths.has(relPosix)) return true;
    for (const prefix of unpackedPaths) {
      if (relPosix.startsWith(prefix + '/')) return true;
    }
    return false;
  };

  let offset = 0;
  const chunks = [];

  function build(currentDir, relPosix) {
    const files = {};
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const childPosix = relPosix ? `${relPosix}/${entry.name}` : entry.name;
      const isUnpacked = isUnpackedPath(childPosix);
      if (entry.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(fullPath);
        files[entry.name] = { link: linkTarget };
      } else if (entry.isDirectory()) {
        const node = { files: build(fullPath, childPosix) };
        if (isUnpacked) node.unpacked = true;
        files[entry.name] = node;
      } else if (entry.isFile()) {
        const buf = fs.readFileSync(fullPath);
        const integrity = computeIntegrity(buf);
        if (isUnpacked) {
          const unpackedTarget = path.join(destAsar + '.unpacked', childPosix);
          fs.mkdirSync(path.dirname(unpackedTarget), { recursive: true });
          fs.copyFileSync(fullPath, unpackedTarget);
          files[entry.name] = { size: buf.length, unpacked: true, integrity };
        } else {
          files[entry.name] = { size: buf.length, offset: String(offset), integrity };
          offset += buf.length;
          chunks.push(buf);
        }
      }
    }
    return files;
  }

  const headerObj = { files: build(srcDir, '') };
  const jsonBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const jsonSize = jsonBuf.length;
  const padding = (4 - (jsonSize % 4)) % 4;
  const alignedSize = jsonSize + padding;
  const headerBuf = Buffer.alloc(16 + alignedSize);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(8 + alignedSize, 4);
  headerBuf.writeUInt32LE(4 + alignedSize, 8);
  headerBuf.writeUInt32LE(jsonSize, 12);
  jsonBuf.copy(headerBuf, 16);

  const fd = fs.openSync(destAsar, 'w');
  try {
    fs.writeSync(fd, headerBuf);
    for (const chunk of chunks) {
      fs.writeSync(fd, chunk);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function getStateDir() {
  if (process.env.AG_TT_STATE_DIR && String(process.env.AG_TT_STATE_DIR).trim()) {
    const dir = path.resolve(String(process.env.AG_TT_STATE_DIR).trim());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const home = process.env.USERPROFILE || os.homedir();
  let base;
  if (process.platform === 'win32') {
    base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  } else if (process.platform === 'darwin') {
    base = path.join(home, 'Library', 'Application Support');
  } else {
    base = process.env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  }
  const dir = path.join(base, 'AntigravityThinkingTranslator');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getAntigravityUserDataDir() {
  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'Antigravity');
  }
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Antigravity');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Antigravity');
}

function getDevToolsPort() {
  try {
    const portFile = path.join(getAntigravityUserDataDir(), 'DevToolsActivePort');
    if (!fs.existsSync(portFile)) return null;
    const raw = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
    const port = Number(raw);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function findAsarPath(customPath) {
  if (customPath) {
    const resolved = path.resolve(String(customPath).trim());
    if (!fs.existsSync(resolved)) {
      throw new Error(`指定的 app.asar 路径不存在: ${resolved}`);
    }
    return resolved;
  }

  const home = process.env.USERPROFILE || os.homedir();
  const candidates = [];

  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents/Resources/app.asar',
      path.join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar')
    );
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.join(localAppData, 'Programs', 'antigravity', 'resources', 'app.asar'),
      path.join(localAppData, 'Programs', 'Antigravity', 'resources', 'app.asar'),
      path.join(progFiles, 'Antigravity', 'resources', 'app.asar')
    );
  } else {
    candidates.push(
      '/usr/share/antigravity/resources/app.asar',
      '/opt/Antigravity/resources/app.asar',
      '/opt/antigravity/resources/app.asar',
      path.join(home, '.local', 'share', 'antigravity', 'resources', 'app.asar')
    );
  }

  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {}
  }

  throw new Error(
    `未自动探测到 Antigravity 的 app.asar，请使用 --path "<path-to-app.asar>" 指定。已检查路径:\n${candidates.join('\n')}`
  );
}

function acquireFileLock(targetPath, timeoutMs = 15000) {
  const lockDir = path.join(getStateDir(), 'locks');
  fs.mkdirSync(lockDir, { recursive: true });
  const key = crypto.createHash('sha256').update(path.resolve(targetPath)).digest('hex').slice(0, 12);
  const lockFile = path.join(lockDir, `${key}.lock`);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), target: targetPath }));
      fs.closeSync(fd);
      return {
        release() {
          try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch {}
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        let alive = false;
        if (info?.pid) {
          try { process.kill(info.pid, 0); alive = true; } catch {}
        }
        if (!alive || Date.now() - (info?.at || 0) > 120000) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {
        try { fs.unlinkSync(lockFile); continue; } catch {}
      }
      if (Date.now() > deadline) {
        throw new Error(`等待文件锁超时 (${lockFile})，请确认无其他安装进程正在运行。`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

module.exports = {
  readHeader,
  extractFile,
  statFile,
  listPackage,
  listUnpackedRelPaths,
  extractAll,
  createPackage,
  getStateDir,
  getAntigravityUserDataDir,
  getDevToolsPort,
  findAsarPath,
  acquireFileLock
};
