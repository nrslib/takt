import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';
import { detectRuleIndex } from '../shared/utils/ruleIndex.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';

const {
  mockCommentOnPr,
  mockMergePr,
  mockSaveTaskFile,
  mockCreateIssueFromTask,
  mockResolveBaseBranch,
  mockFindExistingPr,
  mockFetchPrReviewComments,
  mockListOpenIssues,
  mockListOpenPrs,
  mockTaskRunnerListAllTaskItems,
} = vi.hoisted(() => ({
  mockCommentOnPr: vi.fn(),
  mockMergePr: vi.fn(),
  mockSaveTaskFile: vi.fn(),
  mockCreateIssueFromTask: vi.fn(),
  mockResolveBaseBranch: vi.fn(),
  mockFindExistingPr: vi.fn(),
  mockFetchPrReviewComments: vi.fn(),
  mockListOpenIssues: vi.fn(),
  mockListOpenPrs: vi.fn(),
  mockTaskRunnerListAllTaskItems: vi.fn(),
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
    mergePr: (...args: unknown[]) => mockMergePr(...args),
    findExistingPr: (...args: unknown[]) => mockFindExistingPr(...args),
    fetchPrReviewComments: (...args: unknown[]) => mockFetchPrReviewComments(...args),
    listOpenIssues: (...args: unknown[]) => mockListOpenIssues(...args),
    listOpenPrs: (...args: unknown[]) => mockListOpenPrs(...args),
    checkCliStatus: vi.fn(() => ({ available: true })),
  })),
}));

vi.mock('../features/tasks/add/index.js', () => ({
  saveTaskFile: (...args: unknown[]) => mockSaveTaskFile(...args),
  createIssueFromTask: (...args: unknown[]) => mockCreateIssueFromTask(...args),
}));

vi.mock('../infra/task/index.js', () => ({
  getCurrentBranch: vi.fn(() => 'task/test-branch'),
  materializeCloneHeadToRootBranch: vi.fn(),
  relayPushCloneToOrigin: vi.fn(),
  resolveBaseBranch: (...args: unknown[]) => mockResolveBaseBranch(...args),
  TaskRunner: class {
    listAllTaskItems() {
      return mockTaskRunnerListAllTaskItems();
    }
  },
}));

import { WorkflowEngine } from '../core/workflow/index.js';

function createSystemEngineOptions(projectDir: string) {
  return {
    projectCwd: projectDir,
    provider: 'mock' as const,
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
  };
}

function loadBuiltinAutoImprovementLoopForIssueExecution(projectDir: string) {
  const config = normalizeWorkflowConfig(
    parse(readFileSync(
      join(process.cwd(), 'builtins', 'en', 'workflows', 'auto-improvement-loop.yaml'),
      'utf-8',
    )),
    projectDir,
  );
  return {
    ...config,
    maxSteps: 6,
    steps: config.steps.map((step) => {
      if (step.name === 'plan_from_issue' || step.name === 'plan_fresh_improvement') {
        return {
          ...step,
          delayBeforeMs: 0,
        };
      }
      if (step.name === 'wait_before_next_scan') {
        return {
          ...step,
          delayBeforeMs: 0,
          rules: [
            { condition: 'true', next: 'COMPLETE' },
          ],
        };
      }
      return step;
    }),
  };
}

describe('system workflow execution integration', () => {
  let projectDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    projectDir = mkdtempSync(join(tmpdir(), 'takt-system-it-'));
    mockSaveTaskFile.mockResolvedValue({ taskName: 'task-1', tasksFile: join(projectDir, '.takt', 'tasks.yaml') });
    mockCreateIssueFromTask.mockReturnValue(586);
    mockResolveBaseBranch.mockImplementation((_cwd: string, branch?: string) => ({ branch: branch ?? 'main' }));
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
                when: 'context.route_context.task.exists == true',
                next: 'plan_followup',
              },
              {
                when: 'true',
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
                when: 'structured.plan_followup.action == "noop"',
                next: 'COMPLETE',
              },
              {
                when: 'true',
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
      detectRuleIndex,
      structuredCaller: {
        judgeStatus: vi.fn(),
        evaluateCondition: vi.fn().mockResolvedValue(-1),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
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
                when: 'structured.plan_followup.action == "noop"',
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
      detectRuleIndex,
      structuredCaller: {
        judgeStatus: vi.fn(),
        evaluateCondition: vi.fn().mockResolvedValue(-1),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
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

  it('context と structured のテンプレートを effect に展開し effect.when で COMPLETE できる', async () => {
    setMockScenario([
      {
        persona: 'planner',
        status: 'done',
        content: 'Comment on the PR.',
        structuredOutput: {
          action: 'comment',
          pr_comment_markdown: 'Please check the follow-up.',
        },
      },
    ]);
    mockCommentOnPr.mockReturnValue({ success: true });

    const config = normalizeWorkflowConfig(
      {
        name: 'effect-template-routing',
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
              { when: 'context.route_context.task.exists == true', next: 'plan_followup' },
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
              { when: 'structured.plan_followup.action == "comment"', next: 'comment_on_pr' },
            ],
          },
          {
            name: 'comment_on_pr',
            mode: 'system',
            effects: [
              {
                type: 'comment_pr',
                pr: 42,
                body: 'Task: {context:route_context.task.body}\n{structured:plan_followup.pr_comment_markdown}',
              },
            ],
            rules: [
              { when: 'effect.comment_on_pr.comment_pr.success == true', next: 'COMPLETE' },
            ],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
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
      systemStepServicesFactory: createDefaultSystemStepServices,
    });

    const state = await engine.run();
    const stateRecord = state as Record<string, unknown>;

    expect(state.status).toBe('completed');
    expect(mockCommentOnPr).toHaveBeenCalledWith(
      42,
      'Task: Current task body\nPlease check the follow-up.',
      projectDir,
    );
    expect((stateRecord.effectResults as Map<string, unknown>).get('comment_on_pr')).toEqual({
      comment_pr: {
        success: true,
        failed: false,
      },
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
              { when: 'exists(context.wait_before_next_scan.queue.items, item.kind == "running")', next: 'ABORT' },
              { when: 'true', next: 'route_context' },
            ],
          },
          {
            name: 'route_context',
            mode: 'system',
            system_inputs: [
              { type: 'task_queue_context', source: 'current_project', as: 'queue' },
            ],
            rules: [
              { when: 'context.route_context.queue.total_count == 1', next: 'COMPLETE' },
              { when: 'true', next: 'ABORT' },
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

  it('comment_pr.pr の full template を context 数値へ解決できる', async () => {
    mockCommentOnPr.mockReturnValue({ success: true });

    const config = normalizeWorkflowConfig(
      {
        name: 'effect-pr-template-routing',
        initial_step: 'route_context',
        max_steps: 3,
        steps: [
          {
            name: 'route_context',
            mode: 'system',
            system_inputs: [
              { type: 'pr_context', source: 'current_branch', as: 'pr' },
            ],
            rules: [
              { when: 'context.route_context.pr.exists == true', next: 'comment_on_pr' },
            ],
          },
          {
            name: 'comment_on_pr',
            mode: 'system',
            effects: [
              {
                type: 'comment_pr',
                pr: '{context:route_context.pr.number}',
                body: 'Queued',
              },
            ],
            rules: [
              { when: 'effect.comment_on_pr.comment_pr.success == true', next: 'COMPLETE' },
            ],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
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
      systemStepServicesFactory: createDefaultSystemStepServices,
    });

    const state = await engine.run();
    expect(state.status).toBe('completed');
    expect(mockCommentOnPr).toHaveBeenCalledWith(42, 'Queued', projectDir);
  });

  it('step 修飾付き effect 参照で同一 effect type を安全に保持できる', async () => {
    setMockScenario([
      {
        persona: 'planner',
        status: 'done',
        content: 'done',
      },
    ]);
    mockCommentOnPr.mockReturnValue({ success: true });

    const config = normalizeWorkflowConfig(
      {
        name: 'step-qualified-effects',
        initial_step: 'route_context',
        max_steps: 4,
        steps: [
          {
            name: 'route_context',
            mode: 'system',
            system_inputs: [
              { type: 'task_context', source: 'current_task', as: 'task' },
            ],
            rules: [
              { when: 'context.route_context.task.exists == true', next: 'comment_first' },
            ],
          },
          {
            name: 'comment_first',
            mode: 'system',
            effects: [
              { type: 'comment_pr', pr: 42, body: 'First comment' },
            ],
            rules: [
              { when: 'effect.comment_first.comment_pr.success == true', next: 'comment_second' },
            ],
          },
          {
            name: 'comment_second',
            mode: 'system',
            effects: [
              { type: 'comment_pr', pr: 42, body: 'Second comment' },
            ],
            rules: [
              {
                when: 'effect.comment_first.comment_pr.success == true && effect.comment_second.comment_pr.success == true',
                next: 'summarize',
              },
            ],
          },
          {
            name: 'summarize',
            persona: 'planner',
            instruction: 'Summarize follow-up state.',
            rules: [
              { when: 'true', next: 'COMPLETE' },
            ],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
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
      systemStepServicesFactory: createDefaultSystemStepServices,
    });

    const state = await engine.run();
    const stateRecord = state as Record<string, unknown>;

    expect(state.status).toBe('completed');
    expect(mockCommentOnPr).toHaveBeenNthCalledWith(1, 42, 'First comment', projectDir);
    expect(mockCommentOnPr).toHaveBeenNthCalledWith(2, 42, 'Second comment', projectDir);
    expect((stateRecord.effectResults as Map<string, unknown>).get('comment_first')).toEqual({
      comment_pr: {
        success: true,
        failed: false,
      },
    });
    expect((stateRecord.effectResults as Map<string, unknown>).get('comment_second')).toEqual({
      comment_pr: {
        success: true,
        failed: false,
      },
    });
  });

  it('enqueue_task.issue の full template を structured object へ解決できる', async () => {
    setMockScenario([
      {
        persona: 'planner',
        status: 'done',
        content: 'Enqueue a follow-up.',
        structuredOutput: {
          action: 'enqueue',
          issue: {
            create: true,
            labels: ['automation'],
          },
        },
      },
    ]);

    const config = normalizeWorkflowConfig(
      {
        name: 'effect-issue-template-routing',
        initial_step: 'plan_followup',
        max_steps: 3,
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
              { when: 'structured.plan_followup.action == "enqueue"', next: 'enqueue_followup' },
            ],
          },
          {
            name: 'enqueue_followup',
            mode: 'system',
            effects: [
              {
                type: 'enqueue_task',
                mode: 'new',
                workflow: 'takt-default',
                task: 'Implement follow-up',
                issue: '{structured:plan_followup.issue}',
                base_branch: 'improve',
              },
            ],
            rules: [
              { when: 'effect.enqueue_followup.enqueue_task.success == true', next: 'COMPLETE' },
            ],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
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
      systemStepServicesFactory: createDefaultSystemStepServices,
    });

    const state = await engine.run();
    expect(state.status).toBe('completed');
    expect(mockCreateIssueFromTask).toHaveBeenCalledWith('Implement follow-up', {
      cwd: projectDir,
      labels: ['automation'],
    });
    expect(mockSaveTaskFile).toHaveBeenCalledWith(projectDir, 'Implement follow-up', {
      workflow: 'takt-default',
      issue: 586,
      baseBranch: 'improve',
    });
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
              { when: 'context.route_context.issue.exists == false', next: 'plan_followup' },
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
              { when: 'structured.plan_followup.action == "comment_on_pr"', next: 'draft_comment' },
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
              { when: 'true', next: 'COMPLETE' },
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

  it('agent instruction でも effect を補間できる', async () => {
    setMockScenario([
      {
        persona: 'reviewer',
        status: 'done',
        content: 'Reviewed effect result.',
      },
    ]);
    mockCommentOnPr.mockReturnValue({ success: true });

    const config = normalizeWorkflowConfig(
      {
        name: 'instruction-effect-interpolation',
        initial_step: 'comment_on_pr',
        max_steps: 2,
        steps: [
          {
            name: 'comment_on_pr',
            mode: 'system',
            effects: [
              {
                type: 'comment_pr',
                pr: 42,
                body: 'Queued',
              },
            ],
            rules: [
              { when: 'effect.comment_on_pr.comment_pr.success == true', next: 'draft_review' },
            ],
          },
          {
            name: 'draft_review',
            persona: 'reviewer',
            instruction: 'Comment success: {effect:comment_on_pr.comment_pr.success}',
            rules: [
              { when: 'true', next: 'COMPLETE' },
            ],
          },
        ],
      },
      projectDir,
    );

    const instructions: string[] = [];
    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
      ...createSystemEngineOptions(projectDir),
    });
    engine.on('step:start', (step, _iteration, instruction) => {
      if (step.name === 'draft_review') {
        instructions.push(instruction);
      }
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toContain('Comment success: true');
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
              { when: 'true', next: 'COMPLETE' },
            ],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
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
              { when: 'true', next: 'COMPLETE' },
            ],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
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

  it('merge_pr effect の成功結果で遷移できる', async () => {
    const config = normalizeWorkflowConfig(
      {
        name: 'merge-pr-routing',
        initial_step: 'merge_ready_pr',
        max_steps: 2,
        steps: [
          {
            name: 'merge_ready_pr',
            mode: 'system',
            effects: [
              {
                type: 'merge_pr',
                pr: 42,
              },
            ],
            rules: [
              { when: 'effect.merge_ready_pr.merge_pr.success == true', next: 'COMPLETE' },
              { when: 'true', next: 'ABORT' },
            ],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', createSystemEngineOptions(projectDir));
    const state = await engine.run();
    const stateRecord = state as Record<string, unknown>;

    expect(state.status).toBe('completed');
    expect(mockMergePr).toHaveBeenCalledWith(42, projectDir);
    expect((stateRecord.effectResults as Map<string, unknown>).get('merge_ready_pr')).toEqual({
      merge_pr: {
        success: true,
        failed: false,
      },
    });
  });

  it('pr_list と queue.items を when の配列参照と exists で評価して遷移できる', async () => {
    const createServices = vi.fn(() => ({
      resolveSystemInput(input: { type: string }) {
        if (input.type === 'pr_list') {
          return [
            {
              number: 42,
              author: 'nrslib',
              base_branch: 'improve',
              head_branch: 'task/42',
              draft: false,
            },
          ];
        }
        if (input.type === 'task_queue_context') {
          return {
            exists: true,
            total_count: 1,
            pending_count: 0,
            running_count: 1,
            completed_count: 0,
            failed_count: 0,
            exceeded_count: 0,
            pr_failed_count: 0,
            items: [
              {
                task_name: 'task-42',
                kind: 'running',
                issue: 586,
                pr: 42,
              },
            ],
          };
        }
        throw new Error(`Unexpected system input: ${input.type}`);
      },
      async executeEffect() {
        throw new Error('No effects expected in this workflow');
      },
    }));

    const config = normalizeWorkflowConfig(
      {
        name: 'route-with-pr-list',
        initial_step: 'route_context',
        max_steps: 2,
        steps: [
          {
            name: 'route_context',
            mode: 'system',
            system_inputs: [
              { type: 'pr_list', source: 'current_project', as: 'prs', where: { draft: false } },
              { type: 'task_queue_context', source: 'current_project', as: 'queue' },
            ],
            rules: [
              {
                when: 'context.route_context.prs.length > 0 && context.route_context.prs[0].head_branch == "task/42" && exists(context.route_context.queue.items, item.kind == "running" && item.pr == 42)',
                next: 'wait_before_next_scan',
              },
              { when: 'true', next: 'ABORT' },
            ],
          },
          {
            name: 'wait_before_next_scan',
            mode: 'system',
            rules: [
              { when: 'true', next: 'COMPLETE' },
            ],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
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
      systemStepServicesFactory: createServices as never,
    });

    const state = await engine.run();
    const stateRecord = state as Record<string, unknown>;

    expect(state.status).toBe('completed');
    expect(createServices).toHaveBeenCalledTimes(1);
    expect((stateRecord.systemContexts as Map<string, unknown>).get('route_context')).toEqual({
      prs: [
        {
          number: 42,
          author: 'nrslib',
          base_branch: 'improve',
          head_branch: 'task/42',
          draft: false,
        },
      ],
      queue: {
        exists: true,
        total_count: 1,
        pending_count: 0,
        running_count: 1,
        completed_count: 0,
        failed_count: 0,
        exceeded_count: 0,
        pr_failed_count: 0,
        items: [
          {
            task_name: 'task-42',
            kind: 'running',
            issue: 586,
            pr: 42,
          },
        ],
      },
    });
  });

  it('selected_pr が存在しない場合は comment_on_pr に進まない', async () => {
    const expectedFilter = {
      head_branch: 'takt/*',
      managed_by_takt: true,
      same_repository: true,
      draft: false,
    };
    const executeEffect = vi.fn();
    const createServices = vi.fn(() => ({
      resolveSystemInput(input: { type: string; where?: unknown }) {
        if (input.type === 'pr_selection') {
          expect(input.where).toEqual(expectedFilter);
          return { exists: false };
        }
        throw new Error(`Unexpected system input: ${input.type}`);
      },
      async executeEffect(...args: unknown[]) {
        return executeEffect(...args);
      },
    }));

    const config = normalizeWorkflowConfig(
      {
        name: 'route-skips-human-pr',
        initial_step: 'route_context',
        max_steps: 2,
        steps: [
          {
            name: 'route_context',
            mode: 'system',
            system_inputs: [
              { type: 'pr_selection', source: 'current_project', as: 'selected_pr', where: expectedFilter },
            ],
            rules: [
              { when: 'context.route_context.selected_pr.exists == true', next: 'comment_on_pr' },
              { when: 'true', next: 'COMPLETE' },
            ],
          },
          {
            name: 'comment_on_pr',
            mode: 'system',
            effects: [
              {
                type: 'comment_pr',
                pr: '{context:route_context.selected_pr.number}',
                body: 'should not comment on human PRs',
              },
            ],
            rules: [
              { when: 'true', next: 'ABORT' },
            ],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
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
      systemStepServicesFactory: createServices as never,
    });

    const state = await engine.run();
    const stateRecord = state as Record<string, unknown>;

    expect(state.status).toBe('completed');
    expect(executeEffect).not.toHaveBeenCalled();
    expect((stateRecord.systemContexts as Map<string, unknown>).get('route_context')).toEqual({
      selected_pr: { exists: false },
    });
  });

  it('selected_pr が存在する場合は selected_issue があっても PR 分岐を優先する', async () => {
    const visitedSteps: string[] = [];
    const createServices = vi.fn(() => ({
      resolveSystemInput(input: { type: string }) {
        if (input.type === 'pr_selection') {
          return { exists: true, number: 42 };
        }
        if (input.type === 'issue_selection') {
          return { exists: true, number: 586, title: 'Repo issue' };
        }
        throw new Error(`Unexpected system input: ${input.type}`);
      },
      async executeEffect() {
        throw new Error('No effects expected in this workflow');
      },
    }));

    const config = normalizeWorkflowConfig(
      {
        name: 'route-prefers-pr-over-issue',
        initial_step: 'route_context',
        max_steps: 2,
        steps: [
          {
            name: 'route_context',
            mode: 'system',
            system_inputs: [
              { type: 'pr_selection', source: 'current_project', as: 'selected_pr' },
              { type: 'issue_selection', source: 'current_project', as: 'selected_issue' },
            ],
            rules: [
              { when: 'context.route_context.selected_pr.exists == true', next: 'plan_from_existing_pr' },
              { when: 'context.route_context.selected_pr.exists == false && context.route_context.selected_issue.exists == true', next: 'plan_from_issue' },
              { when: 'true', next: 'plan_fresh_improvement' },
            ],
          },
          {
            name: 'plan_from_existing_pr',
            mode: 'system',
            rules: [{ when: 'true', next: 'COMPLETE' }],
          },
          {
            name: 'plan_from_issue',
            mode: 'system',
            rules: [{ when: 'true', next: 'ABORT' }],
          },
          {
            name: 'plan_fresh_improvement',
            mode: 'system',
            rules: [{ when: 'true', next: 'ABORT' }],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
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
      systemStepServicesFactory: createServices as never,
    });
    engine.on('step:start', (step) => {
      visitedSteps.push(step.name);
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(visitedSteps).toEqual(['route_context', 'plan_from_existing_pr']);
  });

  it('selected_pr がなく selected_issue が存在する場合は Issue 分岐に進む', async () => {
    const visitedSteps: string[] = [];
    const createServices = vi.fn(() => ({
      resolveSystemInput(input: { type: string }) {
        if (input.type === 'pr_selection') {
          return { exists: false };
        }
        if (input.type === 'issue_selection') {
          return { exists: true, number: 586, title: 'Repo issue' };
        }
        throw new Error(`Unexpected system input: ${input.type}`);
      },
      async executeEffect() {
        throw new Error('No effects expected in this workflow');
      },
    }));

    const config = normalizeWorkflowConfig(
      {
        name: 'route-to-selected-issue',
        initial_step: 'route_context',
        max_steps: 2,
        steps: [
          {
            name: 'route_context',
            mode: 'system',
            system_inputs: [
              { type: 'pr_selection', source: 'current_project', as: 'selected_pr' },
              { type: 'issue_selection', source: 'current_project', as: 'selected_issue' },
            ],
            rules: [
              { when: 'context.route_context.selected_pr.exists == true', next: 'plan_from_existing_pr' },
              { when: 'context.route_context.selected_pr.exists == false && context.route_context.selected_issue.exists == true', next: 'plan_from_issue' },
              { when: 'true', next: 'plan_fresh_improvement' },
            ],
          },
          {
            name: 'plan_from_existing_pr',
            mode: 'system',
            rules: [{ when: 'true', next: 'ABORT' }],
          },
          {
            name: 'plan_from_issue',
            mode: 'system',
            rules: [{ when: 'true', next: 'COMPLETE' }],
          },
          {
            name: 'plan_fresh_improvement',
            mode: 'system',
            rules: [{ when: 'true', next: 'ABORT' }],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
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
      systemStepServicesFactory: createServices as never,
    });
    engine.on('step:start', (step) => {
      visitedSteps.push(step.name);
    });

    const state = await engine.run();
    const routeContext = ((state as Record<string, unknown>).systemContexts as Map<string, unknown>).get('route_context');

    expect(state.status).toBe('completed');
    expect(visitedSteps).toEqual(['route_context', 'plan_from_issue']);
    expect(routeContext).toEqual({
      selected_pr: { exists: false },
      selected_issue: { exists: true, number: 586, title: 'Repo issue' },
    });
  });

  it('selected_pr も selected_issue も存在しない場合は fresh improvement 分岐に進む', async () => {
    const visitedSteps: string[] = [];
    const createServices = vi.fn(() => ({
      resolveSystemInput(input: { type: string }) {
        if (input.type === 'pr_selection') {
          return { exists: false };
        }
        if (input.type === 'issue_selection') {
          return { exists: false };
        }
        throw new Error(`Unexpected system input: ${input.type}`);
      },
      async executeEffect() {
        throw new Error('No effects expected in this workflow');
      },
    }));

    const config = normalizeWorkflowConfig(
      {
        name: 'route-to-fresh-improvement',
        initial_step: 'route_context',
        max_steps: 2,
        steps: [
          {
            name: 'route_context',
            mode: 'system',
            system_inputs: [
              { type: 'pr_selection', source: 'current_project', as: 'selected_pr' },
              { type: 'issue_selection', source: 'current_project', as: 'selected_issue' },
            ],
            rules: [
              { when: 'context.route_context.selected_pr.exists == true', next: 'plan_from_existing_pr' },
              { when: 'context.route_context.selected_pr.exists == false && context.route_context.selected_issue.exists == true', next: 'plan_from_issue' },
              { when: 'true', next: 'plan_fresh_improvement' },
            ],
          },
          {
            name: 'plan_from_existing_pr',
            mode: 'system',
            rules: [{ when: 'true', next: 'ABORT' }],
          },
          {
            name: 'plan_from_issue',
            mode: 'system',
            rules: [{ when: 'true', next: 'ABORT' }],
          },
          {
            name: 'plan_fresh_improvement',
            mode: 'system',
            rules: [{ when: 'true', next: 'COMPLETE' }],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
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
      systemStepServicesFactory: createServices as never,
    });
    engine.on('step:start', (step) => {
      visitedSteps.push(step.name);
    });

    const state = await engine.run();
    const routeContext = ((state as Record<string, unknown>).systemContexts as Map<string, unknown>).get('route_context');

    expect(state.status).toBe('completed');
    expect(visitedSteps).toEqual(['route_context', 'plan_fresh_improvement']);
    expect(routeContext).toEqual({
      selected_pr: { exists: false },
      selected_issue: { exists: false },
    });
  });

  it('repo-wide issue からの enqueue は非対話でも enqueue まで進む', async () => {
    setMockScenario([
      {
        persona: 'supervisor',
        status: 'done',
        content: 'Plan issue task.',
        structuredOutput: {
          action: 'enqueue_new_task',
          task_markdown: '## Task\nHandle issue safely',
          issue: {
            create: false,
          },
        },
      },
    ]);
    mockListOpenIssues.mockReturnValue([
      {
        number: 586,
        title: 'Repo issue',
        labels: [],
        updated_at: '2026-04-20T14:00:00Z',
      },
    ]);

    const config = loadBuiltinAutoImprovementLoopForIssueExecution(projectDir);

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', createSystemEngineOptions(projectDir));
    const state = await engine.run();
    const stepNames = Array.from(state.stepOutputs.keys());

    expect(state.status).toBe('completed');
    expect(stepNames).toEqual(['route_context', 'plan_from_issue', 'enqueue_from_issue', 'wait_before_next_scan']);
    expect(mockSaveTaskFile).toHaveBeenCalledWith(projectDir, '## Task\nHandle issue safely', {
      workflow: 'takt-default',
      worktree: true,
      baseBranch: 'improve',
      autoPr: true,
      draftPr: true,
      managedPr: true,
    });
  });

  it('builtin auto-improvement-loop は issue が 0 件のとき fresh improvement にフォールバックする', async () => {
    setMockScenario([
      {
        persona: 'supervisor',
        status: 'done',
        content: 'No repo issue available.',
        structuredOutput: {
          action: 'noop',
        },
      },
    ]);
    mockListOpenIssues.mockReturnValue([]);

    const config = loadBuiltinAutoImprovementLoopForIssueExecution(projectDir);
    const state = await new WorkflowEngine(
      config,
      projectDir,
      'Current task body',
      createSystemEngineOptions(projectDir),
    ).run();
    const routeContext = ((state as Record<string, unknown>).systemContexts as Map<string, unknown>).get('route_context');
    const stepNames = Array.from(state.stepOutputs.keys());

    expect(state.status).toBe('completed');
    expect(stepNames).toEqual(['route_context', 'plan_fresh_improvement', 'wait_before_next_scan']);
    expect(routeContext).toEqual(expect.objectContaining({
      selected_issue: { exists: false },
    }));
    expect(mockSaveTaskFile).not.toHaveBeenCalled();
  });

  it('repo-wide issue からの enqueue は対話モードでも追加承認を要求しない', async () => {
    setMockScenario([
      {
        persona: 'supervisor',
        status: 'done',
        content: 'Plan issue task.',
        structuredOutput: {
          action: 'enqueue_new_task',
          task_markdown: '## Task\nHandle issue safely',
          issue: {
            create: false,
          },
        },
      },
    ]);
    mockListOpenIssues.mockReturnValue([
      {
        number: 586,
        title: 'Repo issue',
        labels: [],
        updated_at: '2026-04-20T14:00:00Z',
      },
    ]);

    const config = loadBuiltinAutoImprovementLoopForIssueExecution(projectDir);
    const onUserInput = vi.fn().mockResolvedValue('approve');
    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
      ...createSystemEngineOptions(projectDir),
      interactive: true,
      onUserInput,
    });
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(onUserInput).not.toHaveBeenCalled();
    expect(mockSaveTaskFile).toHaveBeenCalledWith(projectDir, '## Task\nHandle issue safely', {
      workflow: 'takt-default',
      worktree: true,
      baseBranch: 'improve',
      autoPr: true,
      draftPr: true,
      managedPr: true,
    });
  });

  it('route_context の selected_issue は loop 間で次の issue に巡回できる', async () => {
    const selectionHistory: number[] = [];
    const repoIssues = [
      { number: 587, title: 'Newest repo issue', labels: ['takt-managed'] },
      { number: 586, title: 'Older repo issue', labels: ['takt-managed'] },
    ];
    const createServices = vi.fn(() => ({
      resolveSystemInput(
        input: { type: string },
        state?: { systemContexts?: Map<string, unknown> },
        stepName?: string,
      ) {
        if (input.type === 'issue_list') {
          return repoIssues;
        }
        if (input.type === 'issue_selection') {
          if (!state?.systemContexts) {
            throw new Error('resolveSystemInput requires workflow state for issue_selection');
          }
          if (stepName !== 'route_context') {
            throw new Error(`resolveSystemInput requires step name, got ${String(stepName)}`);
          }
          const previous = state.systemContexts.get('route_context') as { selected_issue?: { number?: number } } | undefined;
          const selected = previous?.selected_issue?.number === 587 ? repoIssues[1] : repoIssues[0];
          selectionHistory.push(selected.number);
          return { exists: true, number: selected.number, title: selected.title };
        }
        throw new Error(`Unexpected system input: ${input.type}`);
      },
      async executeEffect() {
        throw new Error('No effects expected in this workflow');
      },
    }));

    const config = normalizeWorkflowConfig(
      {
        name: 'route-rotates-issue-selection',
        initial_step: 'route_context',
        max_steps: 4,
        steps: [
          {
            name: 'route_context',
            mode: 'system',
            system_inputs: [
              { type: 'issue_list', source: 'current_project', as: 'issues' },
              { type: 'issue_selection', source: 'current_project', as: 'selected_issue' },
            ],
            rules: [
              { when: 'context.route_context.selected_issue.number == 587', next: 'wait_before_next_scan' },
              { when: 'context.route_context.selected_issue.number == 586', next: 'COMPLETE' },
              { when: 'true', next: 'ABORT' },
            ],
          },
          {
            name: 'wait_before_next_scan',
            mode: 'system',
            rules: [{ when: 'true', next: 'route_context' }],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
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
      systemStepServicesFactory: createServices as never,
    });

    const state = await engine.run();
    const routeContext = ((state as Record<string, unknown>).systemContexts as Map<string, unknown>).get('route_context');

    expect(state.status).toBe('completed');
    expect(selectionHistory).toEqual([587, 586]);
    expect(routeContext).toEqual({
      issues: repoIssues,
      selected_issue: {
        exists: true,
        number: 586,
        title: 'Older repo issue',
      },
    });
  });

  it('route_context の selected_pr は loop 間で次の takt PR に巡回できる', async () => {
    const selectionHistory: number[] = [];
    const taktPrs = [
      {
        number: 43,
        author: 'nrslib',
        base_branch: 'improve',
        head_branch: 'takt/654/fix-pr-loop-selection',
        managed_by_takt: true,
        same_repository: true,
        draft: false,
      },
      {
        number: 42,
        author: 'nrslib',
        base_branch: 'improve',
        head_branch: 'takt/20260420-fix-pr-loop-selection',
        managed_by_takt: true,
        same_repository: true,
        draft: false,
      },
    ];
    const createServices = vi.fn(() => ({
      resolveSystemInput(
        input: { type: string },
        state?: { systemContexts?: Map<string, unknown> },
        stepName?: string,
      ) {
        if (input.type === 'pr_list') {
          return taktPrs;
        }
        if (input.type === 'pr_selection') {
          if (!state?.systemContexts) {
            throw new Error('resolveSystemInput requires workflow state for pr_selection');
          }
          if (stepName !== 'route_context') {
            throw new Error(`resolveSystemInput requires step name, got ${String(stepName)}`);
          }
          const previous = state.systemContexts.get('route_context') as { selected_pr?: { number?: number } } | undefined;
          const selected = previous?.selected_pr?.number === 43 ? taktPrs[1] : taktPrs[0];
          selectionHistory.push(selected.number);
          return { exists: true, ...selected };
        }
        throw new Error(`Unexpected system input: ${input.type}`);
      },
      async executeEffect() {
        throw new Error('No effects expected in this workflow');
      },
    }));

    const config = normalizeWorkflowConfig(
      {
        name: 'route-rotates-pr-selection',
        initial_step: 'route_context',
        max_steps: 4,
        steps: [
          {
            name: 'route_context',
            mode: 'system',
            system_inputs: [
              { type: 'pr_list', source: 'current_project', as: 'prs', where: { head_branch: 'takt/*', managed_by_takt: true, same_repository: true, draft: false } },
              { type: 'pr_selection', source: 'current_project', as: 'selected_pr', where: { head_branch: 'takt/*', managed_by_takt: true, same_repository: true, draft: false } },
            ],
            rules: [
              { when: 'context.route_context.selected_pr.number == 43', next: 'wait_before_next_scan' },
              { when: 'context.route_context.selected_pr.number == 42', next: 'COMPLETE' },
              { when: 'true', next: 'ABORT' },
            ],
          },
          {
            name: 'wait_before_next_scan',
            mode: 'system',
            rules: [
              { when: 'true', next: 'route_context' },
            ],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
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
      systemStepServicesFactory: createServices as never,
    });

    const state = await engine.run();
    const stateRecord = state as Record<string, unknown>;

    expect(state.status).toBe('completed');
    expect(selectionHistory).toEqual([43, 42]);
    expect((stateRecord.systemContexts as Map<string, unknown>).get('route_context')).toEqual({
      prs: taktPrs,
      selected_pr: {
        exists: true,
        number: 42,
        author: 'nrslib',
        base_branch: 'improve',
        head_branch: 'takt/20260420-fix-pr-loop-selection',
        managed_by_takt: true,
        same_repository: true,
        draft: false,
      },
    });
  });

  it('selected_pr が存在しない場合は downstream の PR step 群を一切実行しない', async () => {
    const executeEffect = vi.fn();
    const createServices = vi.fn(() => ({
      resolveSystemInput(input: { type: string; where?: unknown }) {
        if (input.type === 'pr_selection') {
          expect(input.where).toEqual({
            head_branch: 'takt/*',
            managed_by_takt: true,
            same_repository: true,
            draft: false,
          });
          return { exists: false };
        }
        throw new Error(`Unexpected system input: ${input.type}`);
      },
      async executeEffect(...args: unknown[]) {
        return executeEffect(...args);
      },
    }));

    const config = normalizeWorkflowConfig(
      {
        name: 'route-skips-all-pr-effects',
        initial_step: 'route_context',
        max_steps: 2,
        steps: [
          {
            name: 'route_context',
            mode: 'system',
            system_inputs: [
              {
                type: 'pr_selection',
                source: 'current_project',
                as: 'selected_pr',
                where: { head_branch: 'takt/*', managed_by_takt: true, same_repository: true, draft: false },
                },
            ],
            rules: [
              { when: 'context.route_context.selected_pr.exists == true', next: 'comment_on_pr' },
              { when: 'true', next: 'COMPLETE' },
            ],
          },
          {
            name: 'comment_on_pr',
            mode: 'system',
            effects: [
              { type: 'comment_pr', pr: '{context:route_context.selected_pr.number}', body: 'noop' },
            ],
            rules: [{ when: 'true', next: 'enqueue_from_pr' }],
          },
          {
            name: 'enqueue_from_pr',
            mode: 'system',
            effects: [
              {
                type: 'enqueue_task',
                mode: 'from_pr',
                pr: '{context:route_context.selected_pr.number}',
                workflow: 'takt-default',
                task: 'noop',
              },
            ],
            rules: [{ when: 'true', next: 'prepare_merge' }],
          },
          {
            name: 'prepare_merge',
            mode: 'system',
            effects: [
              { type: 'sync_with_root', pr: '{context:route_context.selected_pr.number}' },
            ],
            rules: [{ when: 'true', next: 'merge_pr' }],
          },
          {
            name: 'merge_pr',
            mode: 'system',
            effects: [
              { type: 'merge_pr', pr: '{context:route_context.selected_pr.number}' },
            ],
            rules: [{ when: 'true', next: 'ABORT' }],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
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
      systemStepServicesFactory: createServices as never,
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(executeEffect).not.toHaveBeenCalled();
  });

  it('executor 実経路でも pr_list と pr_selection は同一スナップショットを共有する', async () => {
    mockListOpenPrs
      .mockReturnValueOnce([
        {
          number: 43,
          author: 'nrslib',
          base_branch: 'improve',
          head_branch: 'takt/654/fix-pr-loop-selection',
          managed_by_takt: true,
          labels: ['automation'],
          same_repository: true,
          draft: false,
          updated_at: '2026-04-20T14:00:00Z',
        },
        {
          number: 42,
          author: 'nrslib',
          base_branch: 'improve',
          head_branch: 'takt/20260420-fix-pr-loop-selection',
          managed_by_takt: true,
          labels: [],
          same_repository: true,
          draft: false,
          updated_at: '2026-04-20T12:00:00Z',
        },
      ])
      .mockReturnValueOnce([
        {
          number: 99,
          author: 'spoof',
          base_branch: 'improve',
          head_branch: 'takt/999/second-fetch',
          managed_by_takt: false,
          labels: ['automation'],
          same_repository: true,
          draft: false,
          updated_at: '2026-04-20T16:00:00Z',
        },
      ]);

    const config = normalizeWorkflowConfig(
      {
        name: 'route-shares-pr-snapshot',
        initial_step: 'route_context',
        max_steps: 1,
        steps: [
          {
            name: 'route_context',
            mode: 'system',
            system_inputs: [
              {
                type: 'pr_list',
                source: 'current_project',
                as: 'prs',
                where: {
                  head_branch: 'takt/*',
                  managed_by_takt: true,
                  same_repository: true,
                  draft: false,
                },
              },
              {
                type: 'pr_selection',
                source: 'current_project',
                as: 'selected_pr',
                where: {
                  draft: false,
                  managed_by_takt: true,
                  same_repository: true,
                  head_branch: 'takt/*',
                },
              },
            ],
            rules: [
              { when: 'context.route_context.selected_pr.exists == true', next: 'COMPLETE' },
              { when: 'true', next: 'COMPLETE' },
            ],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', createSystemEngineOptions(projectDir));

    const state = await engine.run();
    const systemContexts = (state as Record<string, unknown>).systemContexts as Map<string, unknown>;
    const routeContext = systemContexts.get('route_context') as {
      prs: Array<{ number: number }>;
      selected_pr: { exists: boolean; number: number };
    };

    expect(state.status).toBe('completed');
    expect(mockListOpenPrs).toHaveBeenCalledTimes(1);
    expect(routeContext.prs.map((pr) => pr.number)).toEqual([43, 42]);
    expect(routeContext.selected_pr).toEqual(expect.objectContaining({ exists: true, number: 43 }));
    expect(routeContext.prs.some((pr) => pr.number === routeContext.selected_pr.number)).toBe(true);
  });

  it('executor 実経路でも auto-improvement-loop 既定フィルタは marker のない same-repo takt PR を除外する', async () => {
    mockListOpenPrs.mockReturnValue([
      {
        number: 41,
        author: 'human-reviewer',
        base_branch: 'improve',
        head_branch: 'takt/20260420-human-spoof',
        managed_by_takt: false,
        labels: [],
        same_repository: true,
        draft: false,
        updated_at: '2026-04-20T15:00:00Z',
      },
      {
        number: 42,
        author: 'nrslib',
        base_branch: 'improve',
        head_branch: 'takt/20260420-existing-task-pr',
        managed_by_takt: false,
        labels: [],
        same_repository: true,
        draft: false,
        updated_at: '2026-04-20T12:00:00Z',
      },
      {
        number: 43,
        author: 'fork-user',
        base_branch: 'improve',
        head_branch: 'takt/654/spoofed-fork',
        managed_by_takt: true,
        same_repository: false,
        draft: false,
        updated_at: '2026-04-20T16:00:00Z',
      },
    ]);

    const config = normalizeWorkflowConfig(
      {
        name: 'route-excludes-markerless-existing-takt-pr',
        initial_step: 'route_context',
        max_steps: 1,
        steps: [
          {
            name: 'route_context',
            mode: 'system',
            system_inputs: [
              {
                type: 'pr_list',
                source: 'current_project',
                as: 'prs',
                where: {
                  head_branch: 'takt/*',
                  managed_by_takt: true,
                  same_repository: true,
                  draft: false,
                },
              },
              {
                type: 'pr_selection',
                source: 'current_project',
                as: 'selected_pr',
                where: {
                  head_branch: 'takt/*',
                  managed_by_takt: true,
                  same_repository: true,
                  draft: false,
                },
              },
            ],
            rules: [
              { when: 'context.route_context.selected_pr.exists == true', next: 'COMPLETE' },
              { when: 'true', next: 'COMPLETE' },
            ],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', createSystemEngineOptions(projectDir));

    const state = await engine.run();
    const systemContexts = (state as Record<string, unknown>).systemContexts as Map<string, unknown>;
    const routeContext = systemContexts.get('route_context') as {
      prs: Array<{ number: number }>;
      selected_pr: { exists: boolean; number: number };
    };

    expect(state.status).toBe('completed');
    expect(routeContext.prs).toEqual([]);
    expect(routeContext.selected_pr).toEqual({ exists: false });
  });

  it('executor 実経路でも same-repo の human takt PR だけでは downstream PR step 群に進まない', async () => {
    mockListOpenPrs.mockReturnValue([
      {
        number: 55,
        author: 'human-reviewer',
        base_branch: 'improve',
        head_branch: 'takt/55/manual-spoof',
        managed_by_takt: false,
        labels: [],
        same_repository: true,
        draft: false,
        updated_at: '2026-04-20T19:00:00Z',
      },
    ]);

    const config = normalizeWorkflowConfig(
      {
        name: 'route-skips-unmanaged-takt-pr',
        initial_step: 'route_context',
        max_steps: 2,
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
                  head_branch: 'takt/*',
                  managed_by_takt: true,
                  same_repository: true,
                  draft: false,
                },
              },
            ],
            rules: [
              { when: 'context.route_context.selected_pr.exists == true', next: 'comment_on_pr' },
              { when: 'true', next: 'COMPLETE' },
            ],
          },
          {
            name: 'comment_on_pr',
            mode: 'system',
            effects: [
              { type: 'comment_pr', pr: '{context:route_context.selected_pr.number}', body: 'should not run' },
            ],
            rules: [{ when: 'true', next: 'ABORT' }],
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

    const routeContext = ((state as Record<string, unknown>).systemContexts as Map<string, unknown>).get('route_context');
    expect(state.status).toBe('completed');
    expect(routeContext).toEqual({ selected_pr: { exists: false } });
  });
});
