import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectRuleIndex } from '../shared/utils/ruleIndex.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';

const {
  mockExecFileSync,
  mockGetCurrentBranch,
  mockResolveCloneBaseDir,
  mockCloneAndIsolate,
  mockRemoveClone,
  mockMaterializeCloneHeadToRootBranch,
  mockRelayPushCloneToOrigin,
  mockResolveBaseBranch,
  mockAgentCall,
  mockMergePr,
  mockSaveTaskFile,
  mockCreateIssueFromTask,
  mockFindExistingPr,
  mockFetchPrReviewComments,
  mockListOpenPrs,
  mockTaskRunnerListAllTaskItems,
} = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockGetCurrentBranch: vi.fn(),
  mockResolveCloneBaseDir: vi.fn(),
  mockCloneAndIsolate: vi.fn(),
  mockRemoveClone: vi.fn(),
  mockMaterializeCloneHeadToRootBranch: vi.fn(),
  mockRelayPushCloneToOrigin: vi.fn(),
  mockResolveBaseBranch: vi.fn(),
  mockAgentCall: vi.fn(),
  mockMergePr: vi.fn(),
  mockSaveTaskFile: vi.fn(),
  mockCreateIssueFromTask: vi.fn(),
  mockFindExistingPr: vi.fn(),
  mockFetchPrReviewComments: vi.fn(),
  mockListOpenPrs: vi.fn(),
  mockTaskRunnerListAllTaskItems: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn().mockReturnValue({}),
  getLanguage: vi.fn().mockReturnValue('en'),
  getBuiltinWorkflowsEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/config/project/projectConfig.js', () => ({
  loadProjectConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../infra/config/index.js', () => ({
  getLanguage: vi.fn(() => 'en'),
  resolveConfigValues: vi.fn(() => ({ syncConflictResolver: undefined })),
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: vi.fn((name: string, _lang: string, vars?: Record<string, string>) => {
    if (name === 'sync_conflict_resolver_system_prompt') {
      return 'system-prompt';
    }
    if (name === 'sync_conflict_resolver_message') {
      return `message:${vars?.originalInstruction ?? ''}`;
    }
    return '';
  }),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(() => ({
    setup: vi.fn(() => ({ call: mockAgentCall })),
  })),
}));

vi.mock('../core/config/provider-resolution.js', () => ({
  resolveAssistantProviderModelFromConfig: vi.fn(() => ({ provider: 'codex', model: 'gpt-5.4' })),
}));

vi.mock('../features/interactive/assistantConfig.js', () => ({
  resolveAssistantConfigLayers: vi.fn(() => ({ local: {}, global: {} })),
}));

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: vi.fn(() => ({
    checkCliStatus: vi.fn(() => ({ available: true })),
    mergePr: (...args: unknown[]) => mockMergePr(...args),
    findExistingPr: (...args: unknown[]) => mockFindExistingPr(...args),
    fetchPrReviewComments: (...args: unknown[]) => mockFetchPrReviewComments(...args),
    listOpenPrs: (...args: unknown[]) => mockListOpenPrs(...args),
  })),
}));

vi.mock('../features/tasks/add/index.js', () => ({
  saveTaskFile: (...args: unknown[]) => mockSaveTaskFile(...args),
  createIssueFromTask: (...args: unknown[]) => mockCreateIssueFromTask(...args),
}));

vi.mock('../infra/task/index.js', () => ({
  getCurrentBranch: (...args: unknown[]) => mockGetCurrentBranch(...args),
  resolveCloneBaseDir: (...args: unknown[]) => mockResolveCloneBaseDir(...args),
  removeClone: (...args: unknown[]) => mockRemoveClone(...args),
  materializeCloneHeadToRootBranch: (...args: unknown[]) => mockMaterializeCloneHeadToRootBranch(...args),
  relayPushCloneToOrigin: (...args: unknown[]) => mockRelayPushCloneToOrigin(...args),
  resolveBaseBranch: (...args: unknown[]) => mockResolveBaseBranch(...args),
  TaskRunner: class {
    listAllTaskItems() {
      return mockTaskRunnerListAllTaskItems();
    }
  },
}));

vi.mock('../infra/task/clone-exec.js', () => ({
  cloneAndIsolate: (...args: unknown[]) => mockCloneAndIsolate(...args),
}));

import { WorkflowEngine } from '../core/workflow/index.js';

function createCommandError(message: string, stderr?: string): Error {
  const error = new Error(message);
  if (stderr !== undefined) {
    Object.assign(error, { stderr: Buffer.from(stderr, 'utf-8') });
  }
  return error;
}

function createEngine(
  projectDir: string,
  configInput: Record<string, unknown>,
  optionOverrides: Record<string, unknown> = {},
) {
  const config = normalizeWorkflowConfig(configInput, projectDir);
  return new WorkflowEngine(config, projectDir, 'Resolve conflicts', {
    projectCwd: projectDir,
    provider: 'mock',
    detectRuleIndex,
    structuredCaller: {
      judgeStatus: vi.fn(),
      evaluateCondition: vi.fn().mockResolvedValue(-1),
      decomposeTask: vi.fn(),
      requestMoreParts: vi.fn(),
    },
    reportDirName: 'test-report-dir',
    currentTask: {
      runSlug: 'test-report-dir',
    },
    systemStepServicesFactory: createDefaultSystemStepServices,
    ...optionOverrides,
  });
}

function createSelectedPr(number = 42) {
  return {
    number,
    author: 'nrslib',
    base_branch: 'improve',
    head_branch: 'task/test-branch',
    managed_by_takt: true,
    labels: ['takt-managed'],
    same_repository: true,
    draft: false,
    updated_at: '2026-04-20T12:00:00Z',
  };
}

function createConflictCleanupWorkflowConfig() {
  return {
    name: 'prepare-merge-conflict-cleanup',
    initial_step: 'route_context',
    max_steps: 4,
    steps: [
      {
        name: 'route_context',
        mode: 'system',
        system_inputs: [
          {
            type: 'pr_selection',
            source: 'current_project',
            as: 'selected_pr',
            where: {
              head_branch: 'task/*',
              managed_by_takt: true,
              labels: ['takt-managed'],
              same_repository: true,
              draft: false,
            },
          },
        ],
        rules: [
          { when: 'context.route_context.selected_pr.exists == true', next: 'prepare_merge' },
          { when: 'true', next: 'ABORT' },
        ],
      },
      {
        name: 'prepare_merge',
        mode: 'system',
        effects: [{ type: 'sync_with_root', pr: '{context:route_context.selected_pr.number}' }],
        rules: [
          { when: 'effect.prepare_merge.sync_with_root.conflicted == true', next: 'COMPLETE' },
          { when: 'true', next: 'ABORT' },
        ],
      },
    ],
  };
}

function createConflictThenThrowWorkflowConfig() {
  return {
    name: 'prepare-merge-conflict-then-throw',
    initial_step: 'route_context',
    max_steps: 5,
    steps: [
      {
        name: 'route_context',
        mode: 'system',
        system_inputs: [
          {
            type: 'pr_selection',
            source: 'current_project',
            as: 'selected_pr',
            where: {
              head_branch: 'task/*',
              managed_by_takt: true,
              labels: ['takt-managed'],
              same_repository: true,
              draft: false,
            },
          },
        ],
        rules: [
          { when: 'context.route_context.selected_pr.exists == true', next: 'prepare_merge' },
          { when: 'true', next: 'ABORT' },
        ],
      },
      {
        name: 'prepare_merge',
        mode: 'system',
        effects: [{ type: 'sync_with_root', pr: '{context:route_context.selected_pr.number}' }],
        rules: [
          { when: 'effect.prepare_merge.sync_with_root.conflicted == true', next: 'explode' },
          { when: 'true', next: 'ABORT' },
        ],
      },
      {
        name: 'explode',
        mode: 'system',
        effects: [{ type: 'merge_pr', pr: '{context:route_context.selected_pr}' }],
        rules: [{ when: 'true', next: 'COMPLETE' }],
      },
    ],
  };
}

describe('system workflow PR sync integration', () => {
  let projectDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    projectDir = mkdtempSync(join(tmpdir(), 'takt-system-pr-sync-'));

    mockGetCurrentBranch.mockReturnValue('main');
    mockResolveCloneBaseDir.mockReturnValue(join(projectDir, '.takt'));
    mockResolveBaseBranch.mockImplementation((_cwd: string, branch?: string) => ({ branch: branch ?? 'main' }));
    mockAgentCall.mockResolvedValue({
      status: 'done',
      content: 'resolved',
      persona: 'conflict-resolver',
      timestamp: new Date(),
    });
    mockMergePr.mockReturnValue({ success: true });
    mockSaveTaskFile.mockResolvedValue({
      taskName: 'task-1',
      tasksFile: join(projectDir, '.takt', 'tasks.yaml'),
    });
    mockCreateIssueFromTask.mockReturnValue(undefined);
    mockFindExistingPr.mockReturnValue(undefined);
    mockFetchPrReviewComments.mockReturnValue({
      number: 42,
      title: 'Follow-up PR',
      body: 'Body',
      url: 'https://example.test/pr/42',
      headRefName: 'task/test-branch',
      baseRefName: 'improve',
      comments: [],
      reviews: [],
      files: [],
    });
    mockListOpenPrs.mockReturnValue([createSelectedPr()]);
    mockTaskRunnerListAllTaskItems.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('prepare_merge succeeds from a non-PR cwd and continues to merge_pr', async () => {
    mockExecFileSync.mockReturnValue('');
    const cloneMetaPath = join(projectDir, '.takt', 'clone-meta', 'task--test-branch.json');
    mkdirSync(join(projectDir, '.takt', 'clone-meta'), { recursive: true });
    writeFileSync(cloneMetaPath, JSON.stringify({ branch: 'task/test-branch', clonePath: '/existing/clone' }));

    const engine = createEngine(projectDir, {
      name: 'prepare-merge-happy-path',
      initial_step: 'route_context',
      max_steps: 4,
      steps: [
        {
          name: 'route_context',
          mode: 'system',
          system_inputs: [
            {
              type: 'pr_selection',
              source: 'current_project',
              as: 'selected_pr',
              where: {
                head_branch: 'task/*',
                managed_by_takt: true,
                labels: ['takt-managed'],
                same_repository: true,
                draft: false,
              },
            },
          ],
          rules: [
            { when: 'context.route_context.selected_pr.exists == true', next: 'prepare_merge' },
            { when: 'true', next: 'ABORT' },
          ],
        },
        {
          name: 'prepare_merge',
          mode: 'system',
          effects: [{ type: 'sync_with_root', pr: '{context:route_context.selected_pr.number}' }],
          rules: [
            { when: 'effect.prepare_merge.sync_with_root.success == true', next: 'merge_pr' },
            { when: 'true', next: 'ABORT' },
          ],
        },
        {
          name: 'merge_pr',
          mode: 'system',
          effects: [{ type: 'merge_pr', pr: '{context:route_context.selected_pr.number}' }],
          rules: [{ when: 'effect.merge_pr.merge_pr.success == true', next: 'COMPLETE' }],
        },
      ],
    });

    const state = await engine.run();
    const worktreePath = mockRemoveClone.mock.calls[0]?.[0] as string;

    expect(state.status).toBe('completed');
    expect(mockResolveCloneBaseDir).toHaveBeenCalledWith(projectDir);
    expect(mockCloneAndIsolate).toHaveBeenCalledWith(projectDir, worktreePath);
    expect(worktreePath).toMatch(new RegExp(`^${projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.takt/pr-sync-`));
    expect(mockMaterializeCloneHeadToRootBranch).toHaveBeenCalledWith(worktreePath, projectDir, 'task/test-branch');
    expect(mockRelayPushCloneToOrigin).toHaveBeenCalledWith(worktreePath, projectDir, 'task/test-branch');
    expect(mockMergePr).toHaveBeenCalledWith(42, projectDir);
    expect(readFileSync(cloneMetaPath, 'utf-8')).toBe(JSON.stringify({ branch: 'task/test-branch', clonePath: '/existing/clone' }));
  });

  it('resolve_conflicts_with_ai failure from a non-PR cwd enqueues a follow-up task', async () => {
    mockExecFileSync
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        throw createCommandError('merge conflict', 'CONFLICT (content): Merge conflict in src/file.ts');
      })
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        throw createCommandError('merge conflict', 'CONFLICT (content): Merge conflict in src/file.ts');
      })
      .mockReturnValueOnce('');
    mockAgentCall.mockResolvedValue({
      status: 'error',
      error: 'AI conflict resolution failed',
      content: '',
      persona: 'conflict-resolver',
      timestamp: new Date(),
    });

    const engine = createEngine(projectDir, {
      name: 'prepare-merge-conflict-followup',
      initial_step: 'route_context',
      max_steps: 6,
      steps: [
        {
          name: 'route_context',
          mode: 'system',
          system_inputs: [
            {
              type: 'pr_selection',
              source: 'current_project',
              as: 'selected_pr',
              where: {
                head_branch: 'task/*',
                managed_by_takt: true,
                labels: ['takt-managed'],
                same_repository: true,
                draft: false,
              },
            },
          ],
          rules: [
            { when: 'context.route_context.selected_pr.exists == true', next: 'prepare_merge' },
            { when: 'true', next: 'ABORT' },
          ],
        },
        {
          name: 'prepare_merge',
          mode: 'system',
          effects: [{ type: 'sync_with_root', pr: '{context:route_context.selected_pr.number}' }],
          rules: [
            { when: 'effect.prepare_merge.sync_with_root.success == true', next: 'merge_pr' },
            { when: 'effect.prepare_merge.sync_with_root.conflicted == true', next: 'resolve_conflicts' },
            { when: 'true', next: 'ABORT' },
          ],
        },
        {
          name: 'resolve_conflicts',
          mode: 'system',
          effects: [{ type: 'resolve_conflicts_with_ai', pr: '{context:route_context.selected_pr.number}' }],
          rules: [
            { when: 'effect.resolve_conflicts.resolve_conflicts_with_ai.success == true', next: 'merge_pr' },
            {
              when: 'effect.resolve_conflicts.resolve_conflicts_with_ai.failed == true',
              next: 'enqueue_conflict_resolution_task',
            },
            { when: 'true', next: 'ABORT' },
          ],
        },
        {
          name: 'enqueue_conflict_resolution_task',
          mode: 'system',
          effects: [
            {
              type: 'enqueue_task',
              mode: 'from_pr',
              pr: '{context:route_context.selected_pr.number}',
              workflow: 'takt-default',
              task: 'Resolve merge conflict',
            },
          ],
          rules: [{ when: 'effect.enqueue_conflict_resolution_task.enqueue_task.success == true', next: 'COMPLETE' }],
        },
        {
          name: 'merge_pr',
          mode: 'system',
          effects: [{ type: 'merge_pr', pr: '{context:route_context.selected_pr.number}' }],
          rules: [{ when: 'effect.merge_pr.merge_pr.success == true', next: 'COMPLETE' }],
        },
      ],
    });

    const state = await engine.run();
    const worktreePath = mockRemoveClone.mock.calls[0]?.[0] as string;

    expect(state.status).toBe('completed');
    expect(mockResolveCloneBaseDir).toHaveBeenCalledWith(projectDir);
    expect(mockCloneAndIsolate).toHaveBeenCalledTimes(1);
    expect(mockCloneAndIsolate).toHaveBeenCalledWith(projectDir, worktreePath);
    expect(mockRemoveClone).toHaveBeenCalledTimes(1);
    expect(mockAgentCall).toHaveBeenCalledWith(
      'message:Resolve conflicts',
      expect.objectContaining({ cwd: worktreePath }),
    );
    expect(mockMergePr).not.toHaveBeenCalled();
    expect(mockSaveTaskFile).toHaveBeenCalledWith(
      projectDir,
      'Resolve merge conflict',
      expect.objectContaining({
        workflow: 'takt-default',
        worktree: true,
        branch: 'task/test-branch',
        baseBranch: 'improve',
        autoPr: false,
        shouldPublishBranchToOrigin: true,
        prNumber: 42,
      }),
    );
  });

  it('cleans up retained PR sync sessions when engine.run completes after a conflict', async () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'merge' && argsArr[1] === 'refs/remotes/origin/improve') {
        throw createCommandError('merge conflict', 'CONFLICT (content): Merge conflict in src/file.ts');
      }
      return '';
    });

    const engine = createEngine(projectDir, createConflictCleanupWorkflowConfig());

    const state = await engine.run();
    const worktreePath = mockCloneAndIsolate.mock.calls[0]?.[1] as string;

    expect(state.status).toBe('completed');
    expect(mockCloneAndIsolate).toHaveBeenCalledTimes(1);
    expect(mockRemoveClone).toHaveBeenCalledTimes(1);
    expect(mockRemoveClone).toHaveBeenCalledWith(worktreePath);
  });

  it('cleans up retained PR sync sessions when runSingleIteration reaches completion', async () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'merge' && argsArr[1] === 'refs/remotes/origin/improve') {
        throw createCommandError('merge conflict', 'CONFLICT (content): Merge conflict in src/file.ts');
      }
      return '';
    });

    const engine = createEngine(projectDir, createConflictCleanupWorkflowConfig());

    const routeResult = await engine.runSingleIteration();

    expect(routeResult.isComplete).toBe(false);
    expect(mockRemoveClone).not.toHaveBeenCalled();

    const prepareMergeResult = await engine.runSingleIteration();
    const worktreePath = mockCloneAndIsolate.mock.calls[0]?.[1] as string;

    expect(prepareMergeResult.isComplete).toBe(true);
    expect(prepareMergeResult.nextStep).toBe('COMPLETE');
    expect(engine.getState().status).toBe('completed');
    expect(mockCloneAndIsolate).toHaveBeenCalledTimes(1);
    expect(mockRemoveClone).toHaveBeenCalledTimes(1);
    expect(mockRemoveClone).toHaveBeenCalledWith(worktreePath);
  });

  it('cleans up retained PR sync sessions when a workflow_call child completes', async () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'merge' && argsArr[1] === 'refs/remotes/origin/improve') {
        throw createCommandError('merge conflict', 'CONFLICT (content): Merge conflict in src/file.ts');
      }
      return '';
    });

    const childConfig = normalizeWorkflowConfig({
      ...createConflictCleanupWorkflowConfig(),
      name: 'prepare-merge-child',
      subworkflow: {
        callable: true,
      },
    }, projectDir);
    const engine = createEngine(projectDir, {
      name: 'parent-workflow-call-cleanup',
      initial_step: 'delegate',
      max_steps: 6,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'prepare-merge-child',
          rules: [
            { condition: 'COMPLETE', next: 'COMPLETE' },
            { condition: 'ABORT', next: 'ABORT' },
          ],
        },
      ],
    }, {
      workflowCallResolver: ({ identifier }: { identifier: string }) => {
        return identifier === 'prepare-merge-child' ? childConfig : null;
      },
    });

    const state = await engine.run();
    const worktreePath = mockCloneAndIsolate.mock.calls[0]?.[1] as string;

    expect(state.status).toBe('completed');
    expect(mockCloneAndIsolate).toHaveBeenCalledTimes(1);
    expect(mockRemoveClone).toHaveBeenCalledTimes(1);
    expect(mockRemoveClone).toHaveBeenCalledWith(worktreePath);
  });

  it('cleans up retained PR sync sessions when runSingleIteration throws after a conflict', async () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'merge' && argsArr[1] === 'refs/remotes/origin/improve') {
        throw createCommandError('merge conflict', 'CONFLICT (content): Merge conflict in src/file.ts');
      }
      return '';
    });

    const engine = createEngine(projectDir, createConflictThenThrowWorkflowConfig());

    const routeResult = await engine.runSingleIteration();
    expect(routeResult.isComplete).toBe(false);

    const prepareMergeResult = await engine.runSingleIteration();
    const worktreePath = mockCloneAndIsolate.mock.calls[0]?.[1] as string;

    expect(prepareMergeResult.isComplete).toBe(false);
    expect(prepareMergeResult.nextStep).toBe('explode');
    expect(mockRemoveClone).not.toHaveBeenCalled();

    await expect(engine.runSingleIteration()).rejects.toThrow('System effect requires positive integer');
    expect(mockRemoveClone).toHaveBeenCalledTimes(1);
    expect(mockRemoveClone).toHaveBeenCalledWith(worktreePath);
  });
});
