import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runManagerExecution } from './manager-work-split-execution-worker.mjs';
import ManagerExecutionProvider, { executionConfig, runExecutionWorker } from './manager-work-split-execution.mjs';
import assertExecution, { gradeExecution } from '../asserts/manager-work-split-execution.mjs';
import { buildExecutionOutput, readExecutionEvidence } from '../manager-work-split-execution-result.mjs';
import { GoalStore } from '../../dist/infra/goals/store.js';
import { prepareQuestionFacetVariants } from '../fixtures/manager-question-options/facets.mjs';

const lines = (dir, path) => readFileSync(join(dir, path), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const config = (caseId) => ({ case: caseId, lang: 'ja', model: 'fake-only', timeout_ms: 10000 });

function runPassingCheck(options) {
  const workspace = join(dirname(options.cwd), 'check');
  const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  options.onStream({ type: 'tool_use', data: { tool: 'Bash', id: 'check', input: { command: 'npm test' } } });
  run('git', ['worktree', 'add', '--detach', workspace, 'goal/inventory'], options.cwd);
  const output = run('npm', ['test'], workspace);
  assert.match(output, /PASS inventory import/);
  options.onStream({ type: 'tool_result', data: { id: 'check', content: output, isError: false } });
}

function fakeProvider(action) {
  return { setup(setup) {
    assert.ok(setup.systemPrompt.includes('Repository:'));
    let calls = 0;
    return { async call(prompt, options) {
      calls++;
      assert.equal(options.sessionId, undefined);
      assert.equal(options.permissionMode, 'full');
      assert.equal(options.onToolPermissionDecision, undefined);
      options.abortSignal.throwIfAborted();
      const server = Object.values(options.mcpServers)[0];
      const client = new Client({ name: 'fake-manager', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
      await client.connect(transport);
      try {
        const input = JSON.parse(prompt.split('\n\n')[0]);
        assert.deepEqual(Object.keys(input), ['event', 'instruction']);
        assert.equal(input.event.kind, 'goal_resumed');
        assert.equal(input.instruction, 'Handle this event for the existing goals. Do not propose a new registration.');
        const read = await client.callTool({ name: 'takt_get_goal', arguments: { cwd: options.cwd, goalId: input.event.goalId } });
        const logs = await client.callTool({ name: 'takt_get_goal', arguments: { cwd: options.cwd, goalId: input.event.goalId, path: 'workLog' } });
        const context = { ...input, goal: { ...JSON.parse(read.content[0].text).goal, workLog: JSON.parse(logs.content[0].text).items } };
        const goalRead = await client.callTool({ name: 'takt_get_goal', arguments: { cwd: options.cwd, goalId: context.goal.id, path: 'objective' } });
        assert.equal(JSON.parse(goalRead.content[0].text).path, 'objective');
        const history = await client.callTool({ name: 'takt_get_goal_history', arguments: { cwd: options.cwd, goalId: context.goal.id, limit: 1 } });
        const savedHistory = JSON.parse(history.content[0].text);
        assert.equal(savedHistory.commits.length, 1);
        assert.equal(savedHistory.commits[0].sha, savedHistory.sourceSha);
        assert.equal(typeof savedHistory.commits[0].message, 'string');
        await action({ prompt, options, calls, client, context });
        const summary = '実行済みの記録に結果行がないため未確認。停止済み処理の出力は待たない。';
        await client.callTool({ name: 'takt_record_goal_work_log', arguments: { cwd: options.cwd, goalId: context.goal.id, summary } });
        return { status: 'done', content: JSON.stringify({ message: summary, summary: null }), persona: 'manager' };
      } finally { await client.close(); await transport.close(); }
    } };
  } };
}

test('execution configuration rejects missing model, bad deadlines and unsupported cases', () => {
  for (const change of [{ model: '' }, { timeout_ms: 0 }, { timeout_ms: 1.2 }, { case: 'other' }, { lang: 'de' }]) {
    const value = { ...config('stopped-background-execution'), ...change };
    assert.throws(() => executionConfig(value, value));
  }
});

test('execution provider reports invalid input before starting a worker', async () => {
  const provider = new ManagerExecutionProvider({ config: config('stopped-background-execution') });
  const response = await provider.callApi('', { vars: { case: 'not-an-execution-case', lang: 'ja' } });
  assert.equal(typeof response.error, 'string');
  assert.equal(response.output, undefined);
  assert.equal(response.metadata.artifact_dir, undefined);
  assert.equal(provider.id(), 'manager-execution:fake-only');
});

test('execution provider passes both facet roots to the worker configuration', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'manager-facet-config-'));
  const keys = ['TAKT_EVAL_MANAGER_INSTRUCTION_ROOT', 'TAKT_EVAL_MANAGER_POLICY_ROOT'];
  const prior = keys.map((key) => [key, process.env[key]]);
  const received = [];
  const originalSpawn = spawn;
  const mock = t.mock.method(childProcess, 'spawn', (_command, args, options) => {
    received.push(JSON.parse(readFileSync(args[1], 'utf8')));
    return originalSpawn(process.execPath, ['-e', 'process.exit(1)'], options);
  });
  syncBuiltinESMExports();
  try {
    const provider = new ManagerExecutionProvider({ config: { ...config('integrated-task-execution'), artifact_root: root } });
    for (const phase of ['red', 'green']) {
      process.env.TAKT_EVAL_MANAGER_INSTRUCTION_ROOT = join(root, phase, 'instructions');
      process.env.TAKT_EVAL_MANAGER_POLICY_ROOT = join(root, phase, 'policies');
      const response = await provider.callApi('', { vars: { case: 'integrated-task-execution', lang: 'ja' } });
      assert.equal(response.output, undefined);
      assert.match(response.error, /Execution worker failed/);
      assert.equal(received.at(-1).instruction_root, process.env.TAKT_EVAL_MANAGER_INSTRUCTION_ROOT);
      assert.equal(received.at(-1).policy_root, process.env.TAKT_EVAL_MANAGER_POLICY_ROOT);
    }
    assert.equal(received.length, 2);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('SDK execution prompts contain only their selected red or green question rules in both languages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'manager-sdk-facets-'));
  try {
    for (const lang of ['ja', 'en']) {
      const variants = prepareQuestionFacetVariants(root, lang);
      for (const caseId of ['stopped-background-execution', 'integrated-task-execution']) {
        for (const phase of ['red', 'green']) {
          const artifactDir = join(root, 'artifacts', lang, caseId, phase);
          const trial = await runManagerExecution({ ...config(caseId), lang,
            instruction_root: join(root, phase, 'instructions'), policy_root: join(root, phase, 'policies'),
          }, artifactDir, new AbortController().signal, fakeProvider(async () => {}));
          assert.equal(trial.error, undefined);
          assert.equal(trial.complete, true);
          const prompt = readFileSync(join(artifactDir, 'system-prompt.txt'), 'utf8');
          const promptLines = new Set(prompt.split('\n'));
          const other = phase === 'red' ? 'green' : 'red';
          for (const bodies of Object.values(variants)) {
            const chosen = bodies[phase].split('\n');
            const excluded = bodies[other].split('\n');
            const exclusive = chosen.filter((line) => line.trim() && !excluded.includes(line));
            assert.ok(exclusive.length > 0);
            for (const line of exclusive) assert.ok(promptLines.has(line), `${lang}/${caseId}/${phase}: includes chosen facet line`);
            for (const line of excluded.filter((line) => line.trim() && !chosen.includes(line))) {
              assert.ok(!promptLines.has(line), `${lang}/${caseId}/${phase}: excludes other facet line`);
            }
          }
          assert.doesNotMatch(prompt, /\{\{include:/);
        }
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('work-log MCP returns the production saved entry and count and retains matching evaluation evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'manager-work-log-test-'));
  const summary = 'ゴール先端541f832でnpm test終了0';
  let saved;
  try {
    const provider = fakeProvider(async ({ client, context, options }) => {
      const response = await client.callTool({ name: 'takt_record_goal_work_log', arguments: { cwd: options.cwd, goalId: context.goal.id, summary } });
      assert.notEqual(response.isError, true);
      saved = JSON.parse(response.content[0].text);
      const goal = await new GoalStore(options.cwd).get(context.goal.id);
      assert.deepEqual(saved, { goalId: goal.id, entry: goal.workLog.at(-1), totalCount: goal.workLog.length });
    });
    const trial = await runManagerExecution(config('integrated-task-execution'), root, new AbortController().signal, provider);
    assert.equal(trial.error, undefined);
    const goal = JSON.parse(readFileSync(join(root, 'saved-goal.json'), 'utf8'));
    assert.deepEqual(goal.workLog.find(({ id }) => id === saved.entry.id), saved.entry);
    assert.deepEqual(trial.workLog[0], { turn: 1, summary: saved.entry.summary });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('work-log MCP preserves a production save error without adding successful evaluation evidence', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'manager-work-log-test-'));
  const summary = '保存できなかった確認結果';
  try {
    const provider = fakeProvider(async ({ client, context, options }) => {
      const before = await new GoalStore(options.cwd).get(context.goal.id);
      const save = t.mock.method(GoalStore.prototype, 'update', async () => { throw new Error('Save failed'); });
      let response;
      try {
        response = await client.callTool({ name: 'takt_record_goal_work_log', arguments: { cwd: options.cwd, goalId: context.goal.id, summary } });
      } finally { save.mock.restore(); }
      assert.equal(response.isError, true);
      assert.deepEqual((await new GoalStore(options.cwd).get(context.goal.id)).workLog, before.workLog);
    });
    const trial = await runManagerExecution(config('integrated-task-execution'), root, new AbortController().signal, provider);
    assert.equal(trial.error, undefined);
    assert.equal(trial.workLog.some((entry) => entry.summary === summary), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same manager executor observes a live predecessor then a stopped process and accepts followup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'manager-execution-test-'));
  const prior = process.env.TAKT_CONFIG_DIR;
  const priorTmp = process.env.TMPDIR;
  const observed = [];
  let pid;
  try {
    const provider = fakeProvider(async ({ context, options, calls }) => {
      if (calls === 1) {
        const launch = context.goal.workLog.find(({ summary }) => summary.includes('PID='));
        pid = Number(launch.summary.match(/PID=(\d+)/)[1]);
      }
      if (calls === 1) assert.doesNotThrow(() => process.kill(pid, 0));
      else assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      observed.push({ calls, cwd: options.cwd });
    });
    const trial = await runManagerExecution(config('stopped-background-execution'), root, new AbortController().signal, provider);
    assert.equal(trial.error, undefined);
    assert.equal(trial.complete, true);
    assert.equal(trial.cleaned, true);
    assert.equal(observed.length, 3);
    assert.equal(new Set(observed.map(({ cwd }) => cwd)).size, 1);
    assert.equal(existsSync(trial.cwd), false);
    assert.equal(process.env.TAKT_CONFIG_DIR, prior);
    assert.equal(process.env.TMPDIR, priorTmp);
    assert.equal(gradeExecution(trial, lines(root, 'events.jsonl'), lines(root, 'checks.jsonl')).pass, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const kind of ['real', 'symlink']) {
  test(`cleanup removes only added worktrees with a ${kind} temporary root`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'manager-cleanup-test-')));
    const realRoot = join(root, 'real');
    const linkedRoot = join(root, 'linked');
    const priorTmp = process.env.TMPDIR;
    let mainWorktree;
    let workspace;
    try {
      mkdirSync(realRoot);
      symlinkSync(realRoot, linkedRoot, 'dir');
      process.env.TMPDIR = kind === 'real' ? realRoot : linkedRoot;
      const provider = fakeProvider(async ({ options }) => {
        runPassingCheck(options);
        mainWorktree = realpathSync(options.cwd);
        workspace = realpathSync(join(dirname(options.cwd), 'check'));
      });
      const trial = await runManagerExecution(config('integrated-task-execution'), join(root, 'artifacts'), new AbortController().signal, provider);
      assert.ok(mainWorktree);
      assert.ok(workspace);
      assert.equal(trial.cwd, mainWorktree);
      assert.equal(trial.error, undefined);
      assert.deepEqual(trial.cleanedWorktrees, [workspace]);
      assert.equal(trial.cleanedWorktrees.includes(mainWorktree), false);
      assert.equal(trial.cleaned, true);
      assert.equal(existsSync(workspace), false);
    } finally {
      if (priorTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = priorTmp;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('background startup records an early exit and cleans up without calling the provider', { timeout: 10000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'manager-background-startup-'));
  const originalSpawn = spawn;
  const mock = t.mock.method(childProcess, 'spawn', (_command, _args, options) =>
    originalSpawn(process.execPath, ['-e', 'process.exit(7)'], options));
  syncBuiltinESMExports();
  try {
    const provider = { setup() { return { call() { assert.fail('Provider must not run after startup failure'); } }; } };
    const trial = await runManagerExecution(config('stopped-background-execution'), root, new AbortController().signal, provider);
    assert.equal(trial.complete, false);
    assert.equal(trial.cleaned, true);
    assert.match(trial.error, /code=7, signal=null/);
    assert.ok(lines(root, 'events.jsonl').some(({ type, data }) => type === 'execution_error' && data.message === trial.error));
    assert.equal(existsSync(trial.cwd), false);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test('grading rejects a goal-tip check in the caller checkout even under a symlink temporary root', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'manager-caller-check-')));
  const previousTmp = process.env.TMPDIR;
  try {
    const linkedRoot = join(root, 'linked');
    symlinkSync(root, linkedRoot, 'dir');
    process.env.TMPDIR = linkedRoot;
    const provider = fakeProvider(async ({ options }) => {
      const run = (command, args) => execFileSync(command, args, { cwd: options.cwd, encoding: 'utf8', stdio: 'pipe' });
      options.onStream({ type: 'tool_use', data: { tool: 'Bash', id: 'check', input: { command: 'git checkout goal/inventory && npm test && git checkout main' } } });
      run('git', ['checkout', 'goal/inventory']);
      try { assert.match(run('npm', ['test']), /PASS inventory import/); }
      finally { run('git', ['checkout', 'main']); }
    });
    const trial = await runManagerExecution(config('integrated-task-execution'), join(root, 'artifacts'), new AbortController().signal, provider);
    assert.equal(trial.error, undefined);
    const { checkoutHistory: beforeHistory, ...beforeGit } = trial.before.git;
    const { checkoutHistory: afterHistory, ...afterGit } = trial.after.git;
    assert.deepEqual(afterGit, beforeGit);
    assert.notEqual(afterHistory, beforeHistory);
    const checks = lines(join(root, 'artifacts'), 'checks.jsonl');
    assert.equal(checks[0].cwd, trial.cwd);
    assert.equal(checks[0].head, trial.goalSha);
    const grade = gradeExecution(trial, lines(join(root, 'artifacts'), 'events.jsonl'), checks);
    assert.equal(grade.pass, false);
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    rmSync(root, { recursive: true, force: true });
  }
});

test('verification records a check inside its allowed trial root and persists it before cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'manager-execution-test-'));
  let workspace;
  try {
    const provider = fakeProvider(async ({ options }) => {
      runPassingCheck(options);
      workspace = realpathSync(join(dirname(options.cwd), 'check'));
      assert.equal(lines(dirname(options.cwd), 'checks.jsonl').length, 2);
      assert.deepEqual(lines(root, 'checks.jsonl'), []);
    });
    const trial = await runManagerExecution(config('integrated-task-execution'), root, new AbortController().signal, provider);
    assert.equal(trial.error, undefined);
    assert.equal(gradeExecution(trial, lines(root, 'events.jsonl'), lines(root, 'checks.jsonl')).pass, true);
    assert.equal(lines(root, 'checks.jsonl').length, 2);
    const evidence = readExecutionEvidence(root);
    const unfinished = { ...evidence, checks: evidence.checks.filter(({ kind }) => kind !== 'end') };
    assert.equal(gradeExecution(unfinished.trial, unfinished.events, unfinished.checks).pass, false);
    assert.deepEqual(trial.cleanedWorktrees, [workspace]);
    assert.equal(existsSync(workspace), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('started checks survive provider failure and deadline interruption without becoming successful trials', async () => {
  for (const kind of ['failure', 'deadline']) {
    const root = mkdtempSync(join(tmpdir(), 'manager-started-check-'));
    let child;
    try {
      const provider = fakeProvider(async ({ options }) => {
        const workspace = join(dirname(options.cwd), 'verify');
        execFileSync('git', ['worktree', 'add', '--detach', workspace, 'goal/inventory'], { cwd: options.cwd, stdio: 'pipe' });
        const checksPath = join(dirname(options.cwd), 'checks.jsonl');
        child = spawn(process.execPath, ['check.mjs'], { cwd: workspace, stdio: 'ignore' });
        const closed = once(child, 'close');
        try {
          while (readFileSync(checksPath, 'utf8').length === 0) await setTimeout(10, undefined, { signal: options.abortSignal });
          child.kill('SIGTERM');
          await closed;
          if (kind === 'failure') throw new Error('Failure after test start');
          await new Promise((_, reject) => options.abortSignal.addEventListener('abort', () => reject(options.abortSignal.reason), { once: true }));
        } finally { child.kill('SIGTERM'); await closed; }
      });
      const trial = await runManagerExecution({ ...config('integrated-task-execution'), timeout_ms: kind === 'deadline' ? 5000 : 10000 }, root, new AbortController().signal, provider);
      assert.equal(trial.complete, false);
      assert.equal(trial.cleaned, true);
      assert.equal(lines(root, 'checks.jsonl').length, 1);
      assert.equal(lines(root, 'checks.jsonl')[0].kind, 'start');
      assert.equal(gradeExecution(trial, lines(root, 'events.jsonl'), lines(root, 'checks.jsonl')).pass, false);
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
      assert.equal(existsSync(trial.cwd), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('direct questions persist their kind, details and notification and reuse the pending question during a passing check', async () => {
  for (const kind of [undefined, 'question', 'operation_request']) {
    const root = mkdtempSync(join(tmpdir(), 'manager-question-test-'));
    const priorWebhook = process.env.TAKT_NOTIFY_WEBHOOK;
    process.env.TAKT_NOTIFY_WEBHOOK = 'http://127.0.0.1:1/disabled-by-worker';
    let questionId;
    const details = { body: '検証ログの保管先を教えてください。', options: ['リポジトリ内', '別の保管先'], recommendation: 'リポジトリ内' };
    try {
      const provider = fakeProvider(async ({ options, client, context }) => {
        runPassingCheck(options);
        const args = { cwd: options.cwd, goalId: context.goal.id, ...details, ...(kind === undefined ? {} : { kind }) };
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await client.callTool({ name: 'takt_ask_goal_question', arguments: args });
          assert.notEqual(response.isError, true);
          const saved = JSON.parse(response.content[0].text);
          assert.equal(typeof saved.questionId, 'string');
          if (attempt === 0) questionId = saved.questionId;
          else assert.equal(saved.questionId, questionId);
        }
        assert.equal(process.env.TAKT_NOTIFY_WEBHOOK, '');
      });
      const trial = await runManagerExecution(config('integrated-task-execution'), root, new AbortController().signal, provider);
      assert.equal(trial.error, undefined);
      assert.equal(trial.after.questions.length, 1);
      const question = trial.after.questions[0];
      assert.equal(question.id, questionId);
      assert.equal(question.kind, kind ?? 'question');
      assert.equal(question.status, 'pending');
      assert.equal(question.body, details.body);
      assert.deepEqual(question.options, details.options);
      assert.equal(question.recommendation, details.recommendation);
      const savedGoal = JSON.parse(readFileSync(join(root, 'saved-goal.json'), 'utf8'));
      assert.deepEqual(savedGoal.questions, trial.after.questions);
      const notifications = savedGoal.notifications.filter(({ kind: value }) => value === 'question');
      assert.equal(notifications.length, 1);
      assert.ok(notifications[0].body.startsWith(`${questionId}: ${details.body}`));
      assert.deepEqual(trial.after.git, trial.before.git);
      assert.equal(gradeExecution(trial, lines(root, 'events.jsonl'), lines(root, 'checks.jsonl')).pass, true);
      const evidence = readExecutionEvidence(root);
      const payload = buildExecutionOutput(root, evidence);
      assert.deepEqual(payload.questions, { before: trial.before.questions, after: trial.after.questions });
      const calls = payload.mcpCalls.filter(({ data }) => data.tool === 'takt_ask_goal_question');
      assert.equal(calls.length, 2);
      for (const { data } of calls) {
        assert.equal(data.input.kind, kind ?? 'question');
        assert.equal(data.input.body, details.body);
        assert.deepEqual(data.input.options, details.options);
        assert.equal(data.input.recommendation, details.recommendation);
      }
      const gradingContext = { vars: { case: trial.case, lang: trial.lang } };
      assert.equal(assertExecution(JSON.stringify(payload), gradingContext).pass, true);
      for (const field of ['questions', 'mcpCalls']) {
        const incomplete = { ...payload };
        delete incomplete[field];
        assert.equal(assertExecution(JSON.stringify(incomplete), gradingContext).pass, false);
      }
      const changed = structuredClone(payload);
      changed.mcpCalls.find(({ data }) => data.tool === 'takt_ask_goal_question').data.input.body = '別の内容';
      assert.equal(assertExecution(JSON.stringify(changed), gradingContext).pass, false);
      assert.throws(() => buildExecutionOutput(root, { ...evidence, trial: { ...trial, before: {} } }));
      assert.throws(() => readExecutionEvidence(join(root, 'missing-artifacts')));
      assert.equal(process.env.TAKT_NOTIFY_WEBHOOK, 'http://127.0.0.1:1/disabled-by-worker');
    } finally {
      if (priorWebhook === undefined) delete process.env.TAKT_NOTIFY_WEBHOOK;
      else process.env.TAKT_NOTIFY_WEBHOOK = priorWebhook;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('manager execution uses normal provider tools without a permission callback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'manager-execution-test-'));
  try {
    const provider = fakeProvider(async ({ options }) => {
      assert.equal(options.onToolPermissionDecision, undefined);
    });
    const trial = await runManagerExecution(config('integrated-task-execution'), root, new AbortController().signal, provider);
    assert.equal(trial.error, undefined);
    assert.equal(trial.after.questions.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deadline and provider failure retain events and clean processes and isolated configuration', async () => {
  for (const kind of ['failure', 'deadline']) {
    const root = mkdtempSync(join(tmpdir(), 'manager-execution-test-'));
    try {
      const provider = fakeProvider(async ({ options }) => {
        if (kind === 'failure') throw new Error('Fake provider failure');
        options.abortSignal.throwIfAborted();
        await new Promise((_, reject) => options.abortSignal.addEventListener('abort', () => reject(options.abortSignal.reason), { once: true }));
      });
      const trial = await runManagerExecution({ ...config('stopped-background-execution'), timeout_ms: kind === 'deadline' ? 100 : 10000 }, root, new AbortController().signal, provider);
      assert.equal(trial.complete, false);
      assert.equal(trial.cleaned, true);
      assert.equal(existsSync(trial.cwd), false);
      assert.throws(() => process.kill(trial.background.pid, 0), { code: 'ESRCH' });
      assert.ok(lines(root, 'events.jsonl').some(({ type }) => type === 'execution_error'));
      if (kind === 'deadline') assert.equal(trial.turns[0].timedOut, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('worker startup failure is not returned as a completed evaluation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'manager-execution-test-'));
  try {
    await assert.rejects(runExecutionWorker({ ...config('invalid-case') }, root, new AbortController().signal));
    assert.equal(JSON.parse(readFileSync(join(root, 'worker-exit.json'), 'utf8')).code, 1);
    assert.equal(JSON.parse(readFileSync(join(root, 'trial.json'), 'utf8')).complete, false);
    assert.equal(typeof readFileSync(join(root, 'worker-stderr.log'), 'utf8'), 'string');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const caseId of ['two-goal-pr-execution', 'finite-check-external-execution']) {
  test(`${caseId}: records actual tool calls, external queries and a returned followup turn`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-no-wait-test-'));
    const priorPath = process.env.PATH;
    try {
      const provider = fakeProvider(async ({ options, calls, client, context }) => {
        if (calls !== 1) return;
        const tools = (await client.listTools()).tools;
        assert.ok(tools.some(({ name }) => name === 'takt_get_workflow'));
        if (caseId === 'two-goal-pr-execution') {
          assert.ok(!options.allowedTools || options.allowedTools.some((name) => name.endsWith('__takt_get_workflow')));
          const goals = JSON.parse((await client.callTool({ name: 'takt_list_goals', arguments: { cwd: options.cwd } })).content[0].text).goals;
          assert.equal(goals.length, 2);
          const detail = await client.callTool({ name: 'takt_get_workflow', arguments: { cwd: options.cwd, workflow: 'merge-prepare' } });
          assert.notEqual(detail.isError, true, detail.content[0].text);
          const steps = JSON.parse(detail.content[0].text).steps;
          assert.ok(steps.some(({ name, wait }) => name === 'wait_ci' && wait));
          const target = goals.find(({ id }) => id !== context.goal.id);
          const submitted = await client.callTool({ name: 'takt_merge_goal_pr', arguments: {
            cwd: options.cwd, goalId: target.id, prNumber: target.pullRequest.number, until: 'prepare',
          } });
          assert.notEqual(submitted.isError, true, submitted.content[0].text);
          const command = `gh pr view ${target.pullRequest.number} --json statusCheckRollup`;
          options.onStream({ type: 'tool_use', data: { tool: 'Bash', id: 'status', input: { command } } });
          execFileSync('gh', ['pr', 'view', String(target.pullRequest.number), '--json', 'statusCheckRollup'], { cwd: options.cwd });
        } else {
          const missing = await client.callTool({ name: 'takt_get_workflow', arguments: { cwd: options.cwd, workflow: 'missing-fixture-workflow' } });
          assert.equal(missing.isError, true);
          runPassingCheck(options);
          const observer = join(dirname(options.cwd), 'external-status.mjs');
          const command = `node ${observer}`;
          options.onStream({ type: 'tool_use', data: { tool: 'Bash', id: 'status', input: { command } } });
          execFileSync(process.execPath, [observer], { cwd: options.cwd });
        }
      });
      const trial = await runManagerExecution(config(caseId), root, new AbortController().signal, provider);
      assert.equal(trial.error, undefined);
      const evidence = readExecutionEvidence(root);
      const verdict = gradeExecution(trial, evidence.events, evidence.checks);
      assert.equal(verdict.pass, true, verdict.reason);
      const output = buildExecutionOutput(root, evidence);
      assert.equal(output.workflowDetailsRead, caseId === 'two-goal-pr-execution');
      assert.ok(output.commands.length > 0);
      assert.equal(output.externalObservations.length, 1);
      assert.equal(trial.turns.length, 2);
      assert.equal(process.env.PATH, priorPath);
      assert.equal(assertExecution(JSON.stringify(output), { vars: { case: caseId, lang: 'ja' } }).pass, true);
      const forged = { ...output, workflowDetailsRead: !output.workflowDetailsRead };
      assert.equal(assertExecution(JSON.stringify(forged), { vars: { case: caseId, lang: 'ja' } }).pass, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const repeated of [false, true]) {
  test(`execution observations ${repeated ? 'reject repeated queries' : 'accept different fields queried once'} inside a separately invoked script`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'manager-hidden-wait-'));
    try {
      const provider = fakeProvider(async ({ options, calls }) => {
        if (calls !== 1) return;
        runPassingCheck(options);
        // The script name contains no waiting keywords; observation is at the external query boundary.
        const script = join(dirname(options.cwd), 'check-status.sh');
        const { writeFileSync } = await import('node:fs');
        writeFileSync(script, `gh run view 9001 --json status\ngh run view 9001 --json ${repeated ? 'status' : 'conclusion'}\n`);
        options.onStream({ type: 'tool_use', data: { tool: 'Bash', id: 'script', input: { command: `bash ${script}` } } });
        execFileSync('bash', [script], { cwd: options.cwd });
      });
      const trial = await runManagerExecution(config('finite-check-external-execution'), root, new AbortController().signal, provider);
      assert.equal(trial.error, undefined);
      const evidence = readExecutionEvidence(root);
      assert.equal(evidence.checks.filter(({ kind }) => kind === 'external').length, 2);
      assert.equal(gradeExecution(trial, evidence.events, evidence.checks).pass, !repeated);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
