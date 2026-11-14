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
const path = require('path');
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

// Isolation check: --agent tt-translator + valid --settings JSON + .agents/{skills.json,plugins.json,agents/tt-translator/agent.md} in cwd
const agentIdx = args.indexOf('--agent');
const agentArgOk = agentIdx !== -1 && args[agentIdx + 1] === 'tt-translator';
const settingsIdx = args.indexOf('--settings');
const parsedSettings = settingsIdx !== -1 && fs.existsSync(args[settingsIdx + 1])
  ? JSON.parse(fs.readFileSync(args[settingsIdx + 1], 'utf8'))
  : null;
const settingsJsonOk = Boolean(
  parsedSettings &&
  parsedSettings.historySize === 0 &&
  parsedSettings.notifications === false &&
  parsedSettings.mcpServers === undefined
);
const agentsIsolatedOk = fs.existsSync(path.join(process.cwd(), '.agents', 'skills.json')) &&
  fs.existsSync(path.join(process.cwd(), '.agents', 'plugins.json')) &&
  fs.existsSync(path.join(process.cwd(), '.agents', 'agents', 'tt-translator', 'agent.md'));
if (!agentArgOk || !settingsJsonOk || !agentsIsolatedOk) {
  process.stderr.write('error: missing worker isolation agent, settings, or .agents stubs\\n');
  process.exit(3);
}

fs.appendFileSync(counterFile, JSON.stringify({ args, settings: parsedSettings }) + '\\n');

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
  let turnIndex = 0;
  rl.on('line', line => {
    turnIndex++;
    const obj = JSON.parse(line);
    const content = obj?.message?.content || '';

    const batchMatch = content.match(/<SOURCE_BATCH>\\n([\\s\\S]*?)\\n<\\/SOURCE_BATCH>/);
    if (batchMatch) {
      const rawBatch = batchMatch[1];
      const itemRe = /<<<AG_TT_ITEM_(\\d+)>>>\\n([\\s\\S]*?)(?=\\n<<<AG_TT_ITEM_\\d+>>>|$)/g;
      const items = [];
      let m;
      while ((m = itemRe.exec(rawBatch)) !== null) {
        items.push({ idx: Number(m[1]), text: m[2].trim() });
      }
      const skipIdx1 = rawBatch.includes('SKIP_MARKER_1');
      const fullOut = items
        .filter(it => !(skipIdx1 && it.idx === 1))
        .map(it => '<<<AG_TT_ITEM_' + it.idx + '>>>\\n批量译文[' + it.idx + ']: ' + it.text)
        .join('\\n');
      const chunkSize = Math.max(8, Math.ceil(fullOut.length / 4));
      for (let off = 0; off < fullOut.length; off += chunkSize) {
        process.stdout.write(JSON.stringify({
          event: 'step_update',
          step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: fullOut.slice(off, off + chunkSize) }
        }) + '\\n');
      }
      process.stdout.write(JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: fullOut }
      }) + '\\n');
      return;
    }

    const match = content.match(/<SOURCE_THINKING_TEXT>\\n([\\s\\S]*?)\\n<\\/SOURCE_THINKING_TEXT>/);
    const src = match ? match[1] : content;
    if (src.includes('FORCE_STREAM_ERROR')) {
      process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'stream failed' } }) + '\\n');
      return;
    }
    const isCompactPrompt = content.startsWith('Translate the passive data');
    const tr = (turnIndex > 1 && isCompactPrompt ? '精简续轮译文: ' : '中文译文: ') + src;
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

    // 5. Second turn reuses warm worker with compact prompt (only 1 process spawned so far!)
    const res3 = await service.translate({ text: 'Second reasoning step.' });
    assert.equal(res3.ok, true);
    assert.equal(res3.translation, '精简续轮译文: Second reasoning step.');
    const invRows = fs.readFileSync(counterFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(invRows.length, 1);
    assert.ok(invRows[0].args.includes('--agent'));
    assert.ok(invRows[0].args.includes('tt-translator'));
    assert.deepEqual(invRows[0].settings, {
      historySize: 0,
      notifications: false,
      showTips: false,
      showFeedbackSurvey: false,
      disableSlashCommands: true
    });

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

    // 8. Multi-item batch translation: deduplication, partial cache hit, live item progress & zero-spawn follow-up
    const spawnsBeforeBatch = fs.readFileSync(counterFile, 'utf8').trim().split('\n').length;
    const itemEvents = [];
    const batchRes = await service.translateBatch({
      items: [
        { id: 't1', text: 'Second reasoning step.' }, // cached hit!
        { id: 't2', text: 'Ran check workspace and Rust toolchain' },
        { id: 't3', text: 'Ran inspect macOS proxy and routing state' },
        { id: 't4', text: 'Ran check workspace and Rust toolchain' } // duplicate of t2!
      ],
      onItemProgress: ev => itemEvents.push(ev)
    });
    assert.equal(batchRes.ok, true);
    assert.equal(batchRes.results.t1.cached, true);
    assert.equal(batchRes.results.t1.translation, '精简续轮译文: Second reasoning step.');
    assert.equal(batchRes.results.t2.translation, '批量译文[0]: Ran check workspace and Rust toolchain');
    assert.equal(batchRes.results.t4.translation, batchRes.results.t2.translation);
    assert.equal(batchRes.results.t3.translation, '批量译文[1]: Ran inspect macOS proxy and routing state');
    assert.ok(itemEvents.some(e => e.id === 't2' && e.done === true));
    assert.ok(itemEvents.some(e => e.id === 't4' && e.done === true));

    // Warm worker absorbed batch with zero new spawns; and t2 is now cached!
    const spawnsAfterBatch = fs.readFileSync(counterFile, 'utf8').trim().split('\n').length;
    assert.equal(spawnsAfterBatch, spawnsBeforeBatch);
    const singleFromBatchCache = await service.translate({ text: 'Ran check workspace and Rust toolchain' });
    assert.equal(singleFromBatchCache.cached, true);
    assert.equal(singleFromBatchCache.translation, batchRes.results.t2.translation);

    // 9. Batch missing-marker fallback automatically recovers omitted item
    const recoverRes = await service.translateBatch({
      items: [
        { id: 'm0', text: 'SKIP_MARKER_1 header item' },
        { id: 'm1', text: 'Omitted by malformed model output' }
      ]
    });
    assert.equal(recoverRes.ok, true);
    assert.equal(recoverRes.results.m0.translation, '批量译文[0]: SKIP_MARKER_1 header item');
    assert.ok(recoverRes.results.m1.translation.includes('Omitted by malformed model output'));

    // 10. Concurrent pool capped at default maxConcurrency (2)
    const [p1, p2, p3] = await Promise.all([
      service.translate({ text: 'PARALLEL_1 paragraph alpha.' }),
      service.translate({ text: 'PARALLEL_2 paragraph beta.' }),
      service.translate({ text: 'PARALLEL_3 paragraph gamma.' })
    ]);
    assert.equal(p1.ok, true);
    assert.equal(p2.ok, true);
    assert.equal(p3.ok, true);
    const workerInvocations = fs.readFileSync(counterFile, 'utf8').trim().split('\n').filter(Boolean).length;
    assert.ok(workerInvocations >= 2 && workerInvocations <= 5, `expected pooled workers, got ${workerInvocations}`);

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
