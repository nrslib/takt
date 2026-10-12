import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkQueuedTaskProviders } from '../features/tasks/execute/providerPreflight.js';
import { prepareFailedTaskRetry } from '../features/tasks/taskRetryPreparation.js';
import { persistFailedTaskRetry } from '../features/tasks/taskRetryPersistence.js';
import { TaskRunner, type TaskInfo } from '../infra/task/index.js';
import * as config from '../infra/config/index.js';
import { checkWorkflowProviders } from '../infra/config/runtime-provider/execution-preparation.js';

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), install: vi.fn(), warn: vi.fn() }));
vi.mock('../infra/config/runtime-provider/execution-preparation.js', () => ({ checkWorkflowProviders: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../infra/managed-providers/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/managed-providers/loader.js')>()),
  inspectProviderInstallation: mocks.inspect,
  installProvider: mocks.install,
  warnStaleProvider: mocks.warn,
}));

describe('managed provider preflight for reused worktrees', () => {
  const temporaryProjects: string[] = [];
  beforeEach(() => { vi.clearAllMocks(); mocks.install.mockResolvedValue(undefined); });
  afterEach(() => {
    for (const project of temporaryProjects.splice(0)) fs.rmSync(project, { recursive: true, force: true });
  });

  it.each([true, false])('checks the workflow that a failed retry will execute with project sync %s', async (sync) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-preflight-retry-'));
    temporaryProjects.push(project);
    const clone = path.join(project, '.takt', 'worktrees', 'safe');
    const rootWorkflow = path.join(project, '.takt', 'workflows', 'retry.yaml');
    const cloneWorkflow = path.join(clone, '.takt', 'workflows', 'retry.yaml');
    fs.mkdirSync(path.dirname(rootWorkflow), { recursive: true });
    fs.mkdirSync(path.dirname(cloneWorkflow), { recursive: true });
    fs.writeFileSync(path.join(project, '.takt', 'config.yaml'), `sync_project_local_takt_on_retry: ${sync}\n`);
    const workflow = (name: string) => `name: ${name}\ndescription: Retry workflow\ninitial_step: step1\nmax_steps: 1\nsteps:\n  - name: step1\n    persona: coder\n    instruction: "{task}"\n`;
    fs.writeFileSync(rootWorkflow, workflow('root-workflow'));
    fs.writeFileSync(cloneWorkflow, workflow('clone-workflow'));
    const task = {
      name: 'retry', content: 'Retry', createdAt: '2026-01-01T00:00:00.000Z', filePath: '/tasks.yaml',
      status: 'failed', worktreePath: clone, data: { worktree: true, workflow: './.takt/workflows/retry.yaml' },
    } as TaskInfo;

    await checkQueuedTaskProviders(project, { ...task, kind: 'failed' }, {}, undefined);
    expect(vi.mocked(checkWorkflowProviders).mock.calls.at(-1)?.[2].name).toBe(sync ? 'root-workflow' : 'clone-workflow');
    expect(fs.readFileSync(cloneWorkflow, 'utf8')).toBe(workflow(sync ? 'root-workflow' : 'clone-workflow'));
    await checkQueuedTaskProviders(project, { ...task, status: 'pending', resumeMode: 'retry' }, {}, undefined);
    expect(vi.mocked(checkWorkflowProviders).mock.calls.at(-1)?.[2].name).toBe(sync ? 'root-workflow' : 'clone-workflow');

    fs.writeFileSync(path.join(project, '.takt', 'workflows', 'selected.yaml'), workflow('root-selected'));
    fs.writeFileSync(path.join(clone, '.takt', 'workflows', 'selected.yaml'), workflow('clone-selected'));
    await checkQueuedTaskProviders(project, { ...task, kind: 'completed' }, {}, undefined, undefined, {
      workflow: './.takt/workflows/selected.yaml',
      resumeMode: 'instruct',
    });
    expect(vi.mocked(checkWorkflowProviders).mock.calls.at(-1)?.[2].name).toBe(sync ? 'root-selected' : 'clone-selected');

    fs.writeFileSync(cloneWorkflow, workflow('clone-before-decline'));
    vi.mocked(checkWorkflowProviders).mockRejectedValueOnce(new Error('SDK declined'));
    await expect(checkQueuedTaskProviders(project, { ...task, kind: 'failed' }, {}, undefined))
      .rejects.toThrow('SDK declined');
    expect(fs.readFileSync(cloneWorkflow, 'utf8')).toBe(workflow(sync ? 'root-workflow' : 'clone-before-decline'));
  });

  it('requeues an unprepared PR merge clone after checking the project workflow', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-preflight-merge-retry-'));
    temporaryProjects.push(project);
    const clone = path.join(project, '.takt', 'worktrees', 'merge-pr-123');
    const workflowPath = path.join(project, '.takt', 'workflows', 'merge.yaml');
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, 'name: merge\ninitial_step: review\nmax_steps: 1\nsteps:\n  - name: review\n    instruction: "{task}"\n');
    const runner = new TaskRunner(project);
    const started = runner.startPrMergeTask({
      prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: 'a'.repeat(40),
      headRepositoryUrl: 'https://example.test/repo.git',
      headRepositoryPushUrls: ['https://example.test/repo.git'],
      workflow: './.takt/workflows/merge.yaml', method: 'merge', worktreePath: clone,
      threatCheckMaxDiffBytes: 1000, cacciaRequired: false,
    });
    runner.forceFailRunningTask(started.name, { step: 'review', error: 'merge failed' });
    const failed = runner.listFailedTasks()[0]!;

    const preparation = prepareFailedTaskRetry(failed, project);
    expect(preparation.interactionCwd).toBe(project);
    expect(preparation.worktreePath).toBe(clone);
    await persistFailedTaskRetry({
      task: failed, projectDir: project, worktreePath: preparation.worktreePath,
      startStep: undefined, retryNote: undefined, resumePoint: undefined,
      workflow: undefined, taskDir: undefined, sourceRunSlug: null, restartPoint: undefined,
    });

    expect(vi.mocked(checkWorkflowProviders).mock.calls.at(-1)?.[1]).toBe(project);
    expect(vi.mocked(checkWorkflowProviders).mock.calls.at(-1)?.[2].name).toBe('merge');
    expect(runner.listTasks()[0]?.status).toBe('pending');
    expect(fs.existsSync(clone)).toBe(false);
  });

  it.each([true, false])('checks only the SDK of the workflow used by a reused clone with project sync %s', async (sync) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-preflight-runtime-'));
    temporaryProjects.push(project);
    const clone = path.join(project, '.takt', 'worktrees', 'safe');
    const rootWorkflow = path.join(project, '.takt', 'workflows', 'retry.yaml');
    const cloneWorkflow = path.join(clone, '.takt', 'workflows', 'retry.yaml');
    const oldConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = path.join(project, 'global-config');
    fs.mkdirSync(process.env.TAKT_CONFIG_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(rootWorkflow), { recursive: true });
    fs.mkdirSync(path.dirname(cloneWorkflow), { recursive: true });
    fs.writeFileSync(path.join(project, '.takt', 'config.yaml'), `sync_project_local_takt_on_retry: ${sync}\n`);
    fs.writeFileSync(path.join(project, '.takt', 'runtime.yaml'), [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: mock',
      '  profiles:',
      '    mock:',
      '      provider: mock',
      '      model: test-model',
      '    pi:',
      '      provider: pi',
      '      model: test-model',
      '  targets:',
      '    steps:',
      '      rootstep:',
      '        profile: mock',
      '      clonestep:',
      '        profile: pi',
      '',
    ].join('\n'));
    const workflow = (name: string, step: string) => `name: ${name}\ninitial_step: ${step}\nmax_steps: 1\nsteps:\n  - name: ${step}\n    instruction: "{task}"\n`;
    fs.writeFileSync(rootWorkflow, workflow('root-workflow', 'rootstep'));
    fs.writeFileSync(cloneWorkflow, workflow('clone-workflow', 'clonestep'));
    const task = {
      name: 'retry', content: 'Retry', createdAt: '2026-01-01T00:00:00.000Z', filePath: '/tasks.yaml',
      status: 'failed', worktreePath: clone, data: { worktree: true, workflow: './.takt/workflows/retry.yaml' },
    } as TaskInfo;
    const realPreparation = await vi.importActual<typeof import('../infra/config/runtime-provider/execution-preparation.js')>(
      '../infra/config/runtime-provider/execution-preparation.js',
    );
    vi.mocked(checkWorkflowProviders).mockImplementation(realPreparation.checkWorkflowProviders);
    mocks.inspect.mockResolvedValue({ state: 'missing' });
    config.invalidateGlobalConfigCache();
    config.invalidateAllResolvedConfigCache();
    try {
      const check = checkQueuedTaskProviders(project, task, {}, undefined);
      if (sync) {
        await expect(check).resolves.toBeUndefined();
        expect(mocks.inspect).not.toHaveBeenCalled();
      } else {
        await expect(check).rejects.toThrow('takt install pi');
        expect(mocks.inspect).toHaveBeenCalledTimes(1);
      }
    } finally {
      vi.mocked(checkWorkflowProviders).mockReset().mockImplementation(async () => undefined as never);
      if (oldConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
      else process.env.TAKT_CONFIG_DIR = oldConfigDir;
      config.invalidateGlobalConfigCache();
      config.invalidateAllResolvedConfigCache();
    }
  });

});
