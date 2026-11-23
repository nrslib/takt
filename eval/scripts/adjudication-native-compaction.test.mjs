import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ciChunk, evaluateNativeEvidence, prepareNative, runNative } from './adjudication-native-compaction.mjs';

test('native harness sends the production packet and requires an observed compaction', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'takt-native-contract-'));
  const fake = join(temp, 'codex');
  writeFileSync(fake, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log(process.env.TAKT_FAKE_VERSION || 'codex-cli 0.164.0'); process.exit(0); }
if (process.env.CODEX_HOME && !require('node:path').isAbsolute(process.env.CODEX_HOME)) process.exit(17);
let buffer = '';
let read = 0;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const next = () => {
  if (read < 36) send({ id: 100 + read, method: 'item/tool/call', params: { tool: 'read_ci_evidence', arguments: {}, callId: String(read), threadId: 'thread-1', turnId: 'turn-1' } });
  else {
    send({ method: 'item/started', params: { item: { type: 'commandExecution', command: 'cat requirements.md src/goalOperations.mjs src/lifecycle.mjs src/managerMcpConnection.mjs src/workspaceRegistry.mjs' } } });
    const answer = Buffer.from(JSON.stringify({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'AC7：維持。STYLE2：除外。' } } }) + '\\n');
    const split = answer.indexOf(Buffer.from('維')) + 1;
    process.stdout.write(answer.subarray(0, split));
    setTimeout(() => {
      process.stdout.write(answer.subarray(split));
      send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed', items: [] } } });
    }, 5);
  }
};
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop();
  for (const line of lines) {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    if (msg.method === 'thread/start') send({ id: msg.id, result: { model: msg.params.model, thread: { id: 'thread-1' } } });
    if (msg.method === 'turn/start') {
      send({ id: msg.id, result: { turn: { id: 'turn-1' } } });
      if (process.env.TAKT_FAKE_UNSAFE_COMMAND) {
        send({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'unsafe', command: process.env.TAKT_FAKE_UNSAFE_COMMAND } } });
      } else next();
    }
    if (msg.id >= 100 && msg.result) {
      if (read === 20 && !process.env.TAKT_FAKE_NO_COMPACTION) {
        send({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: { inputTokens: 480000 }, modelContextWindow: 475000 } } });
        send({ method: 'item/completed', params: { item: { type: 'contextCompaction' } } });
      }
      read++;
      next();
    }
  }
});
`, { mode: 0o700 });
  chmodSync(fake, 0o700);
  let cwd;
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    const output = join(temp, 'prepared');
    const prepared = await prepareNative({ dist: resolve('dist'), output });
    cwd = prepared.cwd;
    assert.equal(readFileSync(prepared.artifact, 'utf8'), prepared.input);
    assert.equal(readFileSync(join(prepared.cwd, '.takt/config.yaml'), 'utf8'), 'language: ja\n');
    const instructions = JSON.parse(prepared.input).taktCurrentInstructions;
    assert.equal(instructions.length, 42_800);
    assert.ok(prepared.realFacetChars > 10_000);
    assert.ok(prepared.syntheticChars < 35_000);
    assert.match(instructions, /# Review Adjudicator/);
    assert.match(instructions, /# レビュー指摘の裁定/);
    assert.match(instructions, /# レビュー裁定の知識/);
    assert.match(instructions, /提出されたレビュー指摘を要求と脅威モデルに照らして裁定/);
    assert.match(instructions, /受入条件を引き継ぐときは/);
    assert.match(instructions, /各chunkで別々にfunctions\.execを1回呼び、戻り値の全文をtext\(\)へそのまま渡す/);
    assert.match(instructions, /max_output_tokens": 20000/);
    assert.match(instructions, /text\(await tools\.read_ci_evidence\(\{\}\)\);/);
    assert.match(instructions, /`ID：採用。` または `ID：除外。`/);
    assert.doesNotMatch(instructions, /\{\{include:/);
    process.env.CODEX_HOME = join(temp, 'custom-codex-home');
    const grade = await runNative({ preparedPath: join(output, 'prepared.json'), codexBin: fake, model: 'gpt-6-luna' });
    assert.equal(grade.pass, false); // The fake server has no native rollout to verify.
    assert.equal(grade.codexHome, join(temp, 'custom-codex-home'));
    assert.notEqual(grade.rollout.status, 'read');
    assert.equal(grade.compacted, 1);
    assert.equal(grade.readChunks.length, 36);
    assert.equal(grade.reportedContext, 475000);
    assert.equal(grade.answer, 'AC7：維持。STYLE2：除外。');
    assert.equal(grade.ac7, true);
    assert.equal(grade.style2, true);
    process.env.TAKT_FAKE_NO_COMPACTION = '1';
    process.env.CODEX_HOME = 'relative-codex-home';
    const withoutCompaction = await runNative({ preparedPath: join(output, 'prepared.json'), codexBin: fake, model: 'gpt-6.1-sol' });
    assert.equal(withoutCompaction.codexHome, resolve('relative-codex-home'));
    assert.equal(withoutCompaction.compacted, 0);
    assert.equal(withoutCompaction.pass, false);
    process.env.TAKT_FAKE_VERSION = 'codex-cli 0.164.0-alpha.1';
    await assert.rejects(runNative({ preparedPath: join(output, 'prepared.json'), codexBin: fake, model: 'gpt-6-luna' }),
      /Managed Codex 0\.164\.0 is required/);
    delete process.env.TAKT_FAKE_VERSION;
    process.env.CODEX_HOME = join(temp, 'custom-codex-home');
    process.env.TAKT_FAKE_UNSAFE_COMMAND = 'cat "$CODEX_HOME"/sessions/2026/11/23/*.jsonl';
    const blocked = await runNative({ preparedPath: join(output, 'prepared.json'), codexBin: fake, model: 'gpt-6-luna' });
    assert.equal(blocked.stoppedReason, 'self-session exploration');
  } finally {
    delete process.env.TAKT_FAKE_NO_COMPACTION;
    delete process.env.TAKT_FAKE_VERSION;
    delete process.env.TAKT_FAKE_UNSAFE_COMMAND;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});

test('prepare resolves Japanese facets when the global default is English', () => {
  const temp = mkdtempSync(join(tmpdir(), 'takt-native-lang-'));
  let cwd;
  try {
    mkdirSync(join(temp, 'empty-home/.takt'), { recursive: true });
    writeFileSync(join(temp, 'empty-home/.takt/config.yaml'), 'language: en\n');
    const result = spawnSync(process.execPath, ['eval/scripts/adjudication-native-compaction.mjs',
      '--prepare-only', '--dist', resolve('dist'), '--output-dir', join(temp, 'prepared')],
    { cwd: process.cwd(), env: { ...process.env, HOME: join(temp, 'empty-home') }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const prepared = JSON.parse(readFileSync(join(temp, 'prepared/prepared.json'), 'utf8'));
    cwd = prepared.cwd;
    assert.match(JSON.parse(prepared.input).taktCurrentInstructions, /# レビュー裁定の知識/);
    assert.equal(readFileSync(join(cwd, '.takt/config.yaml'), 'utf8'), 'language: ja\n');
  } finally {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});

test('recorded grade separates continuity, packet recovery, and fully visible load', () => {
  const temp = mkdtempSync(join(tmpdir(), 'takt-native-grade-'));
  const eventsPath = join(temp, 'events.jsonl');
  const rolloutPath = join(temp, 'rollout.jsonl');
  const prepared = { artifact: join(temp, 'packet.json'),
    input: JSON.stringify({ taktCurrentInstructions: '現在の担当はレビュー裁定のPhase 1。AC7とSTYLE2の採否を確かめる。',
      userInstruction: '裁定を続けてください。' }) };
  const base = { threadId: 'trial-thread', codexHome: join(temp, 'custom-codex-home'),
    readChunks: Array.from({ length: 36 }, (_, index) => index),
    toolCalls: 42, stoppedReason: 'turn complete' };
  const files = ['requirements.md', 'goalOperations.mjs', 'lifecycle.mjs', 'managerMcpConnection.mjs', 'workspaceRegistry.mjs'];
  const source = files.map((file) => readFileSync(resolve('eval/fixtures/adjudication-handoff',
    file === 'requirements.md' ? file : `src/${file}`), 'utf8').trimEnd());
  const lineNumbered = source.map((body, index) => index === 0 ? body : body.split('\n')
    .map((line, number) => `${String(number + 1).padStart(6)}\t${line}`).join('\n')).join('\n');
  const encodedSource = JSON.stringify({ i: 0, status: 'fulfilled', value: { exit_code: 0, output: lineNumbered } });
  const rpc = (method, params) => ({ method, params });
  const item = (type, id, extra = {}) => ({ type, id, ...extra });
  const events = [rpc('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 449000 }, modelContextWindow: 475000 } }),
    rpc('item/completed', { item: item('contextCompaction', 'compaction-1') }),
    rpc('item/completed', { item: item('contextCompaction', 'compaction-1') })];
  for (const file of files) {
    const id = `read-${file}`;
    events.push(rpc('item/started', { item: item('commandExecution', id, { command: `cat ${file}` }) }));
    events.push(rpc('item/completed', { item: item('commandExecution', id, { command: `cat ${file}`, exitCode: 0 }) }));
  }
  events.push(rpc('item/started', { item: item('commandExecution', 'packet', { command: `cat ${prepared.artifact}` }) }));
  events.push(rpc('item/completed', { item: item('commandExecution', 'packet', { command: `cat ${prepared.artifact}`, exitCode: 0 }) }));
  events.push(rpc('item/completed', { item: item('agentMessage', 'answer', { text: 'AC7：採用。\nSTYLE2：除外。' }) }));
  events.push(rpc('turn/completed', { turn: { status: 'completed' } }));
  const rollout = [{ type: 'compacted', timestamp: '2026-11-23T00:00:00Z' }];
  rollout.push({ type: 'response_item', payload: { type: 'function_call', namespace: 'history', name: 'list_items', call_id: 'history-1' } });
  rollout.push({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'history-1', output: 'Unable to perform operation: The backend request failed.' } });
  rollout.push({ type: 'response_item', payload: { type: 'function_call', namespace: 'other', name: 'read_file', call_id: 'other-1' } });
  rollout.push({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'other-1', output: 'ordinary file' } });
  for (let index = 0; index < 36; index++) {
    rollout.push({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: `ci-${index}`,
      input: 'text(await tools.read_ci_evidence({}));' } });
    rollout.push({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: `ci-${index}`,
      output: [{ type: 'input_text', text: ciChunk(index) }] } });
  }
  rollout.push({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'source',
    output: [{ type: 'input_text', text: `Script completed\nOutput:\n\n${encodedSource}` }] } });
  rollout.push({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'packet',
    input: `text(await tools.exec_command({cmd: 'cat ${prepared.artifact}'}));` } });
  rollout.push({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'packet',
    output: [{ type: 'input_text', text: prepared.input }] } });
  const write = () => {
    writeFileSync(eventsPath, `${events.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    writeFileSync(rolloutPath, `${rollout.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  };
  try {
    write();
    const full = evaluateNativeEvidence(prepared, base, eventsPath, rolloutPath);
    assert.equal(full.compacted, 1);
    assert.equal(full.taskContinuityPass, true);
    assert.equal(full.packetRecoveryPass, true);
    assert.equal(full.workloadFullyVisible, true);
    assert.equal(full.pass, true);
    assert.equal(full.rollout.historyCalls.length, 1);
    assert.equal(full.rollout.historyCalls[0].backendFailure, true);

    const now = new Date();
    const customHome = join(temp, 'custom-codex-home');
    const sessions = join(customHome, 'sessions', String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
    mkdirSync(sessions, { recursive: true });
    const customRollout = join(sessions, `rollout-test-${base.threadId}.jsonl`);
    writeFileSync(customRollout, readFileSync(rolloutPath));
    const fromCustomHome = evaluateNativeEvidence(prepared, { ...base, codexHome: customHome }, eventsPath);
    assert.equal(fromCustomHome.rollout.path, customRollout);
    assert.equal(fromCustomHome.pass, true);

    events[0].params.tokenUsage.modelContextWindow = 400000;
    write();
    assert.equal(evaluateNativeEvidence(prepared, base, eventsPath, rolloutPath).taskContinuityPass, false);
    events[0].params.tokenUsage.modelContextWindow = 475000;

    const partial = rollout.find((entry) => entry.payload?.call_id === 'ci-30' && entry.payload.type === 'custom_tool_call_output');
    partial.payload.output[0].text = ciChunk(30).slice(0, 400);
    write();
    const truncated = evaluateNativeEvidence(prepared, base, eventsPath, rolloutPath);
    assert.equal(truncated.taskContinuityPass, true);
    assert.equal(truncated.packetRecoveryPass, true);
    assert.equal(truncated.workloadFullyVisible, false);
    assert.equal(truncated.pass, false);

    partial.payload.output[0].text = ciChunk(30);
    rollout.find((entry) => entry.payload?.call_id === 'packet' && entry.payload.type === 'custom_tool_call_output')
      .payload.output[0].text = `${prepared.artifact} 現在の担当はレビュー裁定のPhase 1。AC7とSTYLE2の採否を確かめる。`;
    write();
    const unreadPacket = evaluateNativeEvidence(prepared, base, eventsPath, rolloutPath);
    assert.equal(unreadPacket.taskContinuityPass, true);
    assert.equal(unreadPacket.packetRecoveryPass, false);

    rollout.find((entry) => entry.payload?.call_id === 'packet' && entry.payload.type === 'custom_tool_call_output')
      .payload.output[0].text = prepared.input.slice(0, -1);
    write();
    assert.equal(evaluateNativeEvidence(prepared, base, eventsPath, rolloutPath).packetRecoveryPass, false);

    rollout.find((entry) => entry.payload?.call_id === 'packet' && entry.payload.type === 'custom_tool_call_output')
      .payload.output[0].text = prepared.input;
    rollout.find((entry) => entry.payload?.call_id === 'packet' && entry.payload.type === 'custom_tool_call')
      .payload.input = 'text(await tools.exec_command({cmd: "printf unrelated"}));';
    write();
    assert.equal(evaluateNativeEvidence(prepared, base, eventsPath, rolloutPath).packetRecoveryPass, false);

    rollout.find((entry) => entry.payload?.call_id === 'packet' && entry.payload.type === 'custom_tool_call')
      .payload.input = `text(await tools.exec_command({cmd: 'cat ${prepared.artifact}'}));`;
    events.find((entry) => entry.params?.item?.id === 'packet' && entry.method === 'item/completed').params.item.exitCode = 1;
    write();
    const noPacket = evaluateNativeEvidence(prepared, base, eventsPath, rolloutPath);
    assert.equal(noPacket.taskContinuityPass, true);
    assert.equal(noPacket.packetRecoveryPass, false);

    events.find((entry) => entry.params?.item?.id === 'packet' && entry.method === 'item/completed').params.item.exitCode = 0;
    rollout.find((entry) => entry.payload?.call_id === 'source' && entry.payload.type === 'custom_tool_call_output')
      .payload.output[0].text = 'requirements.md goalOperations.mjs lifecycle.mjs managerMcpConnection.mjs workspaceRegistry.mjs';
    write();
    assert.equal(evaluateNativeEvidence(prepared, base, eventsPath, rolloutPath).taskContinuityPass, false);

    rollout.find((entry) => entry.payload?.call_id === 'source' && entry.payload.type === 'custom_tool_call_output')
      .payload.output[0].text = `Script completed\nOutput:\n\n${encodedSource}`;
    events.find((entry) => entry.params?.item?.id === 'read-workspaceRegistry.mjs' && entry.method === 'item/completed').params.item.exitCode = 1;
    write();
    assert.equal(evaluateNativeEvidence(prepared, base, eventsPath, rolloutPath).taskContinuityPass, false);

    rollout.push({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'unsafe',
      input: 'find ~/.codex -type f' } });
    write();
    assert.deepEqual(evaluateNativeEvidence(prepared, base, eventsPath, rolloutPath).rollout.diskExplorationCalls, ['exec']);

    for (const command of ['find "$HOME/.codex" -type f', 'ls ~/.codex', 'rg --files ~/.codex',
      'rg --files /Users/test/.codex', 'find ~/.codex/* -type f', 'find ~/.codex/. -type f',
      'find ./.codex -type f', 'rg --files /home/test/.codex']) {
      rollout.at(-1).payload.input = command;
      write();
      assert.deepEqual(evaluateNativeEvidence(prepared, base, eventsPath, rolloutPath).rollout.diskExplorationCalls,
        ['exec'], command);
    }
    for (const command of ['find ~/.codex/skills -type f', 'rg --files ~/.codex/skills',
      'cat ~/.codex/skills/coding/SKILL.md', 'cat /Users/test/.codex/skills/coding/SKILL.md',
      'cat ~/.codex/AGENTS.md']) {
      rollout.at(-1).payload.input = command;
      write();
      assert.deepEqual(evaluateNativeEvidence(prepared, base, eventsPath, rolloutPath).rollout.diskExplorationCalls,
        [], command);
    }
    for (const command of ['cat "$CODEX_HOME"/sessions/2026/11/23/*.jsonl',
      'rg --files ${CODEX_HOME}/sessions', `find ${base.codexHome} -type f`,
      `cat ${base.codexHome}/sessions/2026/11/23/rollout.jsonl`]) {
      rollout.at(-1).payload.input = command;
      write();
      assert.deepEqual(evaluateNativeEvidence(prepared, base, eventsPath, rolloutPath).rollout.diskExplorationCalls,
        ['exec'], command);
    }
    for (const command of ['cat "$CODEX_HOME"/skills/coding/SKILL.md',
      `rg --files ${base.codexHome}/skills`, `cat ${base.codexHome}/AGENTS.md`]) {
      rollout.at(-1).payload.input = command;
      write();
      assert.deepEqual(evaluateNativeEvidence(prepared, base, eventsPath, rolloutPath).rollout.diskExplorationCalls,
        [], command);
    }
    rollout.pop();
    events.push(rpc('item/started', { item: item('commandExecution', 'unsafe-custom',
      { command: `find ${base.codexHome}/sessions -type f` }) }));
    write();
    assert.deepEqual(evaluateNativeEvidence(prepared, base, eventsPath, rolloutPath).diskExplorationCalls,
      ['unsafe-custom']);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
