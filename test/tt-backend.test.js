'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getSettings,
  saveSettings,
  listAvailableModels,
  splitLongText,
  AgyTranslationService
} = require('../tt-backend');

function createMockAgyScript(dir) {
  const counterFile = path.join(dir, 'invocations.txt');
  const scriptPath = path.join(dir, 'mock-agy.js');
  const wrapperPath = path.join(dir, process.platform === 'win32' ? 'mock-agy.cmd' : 'mock-agy');

  const scriptBody = `
const fs = require('fs');
const readline = require('readline');
const args = process.argv.slice(2);
const counterFile = ${JSON.stringify(counterFile)};

if (args[0] === 'models') {
  process.stdout.write('gemini-4-hydrogen-medium       Gemini 4 Hydrogen (Medium)\\n');
  process.stdout.write('gemini-4-carbon-medium         Gemini 4 Carbon (Medium)\\n');
  process.exit(0);
}

// Pitfall check: never pass --effort with gemini-4-hydrogen-medium
if (args.includes('--effort')) {
  process.stderr.write('error: --effort conflicts with model slug\\n');
  process.exit(2);
}

fs.appendFileSync(counterFile, JSON.stringify(args) + '\\n');

const pFlag = args.find(a => a.startsWith('-p='));
if (pFlag !== undefined) {
  process.stdout.write(JSON.stringify({
    status: 'SUCCESS',
    response: '一次性译文: ' + pFlag.slice(3, 25)
  }));
  process.exit(0);
}

if (args.includes('--input-format') && args.includes('stream-json')) {
  process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'mock-conv' }) + '\\n');
  const rl = readline.createInterface({ input: process.stdin });
  let failOnce = args.includes('force-stream-fail');
  rl.on('line', line => {
    const obj = JSON.parse(line);
    const content = obj?.message?.content || '';
    const match = content.match(/<SOURCE_THINKING_TEXT>\\n([\\s\\S]*?)\\n<\\/SOURCE_THINKING_TEXT>/);
    const src = match ? match[1] : content;
    if (src.includes('FORCE_STREAM_ERROR')) {
      process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'stream failed' } }) + '\\n');
      return;
    }
    const tr = '中文译文: ' + src;
    const emit = () => {
      const mid = Math.ceil(tr.length / 2);
      process.stdout.write(JSON.stringify({
        event: 'step_update',
        step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: tr.slice(0, mid) }
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        event: 'step_update',
        step_update: { step_type: 'agent_response', state: 'DONE', text_delta: tr.slice(mid) }
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: tr }
      }) + '\\n');
    };
    if (src.includes('PARALLEL_')) {
      setTimeout(emit, 70);
    } else {
      emit();
    }
  });
  process.on('SIGTERM', () => {
    // Reproduce real agy trailing ERROR result on shutdown
    try {
      process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'killed' } }) + '\\n');
    } catch {}
    process.exit(0);
  });
}
`;
  fs.writeFileSync(scriptPath, scriptBody, 'utf8');
  if (process.platform === 'win32') {
    fs.writeFileSync(wrapperPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    fs.writeFileSync(wrapperPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8');
    fs.chmodSync(wrapperPath, 0o755);
  }
  return { wrapperPath, counterFile };
}

test('settings persistence, model discovery, warm stream-json translation, caching, chunking, and shutdown safety', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-tt-backend-test-'));
  const stateDir = path.join(tmp, 'state');
  const { wrapperPath, counterFile } = createMockAgyScript(tmp);

  const service = new AgyTranslationService({
    stateDir,
    agyPath: wrapperPath,
    sandbox: true
  });

  try {
    // 1. Settings roundtrip
    const initial = getSettings({ stateDir });
    assert.equal(initial.settings.model, 'gemini-4-hydrogen-medium');
    assert.equal(initial.settings.displayMode, 'bilingual');

    const updated = saveSettings({ displayMode: 'translation_only', targetLang: '日本語' }, { stateDir });
    assert.equal(updated.settings.displayMode, 'translation_only');
    assert.equal(getSettings({ stateDir }).settings.targetLang, '日本語');
    saveSettings({ displayMode: 'bilingual', targetLang: '简体中文' }, { stateDir });

    // 2. Dynamic model discovery via mock agy
    const modelsRes = await listAvailableModels({ stateDir, agyPath: wrapperPath, force: true });
    assert.equal(modelsRes.ok, true);
    assert.equal(modelsRes.source, 'agy');
    assert.equal(modelsRes.models[0].id, 'gemini-4-hydrogen-medium');

    // 3. Streaming translation + progress updates
    const deltas = [];
    const res1 = await service.translate({
      text: 'Check `local-api.js` on macOS.',
      onProgress: p => deltas.push(p.text)
    });
    assert.equal(res1.ok, true);
    assert.equal(res1.cached, false);
    assert.equal(res1.translation, '中文译文: Check `local-api.js` on macOS.');
    assert.ok(deltas.length >= 2);

    // 4. Cache hit avoids invoking mock agy again
    const countAfter1 = fs.readFileSync(counterFile, 'utf8').trim().split('\n').length;
    const res2 = await service.translate({ text: 'Check `local-api.js` on macOS.' });
    assert.equal(res2.ok, true);
    assert.equal(res2.cached, true);
    assert.equal(res2.translation, res1.translation);
    const countAfter2 = fs.readFileSync(counterFile, 'utf8').trim().split('\n').length;
    assert.equal(countAfter1, countAfter2);

    // 5. Second turn reuses warm worker (only 1 process spawned so far!)
    const res3 = await service.translate({ text: 'Second reasoning step.' });
    assert.equal(res3.ok, true);
    assert.equal(res3.translation, '中文译文: Second reasoning step.');
    assert.equal(fs.readFileSync(counterFile, 'utf8').trim().split('\n').length, 1);

    // 6. Long text splitting & one-shot fallback when stream-json errors
    const longPara1 = 'A'.repeat(3000);
    const longPara2 = 'B'.repeat(3000);
    const chunks = splitLongText(`${longPara1}\n\n${longPara2}`);
    assert.equal(chunks.length, 2);

    const fallbackRes = await service.translate({ text: 'FORCE_STREAM_ERROR trigger fallback' });
    assert.equal(fallbackRes.ok, true);
    assert.ok(fallbackRes.translation.startsWith('一次性译文:'));

    // 7. Canonical cache hit matches raw Markdown translated earlier with DOM plain text
    const mdRes = await service.translate({ text: 'Inspect **bold** `src/app.js` file.' });
    assert.equal(mdRes.ok, true);
    assert.equal(mdRes.cached, false);
    const checkRes = service.checkCache({
      items: [
        { id: 'p1', text: 'Inspect bold src/app.js file.' },
        { id: 'p2', text: 'Never seen before paragraph.' }
      ]
    });
    assert.equal(checkRes.ok, true);
    assert.equal(checkRes.hits.p1, mdRes.translation);
    assert.equal(checkRes.hits.p2, undefined);

    // 8. Concurrent paragraph pool dispatches parallel workers when multiple requests arrive together
    const [p1, p2, p3] = await Promise.all([
      service.translate({ text: 'PARALLEL_1 paragraph alpha.' }),
      service.translate({ text: 'PARALLEL_2 paragraph beta.' }),
      service.translate({ text: 'PARALLEL_3 paragraph gamma.' })
    ]);
    assert.equal(p1.ok, true);
    assert.equal(p2.ok, true);
    assert.equal(p3.ok, true);
    const workerInvocations = fs.readFileSync(counterFile, 'utf8').trim().split('\n').filter(Boolean).length;
    assert.ok(workerInvocations >= 3 && workerInvocations <= 5, `expected pooled workers, got ${workerInvocations}`);

    // Subsequent sequential call reuses an idle warm worker without spawning another process
    const seqRes = await service.translate({ text: 'Fourth sequential step reusing warm pool.' });
    assert.equal(seqRes.ok, true);
    const workerInvocationsAfterSeq = fs.readFileSync(counterFile, 'utf8').trim().split('\n').filter(Boolean).length;
    assert.equal(workerInvocationsAfterSeq, workerInvocations);
  } finally {
    service.dispose();
    await new Promise(r => setTimeout(r, 80));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
