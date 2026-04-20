/**
 * Tests: executeWorkflow() wires a deny handler for AskUserQuestion
 * to WorkflowEngine during workflow execution.
 *
 * This ensures that the agent cannot prompt the user interactively
 * during automated workflow runs — AskUserQuestion is always blocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkflowConfig, WorkflowResumePoint } from '../core/models/index.js';
import { AskUserQuestionDeniedError } from '../core/workflow/ask-user-question-error.js';

const { MockWorkflowEngine } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');

  class MockWorkflowEngine extends EE {
    static lastInstance: MockWorkflowEngine;
    static triggerIterationLimit = false;
    static iterationLimitCurrentStep = 'implement';
    static iterationLimitCurrentIteration = 1;
    static activeResumePoint: WorkflowResumePoint | undefined;
    static buildResumePointForCurrentStep: WorkflowResumePoint | undefined;
    readonly receivedOptions: Record<string, unknown>;
    private readonly config: WorkflowConfig;

    constructor(config: WorkflowConfig, _cwd: string, _task: string, options: Record<string, unknown>) {
      super();
      this.config = config;
      this.receivedOptions = options;
      MockWorkflowEngine.lastInstance = this;
    }

    abort(): void {}

    getResumePoint(): WorkflowResumePoint | undefined {
      return MockWorkflowEngine.activeResumePoint;
    }

    buildResumePointForStepName(stepName: string): WorkflowResumePoint | undefined {
      if (stepName === MockWorkflowEngine.iterationLimitCurrentStep) {
        return MockWorkflowEngine.buildResumePointForCurrentStep;
      }
      return MockWorkflowEngine.activeResumePoint;
    }

    async run(): Promise<{ status: string; iteration: number }> {
      const firstStep = this.config.steps[0];
      if (MockWorkflowEngine.triggerIterationLimit) {
        if (!firstStep) {
          throw new Error('Test fixture requires at least one step');
        }
        const onIterationLimit = this.receivedOptions.onIterationLimit as
          | ((request: { currentIteration: number; maxSteps: number; currentStep: string }) => Promise<number | null>)
          | undefined;
        if (onIterationLimit) {
          await onIterationLimit({
            currentIteration: MockWorkflowEngine.iterationLimitCurrentIteration,
            maxSteps: this.config.maxSteps,
            currentStep: MockWorkflowEngine.iterationLimitCurrentStep,
          });
        }
        this.emit('workflow:abort', {
          status: 'aborted',
          iteration: MockWorkflowEngine.iterationLimitCurrentIteration,
        }, 'Reached max steps');
        return {
          status: 'aborted',
          iteration: MockWorkflowEngine.iterationLimitCurrentIteration,
        };
      }
      if (firstStep) {
        this.emit('step:start', firstStep, 1, firstStep.instruction, { provider: undefined, model: undefined });
      }
      this.emit('workflow:complete', { status: 'completed', iteration: 1 });
      return { status: 'completed', iteration: 1 };
    }
  }

  return { MockWorkflowEngine };
});

vi.mock('../core/workflow/index.js', async () => {
  const errorModule = await import('../core/workflow/ask-user-question-error.js');
  return {
    WorkflowEngine: MockWorkflowEngine,
    createDenyAskUserQuestionHandler: errorModule.createDenyAskUserQuestionHandler,
  };
});

vi.mock('../infra/claude/query-manager.js', () => ({
  interruptAllQueries: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  loadPersonaSessions: vi.fn().mockReturnValue({}),
  updatePersonaSession: vi.fn(),
  loadWorktreeSessions: vi.fn().mockReturnValue({}),
  updateWorktreeSession: vi.fn(),
  resolveWorkflowConfigValues: vi.fn().mockReturnValue({
    notificationSound: true,
    notificationSoundEvents: {},
    provider: 'claude',
    runtime: undefined,
    preventSleep: false,
    model: undefined,
    logging: undefined,
  }),
  saveSessionState: vi.fn(),
  ensureDir: vi.fn(),
  writeFileAtomic: vi.fn(),
}));

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn().mockReturnValue(true),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
  StreamDisplay: vi.fn().mockImplementation(() => ({
    createHandler: vi.fn().mockReturnValue(vi.fn()),
    flush: vi.fn(),
  })),
}));

vi.mock('../infra/fs/index.js', () => ({
  generateSessionId: vi.fn().mockReturnValue('test-session-id'),
  createSessionLog: vi.fn().mockReturnValue({
    startTime: new Date().toISOString(),
    iterations: 0,
  }),
  finalizeSessionLog: vi.fn().mockImplementation((log, status) => ({
    ...log,
    status,
    endTime: new Date().toISOString(),
  })),
  initNdjsonLog: vi.fn().mockReturnValue('/tmp/test-log.jsonl'),
  appendNdjsonLine: vi.fn(),
}));

vi.mock('../shared/utils/index.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  preventSleep: vi.fn(),
  isDebugEnabled: vi.fn().mockReturnValue(false),
  writePromptLog: vi.fn(),
  getDebugPromptsLogFile: vi.fn().mockReturnValue(null),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  isValidReportDirName: vi.fn().mockReturnValue(true),
  playWarningSound: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(),
  promptInput: vi.fn(),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn().mockImplementation((key: string) => key),
}));

vi.mock('../shared/exitCodes.js', () => ({
  EXIT_SIGINT: 130,
}));

import { executeWorkflow } from '../features/tasks/execute/workflowExecution.js';
import { selectOption } from '../shared/prompt/index.js';
import { error, info } from '../shared/ui/index.js';

function makeConfig(): WorkflowConfig {
  return {
    name: 'test-workflow',
    maxSteps: 5,
    initialStep: 'implement',
    steps: [
      {
        name: 'implement',
        persona: '../agents/coder.md',
        personaDisplayName: 'coder',
        instruction: 'Implement task',
        passPreviousResponse: true,
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
  };
}

describe('executeWorkflow AskUserQuestion deny handler wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockWorkflowEngine.triggerIterationLimit = false;
    MockWorkflowEngine.iterationLimitCurrentStep = 'implement';
    MockWorkflowEngine.iterationLimitCurrentIteration = 1;
    MockWorkflowEngine.activeResumePoint = undefined;
    MockWorkflowEngine.buildResumePointForCurrentStep = undefined;
  });

  it('should pass onAskUserQuestion handler to WorkflowEngine', async () => {
    // Given: normal workflow execution
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    // Then: WorkflowEngine receives an onAskUserQuestion handler
    const handler = MockWorkflowEngine.lastInstance.receivedOptions.onAskUserQuestion;
    expect(typeof handler).toBe('function');
  });

  it('should provide a handler that throws AskUserQuestionDeniedError', async () => {
    // Given: workflow execution completed
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    // When: the handler is invoked (as WorkflowEngine would when agent calls AskUserQuestion)
    const handler = MockWorkflowEngine.lastInstance.receivedOptions.onAskUserQuestion as () => never;

    // Then: it throws AskUserQuestionDeniedError
    expect(() => handler()).toThrow(AskUserQuestionDeniedError);
  });

  it('should complete successfully despite deny handler being present', async () => {
    // Given/When: normal workflow execution with deny handler wired
    const result = await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    // Then: workflow completes successfully
    expect(result.success).toBe(true);
  });

  it('should mark exceeded without prompting even when interactiveUserInput is true', async () => {
    // Given: mock engine reaches iteration limit immediately
    MockWorkflowEngine.triggerIterationLimit = true;

    // When: executeWorkflow runs in interactive mode
    const result = await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      interactiveUserInput: true,
    });

    // Then: no extension prompt appears; execution is marked as exceeded
    expect(vi.mocked(selectOption)).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.exceeded).toBe(true);
    expect(result.exceededInfo).toEqual({
      currentStep: 'implement',
      newMaxSteps: 10,
      currentIteration: 1,
    });
  });

  it('should use maxStepsOverride when exceeded handling runs for an infinite workflow', async () => {
    MockWorkflowEngine.triggerIterationLimit = true;

    const result = await executeWorkflow({
      ...makeConfig(),
      maxSteps: 'infinite',
    }, 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      maxStepsOverride: 3,
    });

    expect(result.success).toBe(false);
    expect(result.exceeded).toBe(true);
    expect(result.exceededInfo).toEqual({
      currentStep: 'implement',
      newMaxSteps: 6,
      currentIteration: 1,
    });
  });

  it('should use engine getResumePoint when currentStep cannot be rebuilt in exceeded handling', async () => {
    MockWorkflowEngine.triggerIterationLimit = true;
    MockWorkflowEngine.iterationLimitCurrentStep = 'fix';
    MockWorkflowEngine.iterationLimitCurrentIteration = 2;
    MockWorkflowEngine.activeResumePoint = {
      version: 1,
      stack: [
        { workflow: 'parent', step: 'delegate', kind: 'workflow_call' },
        { workflow: 'takt/coding', step: 'fix', kind: 'agent' },
      ],
      iteration: 2,
      elapsed_ms: 183245,
    };
    MockWorkflowEngine.buildResumePointForCurrentStep = undefined;

    const result = await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(result.success).toBe(false);
    expect(result.exceeded).toBe(true);
    expect(result.exceededInfo).toEqual({
      currentStep: 'fix',
      newMaxSteps: 10,
      currentIteration: 2,
      resumePoint: MockWorkflowEngine.activeResumePoint,
    });
  });

  it('should prefer engine getResumePoint over rebuilding a colliding currentStep in exceeded handling', async () => {
    MockWorkflowEngine.triggerIterationLimit = true;
    MockWorkflowEngine.iterationLimitCurrentStep = 'implement';
    MockWorkflowEngine.iterationLimitCurrentIteration = 3;
    MockWorkflowEngine.activeResumePoint = {
      version: 1,
      stack: [
        { workflow: 'parent', step: 'delegate', kind: 'workflow_call' },
        { workflow: 'takt/coding', step: 'implement', kind: 'agent' },
      ],
      iteration: 3,
      elapsed_ms: 183246,
    };
    MockWorkflowEngine.buildResumePointForCurrentStep = {
      version: 1,
      stack: [
        { workflow: 'parent', step: 'implement', kind: 'agent' },
      ],
      iteration: 3,
      elapsed_ms: 183247,
    };

    const result = await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(result.success).toBe(false);
    expect(result.exceeded).toBe(true);
    expect(result.exceededInfo).toEqual({
      currentStep: 'implement',
      newMaxSteps: 10,
      currentIteration: 3,
      resumePoint: MockWorkflowEngine.activeResumePoint,
    });
  });

  it('should report workflow abort message and session log path when aborted', async () => {
    MockWorkflowEngine.triggerIterationLimit = true;

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(vi.mocked(error)).toHaveBeenCalledWith(
      expect.stringContaining('Workflow aborted after 1 iterations'),
    );
    expect(vi.mocked(info)).toHaveBeenCalledWith('Session log: /tmp/test-log.jsonl');
  });
});
