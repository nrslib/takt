import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/types.js';
import { isStaleRunningTask } from '../infra/task/index.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { initNdjsonLog } from '../infra/fs/index.js';
import { getSessionStatePath } from '../infra/config/project/sessionState.js';
import { createUsageEventLogger } from '../core/logging/usageEventLogger.js';
import {
  initDebugLogger,
  resetDebugLogger,
  setVerboseConsole,
} from '../shared/utils/debug.js';
import {
  OTEL_SESSION_SHADOW_LOG_FILE_SUFFIX,
  PHASE_USAGE_EVENTS_LOG_FILE_SUFFIX,
  PROMPT_LOG_FILE_SUFFIX,
  PROVIDER_EVENTS_LOG_FILE_SUFFIX,
} from '../core/logging/contracts.js';

const {
  mockConfirm,
  mockSuccess,
  mockWarn,
  mockLogError,
  mockForceFailRunningTask,
  mockRunnerProjectDir,
  mockSpawn,
  mockWorkerOnce,
  mockWorkerUnref,
} = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockSuccess: vi.fn(),
  mockWarn: vi.fn(),
  mockLogError: vi.fn(),
  mockForceFailRunningTask: vi.fn(),
  mockRunnerProjectDir: vi.fn(),
  mockSpawn: vi.fn(),
  mockWorkerOnce: vi.fn(),
  mockWorkerUnref: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('../shared/prompt/index.js', () => ({
  confirm: mockConfirm,
}));

vi.mock('../shared/ui/index.js', () => ({
  success: mockSuccess,
  warn: mockWarn,
  error: mockLogError,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  /** Test mock that returns an Error's message or the stringified value. */
  getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

vi.mock('../infra/task/index.js', () => ({
  TaskRunner: class {
    constructor(projectDir: string) {
      mockRunnerProjectDir(projectDir);
    }

    forceFailRunningTask(...args: unknown[]) {
      return mockForceFailRunningTask(...args);
    }
  },
  isStaleRunningTask: vi.fn(() => true),
}));

import { forceFailRunningTask } from '../features/tasks/list/taskForceFailActions.js';
import { createTaskRunForceFailStorage } from '../features/tasks/list/taskRunForceFailStorage.js';

function createRunningTask(projectDir: string, overrides?: Partial<TaskListItem>): TaskListItem {
  return {
    kind: 'running',
    name: 'running-task',
    createdAt: '2026-04-09T00:00:00.000Z',
    filePath: path.join(projectDir, '.takt', 'tasks.yaml'),
    content: 'Force fail me',
    taskDir: '.takt/tasks/20260409-run-a',
    runSlug: '20260409-run-a',
    ownerPid: 4242,
    data: {
      task: 'Force fail me\nwith full prompt',
    },
    ...overrides,
  };
}

function writeMetaOnly(runRoot: string, slug: string, meta: Record<string, unknown>): void {
  const metaPath = path.join(runRoot, '.takt', 'runs', slug, 'meta.json');
  const relativeRunRoot = path.join('.takt', 'runs', slug);
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify({
    task: 'Stored from run context',
    workflow: 'default',
    runSlug: slug,
    runRoot: relativeRunRoot,
    reportDirectory: path.join(relativeRunRoot, 'reports'),
    contextDirectory: path.join(relativeRunRoot, 'context'),
    logsDirectory: path.join(relativeRunRoot, 'logs'),
    status: 'running',
    startTime: '2026-04-09T00:00:00.000Z',
    ...meta,
  }, null, 2), 'utf-8');
}

function writeMeta(runRoot: string, slug: string, meta: Record<string, unknown>): void {
  writeMetaOnly(runRoot, slug, meta);
  initNdjsonLog(
    'force-fail-session',
    typeof meta.task === 'string' ? meta.task : 'Stored from run context',
    typeof meta.workflow === 'string' ? meta.workflow : 'default',
    {
      logsDir: path.join(runRoot, '.takt', 'runs', slug, 'logs'),
      startTime: '2026-04-09T00:00:00.000Z',
    },
  );
}

describe('forceFailRunningTask', () => {
  let projectDir: string;

  beforeEach(() => {
    resetDebugLogger();
    vi.clearAllMocks();
    mockSpawn.mockReturnValue({
      once: mockWorkerOnce,
      unref: mockWorkerUnref,
    });
    vi.mocked(isStaleRunningTask).mockReturnValue(true);
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-force-fail-'));
  });

  afterEach(() => {
    resetDebugLogger();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it(
    'file lifecycle satisfies the force-fail storage contract',
    async () => {
      const runSlug = '20260409-run-a';
      const runPaths = buildRunPaths(projectDir, runSlug);
      writeMeta(projectDir, runSlug, {
        status: 'running',
        currentStep: 'implement',
        currentIteration: 2,
      });

      const storage = createTaskRunForceFailStorage({
        task: createRunningTask(projectDir),
        projectDir,
        onWarning: mockWarn,
      })!;

      expect(storage.currentStep).toBe('implement');
      const reason = 'contract force-fail';
      await expect(storage.terminalize(reason))
        .resolves.toMatchObject({ issues: [] });
      await expect(storage.terminalize(reason))
        .resolves.toMatchObject({ issues: [] });
      const meta = JSON.parse(
        fs.readFileSync(runPaths.metaAbs, 'utf-8'),
      ) as { status: string; reason?: string };
      expect(meta).toMatchObject({
        status: 'failed',
        reason,
      });
      expect(
        fs.readFileSync(
          path.join(runPaths.logsAbs, 'force-fail-session.jsonl'),
          'utf-8',
        ),
      ).toContain('"type":"workflow_abort"');
      expect(
        fs.readFileSync(
          path.join(runPaths.runRootAbs, 'trace.md'),
          'utf-8',
        ),
      ).toContain(reason);
    },
  );

  it('force-failで終端化したrunも重複なくループ分析へ送る', async () => {
    const runSlug = '20260409-loop-analysis';
    const runPaths = buildRunPaths(projectDir, runSlug);
    writeMeta(projectDir, runSlug, {
      status: 'running',
      currentStep: 'review',
      currentIteration: 2,
    });
    fs.writeFileSync(
      path.join(projectDir, '.takt', 'runtime.yaml'),
      'version: 1\nloop_analysis:\n  enabled: true\n  output: file\n',
      'utf-8',
    );
    const storage = createTaskRunForceFailStorage({
      task: createRunningTask(projectDir, { runSlug }),
      projectDir,
      onWarning: mockWarn,
    });

    await storage?.terminalize('manual force-fail');
    await storage?.terminalize('manual force-fail');

    const jobDirectory = path.join(
      runPaths.runRootAbs,
      '.takt-report-internal',
      'loop-analysis',
    );
    const files = fs.readdirSync(jobDirectory);
    expect(files.filter((file) => file.endsWith('.job.json'))).toHaveLength(1);
    expect(files).toContain('dispatch.claim');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('force-failでPRコメント用ジョブを作成した後、publication markerをsettledにする', async () => {
    const runSlug = '20260409-loop-analysis-pr';
    const runPaths = buildRunPaths(projectDir, runSlug);
    writeMeta(projectDir, runSlug, {
      status: 'running',
      currentStep: 'review',
      currentIteration: 2,
    });
    fs.writeFileSync(
      path.join(projectDir, '.takt', 'runtime.yaml'),
      'version: 1\nloop_analysis:\n  enabled: true\n  output: pr-comment\n',
      'utf-8',
    );
    const storage = createTaskRunForceFailStorage({
      task: createRunningTask(projectDir, {
        runSlug,
        branch: 'takt/source-run',
        data: {
          task: 'Force fail me\nwith full prompt',
          auto_pr: true,
        },
      }),
      projectDir,
      onWarning: mockWarn,
    });

    await expect(storage?.terminalize('manual force-fail'))
      .resolves.toMatchObject({ issues: [] });

    const jobDirectory = path.join(
      runPaths.runRootAbs,
      '.takt-report-internal',
      'loop-analysis',
    );
    const jobPath = fs.readdirSync(jobDirectory)
      .find((file) => file.endsWith('.job.json'));
    if (jobPath === undefined) {
      throw new Error('Loop analysis PR comment job was not created');
    }
    const job = JSON.parse(fs.readFileSync(path.join(jobDirectory, jobPath), 'utf8')) as {
      publicationMarkerPath: string;
    };
    expect(JSON.parse(fs.readFileSync(job.publicationMarkerPath, 'utf8')))
      .toMatchObject({ state: 'settled', version: 1 });
  });

  it('bootstrapがmeta作成後かつNDJSON初期化前に停止してもforce-failできる', async () => {
    const runSlug = '20260409-bootstrap-partial';
    const runPaths = buildRunPaths(projectDir, runSlug);
    writeMetaOnly(projectDir, runSlug, {
      status: 'running',
    });

    const storage = createTaskRunForceFailStorage({
      task: createRunningTask(projectDir, { runSlug }),
      projectDir,
      onWarning: mockWarn,
    });

    await expect(storage?.terminalize('bootstrap partial stop'))
      .resolves.toMatchObject({ issues: [] });
    expect(JSON.parse(fs.readFileSync(runPaths.metaAbs, 'utf-8')))
      .toMatchObject({ status: 'failed', reason: 'bootstrap partial stop' });
    expect(fs.readdirSync(runPaths.logsAbs)).toEqual([
      `force-fail-${runSlug}.jsonl`,
    ]);
    expect(fs.readFileSync(
      path.join(runPaths.logsAbs, `force-fail-${runSlug}.jsonl`),
      'utf-8',
    )).toContain('"type":"workflow_abort"');
  });

  it('複数NDJSONがある場合はrun metaとidentityが一致するlogをforce-failする', async () => {
    const runSlug = '20260409-multiple-logs';
    const runPaths = buildRunPaths(projectDir, runSlug);
    writeMeta(projectDir, runSlug, {
      status: 'running',
      currentStep: 'implement',
    });
    const unrelatedPath = initNdjsonLog(
      'unrelated-session',
      'Stored from run context',
      'default',
      {
        logsDir: runPaths.logsAbs,
        startTime: '2026-04-08T00:00:00.000Z',
      },
    );

    const storage = createTaskRunForceFailStorage({
      task: createRunningTask(projectDir, { runSlug }),
      projectDir,
      onWarning: mockWarn,
    });

    await expect(storage?.terminalize('identity matched'))
      .resolves.toMatchObject({ issues: [] });
    expect(fs.readFileSync(
      path.join(runPaths.logsAbs, 'force-fail-session.jsonl'),
      'utf-8',
    )).toContain('"type":"workflow_abort"');
    expect(fs.readFileSync(unrelatedPath, 'utf-8'))
      .not.toContain('"type":"workflow_abort"');
  });

  it('観測sidecarとdebug prompt logが併存してもsession logをforce-failする', async () => {
    const runSlug = '20260409-usage-sidecar';
    const runPaths = buildRunPaths(projectDir, runSlug);
    writeMeta(projectDir, runSlug, {
      status: 'running',
      currentStep: 'implement',
    });
    const usageLogger = createUsageEventLogger({
      logsDir: runPaths.logsAbs,
      sessionId: 'force-fail-session',
      runId: runSlug,
      enabled: true,
    });
    usageLogger.logUsageFor({
      provider: 'mock',
      providerModel: 'mock-model',
      step: 'implement',
      stepType: 'normal',
    }, {
      success: true,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        usageMissing: false,
      },
    });
    fs.writeFileSync(
      path.join(
        runPaths.logsAbs,
        `force-fail-session${PROVIDER_EVENTS_LOG_FILE_SUFFIX}`,
      ),
      '{}\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(
        runPaths.logsAbs,
        `force-fail-session${PHASE_USAGE_EVENTS_LOG_FILE_SUFFIX}`,
      ),
      '{}\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(
        runPaths.logsAbs,
        `force-fail-session${OTEL_SESSION_SHADOW_LOG_FILE_SUFFIX}`,
      ),
      `${JSON.stringify({
        type: 'workflow_start',
        task: 'Stored from run context',
        workflowName: 'default',
        startTime: '2026-04-09T00:00:00.000Z',
      })}\n`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(runPaths.logsAbs, `force-fail-session${PROMPT_LOG_FILE_SUFFIX}`),
      `${JSON.stringify({
        step: 'implement',
        phase: 1,
        iteration: 1,
        scope: '{"step":"implement","stack":[]}',
        phaseExecutionId: 'implement:1:1:1',
        prompt: 'prompt',
        systemPrompt: 'system prompt',
        userInstruction: 'user instruction',
        response: 'response',
        timestamp: '2026-04-09T00:00:00.000Z',
      })}\n`,
      'utf-8',
    );

    const storage = createTaskRunForceFailStorage({
      task: createRunningTask(projectDir, { runSlug }),
      projectDir,
      onWarning: mockWarn,
    })!;

    await expect(storage.terminalize('usage sidecar force-fail'))
      .resolves.toMatchObject({ issues: [] });
    expect(JSON.parse(fs.readFileSync(runPaths.metaAbs, 'utf-8')))
      .toMatchObject({
        status: 'failed',
        reason: 'usage sidecar force-fail',
      });
    expect(fs.readFileSync(
      path.join(runPaths.logsAbs, 'force-fail-session.jsonl'),
      'utf-8',
    )).toContain('"type":"workflow_abort"');
  });

  it('正常sessionと通常名の破損JSONLが併存する場合はforce-failを拒否する', async () => {
    const runSlug = '20260409-corrupt-extra-log';
    const runPaths = buildRunPaths(projectDir, runSlug);
    writeMeta(projectDir, runSlug, {
      status: 'running',
      currentStep: 'implement',
    });
    fs.writeFileSync(
      path.join(runPaths.logsAbs, 'unexpected.jsonl'),
      '{"run_id":"20260409-corrupt-extra-log"}\n',
      'utf-8',
    );

    const storage = createTaskRunForceFailStorage({
      task: createRunningTask(projectDir, { runSlug }),
      projectDir,
      onWarning: mockWarn,
    })!;

    await expect(storage.terminalize('corrupt extra log force-fail'))
      .rejects.toThrow('NDJSON session record type is invalid');
    expect(JSON.parse(fs.readFileSync(runPaths.metaAbs, 'utf-8')))
      .toMatchObject({ status: 'running' });
  });

  it('正常sessionと空の通常名JSONLが併存する場合はforce-failを拒否する', async () => {
    const runSlug = '20260409-empty-extra-log';
    const runPaths = buildRunPaths(projectDir, runSlug);
    writeMeta(projectDir, runSlug, {
      status: 'running',
      currentStep: 'implement',
    });
    const emptyLogPath = path.join(runPaths.logsAbs, 'empty.jsonl');
    fs.writeFileSync(emptyLogPath, '', 'utf-8');

    const storage = createTaskRunForceFailStorage({
      task: createRunningTask(projectDir, { runSlug }),
      projectDir,
      onWarning: mockWarn,
    })!;

    await expect(storage.terminalize('empty extra log force-fail'))
      .rejects.toThrow(
        `Run force-fail session log is missing or invalid: ${emptyLogPath}`,
      );
    expect(JSON.parse(fs.readFileSync(runPaths.metaAbs, 'utf-8')))
      .toMatchObject({ status: 'running' });
  });

  it('唯一のsession logが壊れている場合はforce-failを拒否する', async () => {
    const runSlug = '20260409-corrupt-session';
    const runPaths = buildRunPaths(projectDir, runSlug);
    writeMetaOnly(projectDir, runSlug, {
      status: 'running',
      currentStep: 'implement',
    });
    fs.mkdirSync(runPaths.logsAbs, { recursive: true });
    fs.writeFileSync(
      path.join(runPaths.logsAbs, 'force-fail-session.jsonl'),
      '{"run_id":"20260409-corrupt-session"}\n',
      'utf-8',
    );

    const storage = createTaskRunForceFailStorage({
      task: createRunningTask(projectDir, { runSlug }),
      projectDir,
      onWarning: mockWarn,
    })!;

    await expect(storage.terminalize('corrupt session force-fail'))
      .rejects.toThrow('NDJSON session record type is invalid');
    expect(JSON.parse(fs.readFileSync(runPaths.metaAbs, 'utf-8')))
      .toMatchObject({ status: 'running' });
  });

  it('should return false when confirmation is cancelled', async () => {
    mockConfirm.mockResolvedValue(false);

    const result = await forceFailRunningTask(createRunningTask(projectDir), projectDir);

    expect(result).toBe(false);
    expect(mockConfirm).toHaveBeenCalled();
    expect(mockForceFailRunningTask).not.toHaveBeenCalled();
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('should mark running task as failed using currentStep from project meta.json', async () => {
    mockConfirm.mockResolvedValue(true);
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Stored from run context',
      status: 'running',
      currentStep: 'implement',
      currentIteration: 2,
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir), projectDir);

    expect(result).toBe(true);
    expect(mockConfirm).toHaveBeenCalled();
    expect(mockRunnerProjectDir).toHaveBeenCalledWith(projectDir);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'implement',
      error: 'Manually marked as failed',
    });
    expect(mockSuccess).toHaveBeenCalled();
  });

  it('should mark an interrupted running task as failed with a legacy error session state', async () => {
    mockConfirm.mockResolvedValue(true);
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Interrupted task',
      status: 'aborted',
      currentStep: 'implement',
      currentIteration: 2,
      reason: 'user_interrupted',
      endTime: '2026-04-09T00:01:00.000Z',
    });
    const sessionStatePath = getSessionStatePath(projectDir);
    fs.writeFileSync(
      sessionStatePath,
      JSON.stringify({
        status: 'error',
        errorMessage: 'user_interrupted',
        timestamp: '2026-04-09T00:01:00.000Z',
        workflowName: 'default',
        taskContent: 'Interrupted task',
        lastStep: 'implement',
      }, null, 2),
      'utf-8',
    );

    const result = await forceFailRunningTask(
      createRunningTask(projectDir),
      projectDir,
    );

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: undefined,
      error: 'Manually marked as failed',
    });
    expect(JSON.parse(fs.readFileSync(
      sessionStatePath,
      'utf-8',
    ))).toMatchObject({
      version: 1,
      status: 'pending',
      state: {
        status: 'error',
        errorMessage: 'Manually marked as failed',
        workflowName: 'default',
      },
    });
    expect(mockLogError).not.toHaveBeenCalled();
    expect(mockSuccess).toHaveBeenCalled();
  });

  it('should show a live-process warning before force-failing non-stale running task', async () => {
    vi.mocked(isStaleRunningTask).mockReturnValue(false);
    mockConfirm.mockResolvedValue(false);

    const result = await forceFailRunningTask(createRunningTask(projectDir), projectDir);

    expect(result).toBe(false);
    expect(mockConfirm).toHaveBeenCalledWith(
      'Process 4242 may still be running. Mark "running-task" as failed anyway?',
      false,
    );
    expect(mockForceFailRunningTask).not.toHaveBeenCalled();
  });

  it('should fall back to worktree meta.json when project run metadata has no currentStep', async () => {
    mockConfirm.mockResolvedValue(true);
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'running-task');
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Stored from run context',
      status: 'running',
    });
    writeMeta(worktreePath, '20260409-run-a', {
      task: 'Stored from worktree run context',
      status: 'running',
      currentStep: 'review',
      currentIteration: 4,
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir, { worktreePath }), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'review',
      error: 'Manually marked as failed',
    });
  });

  it('should prefer worktree meta.json when both project and worktree runs match', async () => {
    mockConfirm.mockResolvedValue(true);
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'running-task');
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Stored from project run context',
      status: 'running',
      currentStep: 'implement',
      currentIteration: 2,
    });
    writeMeta(worktreePath, '20260409-run-a', {
      task: 'Stored from worktree run context',
      status: 'running',
      currentStep: 'review',
      currentIteration: 4,
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir, { worktreePath }), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'review',
      error: 'Manually marked as failed',
    });
  });

  it('should ignore unrelated project runs and prefer matching worktree run metadata', async () => {
    mockConfirm.mockResolvedValue(true);
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'running-task');
    writeMeta(projectDir, '20260409-run-z', {
      task: 'Other task prompt',
      status: 'running',
      currentStep: 'wrong-step',
    });
    writeMeta(worktreePath, '20260409-run-a', {
      task: 'Stored from worktree run context',
      status: 'running',
      currentStep: 'implement',
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir, { worktreePath }), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'implement',
      error: 'Manually marked as failed',
    });
  });

  it('should skip an unreadable newest meta.json and use an older matching run', async () => {
    mockConfirm.mockResolvedValue(true);
    fs.mkdirSync(path.join(projectDir, '.takt', 'runs', '20260409-run-z'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.takt', 'runs', '20260409-run-z', 'meta.json'), '{ broken json', 'utf-8');
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Stored from run context',
      status: 'running',
      currentStep: 'implement',
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'implement',
      error: 'Manually marked as failed',
    });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('should report failure when matching meta.json is unreadable', async () => {
    mockConfirm.mockResolvedValue(true);
    const metaPath = path.join(projectDir, '.takt', 'runs', '20260409-run-a', 'meta.json');
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, '{ broken json', 'utf-8');

    const result = await forceFailRunningTask(createRunningTask(projectDir), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: undefined,
      error: 'Manually marked as failed',
    });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to parse run metadata at ${metaPath}`),
    );
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('should skip an unreadable newest worktree meta.json and use an older matching run', async () => {
    mockConfirm.mockResolvedValue(true);
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'running-task');
    fs.mkdirSync(path.join(worktreePath, '.takt', 'runs', '20260409-run-z'), { recursive: true });
    fs.writeFileSync(
      path.join(worktreePath, '.takt', 'runs', '20260409-run-z', 'meta.json'),
      '{ broken json',
      'utf-8',
    );
    writeMeta(worktreePath, '20260409-run-a', {
      task: 'Stored from worktree run context',
      status: 'running',
      currentStep: 'review',
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir, { worktreePath }), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'review',
      error: 'Manually marked as failed',
    });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('should warn and fall back to project metadata when matching worktree meta.json is unreadable', async () => {
    mockConfirm.mockResolvedValue(true);
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'running-task');
    const metaPath = path.join(worktreePath, '.takt', 'runs', '20260409-run-a', 'meta.json');
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(
      metaPath,
      '{ broken json',
      'utf-8',
    );
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Stored from project run context',
      status: 'running',
      currentStep: 'implement',
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir, { worktreePath }), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'implement',
      error: 'Manually marked as failed',
    });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to parse run metadata at ${metaPath}`),
    );
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('should use task run slug to ignore a newer project run from another task', async () => {
    mockConfirm.mockResolvedValue(true);
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'running-task');
    writeMeta(projectDir, '20260409-run-z', {
      task: 'Force fail me\nwith full prompt',
      status: 'running',
      currentStep: 'wrong-step',
    });
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Stored from project run context',
      status: 'running',
      currentStep: 'implement',
    });
    writeMeta(worktreePath, '20260409-run-a', {
      task: 'Stored from worktree run context',
      status: 'running',
      currentStep: 'review',
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir, { worktreePath }), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'review',
      error: 'Manually marked as failed',
    });
  });

  it('should use matching worktree run when unrelated project meta.json is corrupt', async () => {
    mockConfirm.mockResolvedValue(true);
    const worktreePath = path.join(projectDir, '.takt', 'worktrees', 'running-task');
    fs.mkdirSync(path.join(projectDir, '.takt', 'runs', '20260409-run-z'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.takt', 'runs', '20260409-run-z', 'meta.json'), '{ broken json', 'utf-8');
    writeMeta(worktreePath, '20260409-run-a', {
      task: 'Stored from worktree run context',
      status: 'running',
      currentStep: 'review',
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir, { worktreePath }), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'review',
      error: 'Manually marked as failed',
    });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('should allow force-fail with undefined step when only unrelated corrupt meta.json exists', async () => {
    mockConfirm.mockResolvedValue(true);
    fs.mkdirSync(path.join(projectDir, '.takt', 'runs', '20260409-run-z'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.takt', 'runs', '20260409-run-z', 'meta.json'), '{ broken json', 'utf-8');

    const result = await forceFailRunningTask(createRunningTask(projectDir), projectDir);

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: undefined,
      error: 'Manually marked as failed',
    });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('should allow force-fail with undefined step when run slug is missing', async () => {
    mockConfirm.mockResolvedValue(true);
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Force fail me\nwith full prompt',
      status: 'running',
      currentStep: 'implement',
    });

    const result = await forceFailRunningTask(
      createRunningTask(projectDir, { runSlug: undefined, taskDir: undefined }),
      projectDir,
    );

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: undefined,
      error: 'Manually marked as failed',
    });
  });

  it('should allow force-fail when task prompt is missing but run slug is available', async () => {
    mockConfirm.mockResolvedValue(true);
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Stored from run context',
      status: 'running',
      currentStep: 'implement',
    });

    const result = await forceFailRunningTask(
      createRunningTask(projectDir, { data: undefined }),
      projectDir,
    );

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'implement',
      error: 'Manually marked as failed',
    });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('should ignore invalid worktree paths and continue with project run metadata', async () => {
    mockConfirm.mockResolvedValue(true);
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Stored from project run context',
      status: 'running',
      currentStep: 'implement',
    });

    const result = await forceFailRunningTask(
      createRunningTask(projectDir, { worktreePath: '/tmp/outside-project-worktree' }),
      projectDir,
    );

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: 'implement',
      error: 'Manually marked as failed',
    });
  });

  it('should ignore invalid run slug values and continue with undefined step', async () => {
    mockConfirm.mockResolvedValue(true);

    const result = await forceFailRunningTask(
      createRunningTask(projectDir, { runSlug: '../escape-run' }),
      projectDir,
    );

    expect(result).toBe(true);
    expect(mockForceFailRunningTask).toHaveBeenCalledWith('running-task', {
      step: undefined,
      error: 'Manually marked as failed',
    });
  });

  it('should return false and log an error when runner force-fail throws', async () => {
    mockConfirm.mockResolvedValue(true);
    mockForceFailRunningTask.mockImplementation(() => {
      throw new Error('runner exploded');
    });

    const result = await forceFailRunningTask(createRunningTask(projectDir), projectDir);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to mark running task "running-task" as failed: runner exploded',
    );
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('should sanitize control characters in force-fail terminal errors while preserving raw diagnostics', async () => {
    mockConfirm.mockResolvedValue(true);
    const runSlug = '20260409-unsafe-session-log';
    const runPaths = buildRunPaths(projectDir, runSlug);
    writeMetaOnly(projectDir, runSlug, {
      status: 'running',
      currentStep: 'implement',
    });
    fs.mkdirSync(runPaths.logsAbs, { recursive: true });
    const unsafeLogPath = path.join(
      runPaths.logsAbs,
      'unsafe-\u009b31m-session.jsonl',
    );
    fs.writeFileSync(unsafeLogPath, '{}\n', 'utf-8');

    const task = createRunningTask(projectDir, { runSlug });
    const debugLogPath = path.join(projectDir, 'debug', 'force-fail.log');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      initDebugLogger({ enabled: true, logFile: debugLogPath }, projectDir);
      setVerboseConsole(true);

      const result = await forceFailRunningTask(task, projectDir);
      const rawMessage =
        `Failed to parse NDJSON session record in ${unsafeLogPath}: `
        + 'NDJSON session record type is invalid';
      const visibleLogPath = unsafeLogPath.replace('\u009b', '\\x9b');
      const stderrOutput = stderrSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .join('');
      const debugOutput = fs.readFileSync(debugLogPath, 'utf-8');

      expect(result).toBe(false);
      expect(mockLogError).toHaveBeenCalledTimes(1);
      expect(mockLogError).toHaveBeenCalledWith(
        `Failed to mark running task "running-task" as failed: `
        + `Failed to parse NDJSON session record in ${visibleLogPath}: `
        + 'NDJSON session record type is invalid',
      );
      expect(mockLogError.mock.calls[0]?.[0]).not.toContain('\u009b');
      expect(mockLogError.mock.calls[0]?.[0]).toContain(
        'unsafe-\\x9b31m-session.jsonl',
      );
      expect(mockLogError.mock.calls[0]?.[0]).toContain(
        'NDJSON session record type is invalid',
      );
      expect(stderrOutput).toContain('Failed to force-fail running task');
      expect(stderrOutput).not.toContain('\u009b');
      expect(stderrOutput).not.toContain(unsafeLogPath);
      expect(debugOutput).toContain(rawMessage);
      expect(debugOutput).toContain(unsafeLogPath);
      expect(debugOutput).toContain('NDJSON session record type is invalid');
      expect(mockForceFailRunningTask).not.toHaveBeenCalled();
      expect(mockSuccess).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

});
