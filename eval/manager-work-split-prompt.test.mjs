import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import buildPrompt, { buildManagerSystemPrompt, loadManagerCase } from './manager-work-split-prompt.mjs';
import { createManagerConversationPlan } from '../dist/features/manager/conversationPlan.js';
import { buildGoalTurnContext } from '../dist/features/manager/turnContext.js';
import { GoalSchema } from '../dist/infra/goals/schema.js';
import { prepareGoalOperation } from '../dist/infra/goals/operations.js';
import { invalidateGlobalConfigCache } from '../dist/infra/config/global/globalConfig.js';
import { goalDiffInputSchema, goalHistoryInputSchema } from '../dist/features/mcp/schemas.js';

const suite = parse(readFileSync(new URL('./scenarios/manager-work-split/manager-work-split.yaml', import.meta.url), 'utf8'));
const preserveEnv = (key, prior) => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; };

test('assembles all 34 turn prompts without a provider call, excluding scoring conditions', () => {
  assert.equal(suite.tests.length, 34);
  for (const { vars } of suite.tests) {
    const fixture = loadManagerCase(vars.case, vars.lang);
    const prompt = buildPrompt({ vars });
    assert.match(prompt, /SYSTEM:\n/);
    assert.doesNotMatch(prompt, /\{\{include:/);
    assert.ok(prompt.includes(`Concurrency limit: ${fixture.concurrency}`));
    assert.ok(prompt.includes(`Repository: ${JSON.stringify(fixture.cwd)}`));
    assert.ok(prompt.includes('"task"'));
    assert.ok(prompt.includes(JSON.stringify(fixture.readResults)));
    assert.doesNotMatch(prompt, /llm-rubric|manager-work-split\/operations|Expected \d+\.\.|見出しや文言の一致ではなく、内容で判定する|Judge substance rather than headings/);
    if (fixture.turn === 'conversation') assert.ok(prompt.includes(`USER:\n${fixture.user}`));
    else {
      const user = prompt.split('USER:\n')[1].split('\n\n')[0];
      const context = JSON.parse(user);
      assert.equal(context.goal.id, fixture.goal.id);
      assert.equal(context.event.id, fixture.event.id);
      assert.equal(context.tasks[0].startedAt, fixture.tasks[0].startedAt);
      if (vars.case === 'constraint-carryover') {
        assert.ok(context.omissions.acceptanceCriteria.omitted > 0 || context.omissions.acceptanceCriteria.truncated);
      }
    }
  }
});

test('data carryover includes the saved constraints and pending work through the production event input and reads', () => {
  for (const lang of ['ja', 'en']) {
    const fixture = loadManagerCase('constraint-carryover-data', lang);
    const context = JSON.parse(buildGoalTurnContext(fixture.cwd, GoalSchema.parse(fixture.goal), fixture.event, fixture.tasks));
    assert.deepEqual(context.goal.acceptanceCriteria, fixture.goal.acceptanceCriteria);
    const request = fixture.readResults.find(({ tool }) => tool === 'Read').result;
    assert.deepEqual(request.acceptanceCriteria, fixture.goal.acceptanceCriteria);
    assert.deepEqual(request.work.map(({ workKey }) => workKey), ['channel-totals', 'report-export']);
    assert.deepEqual(fixture.goal.workUnits.map(({ workKey }) => workKey), ['foundation']);
    assert.equal(fixture.goal.workUnits[0].integration.status, 'merged');
    assert.equal(fixture.readResults.find(({ tool }) => tool === 'takt_get_goal_relation').result.goalBranch, fixture.goal.branch);
  }
});

test('already checked inventory results include integration history and a completed verification run', () => {
  for (const lang of ['ja', 'en']) {
    const fixture = loadManagerCase('integration-already-checked', lang);
    const goal = GoalSchema.parse(fixture.goal);
    const context = JSON.parse(buildGoalTurnContext(fixture.cwd, goal, fixture.event, fixture.tasks));
    const reader = context.tasks.find(({ name }) => name === 'result-2');
    const storage = goal.workUnits.find(({ taskName }) => taskName === 'result-1');
    assert.ok(reader.startedAt > storage.integration.recordedAt);
    const history = fixture.readResults.find(({ tool }) => tool === 'takt_get_goal_history');
    assert.ok(goalHistoryInputSchema.safeParse(history.arguments).success);
    assert.equal(history.arguments.taskName, reader.name);
    assert.equal(history.result.sourceBranch, reader.completion.branch);
    assert.equal(history.result.sourceSha, reader.completion.sha);
    assert.equal(history.result.truncated, false);
    assert.ok(history.result.commits.every(({ truncated }) => truncated === false));
    const shas = history.result.commits.map(({ sha }) => sha);
    assert.ok(shas.includes(storage.integration.goalSha));
    assert.ok(shas.includes(storage.integration.expectedSha));
    const run = fixture.readResults.find(({ tool, arguments: args }) => tool === 'takt_get_run' && args.runSlug === reader.references.runSlug);
    assert.equal(run.result.status, 'completed');
    assert.equal(run.result.task, goal.workUnits.find(({ taskName }) => taskName === reader.name).purpose);
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

test('event fixtures use production saved operations accepted by buildGoalTurnContext', () => {
  for (const { vars } of suite.tests) {
    const fixture = loadManagerCase(vars.case, vars.lang);
    if (fixture.turn !== 'event') continue;
    const goal = GoalSchema.parse(fixture.goal);
    const context = JSON.parse(buildGoalTurnContext(fixture.cwd, goal, fixture.event, fixture.tasks));
    assert.ok(goal.operations.length > 0);
    for (const saved of goal.operations) {
      for (const key of ['cwd', 'goalId', 'operationName']) {
        assert.equal(Object.hasOwn(saved.arguments, key), false);
      }
      const production = prepareGoalOperation({ ...goal, operations: [] },
        { goalId: goal.id, eventId: saved.eventId }, saved.operationName, saved.tool, saved.arguments);
      assert.equal(saved.id, production.id);
      assert.deepEqual(saved.arguments, production.arguments);
      const task = fixture.tasks.find(({ name }) => name === saved.arguments.taskName);
      const unit = goal.workUnits.find(({ taskName }) => taskName === saved.arguments.taskName);
      if (saved.tool === 'integrate') {
        assert.ok(task?.completion);
        assert.ok(unit?.integration);
        assert.equal(saved.arguments.expectedSha, task.completion.sha);
        assert.deepEqual(saved.result, {
          status: 'merged', sha: unit.integration.goalSha,
          sourceBranch: task.completion.branch, expectedSha: saved.arguments.expectedSha,
          targetBranch: goal.branch, recorded: true,
        });
      } else {
        assert.equal(saved.tool, 'enqueue');
        const enqueued = fixture.tasks.find(({ name }) => name === saved.result.taskName);
        assert.ok(enqueued);
        assert.ok(goal.workUnits.some(({ taskName, workKey }) => taskName === enqueued.name && workKey === saved.arguments.workKey));
        assert.equal(saved.result.tasksFile, enqueued.filePath);
        assert.equal(saved.result.workflow, saved.arguments.workflow);
      }
      assert.ok(goal.events.some(({ id }) => id === saved.eventId));
      const operation = context.goal.operations.find(({ id }) => id === saved.id);
      if (saved.eventId === fixture.event.id || saved.status !== 'completed') {
        assert.ok(operation);
        assert.deepEqual(operation.arguments, saved.arguments);
        assert.equal(operation.operationName, saved.operationName);
        assert.deepEqual(operation.result, saved.result);
      } else {
        assert.equal(operation, undefined);
      }
      const readGoal = fixture.readResults.find(({ tool }) => tool === 'takt_get_goal').result.goal;
      assert.deepEqual(readGoal.operations, fixture.goal.operations);
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
  const semanticCases = new Set(['parallel-cli', 'parallel-docs-migration',
    'shared-resource', 'shared-definition', 'human-order', 'integration-check',
    'constraint-carryover', 'constraint-carryover-data', 'constraint-once',
    'summary-keeps-constraint', 'summary-keeps-constraint-web', 'summary-no-invented-constraint',
    'escalate-repeated-failure', 'escalate-not-on-first-failure']);
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
      const failures = goal.events.filter(({ kind, result }) => kind === 'completion' && result.success === false);
      assert.equal(failures.length, caseId === 'escalate-repeated-failure' ? 2 : 1);
      assert.equal(fixture.event.id, failures.at(-1).id);
      assert.equal(context.event.result.success, false);
      assert.equal(context.event.result.failureReason, fixture.event.result.failureReason);
      assert.equal(goal.executionStatus, 'active');
      for (const event of failures) {
        const task = context.tasks.find(({ name }) => name === event.taskName);
        assert.equal(task.completion.success, false);
        const run = fixture.readResults.find(({ tool, result }) => tool === 'takt_get_run' && result.runSlug === event.runSlug);
        assert.ok(run.result.reports[0].content.length > 0);
      }
      if (caseId === 'escalate-repeated-failure') {
        assert.equal(failures[0].processed, true);
        assert.equal(failures[1].processed, false);
        const retry = goal.operations.find(({ tool }) => tool === 'enqueue');
        assert.equal(retry.eventId, failures[0].id);
        assert.equal(retry.result.taskName, failures[1].taskName);
        const instruction = fixture.readResults.find(({ arguments: args }) => args.file_path?.endsWith('/order.md'));
        assert.equal(instruction.result, retry.arguments.task);
        const pending = fixture.readResults.find(({ tool }) => tool === 'Read').result.work;
        assert.deepEqual(pending.map(({ workKey }) => workKey), ['payment-check', 'checkout-guide', 'admin-copy']);
      }
    }
  }
});
