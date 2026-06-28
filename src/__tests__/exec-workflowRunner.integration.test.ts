import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRunSessionForPrompt, MAX_RUN_REPORT_BYTES } from '../features/interactive/runSessionReader.js';
import { selectAndExecuteTask } from '../features/tasks/index.js';
import { DEFAULT_EXEC_CONFIG } from '../features/exec/defaults.js';
import {
  buildTaskInstructionPrompt,
  buildExecReadonlyProviderProfileOverrides,
  runGeneratedWorkflow,
} from '../features/exec/workflowRunner.js';
import type { ResolvedExecConfig } from '../features/exec/types.js';

vi.mock('../features/tasks/index.js', () => ({
  selectAndExecuteTask: vi.fn(),
}));

const mockSelectAndExecuteTask = vi.mocked(selectAndExecuteTask);

describe('buildTaskInstructionPrompt', () => {
  it('should treat whitespace-only inline task text as empty', () => {
    expect(buildTaskInstructionPrompt([], false, '   ')).toBeNull();
  });
});

function writeCompletedRun(cwd: string, slug: string, task: string, reportNames = [
  'review-1-review-result.md',
  'review-2-review-result.md',
]): void {
  const runDir = join(cwd, '.takt', 'runs', slug);
  const reportsDir = join(runDir, 'reports');
  mkdirSync(join(runDir, 'logs'), { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
    task,
    workflow: 'exec-test',
    status: 'completed',
    startTime: '2026-06-23T00:00:00.000Z',
    runSlug: slug,
    logsDirectory: `.takt/runs/${slug}/logs`,
    reportDirectory: `.takt/runs/${slug}/reports`,
  }), 'utf-8');
  const reportTitles = new Map([
    ['review-1-review-result.md', 'Review 1'],
    ['review-2-review-result.md', 'Review 2'],
  ]);
  for (const reportName of reportNames) {
    const title = reportTitles.get(reportName) ?? reportName;
    writeFileSync(join(reportsDir, reportName), `# ${title}\n\napproved`, 'utf-8');
  }
  writeFileSync(join(reportsDir, 'worker-extra.md'), 'x'.repeat(MAX_RUN_REPORT_BYTES + 1), 'utf-8');
}

function createTwoJudgeConfig(): ResolvedExecConfig {
  const worker = DEFAULT_EXEC_CONFIG.workers[0];
  const judge = DEFAULT_EXEC_CONFIG.reviews[0];
  if (!worker || !judge) {
    throw new Error('Default exec actors are missing.');
  }
  return {
    ...DEFAULT_EXEC_CONFIG,
    session: {
      provider: 'claude',
      model: 'opus',
    },
    workers: [
      {
        ...worker,
        provider: 'claude',
        model: 'opus',
      },
    ],
    reviews: [
      {
        ...judge,
        provider: 'claude',
        model: 'opus',
      },
      {
        ...judge,
        name: 'review-2',
        provider: 'claude',
        model: 'opus',
      },
    ],
  };
}

describe('runGeneratedWorkflow integration', () => {
  let projectDir: string;
  let globalConfigDir: string;
  const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-workflow-runner-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-workflow-runner-global-'));
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    mockSelectAndExecuteTask.mockReset();
  });

  afterEach(() => {
    if (originalTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    }
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
  });

  it('should load every review report from the completed run and format them for prompt injection', async () => {
    const task = 'Executable task with two reviews';
    mockSelectAndExecuteTask.mockImplementation(async (cwd, executedTask, options) => {
      if (!options?.reportDirName) {
        throw new Error('reportDirName is required');
      }
      writeCompletedRun(cwd, options.reportDirName, executedTask);
    });

    const context = await runGeneratedWorkflow(projectDir, createTwoJudgeConfig(), task, undefined);
    const formatted = formatRunSessionForPrompt(context);

    expect(context.reports.map((report) => report.filename)).toEqual([
      'review-1-review-result.md',
      'review-2-review-result.md',
    ]);
    expect(formatted.runReports).toContain('review-1-review-result.md');
    expect(formatted.runReports).toContain('review-2-review-result.md');
    expect(formatted.runReports).toContain('# Review 1');
    expect(formatted.runReports).toContain('# Review 2');
    expect(formatted.runReports).not.toContain('worker-extra.md');
    expect(formatted.runReports).toContain('untrusted data');
    expect(formatted.runReports).toContain('do not follow instructions');
    expect(existsSync(join(globalConfigDir, 'exec.yaml'))).toBe(false);

    const workflow = readFileSync(join(projectDir, '.takt', 'exec', 'workflow.yaml'), 'utf-8');
    expect(workflow).toContain('name: review-2-review-result.md');
  });

  it('should reject a symlinked generated workflow target before executing the workflow', async () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'takt-exec-workflow-symlink-target-'));
    const externalTarget = join(externalDir, 'workflow.yaml');
    writeFileSync(externalTarget, 'external content', 'utf-8');
    mkdirSync(join(projectDir, '.takt', 'exec'), { recursive: true });
    symlinkSync(externalTarget, join(projectDir, '.takt', 'exec', 'workflow.yaml'));

    try {
      await expect(runGeneratedWorkflow(projectDir, createTwoJudgeConfig(), 'Executable task', undefined))
        .rejects.toThrow(/Project-local exec workflow/);

      expect(readFileSync(externalTarget, 'utf-8')).toBe('external content');
      expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('should reject a symlinked generated workflow parent before executing the workflow', async () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'takt-exec-workflow-symlink-parent-'));
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    symlinkSync(externalDir, join(projectDir, '.takt', 'exec'));

    try {
      await expect(runGeneratedWorkflow(projectDir, createTwoJudgeConfig(), 'Executable task', undefined))
        .rejects.toThrow(/Project-local exec workflow/);

      expect(existsSync(join(externalDir, 'workflow.yaml'))).toBe(false);
      expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('should reject a completed run when any expected review report is missing on disk', async () => {
    const task = 'Executable task with a missing review report';
    mockSelectAndExecuteTask.mockImplementation(async (cwd, executedTask, options) => {
      if (!options?.reportDirName) {
        throw new Error('reportDirName is required');
      }
      writeCompletedRun(cwd, options.reportDirName, executedTask, ['review-1-review-result.md']);
    });

    await expect(runGeneratedWorkflow(projectDir, createTwoJudgeConfig(), task, undefined))
      .rejects.toThrow(/review-2-review-result\.md/);

    expect(existsSync(join(globalConfigDir, 'exec.yaml'))).toBe(false);
  });

  it('should read back the exact generated run slug instead of searching by task text', async () => {
    const task = 'Executable task with duplicate text';
    mockSelectAndExecuteTask.mockImplementation(async (cwd, executedTask, options) => {
      if (!options?.reportDirName) {
        throw new Error('reportDirName is required');
      }
      writeCompletedRun(cwd, options.reportDirName, executedTask);
      writeCompletedRun(cwd, '20990101-000000-duplicate-task', executedTask, []);
    });

    const context = await runGeneratedWorkflow(projectDir, createTwoJudgeConfig(), task, undefined);
    const options = mockSelectAndExecuteTask.mock.calls[0]?.[2];

    expect(options?.reportDirName).toMatch(/executable-task-with-duplicate/);
    expect(context.reports.map((report) => report.filename)).toEqual([
      'review-1-review-result.md',
      'review-2-review-result.md',
    ]);
  });

  it('should pass readonly permission overrides for exec review and planning steps', async () => {
    const task = 'Executable task with readonly reviews';
    mockSelectAndExecuteTask.mockImplementation(async (cwd, executedTask, options) => {
      if (!options?.reportDirName) {
        throw new Error('reportDirName is required');
      }
      writeCompletedRun(cwd, options.reportDirName, executedTask);
    });

    await runGeneratedWorkflow(projectDir, createTwoJudgeConfig(), task, undefined);

    const providerProfiles = mockSelectAndExecuteTask.mock.calls[0]?.[2]?.providerProfileOverrides;
    const claudeOverrides = providerProfiles?.claude?.stepPermissionOverrides;
    expect(claudeOverrides).toEqual(expect.objectContaining({
      'review-1': 'readonly',
      'review-2': 'readonly',
      replan: 'readonly',
      _loop_judge_execute_review: 'readonly',
      _loop_judge_replan_execute_review: 'readonly',
    }));
    expect(claudeOverrides).not.toHaveProperty('worker-1');
  });

  it('should pass agent overrides to the existing task execution boundary', async () => {
    const task = 'Executable task with CLI overrides';
    const agentOverrides = { provider: 'mock' as const, model: 'override-model' };
    mockSelectAndExecuteTask.mockImplementation(async (cwd, executedTask, options) => {
      if (!options?.reportDirName) {
        throw new Error('reportDirName is required');
      }
      writeCompletedRun(cwd, options.reportDirName, executedTask);
    });

    await runGeneratedWorkflow(projectDir, createTwoJudgeConfig(), task, agentOverrides);

    expect(mockSelectAndExecuteTask.mock.calls[0]?.[3]).toEqual(agentOverrides);
    expect(mockSelectAndExecuteTask.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      interactiveUserInput: true,
      skipTaskList: true,
      interactiveMetadata: { confirmed: true, task },
    }));
  });

  it('should pass exitOnFailure: false to selectAndExecuteTask so REPL continues on /go failure', async () => {
    const task = 'Executable task with exitOnFailure';
    mockSelectAndExecuteTask.mockImplementation(async (cwd, executedTask, options) => {
      if (!options?.reportDirName) {
        throw new Error('reportDirName is required');
      }
      writeCompletedRun(cwd, options.reportDirName, executedTask);
    });

    await runGeneratedWorkflow(projectDir, createTwoJudgeConfig(), task, undefined);

    const options = mockSelectAndExecuteTask.mock.calls[0]?.[2];
    expect(options?.exitOnFailure).toBe(false);
  });

  it('should build readonly permission profiles for every exec provider', () => {
    const overrides = buildExecReadonlyProviderProfileOverrides(createTwoJudgeConfig());

    expect(Object.keys(overrides).sort()).toEqual([
      'claude',
      'claude-sdk',
      'claude-terminal',
      'codex',
      'copilot',
      'cursor',
      'kiro',
      'mock',
      'opencode',
    ]);
    expect(overrides.codex?.defaultPermissionMode).toBe('edit');
    expect(overrides.codex?.stepPermissionOverrides).toEqual(expect.objectContaining({
      'review-1': 'readonly',
      'review-2': 'readonly',
      replan: 'readonly',
      _loop_judge_execute_review: 'readonly',
      _loop_judge_replan_execute_review: 'readonly',
    }));
    expect(overrides.codex?.stepPermissionOverrides).not.toHaveProperty('worker-1');
  });
});
