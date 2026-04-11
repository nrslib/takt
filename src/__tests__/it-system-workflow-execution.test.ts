import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
} = vi.hoisted(() => ({
  mockCommentOnPr: vi.fn(),
  mockMergePr: vi.fn(),
  mockSaveTaskFile: vi.fn(),
  mockCreateIssueFromTask: vi.fn(),
  mockResolveBaseBranch: vi.fn(),
  mockFindExistingPr: vi.fn(),
  mockFetchPrReviewComments: vi.fn(),
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
      return [];
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
    systemStepServicesFactory: createDefaultSystemStepServices,
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
              { when: 'effect.comment_pr.success == true', next: 'COMPLETE' },
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
    expect((stateRecord.effectResults as Map<string, unknown>).get('comment_pr')).toEqual({
      success: true,
      failed: false,
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
              { when: 'effect.comment_pr.success == true', next: 'COMPLETE' },
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
              { when: 'effect.enqueue_task.success == true', next: 'COMPLETE' },
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
              { when: 'effect.comment_pr.success == true', next: 'draft_review' },
            ],
          },
          {
            name: 'draft_review',
            persona: 'reviewer',
            instruction: 'Comment success: {effect:comment_pr.success}',
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
              { when: 'effect.merge_pr.success == true', next: 'COMPLETE' },
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
    expect((stateRecord.effectResults as Map<string, unknown>).get('merge_pr')).toEqual({
      success: true,
      failed: false,
    });
  });
});
