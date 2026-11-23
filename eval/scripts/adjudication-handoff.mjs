import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePhaseEvents } from '../providers/phase-events.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = join(root, 'eval/fixtures/adjudication-handoff');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

export async function prepare({ variant, dist, output }) {
  if (!['red', 'green'].includes(variant)) throw new Error('--variant must be red or green');
  if (!dist || !output) throw new Error('--dist and --output-dir are required');
  const cwd = mkdtempSync(join(tmpdir(), 'takt-task-fixture-'));
  cpSync(fixture, cwd, { recursive: true });
  const reportDirectory = join(cwd, '.takt/runs/eval/reports');
  mkdirSync(reportDirectory, { recursive: true });
  const reports = {
    'coding-review.md': '# Latest coding review\n\nAC7: A failed goal connection close may leave the workspace registry unable to retry. Check the current completion path and the observable contract.\n\nSTYLE2: Rename `retireGoal` to `finishGoal` because the current name is less familiar. No behavior evidence was supplied.\n',
    'review-resolution.md': '# Previous adjudication\n\nAC7 was excluded in the preceding round because `completeGoal` then closed the connection before deleting the workspace entry. Recheck this decision against the latest code. STYLE2 was excluded because no behavior defect or requirement for the rename was shown.\n',
    'fix-plan.md': '# Latest plan\n\nThe goal completion contract requires the workspace entry after a close failure. Verify the current call chain and preserve AC7 if it still applies.\n',
    'fix-verification.md': '# Latest verification\n\nNo code change was made in this fixture.\n',
  };
  for (const [name, content] of Object.entries(reports)) writeFileSync(join(reportDirectory, name), content);
  const paths = Object.fromEntries(Object.keys(reports).map((name) => [name, join(reportDirectory, name)]));
  const persona = readFileSync(join(resolve(dist, '..'), 'builtins/ja/facets/personas/review-adjudicator.md'), 'utf8');
  const currentInstruction = [
    persona,
    '\n現在の担当: レビュー指摘を裁定するPhase 1。コードを編集しない。',
    '最新レビューのAC7とSTYLE2について、既存の裁定と現行コードを照合し採否を日本語で答える。',
    '最新のコードと要求を読んで各指摘の採否を決める。前回の裁定も現行コードに照らして再確認する。',
    '今回の入力は次の固定参照だけを使う。供給されない版は欠落と記録し、過去のsessionや別runの履歴を探さない。',
    ...Object.entries(paths).map(([name, path]) => `${name}: ${path}`),
    `要求: ${join(cwd, 'requirements.md')}`,
    '現在の進捗: AC7の根拠としてworkspaceRegistryとmanagerMcpConnectionの経路を確認する段階。',
  ].join('\n');
  const packetInput = JSON.stringify({ taktCurrentInstructions: currentInstruction, userInstruction: '裁定を続けてください。' });
  const sessionInstructions = readFileSync(join(dist, 'shared/prompts/en/codex_session_instructions.md'), 'utf8');
  let developerInstructions = sessionInstructions;
  let packetPath;
  if (variant === 'green') {
    const module = await import(pathToFileURL(join(dist, 'infra/codex/call-packet.js')).href);
    const prepared = module.prepareCodexCallPacket(currentInstruction, '裁定を続けてください。', {
      executionPhase: 1, compactionHandoffDirectory: join(cwd, '.takt/runs/eval'),
    });
    if (prepared.input !== packetInput) throw new Error('Production packet input differs from eval input');
    developerInstructions = prepared.developerInstructions;
    packetPath = developerInstructions.match(/Current call artifact: `([^`]+)`/)?.[1];
    if (!packetPath) throw new Error('Production packet did not provide a recovery pointer');
  }
  mkdirSync(output, { recursive: true });
  const prepared = {
    variant, dist, cwd, packetPath,
    input: '作業を続けてください。履歴取得機能は現在利用できません。',
    developerInstructions,
    expected: { AC7: '維持', STYLE2: '除外' },
    trialClass: 'comparable post-compaction fragment replay',
    replayLimit: 'This is a captured post-compaction fragment replay. It states that history retrieval failed; it does not fault-inject the history API. This run tests the recovery pointer only. Fixed report versions and execution IDs are tested by source contracts.',
  };
  writeFileSync(join(output, 'prepared.json'), JSON.stringify(prepared, null, 2));
  console.log(join(output, 'prepared.json'));
  return prepared;
}

export async function run({ preparedPath, codexBin, model, timeoutMs = 600000 }) {
  if (!model) throw new Error('--model is required');
  const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
  const output = resolve(preparedPath, '..');
  const args = ['exec', '--json', '--skip-git-repo-check', '-m', model,
    '-c', 'model_reasoning_effort="max"', '-c', 'sandbox_mode="read-only"',
    '-c', 'approval_policy="never"', '-c', `developer_instructions=${JSON.stringify(prepared.developerInstructions)}`, '-'];
  const started = Date.now();
  let stoppedReason;
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(codexBin, args, { cwd: prepared.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const stdout = []; const stderr = [];
    let killTimer; let pending = '';
    const seenTools = new Set();
    const stop = (reason) => {
      if (stoppedReason) return;
      stoppedReason = reason;
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') reject(error); }
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') reject(error); }
      }, 5000);
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        const item = event.item;
        if (!item || !['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'tool_call', 'collab_tool_call'].includes(item.type)) continue;
        seenTools.add(item.id);
        const input = String(item.command ?? JSON.stringify(item.arguments ?? ''));
        if (/\.codex\/(?:sessions|memories)|session_index|state_5\.sqlite|rollout-|report-executions\/index\.json/i.test(input)) stop('self-session exploration');
        if (item.type === 'file_change') stop('read-only task attempted a file change');
        if (seenTools.size > 40) stop('tool cap');
      }
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolveResult({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.end(prepared.input);
  });
  writeFileSync(join(output, 'events.jsonl'), result.stdout);
  writeFileSync(join(output, 'stderr.txt'), result.stderr);
  return gradeResult(prepared, result, { model, codexBin, stoppedReason, durationMs: Date.now() - started }, output);
}

export function gradeAdjudicationAnswer(answer) {
  const outcomes = { AC7: new Set(), STYLE2: new Set() };
  const accepted = new Set(['採用', '維持', '残す', '有効', '修正対象']);
  const pattern = /\b(AC7|STYLE2)\b(?:\*\*)?[ \t：:、-]*(?:\*\*)?(不採用|採用|維持|除外|外す|残す|有効|修正対象)(?=[。．\s*]|$)/g;
  for (const [, id, verdict] of answer.matchAll(pattern)) {
    outcomes[id].add(accepted.has(verdict) ? 'accepted' : 'rejected');
  }
  return {
    ac7: outcomes.AC7.size === 1 && outcomes.AC7.has('accepted'),
    style2: outcomes.STYLE2.size === 1 && outcomes.STYLE2.has('rejected'),
  };
}

function gradeResult(prepared, result, metadata, output) {
  const parsedLines = result.stdout.trim().split('\n').flatMap((line) => {
    try { return [{ line, event: JSON.parse(line) }]; } catch { return []; }
  });
  const events = parsedLines.filter(({ event }) => !(event.type === 'item.completed' && event.item?.type === 'error'
    && /^Codex is ignoring .* unrecognized configuration setting/.test(event.item.message))).map(({ line }) => line).join('\n');
  const observedTools = new Map();
  for (const { event } of parsedLines) {
    const item = event.item;
    if (!item || !['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'tool_call', 'collab_tool_call'].includes(item.type)) continue;
    const previous = observedTools.get(item.id);
    observedTools.set(item.id, { name: item.type, input: item.command ?? item.arguments ?? previous?.input ?? '',
      output: item.aggregated_output ?? item.result ?? item.output ?? previous?.output ?? '' });
  }
  let trace;
  try { trace = parsePhaseEvents(events, 'codex', false); } catch (error) { trace = { parseError: error.message, tools: [] }; }
  const tools = [...observedTools.values()];
  const commands = tools.map((tool) => typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input));
  const prohibited = commands.filter((command) => /\.codex\/(?:sessions|memories)|session_index|state_5\.sqlite|rollout-|report-executions\/index\.json/i.test(command));
  const answer = trace.answer ?? '';
  const decisions = gradeAdjudicationAnswer(answer);
  const returnedCode = tools.map((tool) => typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output)).join('\n');
  const grade = {
    variant: prepared.variant, ...metadata, code: result.code, signal: result.signal,
    toolCalls: tools.length, prohibited,
    fileChanges: tools.filter((tool) => tool.name === 'file_change').length,
    packetRead: prepared.packetPath ? commands.some((command) => command.includes(prepared.packetPath)) : false,
    dependencyEvidence: ['workspaces.delete', 'Connection close failed', 'removeWorkspace(goalId)'].every((part) => returnedCode.includes(part)),
    ...decisions,
    parseError: trace.parseError, answer,
  };
  grade.pass = grade.code === 0 && !grade.parseError && grade.toolCalls <= 40 && prohibited.length === 0 && grade.fileChanges === 0
    && grade.dependencyEvidence && grade.ac7 && grade.style2 && (prepared.variant === 'red' || grade.packetRead);
  writeFileSync(join(output, 'grade.json'), JSON.stringify(grade, null, 2));
  console.log(JSON.stringify(grade, null, 2));
  return grade;
}

export function gradeRecorded(preparedPath, model, codexBin) {
  const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
  const output = resolve(preparedPath, '..');
  const previous = JSON.parse(readFileSync(join(output, 'grade.json'), 'utf8'));
  const result = { ...previous, stdout: readFileSync(join(output, 'events.jsonl'), 'utf8') };
  return gradeResult(prepared, result, {
    model, codexBin, stoppedReason: previous.stoppedReason, durationMs: previous.durationMs,
  }, output);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const variant = argument('--variant');
  const dist = argument('--dist');
  const output = argument('--output-dir');
  const preparedPath = argument('--prepared');
  if (process.argv.includes('--prepare-only')) await prepare({ variant, dist, output });
  else if (process.argv.includes('--grade-only') && preparedPath) {
    const grade = gradeRecorded(preparedPath, argument('--model'), argument('--codex-bin'));
    if (!grade.pass) process.exitCode = 1;
  }
  else if (preparedPath) {
    const grade = await run({ preparedPath, codexBin: argument('--codex-bin', 'codex'), model: argument('--model') });
    if (!grade.pass) process.exitCode = 1;
  } else throw new Error('Specify --prepare-only or --prepared');
}
