'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PLUGIN_VERSION } = require('../tt-core');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer');
const OUT_FILE = path.join(ROOT, 'tt-renderer.js');

function buildRenderer() {
  const styles = fs.readFileSync(path.join(SRC_DIR, 'styles.css'), 'utf8');
  const template = fs.readFileSync(path.join(SRC_DIR, 'template.html'), 'utf8');
  const main = fs.readFileSync(path.join(SRC_DIR, 'main.js'), 'utf8');

  const marker = '/* @INSERT_STYLES_AND_TEMPLATE */';
  if (!main.includes(marker)) {
    throw new Error(`Missing placeholder ${marker} in src/renderer/main.js`);
  }

  const injected = [
    `const TT_STYLES = ${JSON.stringify(styles)};`,
    `const TT_TEMPLATE = ${JSON.stringify(template)};`
  ].join('\n  ');

  const bundle = main.replace(marker, injected);
  new vm.Script(bundle, { filename: 'tt-renderer.js' });
  fs.writeFileSync(OUT_FILE, bundle, 'utf8');

  const size = Buffer.byteLength(bundle, 'utf8');
  console.log(`[build:renderer] tt-renderer.js built successfully (v${PLUGIN_VERSION}, ${size} bytes)`);
  return { outFile: OUT_FILE, size };
}

if (require.main === module) {
  buildRenderer();
}

module.exports = { buildRenderer };
