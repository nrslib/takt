import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveCodexHomeDirectory } from '../../dist/infra/codex/home.js';
import { gradeAdjudicationAnswer } from './adjudication-handoff.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = join(root, 'eval/fixtures/adjudication-handoff');
const CHUNKS = 36;
const CONTEXT_WINDOW = 500_000;
const MAX_TOOLS = 100;
const MAX_DURATION_MS = 30 * 60_000;
const sourceFiles = ['requirements.md', 'goalOperations.mjs', 'lifecycle.mjs', 'managerMcpConnection.mjs', 'workspaceRegistry.mjs'];
const privateHistoryPath = /\.codex\/(?:sessions|memories)|session_index|state_5\.sqlite|rollout-|report-executions\/index\.json/i;
const codexPath = /(?:^|[/'"`\s])\.codex(?=\/|['"`\s;|&]|$)/g;
const codexHomeVariable = /\$(?:CODEX_HOME|\{CODEX_HOME\})(?=\/|['"`\s;|&]|$)/g;

function isPrivateCodexSuffix(suffix) {
  const path = suffix.replace(/^['"`]/, '').split(/['"`\s;|&]/, 1)[0];
  const child = path.startsWith('/') ? path.slice(1).match(/^[^/'"`\s;|&]+/)?.[0] : undefined;
  return !['skills', 'AGENTS.md'].includes(child) || /(?:^|\/)\.\.(?:\/|$)/.test(path);
}

function isProhibited(input, codexHome) {
  const command = String(input);
  if (privateHistoryPath.test(command)) return true;
  for (const match of command.matchAll(codexPath)) {
    if (isPrivateCodexSuffix(command.slice(match.index + match[0].length))) return true;
  }
  for (const match of command.matchAll(codexHomeVariable)) {
    if (isPrivateCodexSuffix(command.slice(match.index + match[0].length))) return true;
  }
  let offset = command.indexOf(codexHome);
  while (offset !== -1) {
    const suffix = command.slice(offset + codexHome.length);
    const prefixBoundary = offset === 0 || /[='"`\s(]/.test(command[offset - 1]);
    if (prefixBoundary && /^(?:\/|['"`\s;|&]|$)/.test(suffix) && isPrivateCodexSuffix(suffix)) return true;
    offset = command.indexOf(codexHome, offset + 1);
  }
  return false;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function ciChunk(index) {
  const lines = [`SYNTHETIC CI EVIDENCE ${index + 1}/${CHUNKS}. This is a context stressor, not adjudication evidence.`];
  for (let row = 0; row < 420; row++) {
    const key = ((index + 1) * 104729 + row * 8191).toString(36).padStart(8, '0');
    lines.push(`ci/${String(index + 1).padStart(2, '0')}/${String(row + 1).padStart(3, '0')} ${key} build trace: module_${key} passed isolated contract probe; elapsed=${(row * 37 + index * 13) % 997}ms; synthetic observation only.`);
  }
  lines.push(`END SYNTHETIC CI EVIDENCE ${index + 1}/${CHUNKS}. ${index + 1 === CHUNKS ? 'CI EVIDENCE COMPLETE.' : 'Call read_ci_evidence again for the next chunk.'}`);
  return lines.join('\n');
}

function visibleText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(visibleText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(visibleText).join('\n');
  return '';
}

function decodedVisibleText(value) {
  const raw = visibleText(value);
  const embedded = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const item = JSON.parse(line);
      if (item.value?.exit_code === 0 && typeof item.value.output === 'string') embedded.push(item.value.output);
    } catch { /* The line is ordinary tool text. */ }
  }
  return [raw, ...embedded].join('\n').replace(/^[ \t]*\d+\t/gm, '');
}

function sourceBody(file) {
  return readFileSync(join(fixture, file === 'requirements.md' ? file : `src/${file}`), 'utf8').trimEnd();
}

function inspectOwnRollout(threadId, overridePath, codexHome, prepared) {
  if (!threadId) return { status: 'thread id unavailable' };
  let path = overridePath;
  if (!path) {
    const now = new Date();
    const directory = join(codexHome, 'sessions', String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
    let filename;
    try { filename = readdirSync(directory).find((name) => name.endsWith(`-${threadId}.jsonl`)); }
    catch { return { status: 'rollout directory unavailable' }; }
    if (!filename) return { status: 'rollout not yet available' };
    path = join(directory, filename);
  }
  const calls = new Map();
  const historyCalls = [];
  const compactions = [];
  const diskExplorationCalls = [];
  const visibleChunks = [];
  const incompleteEvidenceCalls = [];
  const sourceOutputMatches = new Set();
  let artifactOutputAfterCompaction = false;
  const pendingCalls = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'compacted') compactions.push(event.timestamp);
    const item = event.payload;
    if (event.type !== 'response_item') continue;
    if (item.type === 'custom_tool_call' && isProhibited(item.input ?? '', codexHome)) diskExplorationCalls.push(item.name);
    if (item.type === 'custom_tool_call' || item.type === 'function_call') pendingCalls.set(item.call_id, item);
    if (item.type === 'function_call' && ['history', 'notes'].includes(item.namespace)) {
      calls.set(item.call_id, { namespace: item.namespace, name: item.name, at: event.timestamp });
    }
    if (item.type === 'function_call' && isProhibited(item.arguments ?? '', codexHome)) diskExplorationCalls.push(item.name);
    if (item.type === 'custom_tool_call_output' || item.type === 'function_call_output') {
      const text = decodedVisibleText(item.output);
      const original = pendingCalls.get(item.call_id);
      if (calls.has(item.call_id)) {
        const call = calls.get(item.call_id);
        historyCalls.push({ ...call, backendFailure: text.includes('backend request failed') });
        calls.delete(item.call_id);
      }
      for (const file of sourceFiles) {
        if (text.includes(sourceBody(file))) sourceOutputMatches.add(file);
      }
      const callInput = String(original?.input ?? original?.arguments ?? '');
      if (compactions.length > 0 && callInput.includes(prepared.artifact)
        && text.includes(prepared.input)) artifactOutputAfterCompaction = true;
      if (original?.name === 'read_ci_evidence'
        || String(original?.input ?? original?.arguments ?? '').includes('read_ci_evidence')) {
        const indices = [...text.matchAll(/SYNTHETIC CI EVIDENCE (\d+)\/36\./g)]
          .map((match) => Number(match[1]) - 1).filter((index) => index >= 0 && index < CHUNKS);
        const unique = [...new Set(indices)];
        if (unique.length === 1 && text.includes(ciChunk(unique[0]))) visibleChunks.push(unique[0]);
        else if (!text.includes('CI EVIDENCE COMPLETE')) incompleteEvidenceCalls.push(item.call_id);
      }
      pendingCalls.delete(item.call_id);
    }
  }
  for (const call of calls.values()) historyCalls.push({ ...call, backendFailure: null, outcome: 'no output' });
  return { status: 'read', path, compactions, historyCalls, diskExplorationCalls,
    visibleChunks, incompleteEvidenceCalls, sourceOutputMatches: [...sourceOutputMatches], artifactOutputAfterCompaction };
}

function inspectAppEvents(eventsPath, prepared, codexHome) {
  const itemCompactions = new Map();
  const threadCompactions = new Map();
  const commandStarts = new Map();
  const sourceCommandSuccess = new Set();
  const diskExplorationCalls = [];
  let fileChangeAttempts = 0;
  let packetCommandAfterCompaction = false;
  let reportedContext;
  let highestInputTokens = 0;
  let completed = false;
  let answer = '';
  let toolCalls = 0;
  let compacted = false;
  for (const [ordinal, line] of readFileSync(eventsPath, 'utf8').split('\n').entries()) {
    if (!line) continue;
    const event = JSON.parse(line);
    const item = event.params?.item;
    if (event.method === 'item/completed' && item?.type === 'contextCompaction') {
      itemCompactions.set(item.id ?? `item-${ordinal}`, { id: item.id, at: event.params?.completedAtMs });
      compacted = true;
    }
    if (event.method === 'thread/compacted') {
      const id = event.params?.itemId ?? event.params?.id ?? `thread-${ordinal}`;
      threadCompactions.set(id, { id });
      compacted = true;
    }
    if (event.method === 'thread/tokenUsage/updated') {
      reportedContext = event.params?.tokenUsage?.modelContextWindow ?? reportedContext;
      highestInputTokens = Math.max(highestInputTokens, event.params?.tokenUsage?.last?.inputTokens ?? 0);
    }
    if (event.method === 'item/tool/call') toolCalls++;
    if (event.method === 'item/started' && item?.type === 'fileChange') fileChangeAttempts++;
    if (event.method === 'item/started' && item?.type === 'commandExecution') {
      toolCalls++;
      commandStarts.set(item.id, { command: item.command, afterCompaction: compacted });
      if (isProhibited(item.command, codexHome)) diskExplorationCalls.push(item.id);
    }
    if (event.method === 'item/completed' && item?.type === 'commandExecution' && item.exitCode === 0) {
      const start = commandStarts.get(item.id);
      const command = start?.command ?? item.command;
      for (const file of sourceFiles) if (command.includes(file)) sourceCommandSuccess.add(file);
      if (start?.afterCompaction && command.includes(prepared.artifact)) packetCommandAfterCompaction = true;
    }
    if (event.method === 'item/completed' && item?.type === 'agentMessage') answer = item.text;
    if (event.method === 'turn/completed') completed = event.params?.turn?.status === 'completed';
  }
  const compactionEvents = [...(itemCompactions.size ? itemCompactions : threadCompactions).values()];
  return { compactionEvents, compacted: compactionEvents.length, reportedContext, highestInputTokens,
    sourceCommandSuccess: [...sourceCommandSuccess], packetCommandAfterCompaction,
    diskExplorationCalls, fileChangeAttempts, toolCalls, completed, answer };
}

export function evaluateNativeEvidence(prepared, base, eventsPath, rolloutPath) {
  const codexHome = base.codexHome ?? resolveCodexHomeDirectory(process.env);
  const observed = inspectAppEvents(eventsPath, prepared, codexHome);
  const rollout = inspectOwnRollout(base.threadId, rolloutPath, codexHome, prepared);
  const decisions = gradeAdjudicationAnswer(observed.answer);
  const sourceReads = sourceFiles.filter((file) => observed.sourceCommandSuccess.includes(file)
    && rollout.sourceOutputMatches?.includes(file));
  const workloadFullyVisible = rollout.visibleChunks?.length === CHUNKS
    && rollout.visibleChunks.every((index, position) => index === position)
    && rollout.incompleteEvidenceCalls.length === 0;
  const taskContinuityPass = observed.completed && observed.compacted > 0 && observed.reportedContext === 475_000
    && rollout.status === 'read' && rollout.compactions.length > 0
    && sourceReads.length === sourceFiles.length
    && decisions.ac7 && decisions.style2 && observed.toolCalls <= MAX_TOOLS && observed.fileChangeAttempts === 0
    && observed.diskExplorationCalls.length === 0 && rollout.diskExplorationCalls.length === 0
    && !['timeout', 'tool cap', 'self-session exploration', 'file change attempted'].includes(base.stoppedReason);
  const packetRecoveryPass = taskContinuityPass && observed.packetCommandAfterCompaction && rollout.artifactOutputAfterCompaction;
  return { ...base, ...observed, ...decisions, sourceReads, rollout,
    packetReadAfterCompaction: observed.packetCommandAfterCompaction,
    artifactOutputAfterCompaction: rollout.artifactOutputAfterCompaction,
    workloadFullyVisible, taskContinuityPass, packetRecoveryPass,
    pass: packetRecoveryPass && workloadFullyVisible && base.readChunks?.length === CHUNKS };
}

export function gradeRecordedNative(preparedPath, model) {
  if (!['gpt-6-luna', 'gpt-6.1-sol'].includes(model)) throw new Error('Luna or Sol model is required');
  const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
  const output = resolve(prepared.output, model.replaceAll('.', '-'));
  const previous = JSON.parse(readFileSync(join(output, 'grade.json'), 'utf8'));
  const rolloutPath = previous.rollout?.path;
  if (rolloutPath && !rolloutPath.endsWith(`-${previous.threadId}.jsonl`)) throw new Error('Recorded rollout does not match the trial thread');
  let recordedHome = rolloutPath;
  for (let level = 0; level < 5 && recordedHome; level++) recordedHome = dirname(recordedHome);
  const grade = evaluateNativeEvidence(prepared, { ...previous, codexHome: previous.codexHome ?? recordedHome },
    join(output, 'events.jsonl'), rolloutPath);
  grade.regrade = { regradedAt: new Date().toISOString(), source: 'recorded app-server events and own rollout',
    graderSourceSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex') };
  writeFileSync(join(output, 'regrade.json'), JSON.stringify(grade, null, 2), { mode: 0o600 });
  return grade;
}

export async function prepareNative({ dist, output }) {
  if (!dist || !output) throw new Error('--dist and --output-dir are required');
  const cwd = mkdtempSync(join(tmpdir(), 'takt-native-adjudication-'));
  chmodSync(cwd, 0o700);
  cpSync(fixture, cwd, { recursive: true });
  privateDirectory(join(cwd, '.takt'));
  writeFileSync(join(cwd, '.takt/config.yaml'), 'language: ja\n', { mode: 0o600 });
  const reports = join(cwd, '.takt/runs/eval/reports');
  privateDirectory(reports);
  const content = {
    'coding-review.md': '# Latest coding review\n\nAC7: A failed goal connection close may leave the workspace registry unable to retry. Check the current completion path and observable contract.\n\nSTYLE2: Rename `retireGoal` to `finishGoal` because the current name is less familiar. No behavior evidence was supplied.\n',
    'review-resolution.md': '# Previous adjudication\n\nAC7 was excluded in the preceding round because `completeGoal` then closed the connection before deleting the workspace entry. Recheck this decision against the latest code. STYLE2 was excluded because no behavior defect or requirement for the rename was shown.\n',
    'fix-plan.md': '# Latest plan\n\nThe goal completion contract requires the workspace entry after a close failure. Verify the current call chain and preserve AC7 if it still applies.\n',
    'fix-verification.md': '# Latest verification\n\nNo code change was made in this fixture.\n',
    'architecture-review.md': '# Architecture review\n\nCheck registry ownership and the order of close and deletion. No independent concern beyond AC7.\n',
    'qa-review.md': '# QA review\n\nCheck a failed close followed by a retry. No independent concern beyond AC7.\n',
    'security-review.md': '# Security review\n\nNo security finding in this small fixture.\n',
  };
  for (const [name, body] of Object.entries(content)) writeFileSync(join(reports, name), body, { mode: 0o600 });
  const workflowModule = await import(pathToFileURL(join(dist, 'infra/config/loaders/workflowResolver.js')).href);
  const step = workflowModule.getBuiltinWorkflow('peer-review', cwd)?.steps.find((candidate) => candidate.name === 'review-adjudication');
  if (!step?.personaPath?.includes('/builtins/ja/') || !step.policyContents?.length || !step.knowledgeContents?.length || !step.instruction) {
    throw new Error('Japanese review-adjudication facets were not resolved');
  }
  const realFacets = [readFileSync(step.personaPath, 'utf8'),
    ...step.policyContents.map(({ content }) => content),
    ...step.knowledgeContents.map(({ content }) => content), step.instruction];
  if (realFacets.some((content) => content.includes('{{include:'))) throw new Error('Unexpanded review-adjudication include');
  const realFacetChars = realFacets.reduce((length, content) => length + content.length, 0);
  const instructions = [
    ...realFacets,
    '現在の担当はレビュー裁定のPhase 1。コードを編集しない。AC7とSTYLE2の採否を現行コード・要求・固定レポートに照らして日本語で答える。',
    '圧縮後も同じPhase 1を続ける。担当が不明になったらdeveloper instructionsのCurrent call artifactを読む。過去session、rollout、memory、report indexは探索しない。',
    `合成CI evidenceはコンテキスト圧縮の負荷資料であり、裁定根拠ではない。read_ci_evidenceを「CI EVIDENCE COMPLETE」が返るまで呼ぶ。ツール側が次のchunkを保持する。各chunkの全文をモデル入力に載せることが実験の成立条件である。`,
    '各chunkで別々にfunctions.execを1回呼び、戻り値の全文をtext()へそのまま渡す。JavaScriptのループ・並列呼出・複数chunkのまとめ読み、slice・regex・末尾抽出・要約のみの表示は禁止。出力を確認してから次のchunkを呼ぶ。',
    '// @exec: {"max_output_tokens": 20000}\ntext(await tools.read_ci_evidence({}));',
    'その後、固定レポートとsrc/goalOperations.mjs、src/lifecycle.mjs、src/managerMcpConnection.mjs、src/workspaceRegistry.mjs、requirements.mdを読む。AC7とSTYLE2を明示的に裁定する。',
    '採否は前回判断を維持するかと分け、最後に各IDについて `ID：採用。` または `ID：除外。` の独立行を記す。IDはAC7とSTYLE2。',
    ...Object.keys(content).map((name) => `${name}: ${join(reports, name)}`),
    `requirements: ${join(cwd, 'requirements.md')}`,
    '現在の進捗: 固定入力を受け取り、合成CI evidenceの逐次確認から開始する。',
  ];
  const seed = 'SYNTHETIC REVIEW CONTEXT. This paragraph is generated solely to approximate the original Phase 1 input size. It does not provide evidence for AC7 or STYLE2.\n';
  const realInstructions = instructions.join('\n');
  const syntheticChars = Math.max(0, 42_800 - realInstructions.length - 1);
  const syntheticContext = seed.repeat(Math.ceil(syntheticChars / seed.length)).slice(0, syntheticChars);
  const currentInstruction = `${realInstructions}\n${syntheticContext}`;
  const packetModule = await import(pathToFileURL(join(dist, 'infra/codex/call-packet.js')).href);
  const packet = packetModule.prepareCodexCallPacket(currentInstruction, '裁定を続けてください。', {
    executionPhase: 1, compactionHandoffDirectory: join(cwd, '.takt/runs/eval'),
  });
  const artifact = packet.developerInstructions.match(/Current call artifact: `([^`]+)`/)?.[1];
  if (!artifact || readFileSync(artifact, 'utf8') !== packet.input) throw new Error('Production call packet was not persisted intact');
  privateDirectory(output);
  const prepared = { trialClass: 'native 500k same-turn compaction', cwd, output: resolve(output), dist: resolve(dist),
    input: packet.input, developerInstructions: packet.developerInstructions, artifact, contextWindow: CONTEXT_WINDOW,
    chunks: CHUNKS, codexVersion: '0.164.0', realFacetChars, syntheticChars,
    expected: { AC7: '維持', STYLE2: '除外' } };
  const path = join(output, 'prepared.json');
  writeFileSync(path, JSON.stringify(prepared, null, 2), { mode: 0o600 });
  console.log(path);
  return prepared;
}

export async function runNative({ preparedPath, codexBin, model }) {
  if (!codexBin || !['gpt-6-luna', 'gpt-6.1-sol'].includes(model)) throw new Error('Exact managed Codex binary and Luna/Sol model are required');
  const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
  if (prepared.contextWindow !== CONTEXT_WINDOW || prepared.chunks !== CHUNKS) throw new Error('Prepared trial is incompatible');
  const childEnv = { ...process.env };
  const codexHome = resolveCodexHomeDirectory(childEnv);
  if (childEnv.CODEX_HOME) childEnv.CODEX_HOME = codexHome;
  const version = spawnSync(codexBin, ['--version'], { encoding: 'utf8', env: childEnv });
  if (version.status !== 0 || version.stdout?.trim() !== 'codex-cli 0.164.0') throw new Error('Managed Codex 0.164.0 is required');
  const output = resolve(prepared.output, model.replaceAll('.', '-'));
  privateDirectory(output);
  const eventsPath = join(output, 'events.jsonl');
  writeFileSync(eventsPath, '', { mode: 0o600 });
  let stoppedReason;
  let threadId;
  let turnId;
  let completed;
  let resolveCompleted;
  const completion = new Promise((resolveCompletion) => { resolveCompleted = resolveCompletion; });
  let compacted = 0;
  let toolCalls = 0;
  let packetReadBeforeCompaction = false;
  const readChunks = [];
  const started = Date.now();
  const child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
    cwd: prepared.cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  let killTimer;
  function stop(reason) {
    if (stoppedReason) return;
    stoppedReason = reason;
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    killTimer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }, 5000);
  }
  const timer = setTimeout(() => stop('timeout'), MAX_DURATION_MS);
  let sequence = 0;
  const pending = new Map();
  function send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); }
  function request(method, params) {
    const id = ++sequence;
    send({ id, method, params });
    return new Promise((resolveRequest, rejectRequest) => pending.set(id, { resolveRequest, rejectRequest }));
  }
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      appendFileSync(eventsPath, `${line}\n`);
      let message;
      try { message = JSON.parse(line); } catch { stop('invalid json-rpc output'); continue; }
      if ('id' in message && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.rejectRequest(new Error(JSON.stringify(message.error)));
        else entry.resolveRequest(message.result);
        continue;
      }
      if (message.method === 'item/tool/call') {
        toolCalls++;
        const { tool, arguments: args } = message.params;
        const input = JSON.stringify(args);
        if (isProhibited(input, codexHome)) stop('self-session exploration');
        if (toolCalls > MAX_TOOLS) stop('tool cap');
        if (tool !== 'read_ci_evidence' || args === null || typeof args !== 'object' || Object.keys(args).length !== 0) {
          send({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: 'Invalid evidence request' }] } });
          continue;
        }
        const index = readChunks.length;
        if (index < CHUNKS) readChunks.push(index);
        send({ id: message.id, result: { success: true, contentItems: [{ type: 'inputText', text: index < CHUNKS ? ciChunk(index) : 'CI EVIDENCE COMPLETE. Continue the Phase 1 adjudication using the fixed reports and source files.' }] } });
      }
      if (message.method === 'thread/compacted' || (message.method === 'item/completed' && message.params?.item?.type === 'contextCompaction')) {
        compacted++;
      }
      if (message.method === 'turn/completed') {
        completed = message.params?.turn;
        resolveCompleted();
      }
      if (message.method === 'item/started' && message.params?.item?.type === 'commandExecution') {
        toolCalls++;
        const command = message.params.item.command ?? '';
        if (isProhibited(command, codexHome)) stop('self-session exploration');
        if (command.includes(prepared.artifact) && compacted === 0) packetReadBeforeCompaction = true;
        if (toolCalls > MAX_TOOLS) stop('tool cap');
      }
      if (message.method === 'item/started' && message.params?.item?.type === 'fileChange') stop('file change attempted');
    }
  });
  const closed = new Promise((resolveClose, rejectClose) => {
    child.on('error', rejectClose);
    child.on('close', (code, signal) => {
      for (const entry of pending.values()) entry.rejectRequest(new Error('App server exited before response'));
      pending.clear();
      resolveClose({ code, signal });
    });
  });
  try {
    await request('initialize', { clientInfo: { name: 'takt-native-adjudication-eval', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized' });
    const startedThread = await request('thread/start', {
      model, cwd: prepared.cwd, approvalPolicy: 'never', sandbox: 'read-only',
      developerInstructions: prepared.developerInstructions,
      config: { model_context_window: CONTEXT_WINDOW, tool_output_limit: 20_000 },
      dynamicTools: [{ type: 'function', name: 'read_ci_evidence', description: 'Read one synthetic CI evidence chunk per functions.exec call. Print this result in full with text(await tools.read_ci_evidence({})); no loops, slices, regex, or summaries. Continue until CI EVIDENCE COMPLETE.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    });
    if (startedThread.model !== model) throw new Error(`Model changed: ${startedThread.model}`);
    threadId = startedThread.thread.id;
    const response = await request('turn/start', { threadId, input: [{ type: 'text', text: prepared.input }], effort: 'high' });
    turnId = response.turn.id;
    await Promise.race([closed, completion]);
    if (!stoppedReason) stop('turn complete');
  } catch (error) {
    stop(`protocol error: ${error.message}`);
  }
  const exit = await closed;
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  writeFileSync(join(output, 'stderr.txt'), Buffer.concat(stderr).toString('utf8'), { mode: 0o600 });
  const base = { model, codexBin, codexHome, trialClass: prepared.trialClass, threadId, turnId, code: exit.code, signal: exit.signal,
    stoppedReason, durationMs: Date.now() - started, contextWindow: CONTEXT_WINDOW, toolCalls, readChunks,
    packetReadBeforeCompaction };
  const grade = evaluateNativeEvidence(prepared, base, eventsPath);
  writeFileSync(join(output, 'grade.json'), JSON.stringify(grade, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(grade, null, 2));
  return grade;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes('--prepare-only')) await prepareNative({ dist: option('--dist'), output: option('--output-dir') });
  else if (process.argv.includes('--grade-only')) {
    const grade = gradeRecordedNative(option('--prepared'), option('--model'));
    console.log(JSON.stringify(grade, null, 2));
    if (!grade.pass) process.exitCode = 1;
  }
  else {
    const grade = await runNative({ preparedPath: option('--prepared'), codexBin: option('--codex-bin'), model: option('--model') });
    if (!grade.pass) process.exitCode = 1;
  }
}
