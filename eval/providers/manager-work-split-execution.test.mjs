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
import { getProvider } from '../../dist/infra/providers/index.js';
import { GoalStore } from '../../dist/infra/goals/store.js';

const lines = (dir, path) => readFileSync(join(dir, path), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const config = (caseId) => ({ case: caseId, lang: 'ja', model: 'fake-only', timeout_ms: 10000, judge_effort: 'low' });

function runPassingCheck(options) {
  const workspace = join(dirname(options.cwd), 'check');
  const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  options.onStream({ type: 'tool_use', data: { tool: 'Bash', id: 'check', input: { command: 'npm test' } } });
  run('git', ['worktree', 'add', '--detach', workspace, 'goal/inventory'], options.cwd);
  assert.match(run('npm', ['test'], workspace), /PASS inventory import/);
}

function fakeProvider(action) {
  return { setup(setup) {
    assert.ok(setup.systemPrompt.includes('Repository:'));
    let calls = 0;
    return { async call(prompt, options) {
      calls++;
      assert.equal(options.sessionId, undefined);
      assert.equal(options.permissionMode, 'full');
      assert.equal(typeof options.onToolPermissionDecision, 'function');
      options.abortSignal.throwIfAborted();
      const server = Object.values(options.mcpServers)[0];
      const client = new Client({ name: 'fake-manager', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
      await client.connect(transport);
      try {
        const context = JSON.parse(prompt.split('\n\n')[0]);
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
    assert.deepEqual(trial.after.git, trial.before.git);
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

test('permission decisions are delegated and an approval inquiry is persisted rather than auto-approved', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'manager-execution-test-'));
  t.mock.method(getProvider('claude-sdk'), 'setupIsolatedStructured', () => ({ call: async () => ({ status: 'done', content: '', structuredOutput: { decision: 'ask', reason: 'Commit needs approval' } }) }));
  try {
    const provider = fakeProvider(async ({ options }) => {
      const decision = await options.onToolPermissionDecision({ toolName: 'Bash', toolInput: { command: 'git commit -m verify' }, cwd: options.cwd, abortSignal: options.abortSignal });
      assert.equal(decision.decision, 'deny');
    });
    const trial = await runManagerExecution(config('integrated-task-execution'), root, new AbortController().signal, provider);
    assert.equal(trial.error, undefined);
    assert.equal(trial.after.questions.length, 1);
    assert.equal(trial.after.questions[0].kind, 'approval');
    assert.equal(gradeExecution(trial, lines(root, 'events.jsonl'), []).pass, false);
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
