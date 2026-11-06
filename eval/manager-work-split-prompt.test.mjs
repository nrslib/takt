import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { parse } from 'yaml';
import buildPrompt, { buildManagerSystemPrompt, buildManagerEventInput, loadManagerCase } from './manager-work-split-prompt.mjs';
import { createManagerConversationPlan } from '../dist/features/manager/conversationPlan.js';
import { buildManagerEventPrompt, managerInboxTurnEvent } from '../dist/features/daemon/inboxEvent.js';
import { goalSummary } from '../dist/features/mcp/goalResponse.js';
import { parseDaemonProcessMessage } from '../dist/core/daemon/processProtocol.js';
import { TaskRecordSchema } from '../dist/infra/task/schema.js';
import { GoalSchema } from '../dist/infra/goals/schema.js';
import { ManagerEventSchema } from '../dist/infra/goals/events.js';
import { invalidateGlobalConfigCache } from '../dist/infra/config/global/globalConfig.js';
import { getRunInputSchema, goalDiffInputSchema, goalHistoryInputSchema, goalWriteInputSchema, recordGoalWorkLogInputSchema, tellGoalRunInputSchema } from '../dist/features/mcp/schemas.js';
import { prepareQuestionFacetVariants } from './fixtures/manager-question-options/facets.mjs';

const suite = parse(readFileSync(new URL('./scenarios/manager-work-split/manager-work-split.yaml', import.meta.url), 'utf8'));
const runLogContent = (fixture, runSlug, index) => fixture.readResults.find(({ tool, arguments: args }) =>
  tool === 'takt_get_run' && args.runSlug === runSlug && args.view === 'log' && args.stepIndex === index).result.log.content;
const preserveEnv = (key, prior) => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; };
const facetEnvKeys = ['TAKT_EVAL_MANAGER_INSTRUCTION_ROOT', 'TAKT_EVAL_MANAGER_POLICY_ROOT'];
const inheritedFacetRoots = facetEnvKeys.map((key) => [key, process.env[key]]);
for (const key of facetEnvKeys) delete process.env[key];
after(() => inheritedFacetRoots.forEach(([key, value]) => preserveEnv(key, value)));

test('assembles all 112 turn prompts without a provider call, excluding scoring conditions', (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  assert.equal(suite.tests.length, 112);
  for (const { vars } of suite.tests) {
    const fixture = loadManagerCase(vars.case, vars.lang);
    const prompt = buildPrompt({ vars });
    if (fixture.execution === true) {
      assert.deepEqual(JSON.parse(prompt), { case: vars.case, lang: vars.lang, user: fixture.user });
      const row = suite.tests.find((entry) => entry.vars.case === vars.case && entry.vars.lang === vars.lang);
      assert.deepEqual(row.providers, ['claude-sdk-opus-5']);
      assert.doesNotMatch(prompt, /ps -p|exit code|結果行がない|process is absent/);
      continue;
    }
    assert.match(prompt, /SYSTEM:\n/);
    assert.doesNotMatch(prompt, /\{\{include:/);
    assert.ok(prompt.includes(`Concurrency limit: ${fixture.concurrency}`));
    assert.ok(prompt.includes(`Repository: ${JSON.stringify(fixture.cwd)}`));
    assert.ok(prompt.includes('"task"'));
    assert.ok(prompt.includes(JSON.stringify(fixture.readResults)));
    const tools = JSON.parse(prompt.split('TOOLS:\n')[1].split('\n\nUSER:')[0]);
    assert.deepEqual(tools.takt_record_goal_work_log.required, ['cwd', 'goalId', 'summary']);
    assert.deepEqual(tools.takt_tell_run.required, ['cwd', 'goalId', 'taskName', 'content']);
    assert.ok(recordGoalWorkLogInputSchema.safeParse({
      cwd: fixture.cwd, goalId: '650e8400-e29b-41d4-a716-446655440000', summary: 'Selected the next work after reviewing the goal.',
    }).success);
    assert.ok(tellGoalRunInputSchema.safeParse({
      cwd: fixture.cwd, goalId: '650e8400-e29b-41d4-a716-446655440000',
      taskName: 'running-task', content: 'Review the active repair target.',
    }).success);
    assert.doesNotMatch(prompt, /llm-rubric|manager-work-split\/tool-calls|Expected \d+\.\.|見出しや文言の一致ではなく、内容で判定する|Judge substance rather than headings/);
    assert.ok(!prompt.includes('expectedQuestionType'));
    if (fixture.turn === 'conversation') assert.ok(prompt.includes(`USER:\n${fixture.user}`));
    else {
      const user = prompt.split('USER:\n')[1].split('\n\n')[0];
      const context = JSON.parse(user);
      assert.deepEqual(context, JSON.parse(buildManagerEventInput(fixture.cwd, fixture.event)));
      assert.deepEqual(Object.keys(context), ['event', 'instruction']);
      const readGoal = fixture.readResults.find(({ tool, arguments: args }) => tool === 'takt_get_goal' && args.path === undefined).result.goal;
      assert.deepEqual(readGoal, goalSummary(GoalSchema.parse(fixture.goal)));

    }
  }
});

test('question expectations match choice, information and operation scenarios in both languages', () => {
  const expectations = {
    'task-stopped-not-resumed': 'choice',
    'migration-method-event': 'choice',
    'migration-method-conversation': 'choice',
    'csv-export-scope-conversation': 'choice',
    'search-index-scope-conversation': 'choice',
    'conflicting-calendar-visibility': 'choice',
    'escalate-repeated-failure': 'choice-or-operation',
    'external-contract-limit': 'information',
  };
  for (const lang of ['ja', 'en']) {
    for (const { vars } of suite.tests.filter(({ vars }) => vars.lang === lang)) {
      assert.equal(loadManagerCase(vars.case, lang).expectedQuestionType, expectations[vars.case]);
    }
  }
});

test('stopped-check inputs connect a previous launch to the current process and saved output observations', () => {
  for (const lang of ['ja', 'en']) {
    const fixture = loadManagerCase('stopped-background-check', lang);
    const processRead = fixture.readResults.find(({ tool, arguments: args }) => tool === 'Bash' && args.command.startsWith('ps -p '));
    const pid = processRead.arguments.command.match(/ps -p (\d+)/)[1];
    const outputRead = fixture.readResults.find(({ tool, arguments: args }) => tool === 'Read' && args.file_path.endsWith('.log'));
    const launch = fixture.goal.workLog.find(({ summary }) => summary.includes(outputRead.arguments.file_path) && summary.includes(pid));
    assert.ok(launch);
    assert.ok(Date.parse(launch.recordedAt) < Date.parse(fixture.event.kind === 'patrol' ? fixture.snapshotAt : fixture.event.createdAt));
    assert.match(processRead.result, /^exit code: 1\nstdout:\s*\nstderr:\s*$/);
    assert.match(outputRead.result, /RUN /);
    assert.doesNotMatch(outputRead.result, /PASS|FAIL|Tests\s+\d+/);
    const prompt = buildPrompt({ vars: { case: 'stopped-background-check', lang } });
    assert.ok(prompt.includes(JSON.stringify(fixture.readResults)));
    assert.deepEqual(fixture.readResults.find(({ arguments: args }) => args.path === 'workLog').result.items, fixture.goal.workLog);
  }
});

test('verification inputs expose integration state, result SHA and a distinct goal tip in both languages', () => {
  for (const lang of ['ja', 'en']) {
    for (const caseId of ['integrated-task-verification', 'verification-before-integration']) {
      const fixture = loadManagerCase(caseId, lang);
      const task = fixture.tasks[0];
      const listed = fixture.readResults.find(({ tool }) => tool === 'takt_list_tasks').result.tasks.find(({ name }) => name === task.name);
      const relation = fixture.readResults.find(({ tool }) => tool === 'takt_get_goal_relation').result;
      const history = fixture.readResults.find(({ tool }) => tool === 'takt_get_goal_history');
      assert.equal(listed.goalIntegration, caseId === 'integrated-task-verification' ? 'integrated' : 'not_integrated');
      assert.equal(listed.goalId, fixture.goal.id);
      assert.equal(relation.goalBranch, fixture.goal.branch);
      assert.notEqual(relation.goalSha, task.completion.sha);
      assert.ok(goalHistoryInputSchema.safeParse(history.arguments).success);
      assert.equal(history.result.sourceBranch, task.completion.branch);
      assert.equal(history.result.sourceSha, task.completion.sha);
      const prompt = buildPrompt({ vars: { case: caseId, lang } });
      assert.ok(prompt.includes(JSON.stringify(fixture.readResults)));
      assert.equal(fixture.tasks[0].completion.sha, task.completion.sha);
      assert.equal(fixture.readResults.find(({ tool }) => tool === 'takt_get_goal').result.goal.branch, relation.goalBranch);
    }
  }
});

test('uses the current time for each patrol case even long after module loading', async (t) => {
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now - 24 * 60 * 60 * 1000);
  const { default: buildLaterPrompt, loadManagerCase: loadLaterCase } = await import('./manager-work-split-prompt.mjs?delayed-patrol');
  const earlier = loadLaterCase('mail-dispatch-state', 'ja');
  clock.mock.mockImplementation(() => now);
  const later = loadLaterCase('mail-dispatch-state', 'ja');
  assert.equal(Date.parse(later.snapshotAt) - Date.parse(earlier.snapshotAt), 24 * 60 * 60 * 1000);
  const prompt = buildLaterPrompt({ vars: { case: 'mail-dispatch-state', lang: 'ja' } });
  const context = JSON.parse(prompt.split('USER:\n')[1].split('\n\n')[0]);
  assert.equal(context.event.kind, 'patrol');
  assert.equal(Date.parse(later.snapshotAt), now);
  assert.deepEqual(context.event, later.event);
});

test('patrol fixtures preserve repeated repair history, source documents and the latest adjudication report', () => {
  const cases = [
    'mail-dispatch-state', 'local-config-tampering', 'offline-sync-queue', 'report-publish-replacement',
    'reservation-validation', 'legacy-date-format', 'archive-test-coverage', 'quoted-csv-fields',
    'inventory-retry-idempotency', 'conflicting-calendar-visibility', 'unchanged-adjudication',
  ];
  for (const lang of ['ja', 'en']) {
    for (const caseId of cases) {
      const fixture = loadManagerCase(caseId, lang);
      assert.equal(fixture.turn, 'event');
      assert.equal(fixture.event.kind, 'patrol');
      assert.deepEqual(fixture.event.goalIds, [fixture.goal.id]);
      const run = fixture.readResults.find(({ tool }) => tool === 'takt_get_run');
      assert.ok(fixture.tasks.some(({ runSlug }) => runSlug === run.result.runSlug));
      assert.ok(Date.parse(run.result.currentStepStartedAt) <= Date.parse(fixture.event.kind === 'patrol' ? fixture.snapshotAt : fixture.event.createdAt));
      assert.ok(run.result.stepLogs.every(({ timestamp }) => Date.parse(timestamp) <= Date.parse(fixture.event.kind === 'patrol' ? fixture.snapshotAt : fixture.event.createdAt)));
      for (const entry of run.result.stepLogs.filter(({ step }) => ['fix', 'remediation'].includes(step))) {
        assert.doesNotMatch(runLogContent(fixture, run.result.runSlug, entry.index), /次の review|next review/i);
      }
      if (caseId !== 'conflicting-calendar-visibility') {
        const secondReview = run.result.stepLogs.filter(({ step }) => ['review', 'reviewers'].includes(step))[1];
        assert.match(runLogContent(fixture, run.result.runSlug, secondReview.index), lang === 'ja' ? /1周目.*残っている/ : /cycle 1.*remained unresolved/);
        const secondAdjudication = run.result.stepLogs.filter(({ step }) => step === 'review-adjudication')[1];
        assert.equal(secondAdjudication.status, 'done');
        assert.ok(Date.parse(secondReview.timestamp) < Date.parse(secondAdjudication.timestamp));
      }
      if (caseId === 'unchanged-adjudication') {
        assert.ok(run.result.stepLogs.filter(({ step }) => step === 'review-adjudication').length >= 2);
        const patrol = fixture.goal.workLog.find(({ kind }) => kind === 'patrol');
        assert.ok(patrol.summary.includes(run.result.runSlug));
        const latest = run.result.stepLogs.filter(({ step }) => step === 'review-adjudication').at(-1);
        assert.ok(Date.parse(latest.timestamp) < Date.parse(patrol.recordedAt));
        assert.equal(fixture.readResults.some(({ tool, arguments: args }) =>
          tool === 'takt_get_run' && args.view === 'report' && args.report === 'review-resolution.md'), false);
      } else {
        if (caseId === 'conflicting-calendar-visibility') {
          assert.equal(run.result.stepLogs.filter(({ step }) => step === 'review-adjudication').length, 1);
          const report = fixture.readResults.find(({ tool, arguments: args }) =>
            tool === 'takt_get_run' && args.view === 'report' && args.report === 'review-resolution.md').result.report.content;
          assert.match(report, lang === 'ja' ? /矛盾/ : /conflicts/);
        } else {
          for (const iteration of [1, 2]) {
            const logs = run.result.stepLogs.slice((iteration - 1) * 3, iteration * 3);
            const review = logs.find(({ step }) => ['review', 'reviewers'].includes(step));
            const adjudication = logs.find(({ step }) => step === 'review-adjudication');
            const repair = logs.find(({ step }) => ['fix', 'remediation'].includes(step));
            assert.ok(review && adjudication && repair, `${lang}/${caseId}: cycle ${iteration}`);
            assert.ok(Date.parse(review.timestamp) < Date.parse(adjudication.timestamp));
            assert.ok(Date.parse(adjudication.timestamp) < Date.parse(repair.timestamp));
          }
          if (caseId === 'mail-dispatch-state') {
            const peerReview = parse(readFileSync(new URL('../builtins/ja/workflows/peer-review.yaml', import.meta.url), 'utf8'));
            const cycle = peerReview.loop_monitors[0].cycle;
            assert.ok(cycle.every((step) => run.result.stepLogs.some((entry) => entry.step === step)));
          }
        }
        assert.ok(fixture.readResults.some(({ tool, arguments: args }) =>
          tool === 'takt_get_run' && args.view === 'report' && args.report === 'review-resolution.md'));
        assert.ok(fixture.readResults.some(({ tool, arguments: args }) =>
          tool === 'Read' && args.file_path.endsWith('goal-request.md')));
        assert.ok(fixture.readResults.some(({ tool, arguments: args }) =>
          tool === 'Read' && args.file_path.endsWith('project-policy.md')));
      }
      assert.equal(fixture.tasks.find(({ status }) => status === 'running')?.runSlug, run.result.runSlug);
    }
  }
});

test('data carryover includes the saved constraints and pending work through the production event input and reads', () => {
  for (const lang of ['ja', 'en']) {
    const fixture = loadManagerCase('constraint-carryover-data', lang);
    assert.equal(fixture.readResults.find(({ tool }) => tool === 'takt_get_goal').result.goal.workLogCount, fixture.goal.workLog.length);
    const request = fixture.readResults.find(({ tool }) => tool === 'Read').result;
    assert.deepEqual(request.acceptanceCriteria, fixture.goal.acceptanceCriteria);
    assert.deepEqual(request.constraints, fixture.goal.constraints);
    assert.deepEqual(request.work.map(({ workKey }) => workKey), ['channel-totals', 'report-export']);
    assert.deepEqual(fixture.readResults.find(({ arguments: args }) => args.path === 'acceptanceCriteria').result.items, fixture.goal.acceptanceCriteria);
    assert.deepEqual(fixture.readResults.find(({ arguments: args }) => args.path === 'constraints').result.items, fixture.goal.constraints);
    assert.equal(fixture.tasks[0].goalWorkKey, 'foundation');
    assert.ok(fixture.goal.workLog.some(({ summary }) => summary.includes('foundation') && summary.includes(fixture.tasks[0].completion.sha)));
    assert.equal(fixture.readResults.find(({ tool }) => tool === 'takt_get_goal_relation').result.goalBranch, fixture.goal.branch);
  }
});

test('already checked inventory results include git history and a completed verification run', () => {
  for (const lang of ['ja', 'en']) {
    const fixture = loadManagerCase('integration-already-checked', lang);
    const reader = fixture.tasks.find(({ name }) => name === 'result-2');
    const storage = fixture.tasks.find(({ name }) => name === 'result-1');
    const history = fixture.readResults.find(({ tool }) => tool === 'takt_get_goal_history');
    assert.ok(goalHistoryInputSchema.safeParse(history.arguments).success);
    assert.equal(history.arguments.taskName, reader.name);
    assert.equal(history.result.sourceBranch, reader.completion.branch);
    assert.equal(history.result.sourceSha, reader.completion.sha);
    assert.equal(history.result.truncated, false);
    assert.ok(history.result.commits.every(({ truncated }) => truncated === false));
    const shas = history.result.commits.map(({ sha }) => sha);
    assert.ok(shas.includes(storage.completion.sha));
    assert.ok(shas.includes(storage.completion.sha));
    const run = fixture.readResults.find(({ tool, arguments: args }) => tool === 'takt_get_run' && args.runSlug === reader.runSlug);
    assert.equal(run.result.status, 'completed');
    const taskRead = fixture.readResults.find(({ tool, arguments: args }) => tool === 'takt_get_run' && args.runSlug === reader.runSlug && args.view === 'task');
    assert.equal(taskRead.result.task.content, reader.goalPurpose);
    const report = fixture.readResults.find(({ tool, arguments: args }) => tool === 'takt_get_run' && args.runSlug === reader.runSlug && args.view === 'report').result.report.content;
    assert.ok(report.includes(reader.completion.sha));
    assert.match(report, lang === 'ja' ? /ビルドと.*結合テストが成功/ : /Build and integration tests passed/);
    assert.match(report, lang === 'ja' ? /保存して再起動後に読み込み/ : /save.*reload after restart/);
    const prompt = buildPrompt({ vars: { case: 'integration-already-checked', lang } });
    assert.ok(prompt.includes(JSON.stringify(fixture.readResults)));
  }
});

test('completion fixtures supply file patches and commit history through production read contracts', () => {
  for (const caseId of ['no-check-docs', 'no-check-same-module', 'integration-already-checked']) {
    for (const lang of ['ja', 'en']) {
      const fixture = loadManagerCase(caseId, lang);
      const relation = fixture.readResults.find(({ tool }) => tool === 'takt_get_goal_relation').result;
      const diffs = fixture.readResults.filter(({ tool }) => tool === 'takt_get_goal_diff');
      assert.ok(diffs.length > 0);
      for (const diff of diffs) {
        assert.ok(goalDiffInputSchema.safeParse(diff.arguments).success);
        assert.equal(diff.result.sourceBranch, fixture.goal.branch);
        assert.equal(diff.result.sourceSha, relation.goalSha);
        assert.equal(diff.result.comparisonSha, relation.targetSha);
        assert.equal(diff.result.truncated, false);
        assert.ok(diff.result.files.some(({ path }) => path === diff.arguments.file));
        assert.ok(diff.result.patch.includes(`+++ b/${diff.arguments.file}`));
      }
      const history = fixture.readResults.find(({ tool, arguments: args }) => tool === 'takt_get_goal_history' && args.taskName === undefined);
      assert.ok(goalHistoryInputSchema.safeParse(history.arguments).success);
      assert.equal(history.result.sourceSha, relation.goalSha);
      assert.equal(history.result.truncated, false);
      for (const task of fixture.tasks) {
        assert.ok(history.result.commits.some(({ sha }) => sha === task.completion.sha));
      }
      assert.equal(history.result.commits.length - 1, relation.ahead);
    }
  }
});

test('event fixtures use the production event envelope and goal/task reading contracts', () => {
  for (const { vars } of suite.tests) {
    const fixture = loadManagerCase(vars.case, vars.lang);
    if (fixture.turn !== 'event') continue;
    const goal = GoalSchema.parse(fixture.goal);
    const input = JSON.parse(buildManagerEventInput(fixture.cwd, fixture.event));
    const event = ['watch_observation', 'patrol'].includes(fixture.event.kind) ? fixture.event
      : managerInboxTurnEvent(fixture.cwd, ManagerEventSchema.parse(fixture.event));
    assert.deepEqual(input, JSON.parse(buildManagerEventPrompt(event)));
    parseDaemonProcessMessage({ kind: 'start_turn', protocolVersion: 1, launchId: 'fixture', input: {
      event: { eventId: 'event', requestId: 'event', conversationId: 'manager', operationId: 'turn', acceptedSequence: 1,
        lane: 'other', source: event.kind === 'patrol' ? 'daemon' : event.kind === 'watch_observation' ? 'watcher' : 'run', occurredAt: new Date().toISOString(), event },
      turn: { conversationId: 'manager', operationId: 'turn', generation: 1 },
      state: { version: 0, assignment: { kind: 'repository', repositoryDirectory: fixture.cwd },
        session: { provider: 'mock', model: null, sessionId: null }, revision: 0, pending: null, approval: null },
    } }, 'fixture');
    const readGoal = fixture.readResults.find(({ tool }) => tool === 'takt_get_goal').result.goal;
    assert.deepEqual(readGoal, goalSummary(goal));
    const tasks = fixture.readResults.find(({ tool }) => tool === 'takt_list_tasks').result;
    assert.equal(tasks.collection, 'tasks');
    assert.equal(tasks.totalCount, fixture.tasks.length);
    assert.equal(tasks.nextOffset, null);
    assert.deepEqual(tasks.tasks.map(({ name, status, runSlug }) => ({ name, status, runSlug })),
      fixture.tasks.map(({ name, status, runSlug }) => ({ name, status, runSlug })));
    assert.ok(tasks.tasks.every((task) => ['integrated', 'not_integrated', 'unknown'].includes(task.goalIntegration)));
    assert.ok(tasks.tasks.every((task) => !Object.hasOwn(task, 'completion') && !Object.hasOwn(task, 'failure')));
    const saved = fixture.readResults.find(({ tool, arguments: args }) => tool === 'Read' && args.file_path === `${fixture.cwd}/.takt/tasks.yaml`).result.tasks;
    for (const task of saved) assert.ok(TaskRecordSchema.safeParse(task).success);
    for (const path of ['acceptanceCriteria', 'constraints', 'outOfScope', 'workLog', 'questions']) {
      const read = fixture.readResults.find(({ arguments: args }) => args.path === path);
      assert.deepEqual(read.result.items, goal[path]);
      assert.equal(read.result.collection, 'items');
    }
  }
});

test('uses the exact production system assembly for each language', () => {
  const root = mkdtempSync(join(tmpdir(), 'takt-manager-prompt-test-'));
  const prior = process.env.TAKT_CONFIG_DIR;
  const omit = process.env.TAKT_EVAL_MANAGER_OMIT_CONCURRENCY;
  try {
    process.env.TAKT_CONFIG_DIR = root;
    delete process.env.TAKT_EVAL_MANAGER_OMIT_CONCURRENCY;
    mkdirSync(join(root, '.takt'));
    writeFileSync(join(root, '.takt', 'config.yaml'), 'provider: mock\nconcurrency: 3\nmanager:\n  default_workflow: default\n  main_merge: auto\n');
    invalidateGlobalConfigCache();
    for (const lang of ['ja', 'en']) {
      const fixture = { ...loadManagerCase('parallel-cli', lang), cwd: root };
      const production = createManagerConversationPlan(root, { language: lang });
      assert.equal(buildManagerSystemPrompt(fixture), production.strategy.systemPrompt);
    }
  } finally {
    preserveEnv('TAKT_CONFIG_DIR', prior);
    preserveEnv('TAKT_EVAL_MANAGER_OMIT_CONCURRENCY', omit);
    invalidateGlobalConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ignores global and project facet overrides and restores the environment on success and failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'takt-manager-overrides-test-'));
  const prior = process.env.TAKT_CONFIG_DIR;
  try {
    process.env.TAKT_CONFIG_DIR = root;
    for (const prefix of [root, join(root, '.takt')]) {
      for (const kind of ['personas', 'policies', 'knowledge', 'instructions']) {
        mkdirSync(join(prefix, 'facets', kind), { recursive: true });
        writeFileSync(join(prefix, 'facets', kind, 'manager.md'), `UNWANTED_OVERRIDE_${kind}`);
      }
      writeFileSync(join(prefix, 'config.yaml'), 'concurrency: 1\nmanager:\n  main_merge: approve\n');
    }
    const fixture = { ...loadManagerCase('parallel-cli', 'ja'), cwd: root };
    assert.doesNotMatch(buildManagerSystemPrompt(fixture), /UNWANTED_OVERRIDE_/);
    assert.equal(process.env.TAKT_CONFIG_DIR, root);
    assert.throws(() => buildManagerSystemPrompt({ ...fixture, lang: 'missing' }));
    assert.equal(process.env.TAKT_CONFIG_DIR, root);
  } finally {
    preserveEnv('TAKT_CONFIG_DIR', prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test('red mode removes only the Concurrency limit suffix', () => {
  const prior = process.env.TAKT_EVAL_MANAGER_OMIT_CONCURRENCY;
  try {
    const fixture = loadManagerCase('parallel-cli', 'en');
    delete process.env.TAKT_EVAL_MANAGER_OMIT_CONCURRENCY;
    const green = buildManagerSystemPrompt(fixture);
    process.env.TAKT_EVAL_MANAGER_OMIT_CONCURRENCY = '1';
    const red = buildManagerSystemPrompt(fixture);
    assert.equal(green, `${red}\n\nConcurrency limit: 3`);
  } finally { preserveEnv('TAKT_EVAL_MANAGER_OMIT_CONCURRENCY', prior); }
});

test('work contents, integrated verification and constraint cases receive semantic rubrics', () => {
  const semanticCases = new Set(['paused-requeue', 'paused-requeue-before-start', 'task-stopped-not-resumed', 'resumed-already-requeued', 'parallel-cli', 'parallel-docs-migration',
    'shared-resource', 'shared-definition', 'human-order', 'integration-check',
    'constraint-carryover', 'constraint-carryover-data', 'constraint-once',
    'summary-keeps-constraint', 'summary-keeps-constraint-web', 'summary-no-invented-constraint',
    'escalate-repeated-failure', 'escalate-not-on-first-failure',
    'mail-dispatch-state', 'local-config-tampering', 'offline-sync-queue',
    'report-publish-replacement', 'conflicting-calendar-visibility',
    'reservation-validation', 'legacy-date-format', 'archive-test-coverage', 'quoted-csv-fields', 'inventory-retry-idempotency',
    'verification-repeated', 'verification-once', 'verification-mixed', 'verification-told',
    'plan-missing', 'plan-dependent', 'plan-cancelled', 'plan-integrated', 'plan-queued', 'final-impact-tests',
    'stopped-background-check', 'integrated-task-verification', 'verification-before-integration',
    'stopped-background-execution', 'integrated-task-execution',
    'migration-method-event', 'migration-method-conversation', 'settled-operation-merge',
    'csv-export-scope-conversation', 'search-index-scope-conversation',
    'single-operation-request', 'migration-no-downtime', 'unidentified-goal', 'external-contract-limit']);
  for (const row of suite.tests) {
    assert.equal(row.assert?.[0]?.type === 'llm-rubric', semanticCases.has(row.vars.case));
    if (row.assert) assert.match(row.assert[0].value, row.vars.lang === 'ja'
      ? /^見出しや文言の一致ではなく、内容で判定する/ : /^Judge substance rather than headings or exact wording/);
  }
});

test('failure fixtures preserve attempts, revised instructions and causes through production event inputs', () => {
  for (const lang of ['ja', 'en']) {
    for (const caseId of ['escalate-repeated-failure', 'escalate-not-on-first-failure']) {
      const fixture = loadManagerCase(caseId, lang);
      const goal = GoalSchema.parse(fixture.goal);
        const input = JSON.parse(buildManagerEventInput(fixture.cwd, fixture.event));
      const failures = fixture.tasks.filter(({ completion }) => completion.success === false);
      assert.equal(failures.length, caseId === 'escalate-repeated-failure' ? 2 : 1);
      assert.equal(fixture.event.taskName, failures.at(-1).name);
      assert.equal(input.event.result.success, false);
      assert.equal(input.event.result.failureReason, fixture.event.result.failureReason);
      assert.equal(goal.executionStatus, 'active');
      for (const event of failures) {
        const task = fixture.tasks.find(({ name }) => name === event.name);
        assert.equal(task.completion.success, false);
        const run = fixture.readResults.find(({ tool, arguments: args }) => tool === 'takt_get_run' && args.runSlug === event.runSlug && args.view === 'report');
        assert.ok(run.result.report.content.length > 0);
      }
      if (caseId === 'escalate-repeated-failure') {
        const instruction = fixture.readResults.find(({ arguments: args }) => args.file_path?.endsWith('/order.md'));
        assert.ok(instruction.result.length > 0);
        assert.notEqual(failures[0].runSlug, failures[1].runSlug);
        assert.notEqual(failures[0].completion.failureReason, failures[1].completion.failureReason);
        const pending = fixture.readResults.find(({ tool }) => tool === 'Read').result.work;
        assert.deepEqual(pending.map(({ workKey }) => workKey), ['payment-check', 'checkout-guide', 'admin-copy']);
      }
    }
  }
});

test('instruction file switching preserves input, schemas and other facets in both languages', () => {
  const root = mkdtempSync(join(tmpdir(), 'takt-manager-instruction-test-'));
  const prior = process.env.TAKT_EVAL_MANAGER_INSTRUCTION_ROOT;
  try {
    delete process.env.TAKT_EVAL_MANAGER_INSTRUCTION_ROOT;
    for (const lang of ['ja', 'en']) {
      mkdirSync(join(root, lang));
      const instruction = readFileSync(new URL(`../builtins/${lang}/facets/instructions/manager.md`, import.meta.url), 'utf8');
      writeFileSync(join(root, lang, 'manager.md'), instruction);
      const vars = { case: 'plan-missing', lang };
      const green = buildPrompt({ vars });
      process.env.TAKT_EVAL_MANAGER_INSTRUCTION_ROOT = root;
      assert.equal(buildPrompt({ vars }), green);
      const marker = `INSTRUCTION_VARIANT_${lang}`;
      writeFileSync(join(root, lang, 'manager.md'), `${marker}\n${instruction}`);
      assert.equal(buildPrompt({ vars }).replace(`${marker}\n`, ''), green);
      assert.doesNotMatch(buildPrompt({ vars }), /\{\{include:/);
      delete process.env.TAKT_EVAL_MANAGER_INSTRUCTION_ROOT;
    }
    process.env.TAKT_EVAL_MANAGER_INSTRUCTION_ROOT = 'relative/path';
    assert.throws(() => buildPrompt({ vars: { case: 'plan-missing', lang: 'ja' } }), /absolute path/);
    process.env.TAKT_EVAL_MANAGER_INSTRUCTION_ROOT = join(root, 'missing');
    assert.throws(() => buildPrompt({ vars: { case: 'plan-missing', lang: 'ja' } }), /ENOENT/);
  } finally {
    preserveEnv('TAKT_EVAL_MANAGER_INSTRUCTION_ROOT', prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test('recorded main question rules and green workspace facets are exclusive in assembled prompts', () => {
  const root = mkdtempSync(join(tmpdir(), 'takt-manager-question-redgreen-'));
  const prior = facetEnvKeys.map((key) => [key, process.env[key]]);
  const newRuleMarkers = {
    ja: [
      '人に判断を求めるときは人宛ての質問を使い、',
      '人に届く質問・操作依頼・通知の本文には、理由と試したことの要約を書く。',
      '失敗の記録を確かめ、失敗した操作と、',
      '人の答えが必要な未決定事項があり、それを尋ねる未回答の質問がなければ、',
      '「停止したままにする」「あとで相談する」は、まだ決まっていない案の代わりにしない。',
      '選択肢と理由付きの推奨案も付ける。',
      '事実を答えてもらっただけで、その案を採ることの承認とみなさない。',
      '人にしか分からない、すでに決まっている事実や値',
      '何を決めるために必要か、何を調べても分からなかったかを本文に短く書く。',
      '人への新しい質問を takt_ask_goal_question で作る。',
      '選択肢を options に、推奨案と理由を recommendation に書く。',
      '推奨回答を示すのは、案から選んでもらう質問のときだけです。',
      '質問の直前に「推奨:」を文章で書く手順は、人の発言に応じるターンに適用します。',
      '会話や手元の情報から対象のリポジトリやゴールを特定できないときは、',
    ],
    en: [
      'Use a human-directed question when a decision is needed,',
      'Put a brief explanation of the reason and what you tried in the body of the question,',
      'check its records and include the operation that failed',
      "If an unresolved matter requires the person's answer and no unanswered question addresses that matter,",
      'Do not use "remain stopped" or "discuss later" as substitutes for the unresolved alternatives themselves.',
      'State which alternative each answer selects, and include the options and a recommendation with its reason.',
      'Do not treat an answer that only supplies a fact as approval to adopt an alternative.',
      'When an already established fact or value that only a person knows',
      'briefly state in its body what decision needs the information and what you checked without finding it.',
      'create new questions for the person with takt_ask_goal_question.',
      'put the options in options and the recommendation with its reason in recommendation.',
      'Present a recommended answer only for a question asking the person to choose among alternatives.',
      'Apply the step of writing "Recommended:" immediately before the question in turns responding to a person\'s message.',
      'If the target repository or goal cannot be identified from the conversation and available context,',
    ],
  };
  try {
    for (const lang of ['ja', 'en']) {
      const variants = prepareQuestionFacetVariants(root, lang);
      for (const key of facetEnvKeys) delete process.env[key];
      const prompts = {};
      for (const phase of ['red', 'green']) {
        process.env.TAKT_EVAL_MANAGER_POLICY_ROOT = join(root, phase, 'policies');
        process.env.TAKT_EVAL_MANAGER_INSTRUCTION_ROOT = join(root, phase, 'instructions');
        prompts[phase] = buildPrompt({ vars: { case: 'migration-method-event', lang } });
        for (const marker of newRuleMarkers[lang]) {
          assert.equal(prompts[phase].includes(marker), phase === 'green', `${lang}/${phase}: ${marker}`);
        }
        const other = phase === 'red' ? 'green' : 'red';
        const promptLines = new Set(prompts[phase].split('\n'));
        for (const bodies of Object.values(variants)) {
          const exclusive = bodies[phase].split('\n').filter((line) => line.trim() && !bodies[other].split('\n').includes(line));
          assert.ok(exclusive.length > 0);
          for (const line of exclusive) {
            assert.ok(promptLines.has(line), `${lang}/${phase}: includes chosen facet line`);
          }
          for (const line of bodies[other].split('\n').filter((line) => line.trim() && !bodies[phase].split('\n').includes(line))) {
            assert.ok(!promptLines.has(line), `${lang}/${phase}: excludes other facet line`);
          }
        }
        assert.doesNotMatch(prompts[phase], /\{\{include:/);
      }
      assert.equal(prompts.red.split('\n\nTOOLS:\n')[1], prompts.green.split('\n\nTOOLS:\n')[1]);
    }
    delete process.env.TAKT_EVAL_MANAGER_INSTRUCTION_ROOT;
    process.env.TAKT_EVAL_MANAGER_POLICY_ROOT = 'relative/path';
    assert.throws(() => buildPrompt({ vars: { case: 'migration-method-event', lang: 'ja' } }), /POLICY_ROOT must be an absolute path/);
    process.env.TAKT_EVAL_MANAGER_POLICY_ROOT = join(root, 'missing');
    assert.throws(() => buildPrompt({ vars: { case: 'migration-method-event', lang: 'ja' } }), /ENOENT/);
  } finally {
    prior.forEach(([key, value]) => preserveEnv(key, value));
    rmSync(root, { recursive: true, force: true });
  }
});

test('policy switching preserves all other prompt content in both languages', () => {
  const root = mkdtempSync(join(tmpdir(), 'takt-manager-policy-test-'));
  const prior = process.env.TAKT_EVAL_MANAGER_POLICY_ROOT;
  try {
    delete process.env.TAKT_EVAL_MANAGER_POLICY_ROOT;
    for (const lang of ['ja', 'en']) {
      mkdirSync(join(root, lang));
      const policy = readFileSync(new URL(`../builtins/${lang}/facets/policies/manager.md`, import.meta.url), 'utf8');
      const vars = { case: 'migration-method-event', lang };
      const original = buildPrompt({ vars });
      writeFileSync(join(root, lang, 'manager.md'), policy);
      process.env.TAKT_EVAL_MANAGER_POLICY_ROOT = root;
      assert.equal(buildPrompt({ vars }), original);
      const marker = `POLICY_VARIANT_${lang}`;
      writeFileSync(join(root, lang, 'manager.md'), `${marker}\n${policy}`);
      assert.equal(buildPrompt({ vars }).replace(`${marker}\n`, ''), original);
      delete process.env.TAKT_EVAL_MANAGER_POLICY_ROOT;
    }
  } finally {
    preserveEnv('TAKT_EVAL_MANAGER_POLICY_ROOT', prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test('question fixtures preserve the human input boundary and constraints', () => {
  for (const lang of ['ja', 'en']) {
    const event = loadManagerCase('migration-method-event', lang);
    const conversation = loadManagerCase('migration-method-conversation', lang);
    assert.equal(event.turn, 'event');
    assert.equal(conversation.turn, 'conversation');
    assert.ok(conversation.user.length > 0);
    assert.deepEqual(conversation.goal, event.goal);
    assert.deepEqual(conversation.readResults, event.readResults);
    const constrained = loadManagerCase('migration-no-downtime', lang);
    assert.deepEqual({ ...constrained.goal, constraints: [] }, event.goal);
    assert.equal(constrained.goal.constraints.length, 1);
    const unidentified = loadManagerCase('unidentified-goal', lang);
    assert.equal(unidentified.goal, undefined);
    assert.equal(unidentified.turn, 'conversation');
    assert.equal(new Set(unidentified.goals.map((candidate) => GoalSchema.parse(candidate).id)).size, 2);
    assert.deepEqual(unidentified.readResults[0].result.goals,
      unidentified.goals.map((candidate) => goalSummary(GoalSchema.parse(candidate))));
  }
});

test('scope consultations replay substantial investigation after the human request without inventing a registered goal', () => {
  for (const lang of ['ja', 'en']) {
    for (const caseId of ['csv-export-scope-conversation', 'search-index-scope-conversation']) {
      const fixture = loadManagerCase(caseId, lang);
      assert.equal(fixture.turn, 'conversation');
      assert.equal(fixture.expectedQuestionType, 'choice');
      assert.equal(fixture.goal, undefined);
      assert.deepEqual(fixture.tasks, []);
      const reads = fixture.readResults;
      assert.deepEqual(reads.map(({ tool }) => tool), [
        'takt_list_goals', 'takt_list_standalone_inquiries', 'Bash', 'Bash', 'Bash', 'Agent',
      ]);
      for (const [index, collection] of ['goals', 'inquiries'].entries()) {
        assert.deepEqual(reads[index].result, {
          [collection]: [], collection, totalCount: 0, returnedCount: 0,
          omittedCount: 0, offset: 0, nextOffset: null, truncated: false,
        });
      }
      const research = reads.slice(2);
      assert.ok(research.every(({ result }) => typeof result === 'string' && result.length > 0));
      assert.ok(research.reduce((total, read) => total + read.result.length, 0) > 6000,
        'Preserve the extended investigation rather than reducing it to a short comparison of alternatives');
      assert.equal(reads.at(-1).arguments.subagent_type, 'Explore');
      assert.match(reads.at(-1).result, /src\/.*:\d+/);
      const prompt = buildPrompt({ vars: { case: caseId, lang } });
      const input = prompt.split('\n\nUSER:\n')[1];
      assert.ok(input.startsWith(fixture.user));
      assert.ok(input.includes(JSON.stringify(reads)));
      assert.doesNotMatch(input, /llm-rubric|expectedQuestionType|\/Users\/|Slack|Webhook|合格|不合格/);
      const rows = suite.tests.filter(({ vars }) => vars.case === caseId && vars.lang === lang);
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].providers, ['codex-sol-low', 'claude-opus-5', 'codex-luna-max', 'codex-terra-medium']);
      assert.equal(rows[0].assert[0].type, 'llm-rubric');
    }
  }
});

test('settled-operation fixtures expose an answered method choice and a reviewed unintegrated completion', () => {
  for (const lang of ['ja', 'en']) {
    const fixture = loadManagerCase('settled-operation-merge', lang);
    const goal = GoalSchema.parse(fixture.goal);
    const event = ManagerEventSchema.parse(fixture.event);
    assert.equal(event.kind, 'completion');
    assert.equal(event.goalId, goal.id);
    assert.equal(fixture.tasks.length, 1);
    const task = fixture.tasks[0];
    assert.equal(event.taskName, task.name);
    assert.equal(event.runSlug, task.runSlug);
    assert.deepEqual(event.result, task.completion);
    assert.equal(task.status, 'completed');
    assert.equal(task.goalIntegration, 'not_integrated');
    assert.equal(event.result.success, true);
    assert.equal(goal.questions.length, 1);
    const question = goal.questions[0];
    assert.equal(question.kind, 'question');
    assert.equal(question.recipient, 'human');
    assert.equal(question.status, 'answered');
    assert.ok(question.answer.text.trim().length > 0);
    assert.equal(question.operation, undefined);
    assert.equal(question.answer.decision, undefined);
    assert.ok(Date.parse(question.answer.answeredAt) < Date.parse(task.createdAt));
    const review = fixture.readResults.find(({ tool, arguments: args }) => tool === 'Read'
      && args.file_path === `${fixture.cwd}/docs/ledger-review.md`);
    assert.ok(review.result.includes(task.completion.sha));
    const log = goal.workLog.find(({ summary }) => summary.includes(task.completion.sha));
    assert.ok(log);
    assert.ok(Date.parse(log.recordedAt) >= Date.parse(task.completedAt));
    assert.ok(Date.parse(log.recordedAt) <= Date.parse(event.createdAt));
    assert.deepEqual(fixture.readResults.find(({ tool, arguments: args }) => tool === 'takt_get_goal'
      && args.path === 'questions').result.items, goal.questions);
    const relation = fixture.readResults.find(({ tool }) => tool === 'takt_get_goal_relation');
    assert.ok(goalWriteInputSchema.safeParse(relation.arguments).success);
    assert.deepEqual(Object.keys(relation.result).sort(), ['ahead', 'goalBranch', 'goalSha', 'included', 'targetBranch', 'targetSha']);
    assert.notEqual(task.completion.sha, relation.result.goalSha);
    assert.notEqual(task.completion.sha, relation.result.targetSha);
  }
});

test('verification fixtures distinguish required checks, out-of-scope demands, real defects and prior instruction', () => {
  for (const lang of ['ja', 'en']) {
    for (const caseId of ['verification-repeated', 'verification-once', 'verification-mixed', 'verification-told']) {
      const fixture = loadManagerCase(caseId, lang);
      const run = fixture.readResults.find(({ tool, arguments: args }) => tool === 'takt_get_run' && args.view === undefined).result;
      const checks = run.stepLogs.filter(({ step, status }) => step === 'fix-verifier' && status === 'done');
      assert.equal(checks.length, caseId === 'verification-once' ? 1 : 2);
      assert.equal(new Set(checks.map(({ timestamp }) => timestamp)).size, checks.length);
      assert.ok(run.stepLogs.every((entry, index) => entry.index === index && !Object.hasOwn(entry, 'content')));
      assert.equal(Object.hasOwn(run, 'task'), false);
      const logReads = fixture.readResults.filter(({ tool, arguments: args }) => tool === 'takt_get_run' && args.view === 'log');
      assert.equal(logReads.length, checks.length);
      assert.deepEqual(logReads.map(({ arguments: args }) => args.stepIndex), checks.map(({ index }) => index));
      for (const check of checks) {
        const read = logReads.find(({ arguments: args }) => args.stepIndex === check.index);
        assert.deepEqual(getRunInputSchema.parse(read.arguments), {
          cwd: fixture.cwd, runSlug: run.runSlug, view: 'log', stepIndex: check.index,
        });
        const { log, ...metadata } = read.result;
        const { stepLogs: _stepLogs, reports: _reports, stepLogPage: _stepLogPage, reportPage: _reportPage, retrieval: _retrieval, ...runMetadata } = run;
        assert.deepEqual(metadata, runMetadata);
        const { content, totalBytes, offset, returnedBytes, direction, truncated, nextOffset, ...summary } = log;
        assert.deepEqual(summary, check);
        assert.ok(content.includes('IDX-17'));
        assert.equal(content.includes('IDX-22'), caseId === 'verification-mixed');
        assert.equal(content.includes('audioBlob'), caseId !== 'verification-repeated');
        assert.deepEqual({ totalBytes, offset, returnedBytes, direction, truncated, nextOffset }, {
          totalBytes: Buffer.byteLength(content), offset: 0, returnedBytes: Buffer.byteLength(content),
          direction: 'backward', truncated: false, nextOffset: null,
        });
      }
      assert.equal(run.stepLogs.filter(({ step }) => step === 'review-adjudication').length, 1);
      const patrol = fixture.goal.workLog.find(({ kind }) => kind === 'patrol');
      assert.ok(Date.parse(patrol.recordedAt) > Date.parse(run.stepLogs[0].timestamp));
      assert.ok(Date.parse(patrol.recordedAt) < Date.parse(checks[0].timestamp));
      assert.equal(run.reports.length, checks.length);
      assert.equal(fixture.goal.workLog.length, caseId === 'verification-told' ? 3 : 2);
      assert.equal(fixture.tasks.find(({ status }) => status === 'running').runSlug, run.runSlug);
    }
  }
});

test('plan fixtures store the plan in objective and integrations and cancellations in work records', () => {
  for (const lang of ['ja', 'en']) {
    for (const caseId of ['plan-missing', 'plan-dependent', 'plan-cancelled', 'plan-integrated', 'plan-queued']) {
      const fixture = loadManagerCase(caseId, lang);
      assert.equal(fixture.event.kind, 'completion');
      assert.equal(Object.hasOwn(fixture.goal, 'plan'), false);
      assert.ok(fixture.goal.objective.includes('5. usage-docs:'));
      const eventTask = fixture.tasks.find(({ name }) => name === fixture.event.taskName);
      assert.deepEqual(eventTask.completion, fixture.event.result);
      assert.ok(fixture.goal.workLog.some(({ summary }) => summary.includes(eventTask.completion.sha)));
      const foundation = fixture.goal.workLog.find(({ summary }) => summary.includes('result-1 (foundation)'));
      for (const task of fixture.tasks.filter(({ startedAt, goalWorkKey }) => startedAt && goalWorkKey !== 'foundation')) {
        assert.ok(Date.parse(task.startedAt) > Date.parse(foundation.recordedAt));
      }
      const docs = fixture.tasks.find(({ goalWorkKey }) => goalWorkKey === 'usage-docs');
      assert.equal(docs?.status, caseId === 'plan-integrated' ? 'completed' : caseId === 'plan-queued' ? 'pending' : undefined);
      if (docs?.startedAt) {
        const display = fixture.goal.workLog.find(({ summary }) => summary.includes('result-4 (display)'));
        assert.ok(Date.parse(docs.startedAt) > Date.parse(display.recordedAt));
      }
      if (caseId === 'plan-dependent') assert.equal(fixture.tasks.find(({ goalWorkKey }) => goalWorkKey === 'display').status, 'running');
      if (caseId === 'plan-cancelled') assert.ok(fixture.goal.workLog.some(({ summary }) => summary.includes('docs/index.md')));
    }
  }
});

test('final-check input contains direct and child-process consumers and unrelated tests as read results', () => {
  for (const lang of ['ja', 'en']) {
    const fixture = loadManagerCase('final-impact-tests', lang);
    const files = Object.fromEntries(fixture.readResults.filter(({ tool }) => tool === 'Read')
      .map(({ arguments: args, result }) => [args.file_path.replace(`${fixture.cwd}/`, ''), result]));
    assert.ok(fixture.goal.objective.includes('channel'));
    assert.ok(fixture.goal.acceptanceCriteria.some((criterion) => criterion.includes('channel')));
    assert.deepEqual(fixture.readResults.find(({ arguments: args }) => args.path === 'objective').result.content, fixture.goal.objective);
    const sessionTasks = fixture.tasks.filter(({ goalWorkKey }) => ['storage', 'commands', 'display'].includes(goalWorkKey));
    assert.equal(sessionTasks.length, 3);
    for (const task of sessionTasks) {
      assert.ok(fixture.goal.objective.includes(`${task.goalWorkKey}: ${task.goalPurpose}`));
    }
    assert.ok(files['changes.patch'].includes('src/daemon/session.ts'));
    assert.ok(files['src/__tests__/it-session-store.test.ts'].includes('../daemon/session.js'));
    assert.ok(files['src/__tests__/it-daemon-process.test.ts'].includes('dist/app/cli/index.js'));
    assert.ok(files['src/__tests__/it-daemon-conversations.test.ts'].includes('./helpers/daemon-fixture.js'));
    assert.ok(files['src/__tests__/helpers/daemon-fixture.ts'].includes('dist/app/cli/index.js'));
    assert.ok(files['src/daemon/store.ts'].includes('./session.js'));
    assert.ok(files['src/__tests__/it-session-colors.test.ts'].includes('../ui/session-colors.js'));
    assert.ok(files['src/__tests__/it-storage-export.test.ts'].includes('../storage/export.js'));
    assert.equal(fixture.readResults.some(({ tool }) => tool === 'Bash'), false);
  }
  assert.ok(suite.providers.some(({ config }) => config.model === 'gpt-6.1-terra' && config.reasoning_effort === 'medium'));
  assert.ok(suite.providers.some(({ config }) => config.model === 'gpt-6-luna' && config.reasoning_effort === 'max'));
});


test('pause cases reproduce saved failures, setup identities and current pending state in both languages', () => {
  for (const lang of ['ja', 'en']) {
    for (const caseId of ['paused-requeue', 'paused-requeue-before-start', 'task-stopped-not-resumed', 'resumed-already-requeued']) {
      const fixture = loadManagerCase(caseId, lang);
      const input = JSON.parse(buildManagerEventInput(fixture.cwd, fixture.event));
      assert.equal(fixture.event.kind, 'completion');
      assert.equal(input.event.kind, 'task_failed');
      assert.equal(input.event.result.interrupted, true);
      assert.equal(fixture.goal.executionStatus, 'active');
      const task = fixture.readResults.find(({ tool }) => tool === 'takt_list_tasks').result.tasks[0];
      const saved = fixture.readResults.find(({ tool, arguments: args }) => tool === 'Read' && args.file_path.endsWith('/tasks.yaml')).result.tasks[0];
      if (caseId === 'resumed-already-requeued') {
        assert.equal(task.status, 'pending');
        assert.equal(saved.failure, undefined);
        assert.equal(saved.completion, undefined);
        assert.equal(task.runSlug, undefined);
        assert.equal(saved.source_run_slug, fixture.event.runSlug);
        continue;
      }
      assert.equal(task.status, 'failed');
      assert.deepEqual(saved.completion, input.event.result);
      assert.equal(saved.failure.error, input.event.result.failureReason);
      if (caseId === 'task-stopped-not-resumed') {
        assert.match(saved.failure.error, /^Task booking-validation execution 650e8400-e29b-41d4-a716-446655440082 was stopped by manager$/);
        assert.equal(saved.failure.retryable, false);
      } else {
        assert.equal(saved.failure.error, `Goal ${fixture.goal.id} was paused`);
        assert.notEqual(saved.failure.retryable, false);
      }
      if (caseId === 'paused-requeue-before-start') {
        assert.match(input.event.task.runSlug, /^setup-[0-9a-f-]{36}$/);
        assert.equal(task.runSlug, undefined);
        assert.equal(saved.run_slug, undefined);
        assert.equal(saved.worktree_path, undefined);
        assert.equal(input.event.result.workflowResult, 'error');
        assert.equal(input.event.result.sha, undefined);
        assert.equal(input.event.result.shaUnavailableReason, 'Workflow execution did not start');
      } else {
        assert.equal(input.event.result.workflowResult, 'aborted');
        assert.equal(task.runSlug, fixture.event.runSlug);
      }
    }
  }
});

test('pause cases use production read-tool arguments and paginated run summaries', async () => {
  const schemas = await import('../dist/features/mcp/schemas.js');
  const readSchemas = {
    takt_get_goal: schemas.getGoalInputSchema,
    takt_list_tasks: schemas.listTasksInputSchema,
    takt_get_run: schemas.getRunInputSchema,
    takt_get_goal_relation: schemas.goalWriteInputSchema,
    takt_list_workflows: schemas.listGoalsInputSchema.omit({ errorOffset: true }),
    takt_list_goal_questions: schemas.listGoalQuestionsInputSchema,
    takt_list_standalone_inquiries: schemas.listStandaloneInquiriesInputSchema,
  };
  for (const lang of ['ja', 'en']) {
    for (const caseId of ['paused-requeue', 'paused-requeue-before-start', 'task-stopped-not-resumed', 'resumed-already-requeued']) {
      const fixture = loadManagerCase(caseId, lang);
      for (const read of fixture.readResults) {
        if (!read.tool.startsWith('takt_')) continue;
        assert.ok(readSchemas[read.tool]?.safeParse(read.arguments).success, `${lang}/${caseId}/${read.tool}`);
        if (read.tool === 'takt_get_run' && read.arguments.view === undefined) {
          for (const [field, collection] of [['stepLogPage', 'stepLogs'], ['reportPage', 'reports']]) {
            assert.equal(read.result[field].collection, collection);
            assert.equal(read.result[field].returnedCount, read.result[collection].length);
            assert.equal(read.result[field].nextOffset, null);
          }
          assert.ok(read.result.reports.every((report) => !Object.hasOwn(report, 'content')));
        }
      }
    }
  }
});

test('operation fixtures provide current git state and run evidence before required writes', () => {
  for (const lang of ['ja', 'en']) {
    for (const caseId of ['settled-operation-merge', 'migration-no-downtime']) {
      const fixture = loadManagerCase(caseId, lang);
      const reads = fixture.readResults;
      const bash = (command) => reads.find((read) => read.tool === 'Bash' && read.arguments.command === command)?.result;
      assert.equal(bash(`git -C ${fixture.cwd} status --short --branch`), '## main\n');
      assert.match(bash(`git -C ${fixture.cwd} rev-parse ${fixture.goal.branch}`), /^[a-f0-9]{40}\n$/);
      const listed = reads.find(({ tool }) => tool === 'takt_list_tasks').result;
      assert.ok(listed.tasks.every((task) => task.error === undefined));
      const inquiries = reads.find(({ tool }) => tool === 'takt_list_standalone_inquiries').result;
      assert.equal(inquiries.totalCount, 0);
      assert.equal(inquiries.nextOffset, null);
      if (caseId === 'migration-no-downtime') {
        assert.deepEqual(listed.tasks, []);
        continue;
      }
      const task = fixture.tasks[0];
      assert.equal(bash(`git -C ${task.worktreePath} rev-parse ${task.branch}`).trim(), fixture.event.result.sha);
      assert.equal(bash(`git -C ${task.worktreePath} status --short --branch`), `## ${task.branch}\n`);
      const run = reads.find(({ tool, arguments: args }) => tool === 'takt_get_run' && args.view === undefined);
      assert.ok(getRunInputSchema.safeParse(run.arguments).success);
      assert.equal(run.result.runSlug, task.runSlug);
      assert.equal(run.result.status, 'completed');
      assert.equal(run.result.currentStep, listed.tasks[0].currentStep);
      const report = reads.find(({ tool, arguments: args }) => tool === 'takt_get_run' && args.view === 'report');
      assert.ok(getRunInputSchema.safeParse(report.arguments).success);
      assert.equal(report.result.runSlug, task.runSlug);
      assert.equal(report.result.report.truncated, false);
      assert.ok(report.result.report.content.length > 0);
    }
  }
});


test('patrol replay uses the production event prompt including unreadable goals', () => {
  for (const lang of ['ja', 'en']) {
    const fixture = loadManagerCase('mail-dispatch-state', lang);
    const event = { ...fixture.event, unreadableGoalIds: ['650e8400-e29b-41d4-a716-446655440099'] };
    const replay = buildManagerEventInput(fixture.cwd, event);
    assert.equal(replay, buildManagerEventPrompt(event));
    assert.deepEqual(JSON.parse(replay).event, event);
    assert.notEqual(JSON.parse(replay).instruction, JSON.parse(buildManagerEventInput(fixture.cwd, {
      kind: 'registered', goalId: fixture.goal.id, createdAt: fixture.snapshotAt,
    })).instruction);
  }
});
