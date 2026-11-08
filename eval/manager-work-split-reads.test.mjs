import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { loadRunSessionPage } from '../dist/features/interactive/runSessionReader.js';
import { resolveRetryMetadataFromRunMeta } from '../dist/core/workflow/run/retry-metadata.js';
import { getRunInputSchema } from '../dist/features/mcp/schemas.js';
import { getTaktRun, listTaktTasks } from '../dist/features/mcp/operations.js';
import { requeueTaktGoalTask, retryTaktGoalTask } from '../dist/features/mcp/goalTaskRetryOperations.js';
import { resolveTaskOrderContent } from '../dist/features/tasks/orderRevision.js';
import { issueTellableRunningTask } from '../dist/features/tasks/liveIntervention.js';
import { GoalStore } from '../dist/infra/goals/store.js';
import { TaskStore } from '../dist/infra/task/store.js';
import { StandaloneInquiryStore } from '../dist/infra/goals/standalone-inquiries.js';
import { invalidateGlobalConfigCache } from '../dist/infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../dist/infra/config/index.js';
import { managerStateReads } from './manager-work-split-reads.mjs';
import { listTaktStandaloneInquiries } from '../dist/features/mcp/standaloneInquiryOperations.js';

const suite = parse(readFileSync(new URL('./scenarios/manager-work-split/manager-work-split.yaml', import.meta.url), 'utf8'));
const fixtures = suite.tests.map(({ vars }) => ({ ...vars,
  fixture: parse(readFileSync(new URL(`./cases/manager-work-split/${vars.case}.yaml`, import.meta.url), 'utf8'))[vars.lang],
}));
const pauseCases = new Set(['paused-requeue', 'paused-requeue-before-start', 'task-stopped-not-resumed', 'resumed-already-requeued']);

function fixturePath(cwd, fixture, path) {
  const suffix = relative(fixture.cwd, path);
  assert.ok(!suffix.startsWith('..'));
  return join(cwd, suffix);
}

function saveRun(cwd, fixture, artifact) {
  const directory = fixturePath(cwd, fixture, artifact.directory);
  const { meta } = artifact;
  for (const path of [meta.logsDirectory, meta.reportDirectory]) mkdirSync(join(directory, path), { recursive: true });
  writeFileSync(join(directory, meta.runRoot, 'meta.json'), JSON.stringify(meta));
  writeFileSync(join(directory, meta.logsDirectory, 'session.jsonl'), artifact.sessionLog.map((record) => JSON.stringify(record)).join('\n'));
  for (const report of artifact.reports) {
    const path = join(directory, meta.reportDirectory, report.filename);
    mkdirSync(dirname(path), { recursive: true });
    // Size-only observations reveal no report body to reconstruct.
    writeFileSync(path, report.content === undefined ? Buffer.alloc(report.sizeBytes) : report.content);
  }
}

function saveTasks(cwd, fixture) {
  const records = managerStateReads(fixture).find(({ tool, arguments: args }) => tool === 'Read' && args.file_path.endsWith('/tasks.yaml')).result.tasks;
  const tasks = records.map((record) => ({ ...record,
    ...(record.worktree_path === undefined ? {} : { worktree_path: fixturePath(cwd, fixture, record.worktree_path) }),
  }));
  for (const [index, record] of tasks.entries()) {
    if (record.worktree_path !== undefined) mkdirSync(record.worktree_path, { recursive: true });
    const directory = join(cwd, record.task_dir);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'order.md'), fixture.tasks[index].goalPurpose);
  }
  new TaskStore(cwd).update(() => ({ tasks }));
  return tasks;
}

function assertRunTimeline(artifact, task) {
  const { meta, sessionLog } = artifact;
  assert.equal(sessionLog[0].type, 'workflow_start');
  assert.equal(sessionLog[0].startTime, meta.startTime);
  assert.equal(meta.startTime, task.startedAt);
  let previous = Date.parse(meta.startTime);
  let iteration = 0;
  let active;
  let lastStarted;
  let ended = false;
  for (const record of sessionLog.slice(1)) {
    assert.equal(ended, false, 'A run cannot emit records after its terminal event');
    const timestamp = Date.parse(record.timestamp ?? record.endTime);
    assert.ok(Number.isFinite(timestamp) && timestamp >= previous, 'Run records must be in time order');
    previous = timestamp;
    if (record.type === 'step_start') {
      assert.equal(active, undefined, 'A sequential step must finish before the next starts');
      assert.equal(record.iteration, ++iteration, 'Iteration increments for each step start');
      active = record;
      lastStarted = record;
    } else if (record.type === 'step_complete') {
      assert.ok(active, 'A step completion needs a matching start');
      assert.equal(record.step, active.step);
      assert.equal(record.iteration, active.iteration);
      active = undefined;
    } else {
      assert.ok(['workflow_complete', 'workflow_abort'].includes(record.type));
      if (record.type === 'workflow_complete') assert.equal(active, undefined);
      assert.equal(record.endTime, meta.endTime);
      assert.equal(record.endTime, task.completedAt);
      assert.equal(record.iterations, iteration);
      ended = true;
    }
  }
  assert.equal(ended, meta.status !== 'running');
  if (meta.currentStep !== undefined) {
    assert.ok(lastStarted);
    assert.equal(meta.currentStep, lastStarted.step);
    assert.equal(meta.currentIteration, lastStarted.iteration);
  }
  if (meta.status === 'running') {
    assert.ok(active, 'A running fixture must have an unfinished step');
    assert.equal(meta.currentIteration, active.iteration);
    assert.equal(meta.currentStep, active.step);
    assert.equal(meta.endTime, undefined);
  }
}

function compareReportOrder(value) {
  if (value.reports === undefined) return value;
  return { ...value, reports: [...value.reports].sort((left, right) => left.filename.localeCompare(right.filename)) };
}

test('all event fixtures preserve workflow descriptions and generate complete production list pages', () => {
  let checked = 0;
  for (const { case: caseId, lang, fixture } of fixtures) {
    if (fixture.turn !== 'event') continue;
    const reads = managerStateReads(fixture);
    for (const original of fixture.readResults.filter(({ tool }) => tool === 'takt_list_workflows')) {
      const read = reads.find(({ tool, arguments: args }) => tool === original.tool
        && JSON.stringify(args) === JSON.stringify(original.arguments));
      const { workflows, ...page } = read.result;
      assert.deepEqual(workflows, original.result.workflows, `${caseId}/${lang}`);
      assert.deepEqual(page, { collection: 'workflows', totalCount: workflows.length, returnedCount: workflows.length,
        omittedCount: 0, offset: 0, nextOffset: null, truncated: false }, `${caseId}/${lang}`);
      checked++;
    }
  }
  assert.ok(checked > 50);
});

test('workflow replay lists honor the production default limit and explicit continuation offsets', () => {
  const fixture = fixtures.find(({ case: caseId, lang }) => caseId === 'paused-requeue-before-start' && lang === 'en').fixture;
  const workflows = Array.from({ length: 51 }, (_, index) => ({ name: `workflow-${index}`, description: `Work ${index}` }));
  for (const { parameters, expectedNames, page } of [
    { parameters: {}, expectedNames: workflows.slice(0, 50).map(({ name }) => name),
      page: { returnedCount: 50, omittedCount: 1, offset: 0, nextOffset: 50, truncated: true } },
    { parameters: { offset: 1, limit: 2 }, expectedNames: ['workflow-1', 'workflow-2'],
      page: { returnedCount: 2, omittedCount: 49, offset: 1, nextOffset: 3, truncated: true } },
    { parameters: { offset: 50, limit: 2 }, expectedNames: ['workflow-50'],
      page: { returnedCount: 1, omittedCount: 50, offset: 50, nextOffset: null, truncated: true } },
    { parameters: { offset: 51, limit: 2 }, expectedNames: [],
      page: { returnedCount: 0, omittedCount: 51, offset: 51, nextOffset: null, truncated: true } },
  ]) {
    const paginated = { ...fixture, readResults: [{ tool: 'takt_list_workflows',
      arguments: { cwd: fixture.cwd, ...parameters }, result: { workflows } }] };
    const read = managerStateReads(paginated).find(({ tool }) => tool === 'takt_list_workflows');
    const { workflows: selected, ...actualPage } = read.result;
    assert.deepEqual(selected.map(({ name }) => name), expectedNames);
    assert.deepEqual(actualPage, { collection: 'workflows', totalCount: 51, ...page });
  }
});

test('operation fixtures expose the production empty pending standalone inquiry page', async () => {
  const root = mkdtempSync(join(tmpdir(), 'takt-manager-inquiry-contract-'));
  try {
    const native = await listTaktStandaloneInquiries({ cwd: root }, root,
      { kind: 'repository', repositoryDirectory: root });
    assert.notEqual(native.isError, true);
    for (const { case: caseId, fixture } of fixtures) {
      if (!['settled-operation-merge', 'migration-no-downtime'].includes(caseId)) continue;
      const reads = managerStateReads(fixture);
      const inquiries = reads.find(({ tool }) => tool === 'takt_list_standalone_inquiries');
      assert.deepEqual(inquiries.result, JSON.parse(native.content[0].text));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('standalone inquiry replay supplies production defaults and preserves explicit metadata', () => {
  const fixture = fixtures.find(({ case: caseId, lang }) => caseId === 'settled-operation-merge' && lang === 'en').fixture;
  const inquiries = [
    { body: 'Which goal?' },
    { body: 'Which repository?', createdAt: '2026-11-01T00:00:00.000Z' },
    { kind: 'operation_request', body: 'Configure access.' },
    { kind: 'question', body: 'Which method?', createdAt: '2026-11-02T00:00:00.000Z' },
  ].map((inquiry, index) => ({ id: `650e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`,
    recipient: 'human', status: 'pending', ...inquiry }));
  const original = structuredClone(inquiries);
  const replay = managerStateReads({ ...fixture, readResults: [{ tool: 'takt_list_standalone_inquiries',
    arguments: { cwd: fixture.cwd }, result: { inquiries } }] }).find(({ tool }) => tool === 'takt_list_standalone_inquiries').result;
  assert.deepEqual(replay.inquiries, [
    { ...inquiries[0], kind: 'question', createdAt: null },
    { ...inquiries[1], kind: 'question' },
    { ...inquiries[2], createdAt: null },
    inquiries[3],
  ]);
  assert.deepEqual(inquiries, original);
});

test('standalone inquiry replay matches nonempty production pages with default and explicit pagination', async () => {
  const root = mkdtempSync(join(tmpdir(), 'takt-manager-inquiry-pages-'));
  try {
    const owner = { kind: 'repository', repositoryDirectory: root };
    const store = new StandaloneInquiryStore(root, owner);
    const inquiries = [];
    for (let index = 0; index < 51; index++) inquiries.push(await store.create({ body: `Question ${index}` }));
    inquiries.sort((left, right) => left.id.localeCompare(right.id));
    const fixture = fixtures.find(({ case: caseId, lang }) => caseId === 'settled-operation-merge' && lang === 'en').fixture;
    for (const { parameters, start, end, page } of [
      { parameters: {}, start: 0, end: 50,
        page: { returnedCount: 50, omittedCount: 1, offset: 0, nextOffset: 50, truncated: true } },
      { parameters: { offset: 1, limit: 2 }, start: 1, end: 3,
        page: { returnedCount: 2, omittedCount: 49, offset: 1, nextOffset: 3, truncated: true } },
      { parameters: { offset: 50, limit: 2 }, start: 50, end: 51,
        page: { returnedCount: 1, omittedCount: 50, offset: 50, nextOffset: null, truncated: true } },
      { parameters: { offset: 51, limit: 2 }, start: 51, end: 51,
        page: { returnedCount: 0, omittedCount: 51, offset: 51, nextOffset: null, truncated: true } },
    ]) {
      const native = await listTaktStandaloneInquiries({ cwd: root, ...parameters }, root, owner);
      assert.notEqual(native.isError, true);
      const replay = managerStateReads({ ...fixture, readResults: [{ tool: 'takt_list_standalone_inquiries',
        arguments: { cwd: fixture.cwd, ...parameters }, result: { inquiries } }] })
        .find(({ tool }) => tool === 'takt_list_standalone_inquiries').result;
      assert.deepEqual(replay, JSON.parse(native.content[0].text));
      assert.deepEqual(replay, { inquiries: inquiries.slice(start, end), collection: 'inquiries', totalCount: 51, ...page });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every event fixture lists the saved specification and run metadata in the production response shape', async () => {
  const root = mkdtempSync(join(tmpdir(), 'takt-manager-task-list-contract-'));
  try {
    for (const { case: caseId, lang, fixture } of fixtures) {
      if (fixture.turn !== 'event') continue;
      const cwd = join(root, caseId, lang);
      saveTasks(cwd, fixture);
      for (const artifact of fixture.runArtifacts ?? []) saveRun(cwd, fixture, artifact);
      const response = await listTaktTasks({ cwd }, { allowedProjectRoot: cwd });
      assert.notEqual(response.isError, true, response.content[0].text);
      const native = JSON.parse(response.content[0].text);
      const replay = managerStateReads(fixture).find(({ tool }) => tool === 'takt_list_tasks').result;
      // Commit reachability is declared in the replay. This comparison covers every other production field.
      const withoutIntegration = ({ goalIntegration: _integration, goalIntegrationReason: _reason, ...task }) => task;
      assert.deepEqual({ ...replay, tasks: replay.tasks.map(withoutIntegration) },
        { ...native, tasks: native.tasks.map(withoutIntegration) }, `${caseId}/${lang}`);
      for (const [index, task] of fixture.tasks.entries()) {
        if (task.status === 'running') assert.match(task.executionId, /^[0-9a-f-]{36}$/);
        if (task.status !== 'completed' || task.completion?.sha === undefined) {
          assert.equal(replay.tasks[index].goalIntegration, native.tasks[index].goalIntegration);
        }
        for (const key of ['taskDir', 'workflow', 'summary', ...(task.status === 'running'
          ? ['executionId', 'ownerPid', 'worktreePath', 'runSlug'] : [])]) {
          const missing = structuredClone(fixture);
          delete missing.tasks[index][key];
          assert.throws(() => managerStateReads(missing), `${caseId}/${lang}/${key}`);
        }
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('all fixture run reads match the production paged reader over saved artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'takt-manager-run-contract-'));
  try {
    let checked = 0;
    for (const { case: caseId, lang, fixture } of fixtures) {
      const reads = fixture.readResults?.filter(({ tool }) => tool === 'takt_get_run');
      if (reads === undefined || reads.length === 0) continue;
      const cwd = join(root, caseId, lang);
      saveTasks(cwd, fixture);
      for (const artifact of fixture.runArtifacts) {
        const task = fixture.tasks.find((task) => task.runSlug === artifact.meta.runSlug);
        assertRunTimeline(artifact, task);
        if (task.status === 'failed') {
          const metadata = resolveRetryMetadataFromRunMeta(artifact.meta);
          assert.equal(task.startStep, metadata.startStep);
          assert.deepEqual(task.resumePoint, metadata.resumePoint);
          assert.equal(task.exceededCurrentIteration, metadata.currentIteration);
        }
        saveRun(cwd, fixture, artifact);
      }
      for (const read of reads) {
        const args = getRunInputSchema.parse(read.arguments);
        const response = getTaktRun({ ...args, cwd }, { allowedProjectRoot: cwd });
        assert.notEqual(response.isError, true, response.content[0].text);
        const actual = JSON.parse(response.content[0].text);
        const artifact = fixture.runArtifacts.find((artifact) => artifact.meta.runSlug === args.runSlug);
        assert.equal(artifact.directory, fixture.tasks.find((task) => task.runSlug === args.runSlug).worktreePath ?? fixture.cwd);
        assert.deepEqual(actual, { runSlug: args.runSlug, ...loadRunSessionPage(fixturePath(cwd, fixture, artifact.directory), args.runSlug, { ...args, maxBytes: 4096 }) });
        assert.deepEqual(compareReportOrder(actual), compareReportOrder(read.result), `${caseId}/${lang}/${args.runSlug}/${args.view ?? 'summary'}`);
        checked++;
      }
    }
    assert.ok(checked > 100);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finished tasks require an explicit completion time and preserve it in saved-task reads', () => {
  for (const { fixture } of fixtures) {
    if (fixture.turn !== 'event') continue;
    const records = managerStateReads(fixture).find(({ tool, arguments: args }) => tool === 'Read' && args.file_path.endsWith('/tasks.yaml')).result.tasks;
    for (const [index, task] of fixture.tasks.entries()) {
      assert.equal(records[index].worktree, task.worktree);
      assert.equal(records[index].worktree_path, task.worktreePath);
      for (const [saved, field] of Object.entries({ task_dir: 'taskDir', workflow: 'workflow', summary: 'summary',
        start_step: 'startStep', resume_point: 'resumePoint', restart_point: 'restartPoint',
        source_resume_point: 'sourceResumePoint', retry_note: 'retryNote', slug: 'slug',
        exceeded_current_iteration: 'exceededCurrentIteration', stop_request: 'stopRequest' })) {
        assert.deepEqual(records[index][saved], task[field]);
      }
      assert.equal(records[index].content, undefined);
      if (['pending', 'running'].includes(task.status)) {
        assert.equal(records[index].completed_at, null);
        continue;
      }
      assert.ok(Number.isFinite(Date.parse(task.completedAt)));
      assert.equal(records[index].completed_at, task.completedAt);
      const missing = structuredClone(fixture);
      delete missing.tasks[index].completedAt;
      assert.throws(() => managerStateReads(missing));
    }
  }
});

test('task completion, integration records and new pause-case run evidence follow execution order', () => {
  for (const { case: caseId, lang, fixture } of fixtures) {
    if (fixture.turn !== 'event') continue;
    for (const task of fixture.tasks) {
      const label = `${caseId}/${lang}/${task.name}`;
      if (task.startedAt !== undefined) assert.ok(Date.parse(task.createdAt) <= Date.parse(task.startedAt), label);
      if (task.completedAt !== undefined) {
        assert.ok(Date.parse(task.startedAt) <= Date.parse(task.completedAt), label);
        for (const record of fixture.goal.workLog.filter(({ summary }) => task.status === 'completed' && summary.includes(task.completion.sha))) {
          assert.ok(Date.parse(task.completedAt) <= Date.parse(record.recordedAt), label);
        }
      }
      if (fixture.event.taskName === task.name && task.completedAt !== undefined) {
        assert.ok(Date.parse(task.completedAt) <= Date.parse(fixture.event.createdAt), label);
      }
      if (!pauseCases.has(caseId)) continue;
      const summaries = fixture.readResults.filter(({ tool, arguments: args }) => tool === 'takt_get_run' && args.view === undefined && args.runSlug === task.runSlug);
      for (const { result: run } of summaries) {
        assert.ok(Date.parse(task.startedAt) <= Date.parse(run.currentStepStartedAt), label);
        assert.ok(Date.parse(run.currentStepStartedAt) < Date.parse(task.completedAt), label);
        for (const log of run.stepLogs) {
          assert.ok(Date.parse(task.startedAt) <= Date.parse(log.timestamp), label);
          assert.ok(Date.parse(log.timestamp) <= Date.parse(run.currentStepStartedAt), label);
        }
      }
      for (const { result } of fixture.readResults.filter(({ tool, arguments: args }) => tool === 'takt_get_run' && args.view === 'report' && args.runSlug === task.runSlug)) {
        const timestamps = result.report.content.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g);
        assert.equal(timestamps.length, 4, label);
        assert.deepEqual(timestamps, [...timestamps].sort(), label);
        assert.equal(timestamps.at(-1), task.completedAt, label);
      }
    }
  }
});

test('invalid saved execution timelines are rejected without synthesizing replacement starts', () => {
  const { fixture } = fixtures.find(({ case: caseId, lang }) => caseId === 'conflicting-calendar-visibility' && lang === 'en');
  const task = fixture.tasks.find(({ status }) => status === 'running');
  const artifact = fixture.runArtifacts[0];
  assert.equal(artifact.meta.currentStep, 'fix');
  assert.equal(artifact.meta.currentIteration, 3);
  for (const mutate of [
    (value) => { value.meta.currentStep = 'review'; value.meta.currentIteration = 1; },
    (value) => { value.sessionLog.find(({ type, step }) => type === 'step_start' && step === 'review-adjudication').iteration = 1; },
    (value) => { value.sessionLog.find(({ type }) => type === 'step_complete').timestamp = '2026-10-11T23:02:00.000Z'; },
    (value) => { value.sessionLog.push({ ...value.sessionLog.at(-1), iteration: 4 }); },
  ]) {
    const invalid = structuredClone(artifact);
    mutate(invalid);
    assert.throws(() => assertRunTimeline(invalid, task));
  }
  const stopped = fixtures.find(({ case: caseId, lang }) => caseId === 'paused-requeue' && lang === 'en').fixture;
  const afterEnd = structuredClone(stopped.runArtifacts[0]);
  afterEnd.sessionLog.push({ type: 'step_start', step: 'review', persona: 'reviewer', iteration: 4, timestamp: '2026-11-01T00:11:00.000Z' });
  assert.throws(() => assertRunTimeline(afterEnd, stopped.tasks[0]));
  const lateCompletion = structuredClone(stopped.runArtifacts[0]);
  lateCompletion.sessionLog.find(({ type }) => type === 'step_complete').timestamp = '2026-11-01T00:12:00.000Z';
  assert.throws(() => assertRunTimeline(lateCompletion, stopped.tasks[0]));
});

const git = (args) => execFileSync('git', args, { stdio: 'pipe', encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });

function cloneWorkingLocations(cwd, fixture, source) {
  for (const task of fixture.tasks) {
    if (task.worktreePath === undefined) continue;
    const path = fixturePath(cwd, fixture, task.worktreePath);
    mkdirSync(dirname(path), { recursive: true });
    git(['clone', '--quiet', source, path]);
    const branch = task.branch;
    assert.equal(typeof branch, 'string');
    git(['-C', path, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    assert.equal(git(['-C', path, 'rev-parse', '--is-inside-work-tree']).trim(), 'true');
  }
}

test('patrol fixtures support real run retrieval and all accepted live instructions from valid clones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'takt-manager-tell-contract-'));
  const required = new Set(['local-config-tampering', 'offline-sync-queue',
    'report-publish-replacement', 'verification-once', 'verification-mixed', 'unrelated-history-repair']);
  const optional = new Set(['reservation-validation', 'legacy-date-format', 'archive-test-coverage',
    'quoted-csv-fields', 'inventory-retry-idempotency', 'conflicting-calendar-visibility', 'existing-invoice-format', 'mail-dispatch-state',
    'local-terminal-test-repair', 'local-pytest-config-repair', 'local-env-failure-left-as-is']);
  try {
    const source = join(root, 'source.git');
    git(['init', '--bare', '--quiet', '--initial-branch=main', source]);
    let inspected = 0;
    let instructed = 0;
    let optionallyInstructed = 0;
    for (const { case: caseId, lang, fixture } of fixtures) {
      if (fixture.event?.kind !== 'patrol') continue;
      const cwd = join(root, caseId, lang);
      const task = fixture.tasks.find(({ status }) => status === 'running');
      assert.equal(task.worktree, true);
      cloneWorkingLocations(cwd, fixture, source);
      const records = saveTasks(cwd, fixture);
      const record = records.find(({ name }) => name === task.name);
      assert.equal(record.worktree, true);
      assert.equal(record.worktree_path, fixturePath(cwd, fixture, task.worktreePath));
      for (const artifact of fixture.runArtifacts) {
        assert.equal(artifact.directory, fixture.tasks.find(({ runSlug }) => runSlug === artifact.meta.runSlug).worktreePath);
        saveRun(cwd, fixture, artifact);
      }
      const response = getTaktRun({ cwd, runSlug: task.runSlug }, { allowedProjectRoot: cwd });
      assert.notEqual(response.isError, true, response.content[0].text);
      assert.deepEqual(compareReportOrder(JSON.parse(response.content[0].text)), compareReportOrder(fixture.readResults.find(({ tool, arguments: args }) => tool === 'takt_get_run' && args.view === undefined).result));
      const listed = await listTaktTasks({ cwd }, { allowedProjectRoot: cwd });
      assert.notEqual(listed.isError, true, listed.content[0].text);
      const nativeTask = JSON.parse(listed.content[0].text).tasks.find(({ name }) => name === task.name);
      const replayTask = managerStateReads(fixture).find(({ tool }) => tool === 'takt_list_tasks').result.tasks.find(({ name }) => name === task.name);
      for (const key of ['name', 'status', 'runSlug', 'workflow', 'currentStep']) assert.equal(replayTask[key], nativeTask[key], `${caseId}/${lang}/${key}`);
      inspected++;
      if (required.has(caseId) || optional.has(caseId)) {
        const sent = await issueTellableRunningTask(cwd, task.runSlug, 'Keep the original criteria and apply the recorded repair decision.');
        assert.equal(sent.target.worktreePath, record.worktree_path);
        assert.equal(sent.target.task.executionId, task.executionId);
        assert.equal(sent.instructionId, 1);
        if (required.has(caseId)) instructed++;
        else optionallyInstructed++;
      }
    }
    assert.equal(inspected, 40);
    assert.equal(instructed, 12);
    assert.equal(optionallyInstructed, 22);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pause fixtures, including before-start interruptions, and first failures accept MCP retry operations and preserve the production record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'takt-manager-requeue-contract-'));
  const previousConfig = process.env.TAKT_CONFIG_DIR;
  const previousWebhook = process.env.TAKT_NOTIFY_WEBHOOK;
  try {
    const config = join(root, 'config');
    mkdirSync(join(config, 'workflows'), { recursive: true });
    process.env.TAKT_CONFIG_DIR = config;
    process.env.TAKT_NOTIFY_WEBHOOK = '';
    writeFileSync(join(config, 'config.yaml'), 'language: en\nprovider: mock\nmanager:\n  auto_run: false\n');
    writeFileSync(join(config, 'workflows', 'worker.md'), 'Execute the assigned work.');
    for (const workflow of ['pause-replay', 'csv-import-replay']) writeFileSync(join(config, 'workflows', `${workflow}.yaml`), [
      `name: ${workflow}`, 'initial_step: plan', 'max_steps: 6', 'steps:',
      ...['plan', 'implement', 'review'].flatMap((step, index) => [
        `  - name: ${step}`, '    persona: ./worker.md', '    instruction: "{task}"',
        '    rules:', '      - condition: when(true)', `        next: ${['implement', 'review', 'COMPLETE'][index]}`,
      ]),
    ].join('\n'));
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    const source = join(root, 'source.git');
    git(['init', '--bare', '--quiet', '--initial-branch=main', source]);
    for (const { case: caseId, lang, fixture } of fixtures) {
      if (!['paused-requeue', 'paused-requeue-before-start', 'escalate-not-on-first-failure'].includes(caseId)) continue;
      const cwd = join(root, caseId, lang);
      cloneWorkingLocations(cwd, fixture, source);
      const saved = saveTasks(cwd, fixture);
      for (const artifact of fixture.runArtifacts ?? []) saveRun(cwd, fixture, artifact);
      await new GoalStore(cwd).create(fixture.goal);
      const target = saved.find(({ name }) => name === fixture.event.taskName);
      const order = resolveTaskOrderContent(cwd, target.task_dir, '');
      if (caseId === 'paused-requeue-before-start') {
        assert.equal(saved[0].worktree, true);
        assert.equal(saved[0].run_slug, undefined);
        assert.equal(saved[0].worktree_path, undefined);
        assert.match(fixture.event.runSlug, /^setup-/);
        new TaskStore(cwd).update(() => ({ tasks: saved.map((task) => ({ ...task, worktree: undefined })) }));
        const rejected = await requeueTaktGoalTask({ cwd, goalId: fixture.goal.id, taskName: target.name },
          { allowedProjectRoot: cwd }, new AbortController().signal);
        assert.equal(rejected.isError, true);
        assert.equal(new TaskStore(cwd).read().tasks[0].status, 'failed');
      }
      const operations = caseId === 'paused-requeue-before-start' ? [{ startStep: undefined }, { startStep: 'plan' }]
        : caseId === 'escalate-not-on-first-failure'
          ? ['retry', 'requeue'].flatMap((tool) => [undefined, 'plan', 'implement', 'review'].map((startStep) => ({ tool, startStep })))
          : [{ tool: 'requeue' }];
      for (const { tool, startStep } of operations) {
        new TaskStore(cwd).update(() => ({ tasks: saved }));
        const retry = tool === 'retry';
        const revised = 'Read docs/sales-csv.md and data/sales_sample.csv; implement sales/loader.py using sale_date, amount, channel and the existing date format, then verify loading and input validation with sample data.';
        const action = retry ? retryTaktGoalTask : requeueTaktGoalTask;
        const result = await action({ cwd, goalId: fixture.goal.id, taskName: target.name,
          ...(startStep === undefined ? {} : { startStep }),
          ...(retry ? { task: revised } : caseId === 'escalate-not-on-first-failure' ? { retryNote: revised } : {}) },
          { allowedProjectRoot: cwd }, new AbortController().signal);
        assert.notEqual(result.isError, true, result.content[0].text);
        assert.equal(JSON.parse(result.content[0].text).status, 'pending');
        const pending = new TaskStore(cwd).read().tasks.find(({ name }) => name === target.name);
        assert.equal(pending.status, 'pending');
        assert.equal(pending.task_dir, target.task_dir);
        if (tool !== 'retry') assert.equal(resolveTaskOrderContent(cwd, pending.task_dir, ''), order);
        else assert.match(resolveTaskOrderContent(cwd, pending.task_dir, ''), /docs\/sales-csv.md/);
        assert.equal(pending.run_slug, undefined);
        if (caseId === 'paused-requeue-before-start') {
          assert.equal(pending.source_run_slug, undefined);
          assert.equal(pending.worktree_path, undefined);
          assert.equal(pending.worktree, true);
          assert.equal(pending.resume_point, undefined);
          assert.equal(pending.resume_mode, undefined);
          assert.equal(pending.restart_point?.stack[0]?.step, 'plan');
        } else assert.equal(pending.source_run_slug, fixture.event.runSlug);
        if (caseId === 'paused-requeue') {
          const resumed = fixtures.find((entry) => entry.case === 'resumed-already-requeued' && entry.lang === lang).fixture;
          const expected = managerStateReads(resumed).find(({ tool, arguments: args }) => tool === 'Read' && args.file_path.endsWith('/tasks.yaml')).result.tasks[0];
          assert.deepEqual(JSON.parse(JSON.stringify({ ...pending, worktree_path: target.worktree_path })),
            JSON.parse(JSON.stringify({ ...expected, worktree_path: target.worktree_path })));
        }
        // Retry may revise order.md; restore this fixture's original order before checking another accepted operation.
        writeFileSync(join(cwd, target.task_dir, 'order.md'), order);
      }
    }
  } finally {
    if (previousConfig === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfig;
    if (previousWebhook === undefined) delete process.env.TAKT_NOTIFY_WEBHOOK;
    else process.env.TAKT_NOTIFY_WEBHOOK = previousWebhook;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test('normalizing saved state reads preserves a single tasks artifact across replay input kinds', () => {
  const fixture = fixtures.find(({ case: caseId, lang }) => caseId === 'human-quotes-review-stop' && lang === 'ja').fixture;
  const first = managerStateReads(fixture);
  const second = managerStateReads({ ...fixture, readResults: first });
  assert.deepEqual(second, first);
  assert.equal(second.filter(({ tool, arguments: args }) => tool === 'Read' && args.file_path === `${fixture.cwd}/.takt/tasks.yaml`).length, 1);
});
