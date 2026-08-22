import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { parse } from 'yaml';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';
import { createDefaultStructuredOutputNormalizers } from '../infra/workflow/structured-output/followup-task-normalizer.js';

const {
  mockCommentOnPr,
  mockClosePr,
  mockMergePr,
  mockSaveTaskFile,
  mockCreateIssueFromTaskResult,
  mockCloseIssue,
  mockCreateBaseBranchIfMissing,
  mockResolveBaseBranch,
  mockFindExistingPr,
  mockFetchPrReviewComments,
  mockListOpenIssues,
  mockListOpenPrs,
  mockTaskRunnerListAllTaskItems,
  mockLogInfo,
} = vi.hoisted(() => ({
  mockCommentOnPr: vi.fn(),
  mockClosePr: vi.fn(),
  mockMergePr: vi.fn(),
  mockSaveTaskFile: vi.fn(),
  mockCreateIssueFromTaskResult: vi.fn(),
  mockCloseIssue: vi.fn(),
  mockCreateBaseBranchIfMissing: vi.fn(),
  mockResolveBaseBranch: vi.fn(),
  mockFindExistingPr: vi.fn(),
  mockFetchPrReviewComments: vi.fn(),
  mockListOpenIssues: vi.fn(),
  mockListOpenPrs: vi.fn(),
  mockTaskRunnerListAllTaskItems: vi.fn(),
  mockLogInfo: vi.fn(),
}));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn().mockReturnValue({}),
  getLanguage: vi.fn().mockReturnValue('en'),
  getBuiltinWorkflowsEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/config/project/projectConfig.js', () => ({
  loadProjectConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: vi.fn(() => ({
    commentOnPr: (...args: unknown[]) => mockCommentOnPr(...args),
    closePr: (...args: unknown[]) => mockClosePr(...args),
    mergePr: (...args: unknown[]) => mockMergePr(...args),
    closeIssue: (...args: unknown[]) => mockCloseIssue(...args),
    findExistingPr: (...args: unknown[]) => mockFindExistingPr(...args),
    fetchPrReviewComments: (...args: unknown[]) => mockFetchPrReviewComments(...args),
    listOpenIssues: (...args: unknown[]) => mockListOpenIssues(...args),
    listOpenPrs: (...args: unknown[]) => mockListOpenPrs(...args),
    checkCliStatus: vi.fn(() => ({ available: true })),
  })),
}));

vi.mock('../infra/task/enqueuedTaskFile.js', () => ({
  saveEnqueuedTaskFile: (...args: unknown[]) => mockSaveTaskFile(...args),
}));

vi.mock('../infra/task/issueTask.js', () => ({
  createIssueFromTaskResult: (...args: unknown[]) => mockCreateIssueFromTaskResult(...args),
}));

vi.mock('../infra/task/index.js', () => ({
  getCurrentBranch: vi.fn(() => 'task/test-branch'),
  createBaseBranchIfMissing: (...args: unknown[]) => mockCreateBaseBranchIfMissing(...args),
  materializeCloneHeadToRootBranch: vi.fn(),
  relayPushCloneToOrigin: vi.fn(),
  resolveBaseBranch: (...args: unknown[]) => mockResolveBaseBranch(...args),
  TaskRunner: class {
    listAllTaskItems() {
      return mockTaskRunnerListAllTaskItems();
    }
  },
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: mockLogInfo,
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { WorkflowEngine } from '../core/workflow/index.js';

function createSystemEngineOptions(projectDir: string) {
  return {
    projectCwd: projectDir,
    provider: 'mock' as const,
    structuredCaller: {
      judgeStatus: vi.fn(),
      evaluateCondition: vi.fn().mockResolvedValue(-1),
      decomposeTask: vi.fn(),
      requestMoreParts: vi.fn(),
    },
    structuredOutputNormalizers: createDefaultStructuredOutputNormalizers(),
    reportDirName: 'test-report-dir',
    currentTask: {
      runSlug: 'test-report-dir',
    },
    systemStepServicesFactory: createDefaultSystemStepServices,
  };
}

function createFollowupStructuredOutput(overrides: {
  action: 'enqueue_new_task' | 'wait_before_next_scan';
  title?: string;
  type?: 'feature' | 'bug' | 'chore' | 'docs';
  scope?: string;
  summary?: string;
  goals?: string[];
  acceptance_criteria?: string[];
  labels?: string[];
  issue?: {
    create?: boolean;
  };
}) {
  const enqueueNewTask = overrides.action === 'enqueue_new_task';
  return {
    action: overrides.action,
    title: overrides.title ?? (enqueueNewTask ? 'Complete the follow-up task' : ''),
    type: overrides.type ?? 'chore',
    scope: overrides.scope ?? '',
    summary: overrides.summary ?? '',
    goals: overrides.goals ?? (enqueueNewTask ? ['Complete the follow-up task'] : []),
    acceptance_criteria: overrides.acceptance_criteria ?? (
      enqueueNewTask
        ? ['Task requirements are implemented', 'Validation is completed']
        : []
    ),
    labels: overrides.labels ?? [],
    issue: {
      create: false,
      ...overrides.issue,
    },
  };
}

function renderExpectedFallbackTask(summary: string): string {
  return [
    '## Summary',
    summary,
    '',
    '## Goals',
    `- ${summary}`,
    '',
    '## Acceptance Criteria',
    '- [ ] Task requirements are captured in task_markdown.',
    '- [ ] Completion can be verified against the task instruction.',
  ].join('\n');
}

describe('system workflow execution integration', () => {
  let projectDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    projectDir = mkdtempSync(join(tmpdir(), 'takt-system-it-'));
    mockSaveTaskFile.mockResolvedValue({ taskName: 'task-1', tasksFile: join(projectDir, '.takt', 'tasks.yaml') });
    mockCreateIssueFromTaskResult.mockReturnValue({ success: true, issueNumber: 586 });
    mockCloseIssue.mockReturnValue({ success: true });
    mockCreateBaseBranchIfMissing.mockImplementation((_cwd: string, config: { name: string }) => ({
      branch: config.name,
      created: true,
    }));
    mockResolveBaseBranch.mockImplementation((_cwd: string, branch?: string) => ({ branch: branch ?? 'main' }));
    mockClosePr.mockReturnValue({ success: true });
    mockMergePr.mockReturnValue({ success: true });
    mockListOpenIssues.mockReset();
    mockListOpenIssues.mockReturnValue([]);
    mockListOpenPrs.mockReset();
    mockListOpenPrs.mockReturnValue([]);
    mockTaskRunnerListAllTaskItems.mockReturnValue([]);
    mockFindExistingPr.mockReturnValue({ number: 42, url: 'https://example.test/pr/42' });
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
    mkdirSync(join(projectDir, '.takt', 'schemas'), { recursive: true });
    writeFileSync(
      join(projectDir, '.takt', 'schemas', 'followup-task.json'),
      JSON.stringify({
        type: 'object',
        properties: {
          action: { type: 'string' },
          task_markdown: { type: 'string' },
          issue: {
            type: 'object',
            additionalProperties: true,
          },
        },
        required: ['action'],
      }),
      'utf-8',
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    resetScenario();
    rmSync(projectDir, { recursive: true, force: true });
  });

  function createFreshFollowupFallbackWorkflow(name: string) {
    return normalizeWorkflowConfig(
      {
        name,
        initial_step: 'plan_fresh_improvement',
        max_steps: 3,
        schemas: {
          'followup-task': 'followup-task',
        },
        steps: [
          {
            name: 'plan_fresh_improvement',
            persona: 'planner',
            instruction: 'Plan the next follow-up action.',
            structured_output: {
              schema_ref: 'followup-task',
            },
            rules: [
              { condition: 'when(structured.plan_fresh_improvement.action == "enqueue_new_task")', next: 'enqueue_fresh' },
            ],
          },
          {
            name: 'enqueue_fresh',
            mode: 'system',
            effects: [
              {
                type: 'enqueue_task',
                mode: 'new',
                workflow: 'takt-default',
                task: '{structured:plan_fresh_improvement.task_markdown}',
                issue: '{structured:plan_fresh_improvement.issue}',
              },
            ],
            rules: [
              { condition: 'when(effect.enqueue_fresh.enqueue_task.success == true)', next: 'COMPLETE' },
            ],
          },
        ],
      },
      projectDir,
    );
  }

  it('followup-task の structured output が不正な場合は fallback せず abort する', async () => {
    setMockScenario([
      {
        persona: 'planner',
        status: 'done',
        content: '## Implement fallback follow-up\nDetails',
        structuredOutput: {},
      },
    ]);

    const config = normalizeWorkflowConfig(
      {
        name: 'effect-issue-template-structured-fallback',
        initial_step: 'plan_fresh_improvement',
        max_steps: 3,
        schemas: {
          'followup-task': 'followup-task',
        },
        steps: [
          {
            name: 'plan_fresh_improvement',
            persona: 'planner',
            instruction: 'Plan the next follow-up action.',
            structured_output: {
              schema_ref: 'followup-task',
            },
            rules: [
              { condition: 'when(structured.plan_fresh_improvement.action == "enqueue_new_task")', next: 'enqueue_fresh' },
            ],
          },
          {
            name: 'enqueue_fresh',
            mode: 'system',
            effects: [
              {
                type: 'enqueue_task',
                mode: 'new',
                workflow: 'takt-default',
                task: '{structured:plan_fresh_improvement.task_markdown}',
                issue: '{structured:plan_fresh_improvement.issue}',
              },
            ],
            rules: [
              { condition: 'when(effect.enqueue_fresh.enqueue_task.success == true)', next: 'COMPLETE' },
            ],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
      projectCwd: projectDir,
      provider: 'mock',
      structuredCaller: {
        judgeStatus: vi.fn(),
        evaluateCondition: vi.fn().mockResolvedValue(-1),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createDefaultStructuredOutputNormalizers(),
      reportDirName: 'test-report-dir',
      systemStepServicesFactory: createDefaultSystemStepServices,
    });

    let abortReason = '';
    engine.on('workflow:abort', (_state, reason) => {
      abortReason = reason;
    });
    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReason).toContain('required');
    expect(mockCreateIssueFromTaskResult).not.toHaveBeenCalled();
    expect(mockSaveTaskFile).not.toHaveBeenCalled();
    expect(mockLogInfo).not.toHaveBeenCalledWith(
      'Structured output failed, falling back to task_markdown issue flow',
      expect.anything(),
    );
  });

  it('followup-task の structured output 欠落時は missing としてログに残す', async () => {
    setMockScenario([
      {
        persona: 'planner',
        status: 'done',
        content: '## Implement missing structured output fallback\nDetails',
      },
    ]);

    const config = normalizeWorkflowConfig(
      {
        name: 'effect-issue-template-missing-structured-output',
        initial_step: 'plan_fresh_improvement',
        max_steps: 3,
        schemas: {
          'followup-task': 'followup-task',
        },
        steps: [
          {
            name: 'plan_fresh_improvement',
            persona: 'planner',
            instruction: 'Plan the next follow-up action.',
            structured_output: {
              schema_ref: 'followup-task',
            },
            rules: [
              { condition: 'when(structured.plan_fresh_improvement.action == "enqueue_new_task")', next: 'enqueue_fresh' },
            ],
          },
          {
            name: 'enqueue_fresh',
            mode: 'system',
            effects: [
              {
                type: 'enqueue_task',
                mode: 'new',
                workflow: 'takt-default',
                task: '{structured:plan_fresh_improvement.task_markdown}',
                issue: '{structured:plan_fresh_improvement.issue}',
              },
            ],
            rules: [
              { condition: 'when(effect.enqueue_fresh.enqueue_task.success == true)', next: 'COMPLETE' },
            ],
          },
        ],
      },
      projectDir,
    );

    const state = await new WorkflowEngine(
      config,
      projectDir,
      'Current task body',
      createSystemEngineOptions(projectDir),
    ).run();

    expect(state.status).toBe('completed');
    const renderedTask = renderExpectedFallbackTask('Implement missing structured output fallback');
    expect(mockCreateIssueFromTaskResult).toHaveBeenCalledWith(renderedTask, expect.objectContaining({
      cwd: projectDir,
      outputMode: 'silent',
    }));
    expect(mockSaveTaskFile).toHaveBeenCalledWith(projectDir, renderedTask, {
      workflow: 'takt-default',
      issue: 586,
    });
    expect(mockLogInfo).toHaveBeenCalledWith(
      'Structured output failed, falling back to task_markdown issue flow',
      expect.objectContaining({
        step: 'plan_fresh_improvement',
        used_structured_output: false,
        structured_output_failure_reason: 'missing',
      }),
    );
  });

  it('followup-task の provider error は本文があっても fallback せず abort する', async () => {
    setMockScenario([
      {
        persona: 'planner',
        status: 'error',
        content: '## Implement provider error fallback\nDetails',
        error: 'provider failed after partial response',
        failureCategory: 'provider_error',
        structuredOutput: createFollowupStructuredOutput({
          action: 'enqueue_new_task',
          goals: [],
          acceptance_criteria: [],
          issue: {
            create: true,
          },
        }),
      },
    ]);

    const config = normalizeWorkflowConfig(
      {
        name: 'effect-issue-template-provider-error-fallback',
        initial_step: 'plan_fresh_improvement',
        max_steps: 3,
        schemas: {
          'followup-task': 'followup-task',
        },
        steps: [
          {
            name: 'plan_fresh_improvement',
            persona: 'planner',
            instruction: 'Plan the next follow-up action.',
            structured_output: {
              schema_ref: 'followup-task',
            },
            rules: [
              { condition: 'when(structured.plan_fresh_improvement.action == "enqueue_new_task")', next: 'enqueue_fresh' },
            ],
          },
          {
            name: 'enqueue_fresh',
            mode: 'system',
            effects: [
              {
                type: 'enqueue_task',
                mode: 'new',
                workflow: 'takt-default',
                task: '{structured:plan_fresh_improvement.task_markdown}',
                issue: '{structured:plan_fresh_improvement.issue}',
              },
            ],
            rules: [
              { condition: 'when(effect.enqueue_fresh.enqueue_task.success == true)', next: 'COMPLETE' },
            ],
          },
        ],
      },
      projectDir,
    );

    let abortReason = '';
    const engine = new WorkflowEngine(
      config,
      projectDir,
      'Current task body',
      createSystemEngineOptions(projectDir),
    );
    engine.on('workflow:abort', (_state, reason) => {
      abortReason = reason;
    });
    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReason).toContain('provider failed after partial response');
    expect(mockCreateIssueFromTaskResult).not.toHaveBeenCalled();
    expect(mockSaveTaskFile).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      'Structured output failed',
      expect.objectContaining({
        step: 'plan_fresh_improvement',
        used_structured_output: false,
        structured_output_failure_reason: 'provider_error',
        error: 'provider failed after partial response',
      }),
    );
  });

  it.each([
    {
      name: 'stream idle timeout',
      contentTitle: 'Implement stream timeout fallback',
      failureCategory: 'stream_idle_timeout' as const,
      error: 'stream idle timeout',
    },
    {
      name: 'part timeout',
      contentTitle: 'Implement part timeout fallback',
      failureCategory: 'part_timeout' as const,
      error: 'part timeout',
    },
  ])('followup-task の $name は本文があっても fallback せず abort する', async (input) => {
    setMockScenario([
      {
        persona: 'planner',
        status: 'error',
        content: `## ${input.contentTitle}\nDetails`,
        error: input.error,
        failureCategory: input.failureCategory,
      },
    ]);

    const config = normalizeWorkflowConfig(
      {
        name: `effect-issue-template-${input.failureCategory}-fallback`,
        initial_step: 'plan_fresh_improvement',
        max_steps: 3,
        schemas: {
          'followup-task': 'followup-task',
        },
        steps: [
          {
            name: 'plan_fresh_improvement',
            persona: 'planner',
            instruction: 'Plan the next follow-up action.',
            structured_output: {
              schema_ref: 'followup-task',
            },
            rules: [
              { condition: 'when(structured.plan_fresh_improvement.action == "enqueue_new_task")', next: 'enqueue_fresh' },
            ],
          },
          {
            name: 'enqueue_fresh',
            mode: 'system',
            effects: [
              {
                type: 'enqueue_task',
                mode: 'new',
                workflow: 'takt-default',
                task: '{structured:plan_fresh_improvement.task_markdown}',
                issue: '{structured:plan_fresh_improvement.issue}',
              },
            ],
            rules: [
              { condition: 'when(effect.enqueue_fresh.enqueue_task.success == true)', next: 'COMPLETE' },
            ],
          },
        ],
      },
      projectDir,
    );

    let abortReason = '';
    const engine = new WorkflowEngine(
      config,
      projectDir,
      'Current task body',
      createSystemEngineOptions(projectDir),
    );
    engine.on('workflow:abort', (_state, reason) => {
      abortReason = reason;
    });
    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReason).toContain(input.error);
    expect(mockCreateIssueFromTaskResult).not.toHaveBeenCalled();
    expect(mockSaveTaskFile).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      'Structured output failed',
      expect.objectContaining({
        step: 'plan_fresh_improvement',
        used_structured_output: false,
        structured_output_failure_reason: 'timeout',
        error: input.error,
      }),
    );
  });

  it.each([
    {
      name: 'provider error',
      failureCategory: 'provider_error' as const,
      expectedReason: 'provider_error',
      error: 'provider failed before content',
    },
    {
      name: 'timeout',
      failureCategory: 'stream_idle_timeout' as const,
      expectedReason: 'timeout',
      error: 'stream idle timeout before content',
    },
    {
      name: 'part timeout',
      failureCategory: 'part_timeout' as const,
      expectedReason: 'timeout',
      error: 'part timeout before content',
    },
  ])('followup-task の $name は本文が空なら fallback せず abort する', async (input) => {
    setMockScenario([
      {
        persona: 'planner',
        status: 'error',
        content: '',
        error: input.error,
        failureCategory: input.failureCategory,
      },
    ]);

    const state = await new WorkflowEngine(
      createFreshFollowupFallbackWorkflow(`effect-issue-template-${input.failureCategory}-empty-abort`),
      projectDir,
      'Current task body',
      createSystemEngineOptions(projectDir),
    ).run();

    expect(state.status).toBe('aborted');
    expect(mockCreateIssueFromTaskResult).not.toHaveBeenCalled();
    expect(mockSaveTaskFile).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      'Structured output failed',
      expect.objectContaining({
        step: 'plan_fresh_improvement',
        used_structured_output: false,
        structured_output_failure_reason: input.expectedReason,
        error: input.error,
      }),
    );
  });

  it.each([
    {
      name: 'provider error',
      failureCategory: 'provider_error' as const,
      expectedReason: 'provider_error',
      error: 'Codex execution failed',
    },
    {
      name: 'stream idle timeout',
      failureCategory: 'stream_idle_timeout' as const,
      expectedReason: 'timeout',
      error: 'Codex stream idle timeout',
    },
    {
      name: 'part timeout',
      failureCategory: 'part_timeout' as const,
      expectedReason: 'timeout',
      error: 'Codex part timeout',
    },
  ])('followup-task の $name は content が error と同一なら fallback せず abort する', async (input) => {
    setMockScenario([
      {
        persona: 'planner',
        status: 'error',
        content: input.error,
        error: input.error,
        failureCategory: input.failureCategory,
      },
    ]);

    const state = await new WorkflowEngine(
      createFreshFollowupFallbackWorkflow(`effect-issue-template-${input.failureCategory}-error-content-abort`),
      projectDir,
      'Current task body',
      createSystemEngineOptions(projectDir),
    ).run();

    expect(state.status).toBe('aborted');
    expect(mockCreateIssueFromTaskResult).not.toHaveBeenCalled();
    expect(mockSaveTaskFile).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      'Structured output failed',
      expect.objectContaining({
        step: 'plan_fresh_improvement',
        used_structured_output: false,
        structured_output_failure_reason: input.expectedReason,
        error: input.error,
      }),
    );
  });

  it('followup-task の schema error が fallback 不能な場合も失敗理由をログに残す', async () => {
    setMockScenario([
      {
        persona: 'planner',
        status: 'done',
        content: '',
        structuredOutput: {},
      },
    ]);

    const state = await new WorkflowEngine(
      createFreshFollowupFallbackWorkflow('effect-issue-template-schema-error-no-fallback'),
      projectDir,
      'Current task body',
      createSystemEngineOptions(projectDir),
    ).run();

    expect(state.status).toBe('aborted');
    expect(mockCreateIssueFromTaskResult).not.toHaveBeenCalled();
    expect(mockSaveTaskFile).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      'Structured output failed',
      expect.objectContaining({
        step: 'plan_fresh_improvement',
        used_structured_output: false,
        structured_output_failure_reason: 'schema_error',
      }),
    );
  });

});
