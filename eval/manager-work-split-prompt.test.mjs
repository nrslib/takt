import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { parse } from 'yaml';
import buildPrompt, { buildManagerSystemPrompt, loadManagerCase } from './manager-work-split-prompt.mjs';
import { createManagerConversationPlan } from '../dist/features/manager/conversationPlan.js';
import { buildGoalTurnContext, buildManagerGoalSummary } from '../dist/features/manager/turnContext.js';
import { GoalSchema } from '../dist/infra/goals/schema.js';
import { ManagerEventSchema } from '../dist/infra/goals/events.js';
import { invalidateGlobalConfigCache } from '../dist/infra/config/global/globalConfig.js';
import { getRunInputSchema, goalDiffInputSchema, goalHistoryInputSchema, recordGoalWorkLogInputSchema, tellGoalRunInputSchema } from '../dist/features/mcp/schemas.js';

const suite = parse(readFileSync(new URL('./scenarios/manager-work-split/manager-work-split.yaml', import.meta.url), 'utf8'));
const preserveEnv = (key, prior) => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; };
const inheritedInstructionRoot = process.env.TAKT_EVAL_MANAGER_INSTRUCTION_ROOT;
delete process.env.TAKT_EVAL_MANAGER_INSTRUCTION_ROOT;
after(() => preserveEnv('TAKT_EVAL_MANAGER_INSTRUCTION_ROOT', inheritedInstructionRoot));

test('assembles all 76 turn prompts without a provider call, excluding scoring conditions', (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  assert.equal(suite.tests.length, 76);
  for (const { vars } of suite.tests) {
    const fixture = loadManagerCase(vars.case, vars.lang);
    const prompt = buildPrompt({ vars });
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
    if (fixture.turn === 'conversation') assert.ok(prompt.includes(`USER:\n${fixture.user}`));
    else {
      const user = prompt.split('USER:\n')[1].split('\n\n')[0];
      const context = JSON.parse(user);
      assert.equal(context.goal.id, fixture.goal.id);
      assert.deepEqual(ManagerEventSchema.parse(context.event), fixture.event);
      assert.equal(context.tasks[0].startedAt, fixture.tasks[0].startedAt);
      assert.deepEqual(context.goal, buildManagerGoalSummary(fixture.cwd, GoalSchema.parse(fixture.goal), fixture.tasks));
      const readGoal = fixture.readResults.find(({ tool }) => tool === 'takt_get_goal').result.goal;
      assert.deepEqual(GoalSchema.parse(readGoal), GoalSchema.parse(fixture.goal));

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
  assert.equal(Date.parse(later.event.createdAt) - Date.parse(earlier.event.createdAt), 24 * 60 * 60 * 1000);
  const prompt = buildLaterPrompt({ vars: { case: 'mail-dispatch-state', lang: 'ja' } });
  const context = JSON.parse(prompt.split('USER:\n')[1].split('\n\n')[0]);
  assert.ok(Math.abs(Date.parse(context.patrol.observedAt) - Date.parse(context.event.createdAt)) < 1000);
  assert.deepEqual(context.event, later.event);
});

test('patrol fixtures include repeated repair history, source documents and the latest adjudication report', () => {
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
      const run = fixture.readResults.find(({ tool }) => tool === 'takt_get_run');
      const context = JSON.parse(buildGoalTurnContext(fixture.cwd, GoalSchema.parse(fixture.goal), fixture.event, fixture.tasks));
      assert.ok(Math.abs(Date.parse(context.patrol.observedAt) - Date.parse(fixture.event.createdAt)) < 60000);
      assert.ok(Date.parse(run.result.currentStepStartedAt) <= Date.parse(fixture.event.createdAt));
      assert.ok(run.result.stepLogs.every(({ timestamp }) => Date.parse(timestamp) <= Date.parse(fixture.event.createdAt)));
      for (const entry of run.result.stepLogs.filter(({ step }) => ['fix', 'remediation'].includes(step))) {
        assert.doesNotMatch(entry.content, /次の review|next review/i);
      }
      if (caseId !== 'conflicting-calendar-visibility') {
        const secondReview = run.result.stepLogs.find(({ step, iteration }) => ['review', 'reviewers'].includes(step) && iteration === 2);
        assert.match(secondReview.content, lang === 'ja' ? /1周目.*残っている/ : /cycle 1.*remained unresolved/);
        const secondAdjudication = run.result.stepLogs.find(({ step, iteration }) => step === 'review-adjudication' && iteration === 2);
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
          tool === 'Read' && args.file_path.endsWith('review-resolution.md')), false);
      } else {
        if (caseId === 'conflicting-calendar-visibility') {
          assert.equal(run.result.stepLogs.filter(({ step }) => step === 'review-adjudication').length, 1);
          const report = fixture.readResults.find(({ tool, arguments: args }) =>
            tool === 'Read' && args.file_path.endsWith('review-resolution.md')).result;
          assert.match(report, lang === 'ja' ? /矛盾/ : /conflicts/);
        } else {
          for (const iteration of [1, 2]) {
            const logs = run.result.stepLogs.filter((entry) => entry.iteration === iteration && entry.status === 'done');
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
          tool === 'Read' && args.file_path.endsWith('review-resolution.md')));
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
    const context = JSON.parse(buildGoalTurnContext(fixture.cwd, GoalSchema.parse(fixture.goal), fixture.event, fixture.tasks));
    assert.equal(context.goal.id, fixture.goal.id);
    assert.equal(context.goal.workLogCount, fixture.goal.workLog.length);
    const request = fixture.readResults.find(({ tool }) => tool === 'Read').result;
    assert.deepEqual(request.acceptanceCriteria, fixture.goal.acceptanceCriteria);
    assert.deepEqual(request.constraints, fixture.goal.constraints);
    assert.deepEqual(request.work.map(({ workKey }) => workKey), ['channel-totals', 'report-export']);
    const readGoal = fixture.readResults.find(({ tool }) => tool === 'takt_get_goal').result.goal;
    assert.deepEqual(readGoal.acceptanceCriteria, fixture.goal.acceptanceCriteria);
    assert.deepEqual(readGoal.constraints, fixture.goal.constraints);
    assert.equal(fixture.tasks[0].goalWorkKey, 'foundation');
    assert.ok(fixture.goal.workLog.some(({ summary }) => summary.includes('foundation') && summary.includes(fixture.tasks[0].completion.sha)));
    assert.equal(fixture.readResults.find(({ tool }) => tool === 'takt_get_goal_relation').result.goalBranch, fixture.goal.branch);
  }
});

test('already checked inventory results include git history and a completed verification run', () => {
  for (const lang of ['ja', 'en']) {
    const fixture = loadManagerCase('integration-already-checked', lang);
    const goal = GoalSchema.parse(fixture.goal);
    const context = JSON.parse(buildGoalTurnContext(fixture.cwd, goal, fixture.event, fixture.tasks));
    const reader = context.tasks.find(({ name }) => name === 'result-2');
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
    assert.equal(run.result.task, reader.goalPurpose);
    const report = run.result.reports[0].content;
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

test('event fixtures carry production goal memory, inbox events and current task state', () => {
  for (const { vars } of suite.tests) {
    const fixture = loadManagerCase(vars.case, vars.lang);
    if (fixture.turn !== 'event') continue;
    const goal = GoalSchema.parse(fixture.goal);
    const event = ManagerEventSchema.parse(fixture.event);
    const context = JSON.parse(buildGoalTurnContext(fixture.cwd, goal, event, fixture.tasks));
    assert.deepEqual(context.goal, buildManagerGoalSummary(fixture.cwd, goal, fixture.tasks));
    assert.deepEqual(context.event, event);
    assert.deepEqual(context.tasks, fixture.tasks);
    assert.equal(context.references.goal, `${fixture.cwd}/.takt/goals/${goal.id}/goal.json`);
    assert.equal(context.references.tasks, `${fixture.cwd}/.takt/tasks.yaml`);
    const readGoal = fixture.readResults.find(({ tool }) => tool === 'takt_get_goal').result.goal;
    assert.deepEqual(GoalSchema.parse(readGoal), goal);
    assert.ok(goal.workLog.some(({ summary }) => fixture.tasks.some((task) => task.completion !== undefined && summary.includes(task.completion.sha))));
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
  const semanticCases = new Set(['parallel-cli', 'parallel-docs-migration',
    'shared-resource', 'shared-definition', 'human-order', 'integration-check',
    'constraint-carryover', 'constraint-carryover-data', 'constraint-once',
    'summary-keeps-constraint', 'summary-keeps-constraint-web', 'summary-no-invented-constraint',
    'escalate-repeated-failure', 'escalate-not-on-first-failure',
    'mail-dispatch-state', 'local-config-tampering', 'offline-sync-queue',
    'report-publish-replacement', 'conflicting-calendar-visibility',
    'reservation-validation', 'legacy-date-format', 'archive-test-coverage', 'quoted-csv-fields', 'inventory-retry-idempotency',
    'verification-repeated', 'verification-once', 'verification-mixed', 'verification-told',
    'plan-missing', 'plan-dependent', 'plan-cancelled', 'plan-integrated', 'plan-queued', 'final-impact-tests']);
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
      const context = JSON.parse(buildGoalTurnContext(fixture.cwd, goal, fixture.event, fixture.tasks));
      const failures = context.tasks.filter(({ completion }) => completion.success === false);
      assert.equal(failures.length, caseId === 'escalate-repeated-failure' ? 2 : 1);
      assert.equal(fixture.event.taskName, failures.at(-1).name);
      assert.equal(context.event.result.success, false);
      assert.equal(context.event.result.failureReason, fixture.event.result.failureReason);
      assert.equal(goal.executionStatus, 'active');
      for (const event of failures) {
        const task = context.tasks.find(({ name }) => name === event.name);
        assert.equal(task.completion.success, false);
        const run = fixture.readResults.find(({ tool, result }) => tool === 'takt_get_run' && result.runSlug === event.runSlug);
        assert.ok(run.result.reports[0].content.length > 0);
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

test('verification fixtures distinguish separate finished checks, a single check, mixed causes and prior instruction', () => {
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
        const { stepLogs: _stepLogs, reports: _reports, ...runMetadata } = run;
        assert.deepEqual(metadata, runMetadata);
        const { content, totalBytes, offset, returnedBytes, direction, truncated, nextOffset, ...summary } = log;
        assert.deepEqual(summary, check);
        assert.ok(content.includes('IDX-17'));
        assert.equal(content.includes('IDX-22'), caseId === 'verification-mixed');
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
    assert.equal(fixture.readResults.find(({ tool }) => tool === 'takt_get_goal').result.goal, fixture.goal);
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
