import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import {
  CapabilityAwareStructuredCaller,
  DefaultStructuredCaller,
  type StructuredCaller,
} from '../agents/structured-caller.js';

const {
  MockWorkflowEngine,
  mockGetProvider,
  mockRunAgent,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');

  class MockWorkflowEngine extends EE {
    static lastInstance: MockWorkflowEngine;
    readonly receivedOptions: Record<string, unknown>;
    private readonly config: WorkflowConfig;

    constructor(config: WorkflowConfig, _cwd: string, _task: string, options: Record<string, unknown>) {
      super();
      this.config = config;
      this.receivedOptions = options;
      MockWorkflowEngine.lastInstance = this;
    }

    abort(): void {}

    async run(): Promise<{ status: string; iteration: number }> {
      const step = this.config.steps[0];
      if (step) {
        this.emit('step:start', step, 1, step.instruction, { provider: 'cursor', model: undefined });
        this.emit('step:complete', step, {
          persona: step.personaDisplayName,
          status: 'done',
          content: 'ok',
          timestamp: new Date('2026-04-01T00:00:00.000Z'),
        }, step.instruction);
      }
      this.emit('workflow:complete', { status: 'completed', iteration: 1 });
      return { status: 'completed', iteration: 1 };
    }
  }

  return {
    MockWorkflowEngine,
    mockGetProvider: vi.fn(),
    mockRunAgent: vi.fn(),
  };
});

vi.mock('../core/workflow/index.js', async () => {
  const errorModule = await import('../core/workflow/ask-user-question-error.js');
  return {
    WorkflowEngine: MockWorkflowEngine,
    createDenyAskUserQuestionHandler: errorModule.createDenyAskUserQuestionHandler,
  };
});

vi.mock('../infra/providers/index.js', () => ({
  getProvider: mockGetProvider,
}));

vi.mock('../agents/runner.js', () => ({
  runAgent: mockRunAgent,
}));

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
    provider: 'cursor',
    runtime: undefined,
    preventSleep: false,
    model: undefined,
    logging: undefined,
    analytics: undefined,
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

vi.mock('../shared/utils/providerEventLogger.js', () => ({
  createProviderEventLogger: vi.fn().mockReturnValue({
    filepath: '/tmp/provider-events.jsonl',
    wrapCallback: vi.fn((callback) => callback),
    setStep: vi.fn(),
    setProvider: vi.fn(),
  }),
  isProviderEventsEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('../shared/utils/usageEventLogger.js', () => ({
  createUsageEventLogger: vi.fn().mockReturnValue({
    filepath: '/tmp/usage-events.jsonl',
    setStep: vi.fn(),
    setProvider: vi.fn(),
    logUsage: vi.fn(),
  }),
  isUsageEventsEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: vi.fn().mockImplementation((key: string) => key),
}));

import { executeWorkflow } from '../features/tasks/execute/workflowExecution.js';

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

function expectStructuredCallerShape(value: unknown): void {
  expect(value).toEqual(
    expect.objectContaining({
      judgeStatus: expect.any(Function),
      evaluateCondition: expect.any(Function),
      decomposeTask: expect.any(Function),
      requestMoreParts: expect.any(Function),
    }),
  );
}

function getInjectedStructuredCaller(): StructuredCaller {
  const structuredCaller = MockWorkflowEngine.lastInstance.receivedOptions.structuredCaller;
  expectStructuredCallerShape(structuredCaller);
  return structuredCaller as StructuredCaller;
}

describe('executeWorkflow structuredCaller injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProvider.mockReturnValue({ supportsStructuredOutput: false });
  });

  it('global provider が cursor のとき prompt-based judge へ委譲できること', async () => {
    mockGetProvider.mockReturnValue({ supportsStructuredOutput: false });
    const { resolveWorkflowConfigValues } = await import('../infra/config/index.js');
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      notificationSound: true,
      notificationSoundEvents: {},
      provider: 'cursor',
      runtime: undefined,
      preventSleep: false,
      model: undefined,
      logging: undefined,
      analytics: undefined,
    });
    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    mockGetProvider.mockReturnValue({ supportsStructuredOutput: false });
    mockRunAgent.mockResolvedValue({
      persona: 'default',
      status: 'done',
      content: '[JUDGE:6]',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });

    const structuredCaller = getInjectedStructuredCaller();
    expect(structuredCaller).toBeInstanceOf(CapabilityAwareStructuredCaller);
    expect(structuredCaller).toBeInstanceOf(DefaultStructuredCaller);
    const result = await structuredCaller.evaluateCondition(
      'agent output',
      [{ index: 5, text: 'approved' }],
      { cwd: '/tmp/project', provider: MockWorkflowEngine.lastInstance.receivedOptions.provider as 'cursor' },
    );

    expect(result).toBe(5);
    expect(mockGetProvider).toHaveBeenCalledWith('cursor');
    expect(MockWorkflowEngine.lastInstance.receivedOptions.callAiJudge).toBeUndefined();
    expect(MockWorkflowEngine.lastInstance.receivedOptions.provider).toBe('cursor');
    expect(MockWorkflowEngine.lastInstance.receivedOptions.model).toBeUndefined();
    const [, prompt, runOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(prompt).toContain('Output ONLY the tag `[JUDGE:N]`');
    expect(runOptions).toEqual(expect.objectContaining({
      cwd: '/tmp/project',
      provider: 'cursor',
    }));
    expect(runOptions).not.toHaveProperty('outputSchema');
  });

  it('global provider が claude のとき structured output caller へ委譲できること', async () => {
    mockGetProvider.mockReturnValue({ supportsStructuredOutput: true });
    const { resolveWorkflowConfigValues } = await import('../infra/config/index.js');
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      notificationSound: true,
      notificationSoundEvents: {},
      provider: 'claude',
      runtime: undefined,
      preventSleep: false,
      model: undefined,
      logging: undefined,
      analytics: undefined,
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    mockRunAgent.mockResolvedValue({
      persona: 'default',
      status: 'done',
      content: '[JUDGE:1]',
      structuredOutput: { matched_index: 2 },
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });

    const structuredCaller = getInjectedStructuredCaller();
    expect(structuredCaller).toBeInstanceOf(CapabilityAwareStructuredCaller);
    expect(structuredCaller).toBeInstanceOf(DefaultStructuredCaller);
    const result = await structuredCaller.evaluateCondition(
      'agent output',
      [
        { index: 2, text: 'approved' },
        { index: 5, text: 'needs_fix' },
      ],
      { cwd: '/tmp/project', provider: MockWorkflowEngine.lastInstance.receivedOptions.provider as 'claude' },
    );

    expect(result).toBe(5);
    expect(mockGetProvider).toHaveBeenCalledWith('claude');
    expect(MockWorkflowEngine.lastInstance.receivedOptions.callAiJudge).toBeUndefined();
    expect(MockWorkflowEngine.lastInstance.receivedOptions.provider).toBe('claude');
    const [, prompt, runOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(prompt).toContain('Output ONLY the tag `[JUDGE:N]`');
    expect(runOptions).toEqual(expect.objectContaining({
      cwd: '/tmp/project',
      provider: 'claude',
    }));
    expect(runOptions).toHaveProperty('outputSchema');
  });

  it('judgeStatus は unsupported provider で prompt-based fallback を使うこと', async () => {
    mockGetProvider.mockImplementation((provider: string) => ({
      supportsStructuredOutput: provider === 'claude',
    }));
    const { resolveWorkflowConfigValues } = await import('../infra/config/index.js');
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      notificationSound: true,
      notificationSoundEvents: {},
      provider: 'cursor',
      runtime: undefined,
      preventSleep: false,
      model: undefined,
      logging: undefined,
      analytics: undefined,
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    mockRunAgent
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: 'plain text',
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        persona: 'conductor',
        status: 'done',
        content: '[IMPLEMENT:1]',
        timestamp: new Date('2026-04-01T00:00:01.000Z'),
      });

    const structuredCaller = getInjectedStructuredCaller();
    const result = await structuredCaller.judgeStatus(
      'structured judge prompt',
      'tag judge prompt',
      [
        { condition: 'approved', next: 'COMPLETE' },
        { condition: 'needs_fix', next: 'fix' },
      ],
      {
        cwd: '/tmp/project',
        stepName: 'implement',
        provider: 'cursor',
        resolvedProvider: 'cursor',
      },
    );

    expect(result).toEqual({ ruleIndex: 0, method: 'phase3_tag' });
    expect(mockGetProvider).toHaveBeenCalledWith('cursor');
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    const [, firstPrompt, firstRunOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(firstPrompt).toContain('structured judge prompt');
    expect(firstRunOptions).toEqual(expect.objectContaining({
      cwd: '/tmp/project',
      provider: 'cursor',
      resolvedProvider: 'cursor',
    }));
    expect(firstRunOptions).not.toHaveProperty('outputSchema');
    const [, secondPrompt, secondRunOptions] = mockRunAgent.mock.calls[1] ?? [];
    expect(secondPrompt).toContain('tag judge prompt');
    expect(secondRunOptions).not.toHaveProperty('outputSchema');
  });

  it('judgeStatus は supported provider で native structured output を使うこと', async () => {
    mockGetProvider.mockImplementation((provider: string) => ({
      supportsStructuredOutput: provider === 'claude',
    }));
    const { resolveWorkflowConfigValues } = await import('../infra/config/index.js');
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      notificationSound: true,
      notificationSoundEvents: {},
      provider: 'claude',
      runtime: undefined,
      preventSleep: false,
      model: 'sonnet',
      logging: undefined,
      analytics: undefined,
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    mockRunAgent.mockResolvedValue({
      persona: 'conductor',
      status: 'done',
      content: '{"step":1}',
      structuredOutput: { step: 1 },
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });

    const structuredCaller = getInjectedStructuredCaller();
    const result = await structuredCaller.judgeStatus(
      'structured judge prompt',
      'tag judge prompt',
      [
        { condition: 'approved', next: 'COMPLETE' },
        { condition: 'needs_fix', next: 'fix' },
      ],
      {
        cwd: '/tmp/project',
        stepName: 'implement',
        provider: 'claude',
        resolvedProvider: 'claude',
        resolvedModel: 'sonnet',
      },
    );

    expect(result).toEqual({ ruleIndex: 0, method: 'structured_output' });
    expect(mockGetProvider).toHaveBeenCalledWith('claude');
    const [, prompt, runOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(prompt).toContain('structured judge prompt');
    expect(runOptions).toEqual(expect.objectContaining({
      cwd: '/tmp/project',
      provider: 'claude',
      resolvedProvider: 'claude',
      resolvedModel: 'sonnet',
    }));
    expect(runOptions).toHaveProperty('outputSchema');
  });

  it('should pass the effective model from global config to WorkflowEngine when no override is provided', async () => {
    const { resolveWorkflowConfigValues } = await import('../infra/config/index.js');
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      notificationSound: true,
      notificationSoundEvents: {},
      provider: 'cursor',
      runtime: undefined,
      preventSleep: false,
      model: 'cursor-fast',
      logging: undefined,
      analytics: undefined,
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    expect(MockWorkflowEngine.lastInstance.receivedOptions.provider).toBe('cursor');
    expect(MockWorkflowEngine.lastInstance.receivedOptions.model).toBe('cursor-fast');
  });

  it('should pass provider override through to WorkflowEngine', async () => {
    mockGetProvider.mockImplementation((provider: string) => ({
      supportsStructuredOutput: provider === 'mock',
    }));
    const { resolveWorkflowConfigValues } = await import('../infra/config/index.js');
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      notificationSound: true,
      notificationSoundEvents: {},
      provider: 'claude',
      runtime: undefined,
      preventSleep: false,
      model: undefined,
      logging: undefined,
      analytics: undefined,
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
      provider: 'mock',
    });

    const structuredCaller = getInjectedStructuredCaller();
    expect(structuredCaller).toBeInstanceOf(CapabilityAwareStructuredCaller);
    expect(structuredCaller).toBeInstanceOf(DefaultStructuredCaller);
    expect(MockWorkflowEngine.lastInstance.receivedOptions.provider).toBe('mock');
  });

  it('should avoid native structured output judge calls when the step provider override is unsupported', async () => {
    mockGetProvider.mockImplementation((provider: string) => ({
      supportsStructuredOutput: provider === 'claude',
    }));
    const { resolveWorkflowConfigValues } = await import('../infra/config/index.js');
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      notificationSound: true,
      notificationSoundEvents: {},
      provider: 'claude',
      runtime: undefined,
      preventSleep: false,
      model: undefined,
      logging: undefined,
      analytics: undefined,
    });

    const config = makeConfig();
    config.steps[0] = {
      ...config.steps[0]!,
      provider: 'cursor',
    };

    await executeWorkflow(config, 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    mockRunAgent.mockResolvedValue({
      persona: 'default',
      status: 'done',
      content: '[JUDGE:1]',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });

    const structuredCaller = getInjectedStructuredCaller();
    const result = await structuredCaller.evaluateCondition(
      'agent output',
      [{ index: 0, text: 'approved' }],
      { cwd: '/tmp/project', provider: 'cursor', resolvedProvider: 'cursor' },
    );

    expect(result).toBe(0);
    const [, prompt, runOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(prompt).toContain('Output ONLY the tag `[JUDGE:N]`');
    expect(runOptions).toEqual(expect.objectContaining({
      cwd: '/tmp/project',
      provider: 'cursor',
      resolvedProvider: 'cursor',
    }));
    expect(runOptions).not.toHaveProperty('outputSchema');
  });

  it('should use native structured output judge calls when a step provider override is supported', async () => {
    mockGetProvider.mockImplementation((provider: string) => ({
      supportsStructuredOutput: provider === 'claude',
    }));
    const { resolveWorkflowConfigValues } = await import('../infra/config/index.js');
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      notificationSound: true,
      notificationSoundEvents: {},
      provider: 'cursor',
      runtime: undefined,
      preventSleep: false,
      model: undefined,
      logging: undefined,
      analytics: undefined,
    });

    const config = makeConfig();
    config.steps[0] = {
      ...config.steps[0]!,
      provider: 'claude',
    };

    await executeWorkflow(config, 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    mockRunAgent.mockResolvedValue({
      persona: 'default',
      status: 'done',
      content: '[JUDGE:1]',
      structuredOutput: { matched_index: 1 },
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });

    const structuredCaller = getInjectedStructuredCaller();
    const result = await structuredCaller.evaluateCondition(
      'agent output',
      [{ index: 0, text: 'approved' }],
      { cwd: '/tmp/project', provider: 'claude', resolvedProvider: 'claude' },
    );

    expect(result).toBe(0);
    const [, prompt, runOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(prompt).toContain('Output ONLY the tag `[JUDGE:N]`');
    expect(runOptions).toEqual(expect.objectContaining({
      cwd: '/tmp/project',
      provider: 'claude',
      resolvedProvider: 'claude',
    }));
    expect(runOptions).toHaveProperty('outputSchema');
  });

  it('should use prompt-based team leader decomposition when resolvedProvider is unsupported', async () => {
    mockGetProvider.mockImplementation((provider: string) => ({
      supportsStructuredOutput: provider === 'claude',
    }));
    const { resolveWorkflowConfigValues } = await import('../infra/config/index.js');
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      notificationSound: true,
      notificationSoundEvents: {},
      provider: 'claude',
      runtime: undefined,
      preventSleep: false,
      model: undefined,
      logging: undefined,
      analytics: undefined,
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    mockRunAgent.mockResolvedValue({
      persona: 'team-leader',
      status: 'done',
      content: '```json\n[{"id":"part-1","title":"API","instruction":"Implement API"}]\n```',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });

    const structuredCaller = getInjectedStructuredCaller();
    const result = await structuredCaller.decomposeTask(
      'break down the work',
      2,
      { cwd: '/tmp/project', resolvedProvider: 'cursor', resolvedModel: 'cursor-fast', persona: 'team-leader' },
    );

    expect(result).toEqual([
      { id: 'part-1', title: 'API', instruction: 'Implement API' },
    ]);
    const [, prompt, runOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(prompt).toContain('```json');
    expect(runOptions).toEqual(expect.objectContaining({
      cwd: '/tmp/project',
      resolvedProvider: 'cursor',
      resolvedModel: 'cursor-fast',
    }));
    expect(runOptions).not.toHaveProperty('outputSchema');
  });

  it('should keep native team leader decomposition when resolvedProvider is supported', async () => {
    mockGetProvider.mockImplementation((provider: string) => ({
      supportsStructuredOutput: provider === 'claude',
    }));
    const { resolveWorkflowConfigValues } = await import('../infra/config/index.js');
    vi.mocked(resolveWorkflowConfigValues).mockReturnValue({
      notificationSound: true,
      notificationSoundEvents: {},
      provider: 'cursor',
      runtime: undefined,
      preventSleep: false,
      model: undefined,
      logging: undefined,
      analytics: undefined,
    });

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    mockRunAgent.mockResolvedValue({
      persona: 'team-leader',
      status: 'done',
      content: 'ignored',
      structuredOutput: {
        parts: [{ id: 'part-1', title: 'API', instruction: 'Implement API' }],
      },
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });

    const structuredCaller = getInjectedStructuredCaller();
    const result = await structuredCaller.decomposeTask(
      'break down the work',
      2,
      { cwd: '/tmp/project', resolvedProvider: 'claude', resolvedModel: 'sonnet', persona: 'team-leader' },
    );

    expect(result).toEqual([
      { id: 'part-1', title: 'API', instruction: 'Implement API' },
    ]);
    const [, , runOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(runOptions).toEqual(expect.objectContaining({
      cwd: '/tmp/project',
      resolvedProvider: 'claude',
      resolvedModel: 'sonnet',
    }));
    expect(runOptions).toHaveProperty('outputSchema');
  });

  it('should use prompt-based team leader feedback when resolvedProvider is unsupported', async () => {
    mockGetProvider.mockImplementation((provider: string) => ({
      supportsStructuredOutput: provider === 'claude',
    }));

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    mockRunAgent.mockResolvedValue({
      persona: 'team-leader',
      status: 'done',
      content: '```json\n{\"done\":false,\"reasoning\":\"need tests\",\"parts\":[{\"id\":\"part-2\",\"title\":\"Tests\",\"instruction\":\"Add tests\"}]}\n```',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });

    const structuredCaller = getInjectedStructuredCaller();
    const result = await structuredCaller.requestMoreParts(
      'break down the work',
      [{ id: 'part-1', title: 'API', status: 'done', content: 'Implemented API' }],
      ['part-1'],
      2,
      { cwd: '/tmp/project', resolvedProvider: 'cursor', resolvedModel: 'cursor-fast', persona: 'team-leader' },
    );

    expect(result).toEqual({
      done: false,
      reasoning: 'need tests',
      parts: [{ id: 'part-2', title: 'Tests', instruction: 'Add tests' }],
    });
    const [, prompt, runOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(prompt).toContain('```json');
    expect(runOptions).toEqual(expect.objectContaining({
      cwd: '/tmp/project',
      resolvedProvider: 'cursor',
      resolvedModel: 'cursor-fast',
    }));
    expect(runOptions).not.toHaveProperty('outputSchema');
  });

  it('should keep native team leader feedback when resolvedProvider is supported', async () => {
    mockGetProvider.mockImplementation((provider: string) => ({
      supportsStructuredOutput: provider === 'claude',
    }));

    await executeWorkflow(makeConfig(), 'task', '/tmp/project', {
      projectCwd: '/tmp/project',
    });

    mockRunAgent.mockResolvedValue({
      persona: 'team-leader',
      status: 'done',
      content: 'ignored',
      structuredOutput: {
        done: false,
        reasoning: 'need tests',
        parts: [{ id: 'part-2', title: 'Tests', instruction: 'Add tests' }],
      },
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });

    const structuredCaller = getInjectedStructuredCaller();
    const result = await structuredCaller.requestMoreParts(
      'break down the work',
      [{ id: 'part-1', title: 'API', status: 'done', content: 'Implemented API' }],
      ['part-1'],
      2,
      { cwd: '/tmp/project', resolvedProvider: 'claude', resolvedModel: 'sonnet', persona: 'team-leader' },
    );

    expect(result).toEqual({
      done: false,
      reasoning: 'need tests',
      parts: [{ id: 'part-2', title: 'Tests', instruction: 'Add tests' }],
    });
    const [, , runOptions] = mockRunAgent.mock.calls[0] ?? [];
    expect(runOptions).toEqual(expect.objectContaining({
      cwd: '/tmp/project',
      resolvedProvider: 'claude',
      resolvedModel: 'sonnet',
    }));
    expect(runOptions).toHaveProperty('outputSchema');
  });
});
