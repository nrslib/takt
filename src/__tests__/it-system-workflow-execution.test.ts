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

  it('system input と structured output を経由して COMPLETE できる', async () => {
    setMockScenario([
      {
        persona: 'planner',
        status: 'done',
        content: 'No follow-up needed.',
        structuredOutput: {
          action: 'noop',
        },
      },
    ]);

    const config = normalizeWorkflowConfig(
      {
        name: 'auto-improvement-loop',
        initial_step: 'route_context',
        max_steps: 4,
        schemas: {
          'followup-task': 'followup-task',
        },
        steps: [
          {
            name: 'route_context',
            mode: 'system',
            system_inputs: [
              { type: 'task_context', source: 'current_task', as: 'task' },
            ],
            rules: [
              {
                condition: 'when(context.route_context.task.exists == true)',
                next: 'plan_followup',
              },
              {
                condition: 'when(true)',
                next: 'ABORT',
              },
            ],
          },
          {
            name: 'plan_followup',
            persona: 'planner',
            instruction: 'Plan the next follow-up action.',
            structured_output: {
              schema_ref: 'followup-task',
            },
            rules: [
              {
                condition: 'when(structured.plan_followup.action == "noop")',
                next: 'COMPLETE',
              },
              {
                condition: 'when(true)',
                next: 'ABORT',
              },
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

    const state = await engine.run();
    const stateRecord = state as Record<string, unknown>;

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(2);
    expect(stateRecord.systemContexts).toBeInstanceOf(Map);
    expect(stateRecord.structuredOutputs).toBeInstanceOf(Map);
    expect((stateRecord.systemContexts as Map<string, unknown>).get('route_context')).toEqual({
      task: {
        exists: true,
        body: 'Current task body',
      },
    });
    expect((stateRecord.structuredOutputs as Map<string, unknown>).get('plan_followup')).toEqual({
      action: 'noop',
    });
  });

  it('deterministic when を持つ structured_output step を Phase 3 なしで遷移できる', async () => {
    setMockScenario([
      {
        persona: 'planner',
        status: 'done',
        content: 'Structured output prepared.',
        structuredOutput: {
          action: 'noop',
        },
      },
    ]);

    const config = normalizeWorkflowConfig(
      {
        name: 'structured-when-without-phase3',
        initial_step: 'plan_followup',
        max_steps: 2,
        schemas: {
          'followup-task': 'followup-task',
        },
        steps: [
          {
            name: 'plan_followup',
            persona: 'planner',
            instruction: 'Plan the next follow-up action.',
            structured_output: {
              schema_ref: 'followup-task',
            },
            rules: [
              {
                condition: 'when(structured.plan_followup.action == "noop")',
                next: 'COMPLETE',
              },
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

    const state = await engine.run();
    const stateRecord = state as Record<string, unknown>;

    expect(state.status).toBe('completed');
    expect((stateRecord.structuredOutputs as Map<string, unknown>).get('plan_followup')).toEqual({
      action: 'noop',
    });
  });

  it('wait_before_next_scan は exclude_current_task 指定時に他の running task がなければ route_context に戻る', async () => {
    mockTaskRunnerListAllTaskItems.mockReturnValue([
      {
        name: 'orchestration-loop',
        kind: 'running',
        runSlug: 'test-report-dir',
        issueNumber: 586,
        prNumber: 42,
      },
    ]);

    const config = normalizeWorkflowConfig(
      {
        name: 'wait-loop-self-filter',
        initial_step: 'wait_before_next_scan',
        max_steps: 3,
        steps: [
          {
            name: 'wait_before_next_scan',
            mode: 'system',
            system_inputs: [
              { type: 'task_queue_context', source: 'current_project', as: 'queue', exclude_current_task: true },
            ],
            rules: [
              { condition: 'when(exists(context.wait_before_next_scan.queue.items, item.kind == "running"))', next: 'ABORT' },
              { condition: 'when(true)', next: 'route_context' },
            ],
          },
          {
            name: 'route_context',
            mode: 'system',
            system_inputs: [
              { type: 'task_queue_context', source: 'current_project', as: 'queue' },
            ],
            rules: [
              { condition: 'when(context.route_context.queue.total_count == 1)', next: 'COMPLETE' },
              { condition: 'when(true)', next: 'ABORT' },
            ],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
      ...createSystemEngineOptions(projectDir),
    });

    const state = await engine.run();
    const stateRecord = state as Record<string, unknown>;

    expect(state.status).toBe('completed');
    expect((stateRecord.systemContexts as Map<string, unknown>).get('wait_before_next_scan')).toEqual({
      queue: {
        exists: false,
        total_count: 0,
        pending_count: 0,
        running_count: 0,
        completed_count: 0,
        failed_count: 0,
        exceeded_count: 0,
        pr_failed_count: 0,
        items: [],
      },
    });
  });

  it.each(['en', 'ja'] as const)('実 builtin の空キュー時に wait_before_next_scan から route_context へ遷移する (%s)', async (language) => {
    const builtinPath = join(process.cwd(), 'builtins', language, 'workflows', 'auto-improvement-loop.yaml');
    const builtin = parse(readFileSync(builtinPath, 'utf-8')) as {
      steps: Array<Record<string, unknown>>;
    };
    const waitBeforeNextScan = builtin.steps.find((step) => step.name === 'wait_before_next_scan');
    if (!waitBeforeNextScan) {
      throw new Error('wait_before_next_scan is required in the auto-improvement-loop builtin');
    }
    const config = normalizeWorkflowConfig({
      name: `builtin-empty-queue-${language}`,
      initial_step: 'wait_before_next_scan',
      max_steps: 2,
      steps: [
        { ...waitBeforeNextScan, delay_before_ms: 0 },
        {
          name: 'route_context',
          mode: 'system',
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }],
        },
      ],
    }, projectDir);
    const visitedSteps: string[] = [];
    const engine = new WorkflowEngine(config, projectDir, 'Current task body', createSystemEngineOptions(projectDir));
    engine.on('step:start', (step) => visitedSteps.push(step.name));

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(visitedSteps).toEqual(['wait_before_next_scan', 'route_context']);
  });

  it('agent instruction でも context と structured を補間できる', async () => {
    setMockScenario([
      {
        persona: 'planner',
        status: 'done',
        content: 'Need a PR comment.',
        structuredOutput: {
          action: 'comment_on_pr',
          pr_comment_markdown: 'Please update the tests.',
        },
      },
      {
        persona: 'reviewer',
        status: 'done',
        content: 'Reviewed.',
      },
    ]);

    const config = normalizeWorkflowConfig(
      {
        name: 'instruction-context-interpolation',
        initial_step: 'route_context',
        max_steps: 3,
        schemas: {
          'followup-task': 'followup-task',
        },
        steps: [
          {
            name: 'route_context',
            mode: 'system',
            system_inputs: [
              { type: 'issue_context', source: 'current_task', as: 'issue' },
            ],
            rules: [
              { condition: 'when(context.route_context.issue.exists == false)', next: 'plan_followup' },
            ],
          },
          {
            name: 'plan_followup',
            persona: 'planner',
            instruction: 'Plan the next follow-up action.',
            structured_output: {
              schema_ref: 'followup-task',
            },
            rules: [
              { condition: 'when(structured.plan_followup.action == "comment_on_pr")', next: 'draft_comment' },
            ],
          },
          {
            name: 'draft_comment',
            persona: 'reviewer',
            instruction: [
              'Issue exists: {context:route_context.issue.exists}',
              'Action: {structured:plan_followup.action}',
              'Comment: {structured:plan_followup.pr_comment_markdown}',
            ].join('\\n'),
            rules: [
              { condition: 'when(true)', next: 'COMPLETE' },
            ],
          },
        ],
      },
      projectDir,
    );

    const instructions: string[] = [];
    const engine = new WorkflowEngine(config, projectDir, 'Current task body', createSystemEngineOptions(projectDir));
    engine.on('step:start', (step, _iteration, instruction) => {
      if (step.name === 'draft_comment') {
        instructions.push(instruction);
      }
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toContain('Issue exists: false');
    expect(instructions[0]).toContain('Action: comment_on_pr');
    expect(instructions[0]).toContain('Comment: Please update the tests.');
  });

  it('agent step でも delay_before_ms を実行前に待機する', async () => {
    vi.useFakeTimers();
    setMockScenario([
      {
        persona: 'planner',
        status: 'done',
        content: 'Delayed execution finished.',
      },
    ]);

    const config = normalizeWorkflowConfig(
      {
        name: 'delayed-agent-step',
        initial_step: 'plan_followup',
        max_steps: 2,
        steps: [
          {
            name: 'plan_followup',
            persona: 'planner',
            delay_before_ms: 50,
            instruction: 'Plan the next follow-up action.',
            rules: [
              { condition: 'when(true)', next: 'COMPLETE' },
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
      reportDirName: 'test-report-dir',
      systemStepServicesFactory: createDefaultSystemStepServices,
    });

    let settled = false;
    const runPromise = engine.run().then((state) => {
      settled = true;
      return state;
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const state = await runPromise;
    expect(state.status).toBe('completed');
  });

  it('system step でも delay_before_ms を実行前に待機する', async () => {
    vi.useFakeTimers();
    const createServices = vi.fn((options: Parameters<typeof createDefaultSystemStepServices>[0]) =>
      createDefaultSystemStepServices(options),
    );

    const config = normalizeWorkflowConfig(
      {
        name: 'delayed-system-step',
        initial_step: 'route_context',
        max_steps: 2,
        steps: [
          {
            name: 'route_context',
            mode: 'system',
            delay_before_ms: 50,
            system_inputs: [
              { type: 'task_context', source: 'current_task', as: 'task' },
            ],
            rules: [
              { condition: 'when(true)', next: 'COMPLETE' },
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
      reportDirName: 'test-report-dir',
      systemStepServicesFactory: createServices,
    });

    let settled = false;
    const runPromise = engine.run().then((state) => {
      settled = true;
      return state;
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    expect(createServices).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const state = await runPromise;
    expect(state.status).toBe('completed');
    expect(createServices).toHaveBeenCalledTimes(1);
  });

});
