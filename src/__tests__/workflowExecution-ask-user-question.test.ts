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

const { disabledObservability, MockWorkflowEngine } = vi.hoisted(() => {
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
      MockWorkflowEngine.activeResumePoint ??= options.resumePoint as WorkflowResumePoint | undefined;
      MockWorkflowEngine.lastInstance = this;
    }

    abort(): void {}

    getResumePoint(): WorkflowResumePoint | undefined {
      return MockWorkflowEngine.activeResumePoint
        ?? this.receivedOptions.resumePoint as WorkflowResumePoint | undefined;
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
        if (MockWorkflowEngine.activeResumePoint === undefined) {
          MockWorkflowEngine.activeResumePoint = {
            version: 2,
            stack: [{
              workflow: this.config.name,
              step: MockWorkflowEngine.iterationLimitCurrentStep,
              kind: 'agent',
              step_iterations: { [MockWorkflowEngine.iterationLimitCurrentStep]: 1 },
            }],
            iteration: MockWorkflowEngine.iterationLimitCurrentIteration,
            max_steps: this.config.maxSteps,
            elapsed_ms: 0,
            workflow_call_invocations: {},
            workflow_step_participations: {},
          };
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
        const stepIteration = 1;
        const executionScope = Object.freeze({
          kind: 'workflow_execution_scope' as const,
          stack: Object.freeze([
            Object.freeze({
              workflow: this.config.name,
              step: firstStep.name,
              kind: firstStep.kind
                ?? (firstStep.mode === 'system' ? 'system' : firstStep.call ? 'workflow_call' : 'agent'),
              step_iterations: Object.freeze({ [firstStep.name]: stepIteration }),
            }),
          ]),
        });
        this.emit(
          'step:start',
          firstStep,
          1,
          firstStep.instruction,
          { provider: 'mock', model: undefined },
          this.config.name,
          firstStep.name,
          stepIteration,
          this.config.maxSteps,
          executionScope,
        );
      }
      this.emit('workflow:complete', { status: 'completed', iteration: 1 });
      return { status: 'completed', iteration: 1 };
    }
  }

  return {
    disabledObservability: {
      enabled: false,
      monitor: false,
      sessionLogExporter: false,
      usageEventsPhase: false,
    },
    MockWorkflowEngine,
  };
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
    observability: disabledObservability,
  }),
  saveSessionState: vi.fn(),
  ensureDir: vi.fn(),
  writeFileAtomic: vi.fn(),
}));

vi.mock('../infra/config/resolveConfigValue.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveConfigValueWithSource: vi.fn((_cwd, key) => key === 'provider'
    ? { value: 'claude', source: 'global' }
    : { value: undefined, source: 'default' }),
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
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { buildWorkflowCallInvocationFixture } from './helpers/workflow-resume-fixture.js';

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
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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

  it('should pass a custom AskUserQuestion handler when supplied by an adapter', async () => {
    const onAskUserQuestion = vi.fn().mockResolvedValue({ Answer: 'Use src/index.ts' });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      onAskUserQuestion,
    });

    expect(MockWorkflowEngine.lastInstance.receivedOptions.onAskUserQuestion).toBe(onAskUserQuestion);
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
      resumePoint: MockWorkflowEngine.activeResumePoint,
    });
  });

  it('should preserve a nested checkpoint when a resumed run exceeds before its first step', async () => {
    const resumeStack = [
      {
        workflow: 'default',
        step: 'develop',
        kind: 'workflow_call' as const,
        call_instance: 1,
      },
      {
        workflow: 'development-core',
        step: 'peer-review',
        kind: 'workflow_call' as const,
        call_instance: 1,
      },
      { workflow: 'peer-review', step: 'fix', kind: 'agent' as const },
    ];
    const resumePoint = {
      version: 2 as const,
      stack: resumeStack,
      iteration: 59,
      elapsed_ms: 183245,
      workflow_call_invocations: buildWorkflowCallInvocationFixture(resumeStack),
      workflow_step_participations: {},
    };
    MockWorkflowEngine.triggerIterationLimit = true;
    MockWorkflowEngine.iterationLimitCurrentStep = 'develop';
    MockWorkflowEngine.iterationLimitCurrentIteration = 59;

    const result = await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      startStep: 'develop',
      resumePoint,
      initialIterationOverride: 59,
    });

    expect(result.exceededInfo?.resumePoint).toEqual(resumePoint);
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
      resumePoint: MockWorkflowEngine.activeResumePoint,
    });
  });

  it('should add the latest workflow max steps when a resumed workflow exceeds again', async () => {
    MockWorkflowEngine.triggerIterationLimit = true;

    const result = await executeWorkflow({
      ...makeConfig(),
      maxSteps: 51,
    }, 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      maxStepsOverride: 102,
    });

    expect(result.success).toBe(false);
    expect(result.exceeded).toBe(true);
    expect(result.exceededInfo).toEqual({
      currentStep: 'implement',
      newMaxSteps: 153,
      currentIteration: 1,
      resumePoint: MockWorkflowEngine.activeResumePoint,
    });
  });

  it('should allow the next max steps when a finite workflow reaches the safe integer boundary', async () => {
    MockWorkflowEngine.triggerIterationLimit = true;

    const result = await executeWorkflow({
      ...makeConfig(),
      maxSteps: 51,
    }, 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      maxStepsOverride: Number.MAX_SAFE_INTEGER - 51,
    });

    expect(result.success).toBe(false);
    expect(result.exceeded).toBe(true);
    expect(result.exceededInfo).toEqual({
      currentStep: 'implement',
      newMaxSteps: Number.MAX_SAFE_INTEGER,
      currentIteration: 1,
      resumePoint: MockWorkflowEngine.activeResumePoint,
    });
  });

  it('should reject the next max steps when a finite workflow would exceed the safe integer range', async () => {
    MockWorkflowEngine.triggerIterationLimit = true;

    await expect(executeWorkflow({
      ...makeConfig(),
      maxSteps: 51,
    }, 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      maxStepsOverride: Number.MAX_SAFE_INTEGER - 50,
    })).rejects.toThrow('safe integer range');
  });

  it('should reject the next max steps when an infinite workflow override would exceed the safe integer range', async () => {
    MockWorkflowEngine.triggerIterationLimit = true;
    const maxStepsOverride = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;

    await expect(executeWorkflow({
      ...makeConfig(),
      maxSteps: 'infinite',
    }, 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      maxStepsOverride,
    })).rejects.toThrow('safe integer range');
  });

  it('should use engine getResumePoint when currentStep cannot be rebuilt in exceeded handling', async () => {
    MockWorkflowEngine.triggerIterationLimit = true;
    MockWorkflowEngine.iterationLimitCurrentStep = 'fix';
    MockWorkflowEngine.iterationLimitCurrentIteration = 2;
    const resumeStack = [
      {
        workflow: 'parent',
        step: 'delegate',
        kind: 'workflow_call' as const,
        step_iterations: { delegate: 1 },
        call_instance: 1,
      },
      { workflow: 'takt/coding', step: 'fix', kind: 'agent' as const },
    ];
    MockWorkflowEngine.activeResumePoint = {
      version: 2,
      stack: resumeStack,
      iteration: 2,
      elapsed_ms: 183245,
      workflow_call_invocations: buildWorkflowCallInvocationFixture(resumeStack),
      workflow_step_participations: {},
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
    const resumeStack = [
      {
        workflow: 'parent',
        step: 'delegate',
        kind: 'workflow_call' as const,
        step_iterations: { delegate: 1 },
        call_instance: 1,
      },
      { workflow: 'takt/coding', step: 'implement', kind: 'agent' as const },
    ];
    MockWorkflowEngine.activeResumePoint = {
      version: 2,
      stack: resumeStack,
      iteration: 3,
      elapsed_ms: 183246,
      workflow_call_invocations: buildWorkflowCallInvocationFixture(resumeStack),
      workflow_step_participations: {},
    };
    MockWorkflowEngine.buildResumePointForCurrentStep = {
      version: 2,
      stack: [
        { workflow: 'parent', step: 'implement', kind: 'agent' },
      ],
      iteration: 3,
      elapsed_ms: 183247,
      workflow_call_invocations: {},
      workflow_step_participations: {},
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
