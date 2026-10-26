import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import * as childProcess from 'node:child_process';
import { runWorkflow } from '../features/pipeline/steps.js';
import { executePipeline } from '../features/pipeline/execute.js';
import { executeTaskWithResult } from '../features/tasks/execute/taskExecution.js';
import { GitHubProvider } from '../infra/github/GitHubProvider.js';
import * as taskGit from '../infra/task/index.js';
import { getGlobalConfigPath } from '../infra/config/paths.js';
import { selectAndExecuteTask } from '../features/tasks/execute/selectAndExecute.js';
import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/resolutionCache.js';
import { resetScenario, setMockScenario } from '../infra/mock/index.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const entrypoints = [
  { name: 'direct task', execute: async (cwd: string, workflow: string) => {
    const result = await selectAndExecuteTask(cwd, 'Inspect approval', {
      workflow, skipTaskList: true, failureMode: 'return',
    }, { provider: 'mock' });
    return 'success' in result && result.success;
  } },
  { name: 'pipeline', execute: async (cwd: string, workflow: string) => (
    await runWorkflow(cwd, workflow, 'Inspect approval', cwd, { provider: 'mock', outputMode: 'silent' }, { execCwd: cwd, isWorktree: false })
  ).success },
  { name: 'interactive', execute: async (cwd: string, workflow: string) => {
    const result = await selectAndExecuteTask(cwd, 'Inspect approval', {
      workflow, skipTaskList: true, failureMode: 'return', interactiveUserInput: true,
    }, { provider: 'mock' });
    return 'success' in result && result.success;
  } },
] as const;

describe('command system input execution entrypoints', () => {
  let projectDir: string;
  let workflowPath: string;
  let promptLog: string;

  beforeEach(() => {
    vi.mocked(childProcess.spawn).mockClear();
    projectDir = mkdtempSync(join(tmpdir(), 'takt-command-entrypoint-'));
    writeFileSync(getGlobalConfigPath(), stringify({ workflow_system_commands_trusted_projects: [projectDir] }));
    mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
    workflowPath = join(projectDir, '.takt', 'workflows', 'approval.yaml');
    promptLog = join(projectDir, 'prompts.jsonl');
    vi.stubEnv('TAKT_MOCK_PROMPT_LOG', promptLog);
    vi.stubEnv('TAKT_NOTIFY_WEBHOOK', undefined);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    setMockScenario([{ status: 'done', content: 'Consumed approval' }]);
    writeFileSync(join(projectDir, 'approval.mjs'), `
      import { writeFileSync } from 'node:fs';
      writeFileSync('command-ran', 'yes');
      process.stdout.write('{"status":"approved"}');
    `);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetScenario();
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeWorkflow(allowed: boolean): void {
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), stringify({
      provider: 'mock', language: 'en', workflow_system_commands: { custom_scripts: allowed },
    }));
    writeFileSync(workflowPath, stringify({
      name: 'approval', max_steps: 2,
      steps: [
        { name: 'check', mode: 'system', system_inputs: [{
          type: 'command', as: 'approval', command: 'node approval.mjs', timeout_ms: 5000, output: 'json',
        }], rules: [
          { condition: 'when(context.approval.json.status == "approved")', next: 'consume' },
          { condition: 'when(true)', next: 'ABORT' },
        ] },
        { name: 'consume', persona: 'consumer', instruction: 'Approval: {context:check.approval.json.status}',
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }],
        },
      ],
    }));
  }

  it.each(entrypoints)('$name executes the command and passes its JSON value to the selected agent', async ({ execute }) => {
    writeWorkflow(true);
    expect(await execute(projectDir, workflowPath)).toBe(true);
    expect(readFileSync(join(projectDir, 'command-ran'), 'utf8')).toBe('yes');
    const prompts = readFileSync(promptLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { prompt: string });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.prompt).toContain('Approval: approved');
  });

  it.each(entrypoints)('$name rejects a command without permission before running it or an agent', async ({ execute }) => {
    writeWorkflow(false);
    let success = false;
    try {
      success = await execute(projectDir, workflowPath);
    } catch {
      // 読み込み時の例外と実行結果での失敗は各入口の既存契約に従う。
    }
    expect(success).toBe(false);
    expect(existsSync(join(projectDir, 'command-ran'))).toBe(false);
    expect(existsSync(promptLog)).toBe(false);
  });

  it.each(entrypoints)('$name keeps existing system inputs usable without command permission', async ({ execute }) => {
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n');
    writeFileSync(workflowPath, stringify({
      name: 'task-context', max_steps: 2,
      steps: [
        { name: 'check', mode: 'system', system_inputs: [{ type: 'task_context', source: 'current_task', as: 'task' }],
          rules: [{ condition: 'when(context.check.task.exists == true)', next: 'consume' }],
        },
        { name: 'consume', persona: 'consumer', instruction: 'Task: {context:check.task.body}',
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }],
        },
      ],
    }));
    expect(await execute(projectDir, workflowPath)).toBe(true);
    const prompts = readFileSync(promptLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { prompt: string });
    expect(prompts[0]?.prompt).toContain('Task: Inspect approval');
  });

  it.each(entrypoints)('$name requires operator permission without PR context', async ({ execute }) => {
    writeCommandWorkflow(true);
    writeGlobalPermission(true);
    expect(await execute(projectDir, workflowPath)).toBe(true);
    expect(readFileSync(join(projectDir, 'command-ran'), 'utf8')).toBe('approved');
    rmSync(join(projectDir, 'command-ran'));
    writeGlobalPermission(false);
    vi.mocked(childProcess.spawn).mockClear();
    let success = false;
    try { success = await execute(projectDir, workflowPath); } catch { /* Loader rejection follows the entrypoint contract. */ }
    expect(success).toBe(false);
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(existsSync(join(projectDir, 'command-ran'))).toBe(false);
  });

  function writeCommandWorkflow(projectPermission: boolean, childOnly = false): void {
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), stringify({
      provider: 'mock', language: 'en', workflow_system_commands: { custom_scripts: projectPermission },
    }));
    const commandWorkflow = {
      name: 'approval', steps: [{ name: 'check', mode: 'system', system_inputs: [{
        type: 'command', as: 'approval', command: 'printf approved > command-ran', timeout_ms: 1000,
      }], rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }],
    };
    writeFileSync(workflowPath, stringify(childOnly ? {
      name: 'parent', steps: [{ name: 'delegate', kind: 'workflow_call', call: './child.yaml',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    } : commandWorkflow));
    if (childOnly) writeFileSync(join(projectDir, '.takt', 'workflows', 'child.yaml'), stringify({
      ...commandWorkflow, subworkflow: { callable: true },
    }));
  }

  function writeGlobalPermission(permission: boolean | undefined, trusted = false): void {
    writeFileSync(getGlobalConfigPath(), stringify({
      ...(permission === undefined ? {} : { workflow_system_commands: { custom_scripts: permission } }),
      workflow_system_commands_trusted_projects: trusted ? [projectDir] : [],
    }));
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  }

  it.each([
    { global: false, project: true, pr: false, trusted: true, allowed: true },
    { global: false, project: true, pr: false, trusted: false, allowed: false },
    { global: false, project: true, pr: true, allowed: false },
    { global: undefined, project: true, pr: true, allowed: false },
    { global: true, project: true, pr: true, allowed: true },
    { global: true, project: false, pr: true, allowed: false },
  ])('enforces configuration trust before shell startup ($global/$project, PR=$pr)', async ({ global, project, pr, trusted, allowed }) => {
    writeCommandWorkflow(project);
    writeGlobalPermission(global, trusted);
    const spawn = vi.mocked(childProcess.spawn);
    const execution = executeTaskWithResult({
      task: 'Inspect approval', cwd: projectDir, projectCwd: projectDir, workflowIdentifier: workflowPath,
      outputMode: 'silent', agentOverrides: { provider: 'mock' },
      ...(pr ? { prContext: { source: 'pr_review' as const, prNumber: 1905, baseBranch: 'main',
        headBranch: 'feature/pr', baseBranchSource: 'pull_request' as const } } : {}),
    });
    if (allowed) {
      expect((await execution).success).toBe(true);
      expect(readFileSync(join(projectDir, 'command-ran'), 'utf8')).toBe('approved');
      expect(spawn).toHaveBeenCalledWith('printf approved > command-ran', expect.objectContaining({ shell: true }));
    } else {
      await expect(execution).rejects.toThrow();
      expect(spawn).not.toHaveBeenCalled();
      expect(existsSync(join(projectDir, 'command-ran'))).toBe(false);
    }
  });

  it.each([true, false])('uses operator permission %s after the pipeline checks out a PR', async (global) => {
    writeGlobalPermission(global);
    vi.spyOn(GitHubProvider.prototype, 'checkCliStatus').mockReturnValue({ available: true });
    vi.spyOn(GitHubProvider.prototype, 'fetchPrReviewComments').mockReturnValue({
      number: 1905, title: 'PR command', body: '', url: 'https://example.test/pull/1905',
      headRefName: 'feature/pr', baseRefName: 'main', comments: [], reviews: [], files: [],
    });
    const checkout = vi.spyOn(taskGit, 'checkoutBranch').mockImplementation(() => writeCommandWorkflow(true));
    vi.spyOn(taskGit, 'materializePullRequestBase').mockReturnValue('refs/takt/pr-base/main');
    vi.spyOn(taskGit, 'stageAndCommit').mockResolvedValue(undefined);
    vi.spyOn(taskGit, 'pushBranch').mockImplementation(() => undefined);
    const spawn = vi.mocked(childProcess.spawn);
    const execution = executePipeline({
      cwd: projectDir, workflow: workflowPath, prNumber: 1905, provider: 'mock',
      autoPr: false, createWorktree: false, outputMode: 'silent',
    });
    if (global) {
      expect(await execution).toBe(0);
      expect(readFileSync(join(projectDir, 'command-ran'), 'utf8')).toBe('approved');
      expect(spawn).toHaveBeenCalledWith('printf approved > command-ran', expect.objectContaining({ shell: true }));
    } else {
      await expect(execution).rejects.toThrow();
      expect(spawn).not.toHaveBeenCalled();
      expect(existsSync(join(projectDir, 'command-ran'))).toBe(false);
    }
    expect(checkout).toHaveBeenCalledWith(projectDir, 'feature/pr');
  });

  it.each([true, false])('uses the run permission %s for child-only commands through bundle execution', async (global) => {
    writeCommandWorkflow(true, true);
    writeGlobalPermission(global);
    const spawn = vi.mocked(childProcess.spawn);
    const execution = executeTaskWithResult({
      task: 'Inspect child', cwd: projectDir, projectCwd: projectDir, workflowIdentifier: workflowPath,
      outputMode: 'silent', agentOverrides: { provider: 'mock' },
      prContext: { source: 'pr_review', prNumber: 1905, baseBranch: 'main', headBranch: 'feature/pr',
        baseBranchSource: 'pull_request' },
    });
    if (global) {
      expect((await execution).success).toBe(true);
      expect(readFileSync(join(projectDir, 'command-ran'), 'utf8')).toBe('approved');
    } else {
      await expect(execution).rejects.toThrow();
      expect(spawn).not.toHaveBeenCalled();
      expect(existsSync(join(projectDir, 'command-ran'))).toBe(false);
    }
  });

  it.each([
    { global: false, trusted: true, allowed: true },
    { global: false, trusted: false, allowed: false },
    { global: true, trusted: false, allowed: true },
  ])('reads original project trust when executing in a separate clone: $global/$trusted', async ({ global, trusted, allowed }) => {
    writeCommandWorkflow(true);
    writeGlobalPermission(global, trusted);
    const clone = join(projectDir, 'clone');
    mkdirSync(join(clone, '.takt'), { recursive: true });
    writeFileSync(join(clone, '.takt', 'config.yaml'), stringify({
      workflow_system_commands: { custom_scripts: false },
    }));
    const execution = executeTaskWithResult({
      task: 'Inspect clone', cwd: clone, projectCwd: projectDir, workflowIdentifier: workflowPath,
      outputMode: 'silent', agentOverrides: { provider: 'mock' },
      prContext: { source: 'pr_review', prNumber: 1905, baseBranch: 'main', headBranch: 'feature/pr',
        baseBranchSource: 'pull_request' },
    });
    if (allowed) {
      expect((await execution).success).toBe(true);
      expect(readFileSync(join(clone, 'command-ran'), 'utf8')).toBe('approved');
      expect(existsSync(join(projectDir, 'command-ran'))).toBe(false);
    } else {
      await expect(execution).rejects.toThrow();
      expect(childProcess.spawn).not.toHaveBeenCalled();
      expect(existsSync(join(clone, 'command-ran'))).toBe(false);
    }
  });

  it('rechecks current operator permission for a saved PR task on each execution', async () => {
    writeCommandWorkflow(true);
    const resolved = await resolveTaskExecution({
      name: 'saved-pr', content: 'Review PR', filePath: join(projectDir, 'saved.yaml'),
      createdAt: '2026-10-26T00:00:00Z', status: 'pending',
      data: { task: 'Review PR', workflow: workflowPath, source: 'pr_review', pr_number: 1905,
        branch: 'feature/pr', base_branch: 'main' },
    }, projectDir);
    expect(resolved.prContext?.source).toBe('pr_review');
    const request = {
      task: 'Review PR', cwd: resolved.execCwd, projectCwd: projectDir,
      workflowIdentifier: resolved.workflowIdentifier, prContext: resolved.prContext,
      outputMode: 'silent' as const, agentOverrides: { provider: 'mock' as const },
    };
    writeGlobalPermission(false, true);
    expect((await executeTaskWithResult(request)).success).toBe(true);
    expect(readFileSync(join(projectDir, 'command-ran'), 'utf8')).toBe('approved');
    rmSync(join(projectDir, 'command-ran'));
    writeGlobalPermission(false);
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();
    await expect(executeTaskWithResult(request)).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(projectDir, 'command-ran'))).toBe(false);
  });
});
