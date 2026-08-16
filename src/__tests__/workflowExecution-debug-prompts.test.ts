/**
 * Integration tests: debug prompt log wiring in executeWorkflow().
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import { buildPhaseExecutionId } from '../shared/utils/phaseExecutionId.js';

const {
  disabledObservability,
  mockIsDebugEnabled,
  mockWritePromptLog,
  mockInitNdjsonLog,
  mockAppendNdjsonLine,
  MockWorkflowEngine,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');

  const mockIsDebugEnabled = vi.fn().mockReturnValue(true);
  const mockWritePromptLog = vi.fn();
  const mockInitNdjsonLog = vi.fn((
    sessionId: string,
    task: string,
    workflowName: string,
    options: { logsDir: string; startTime: string },
  ) => {
    fs.mkdirSync(options.logsDir, { recursive: true });
    const filePath = path.join(options.logsDir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, `${JSON.stringify({
      type: 'workflow_start',
      task,
      workflowName,
      startTime: options.startTime,
    })}\n`);
    return filePath;
  });
  const mockAppendNdjsonLine = vi.fn((filePath: string, record: unknown) => {
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
  });

  class MockWorkflowEngine extends EE {
    private config: WorkflowConfig;
    private task: string;

    constructor(config: WorkflowConfig, _cwd: string, task: string, _options: unknown) {
      super();
      if (task === 'constructor-throw-task') {
        throw new Error('mock constructor failure');
      }
      this.config = config;
      this.task = task;
    }

    abort(): void {}

    async run(): Promise<{ status: string; iteration: number }> {
      const step = this.config.steps[0]!;
      const timestamp = new Date('2026-02-07T00:00:00.000Z');
      const shouldAbort = this.task === 'abort-task';
      const shouldAbortBeforeComplete = this.task === 'abort-before-complete-task';
      const shouldDuplicatePhase = this.task === 'duplicate-phase-task';
      const shouldEmitSensitive = this.task === 'sensitive-content-task';
      const shouldRepeatStep = this.task === 'repeat-step-task';
      const shouldReversePhaseCompletion = this.task === 'reverse-phase-complete-task';
      const providerInfo = { provider: undefined, model: undefined };
      const executePhaseId = buildPhaseExecutionId({
        step: step.name,
        iteration: 1,
        phase: 1,
        sequence: 1,
      });
      const executePhaseSecondId = buildPhaseExecutionId({
        step: step.name,
        iteration: 1,
        phase: 1,
        sequence: 2,
      });
      const judgePhaseId = buildPhaseExecutionId({
        step: step.name,
        iteration: 1,
        phase: 3,
        sequence: 1,
      });
      this.emit('step:start', step, 1, 'step instruction', providerInfo, this.config.name, step.name, 1);
      if (shouldReversePhaseCompletion) {
        this.emit('phase:start', step, 1, 'execute', 'phase prompt first', {
          systemPrompt: '../agents/coder.md',
          userInstruction: 'phase prompt first',
        }, executePhaseId, 1);
        this.emit('phase:start', step, 1, 'execute', 'phase prompt second', {
          systemPrompt: '../agents/coder.md',
          userInstruction: 'phase prompt second',
        }, executePhaseSecondId, 1);
      } else {
        this.emit('phase:start', step, 1, 'execute', shouldEmitSensitive ? 'token=plain-secret' : 'phase prompt', {
          systemPrompt: shouldEmitSensitive ? 'Authorization: Bearer super-secret-token' : '../agents/coder.md',
          userInstruction: shouldEmitSensitive ? 'api_key=plain-secret' : 'phase prompt',
        }, executePhaseId, 1);
      }
      this.emit('phase:start', step, 3, 'judge', 'phase3 prompt', {
        systemPrompt: 'conductor',
        userInstruction: 'phase3 prompt',
      }, judgePhaseId, 1);
      this.emit('phase:judge_stage', step, 3, 'judge', {
        stage: 1,
        method: 'structured_output',
        status: 'done',
        instruction: 'judge stage prompt',
        response: 'judge stage response',
      }, judgePhaseId, 1);
      this.emit('phase:complete', step, 3, 'judge', '[IMPLEMENT:1]', 'done', undefined, judgePhaseId, 1);
      if (shouldAbortBeforeComplete) {
        this.emit(
          'workflow:abort',
          { status: 'aborted', iteration: 1 },
          'user_interrupted',
          'interrupt',
          {
            kind: 'interrupt',
            step: step.name,
            reason: 'user_interrupted',
            error: 'user_interrupted',
          },
        );
        return { status: 'aborted', iteration: 1 };
      }
      if (shouldReversePhaseCompletion) {
        this.emit('phase:complete', step, 1, 'execute', 'phase response second', 'done', undefined, executePhaseSecondId, 1);
        this.emit('phase:complete', step, 1, 'execute', 'phase response first', 'done', undefined, executePhaseId, 1);
      } else {
        this.emit('phase:complete', step, 1, 'execute', shouldEmitSensitive ? 'password=plain-secret' : 'phase response', 'done', undefined, executePhaseId, 1);
      }
      if (shouldDuplicatePhase) {
        this.emit('phase:start', step, 1, 'execute', 'phase prompt second', {
          systemPrompt: '../agents/coder.md',
          userInstruction: 'phase prompt second',
        }, executePhaseSecondId, 1);
        this.emit('phase:complete', step, 1, 'execute', 'phase response second', 'done', undefined, executePhaseSecondId, 1);
      }
      this.emit(
        'step:complete',
        step,
        {
          persona: step.personaDisplayName,
          status: 'done',
          content: 'step response',
          timestamp,
        },
        'step instruction',
        step.name,
      );
      if (shouldRepeatStep) {
        this.emit(
          'step:start',
          step,
          2,
          'step instruction repeat',
          providerInfo,
          this.config.name,
          step.name,
          2,
        );
        this.emit(
          'step:complete',
          step,
          {
            persona: step.personaDisplayName,
            status: 'done',
            content: 'step response repeat',
            timestamp,
          },
          'step instruction repeat',
          step.name,
        );
      }
      if (shouldAbort) {
        this.emit(
          'workflow:abort',
          { status: 'aborted', iteration: 1 },
          'user_interrupted',
          'interrupt',
          {
            kind: 'interrupt',
            step: step.name,
            reason: 'user_interrupted',
            error: 'user_interrupted',
          },
        );
        return { status: 'aborted', iteration: shouldRepeatStep ? 2 : 1 };
      }
      this.emit('workflow:complete', { status: 'completed', iteration: 1 });
      return { status: 'completed', iteration: shouldRepeatStep ? 2 : 1 };
    }
  }

  return {
    disabledObservability: {
      enabled: false,
      monitor: false,
      sessionLogExporter: false,
      usageEventsPhase: false,
    },
    mockIsDebugEnabled,
    mockWritePromptLog,
    mockInitNdjsonLog,
    mockAppendNdjsonLine,
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

vi.mock('../features/tasks/execute/workflowRunLifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../features/tasks/execute/workflowRunLifecycle.js')
  >();
  const { createWorkflowRunLifecycleCompositionTestDouble } = await import(
    './helpers/run-lifecycle.js'
  );
  return {
    ...actual,
    createWorkflowRunLifecycle: (
      input: Parameters<typeof actual.createWorkflowRunLifecycle>[0],
    ) => createWorkflowRunLifecycleCompositionTestDouble(
      actual.createWorkflowRunLifecycle,
      input,
      {
        sessionId: 'test-session-id',
        startedAt: '2026-02-07T00:00:00.000Z',
        projectTerminalArtifacts: true,
      },
    ),
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
  loadProjectConfig: vi.fn(() => ({})),
  loadGlobalConfig: vi.fn(() => ({})),
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

vi.mock('../features/tasks/execute/traceReportWriter.js', async () => {
  const { renderTraceReportFromLogs } = await import(
    '../features/tasks/execute/traceReport.js'
  );
  const { writeFileAtomic } = await import('../infra/config/index.js');
  return {
    writeTerminalTraceReport: (input: {
      tracePath: string;
      workflowName: string;
      task: string;
      runSlug: string;
      ndjsonLogPath: string;
      promptLogPath?: string;
      mode: 'off' | 'redacted' | 'full';
      terminal: {
        status: 'completed' | 'aborted' | 'failed';
        iterations: number;
        endTime: string;
        reason?: string;
      };
    }) => {
      const markdown = renderTraceReportFromLogs(
        {
          tracePath: input.tracePath,
          workflowName: input.workflowName,
          task: input.task,
          runSlug: input.runSlug,
          ...input.terminal,
        },
        input.ndjsonLogPath,
        input.promptLogPath,
        input.mode,
      );
      if (markdown !== undefined) {
        writeFileAtomic(input.tracePath, markdown);
      }
    },
  };
});

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

vi.mock('../infra/fs/index.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../infra/fs/index.js')
  >()),
  generateSessionId: vi.fn().mockReturnValue('test-session-id'),
  createSessionLog: vi.fn().mockImplementation((
    task,
    projectDir,
    workflowName,
    options,
  ) => ({
    task,
    projectDir,
    workflowName,
    startTime: options.startTime,
    iterations: 0,
    status: 'running',
    history: [],
  })),
  finalizeSessionLog: vi.fn().mockImplementation((log, status) => ({
    ...log,
    status,
    endTime: new Date().toISOString(),
  })),
  initNdjsonLog: mockInitNdjsonLog,
  appendNdjsonLine: mockAppendNdjsonLine,
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
  isDebugEnabled: mockIsDebugEnabled,
  writePromptLog: mockWritePromptLog,
  getDebugPromptsLogFile: vi.fn().mockReturnValue(null),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  isValidReportDirName: vi.fn().mockImplementation((value: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)),
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
import { ensureDir, writeFileAtomic } from '../infra/config/index.js';
import { appendNdjsonLine } from '../infra/fs/index.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

describe('executeWorkflow debug prompts logging', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-debug-prompts-'));
    vi.clearAllMocks();
    mockIsDebugEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

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

  it('should write prompt log record when debug is enabled', async () => {
    mockIsDebugEnabled.mockReturnValue(true);

    await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
    });

    expect(mockWritePromptLog).toHaveBeenCalledTimes(2);
    const records = mockWritePromptLog.mock.calls.map((call) => call[0]) as Array<{
      step: string;
      phase: number;
      iteration: number;
      prompt: string;
      response: string;
      timestamp: string;
    }>;
    const record = records.find((entry) => entry.phase === 1)!;
    expect(record.step).toBe('implement');
    expect(record.phase).toBe(1);
    expect(record.iteration).toBe(1);
    expect(record.prompt).toBeTypeOf('string');
    expect(record.response).toBeTypeOf('string');
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should separate system prompt and user instruction in debug prompt records', async () => {
    mockIsDebugEnabled.mockReturnValue(true);

    await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
    });

    expect(mockWritePromptLog).toHaveBeenCalledTimes(2);
    const records = mockWritePromptLog.mock.calls.map((call) => call[0]) as Array<Record<string, unknown> & { phase: number }>;
    const record = records.find((entry) => entry.phase === 1)!;
    expect(record).toHaveProperty('systemPrompt');
    expect(record).toHaveProperty('userInstruction');
    expect(record.systemPrompt).toBeTypeOf('string');
    expect(record.userInstruction).toBeTypeOf('string');
  });

  it('should not write prompt log record when debug is disabled', async () => {
    mockIsDebugEnabled.mockReturnValue(false);

    await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
    });

    expect(mockWritePromptLog).not.toHaveBeenCalled();
  });

  it('should handle repeated phase starts for same step and phase without missing debug prompt', async () => {
    mockIsDebugEnabled.mockReturnValue(true);

    await executeWorkflow(makeConfig(), 'duplicate-phase-task', projectDir, {
      projectCwd: projectDir,
    });

    expect(mockWritePromptLog).toHaveBeenCalledTimes(3);
    const records = mockWritePromptLog.mock.calls.map((call) => call[0]) as Array<{
      phase: number;
      response: string;
    }>;
    const phase1Responses = records
      .filter((record) => record.phase === 1)
      .map((record) => record.response);
    expect(phase1Responses).toHaveLength(2);
    expect(phase1Responses.every((response) => typeof response === 'string' && response.length > 0)).toBe(true);
  });

  it('should fail fast when taskPrefix is provided without taskColorIndex', async () => {
    await expect(
      executeWorkflow(makeConfig(), 'task', projectDir, {
        projectCwd: projectDir,
        taskPrefix: 'override-persona-provider',
      })
    ).rejects.toThrow('taskPrefix and taskColorIndex must be provided together');
  });

  it('should fail fast for invalid reportDirName before run directory writes', async () => {
    await expect(
      executeWorkflow(makeConfig(), 'task', projectDir, {
        projectCwd: projectDir,
        reportDirName: '..',
      })
    ).rejects.toThrow('Invalid reportDirName: ..');

    expect(vi.mocked(ensureDir)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFileAtomic)).not.toHaveBeenCalled();
  });

  it('should update meta status from running to completed', async () => {
    await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'test-report-dir',
    });

    const metaCalls = vi.mocked(writeFileAtomic).mock.calls.filter(
      (call) => String(call[0]).endsWith('/meta.json')
    );
    expect(metaCalls.length).toBeGreaterThanOrEqual(3);

    const firstMeta = JSON.parse(String(metaCalls[0]![1])) as { status: string; endTime?: string };
    const stepMeta = metaCalls
      .map((call) => JSON.parse(String(call[1])) as {
        status: string;
        currentStep?: string;
        currentIteration?: number;
        phase?: number;
        endTime?: string;
      })
      .find((meta) => meta.currentStep === 'implement' && meta.currentIteration === 1 && meta.phase === undefined);
    const finalMeta = JSON.parse(String(metaCalls[metaCalls.length - 1]![1])) as {
      status: string;
      currentStep?: string;
      currentIteration?: number;
      endTime?: string;
    };
    expect(firstMeta.status).toBe('running');
    expect(firstMeta.endTime).toBeUndefined();
    expect(stepMeta).toMatchObject({
      status: 'running',
      currentStep: 'implement',
      currentIteration: 1,
    });
    expect(stepMeta?.endTime).toBeUndefined();
    expect(finalMeta.status).toBe('completed');
    expect(finalMeta.currentStep).toBe('implement');
    expect(finalMeta.currentIteration).toBe(1);
    expect(finalMeta.endTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should update meta status from running to aborted', async () => {
    await executeWorkflow(makeConfig(), 'abort-task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'test-report-dir',
    });

    const metaCalls = vi.mocked(writeFileAtomic).mock.calls.filter(
      (call) => String(call[0]).endsWith('/meta.json')
    );
    expect(metaCalls.length).toBeGreaterThanOrEqual(3);

    const firstMeta = JSON.parse(String(metaCalls[0]![1])) as { status: string; endTime?: string };
    const stepMeta = metaCalls
      .map((call) => JSON.parse(String(call[1])) as {
        status: string;
        currentStep?: string;
        currentIteration?: number;
        phase?: number;
        endTime?: string;
      })
      .find((meta) => meta.currentStep === 'implement' && meta.currentIteration === 1 && meta.phase === undefined);
    const finalMeta = JSON.parse(String(metaCalls[metaCalls.length - 1]![1])) as {
      status: string;
      currentStep?: string;
      currentIteration?: number;
      endTime?: string;
    };
    expect(firstMeta.status).toBe('running');
    expect(firstMeta.endTime).toBeUndefined();
    expect(stepMeta).toMatchObject({
      status: 'running',
      currentStep: 'implement',
      currentIteration: 1,
    });
    expect(stepMeta?.endTime).toBeUndefined();
    expect(finalMeta.status).toBe('aborted');
    expect(finalMeta.currentStep).toBe('implement');
    expect(finalMeta.currentIteration).toBe(1);
    expect(finalMeta.endTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should finalize meta as aborted when WorkflowEngine constructor throws', async () => {
    await expect(
      executeWorkflow(makeConfig(), 'constructor-throw-task', projectDir, {
        projectCwd: projectDir,
        reportDirName: 'test-report-dir',
      })
    ).rejects.toThrow('mock constructor failure');

    const metaCalls = vi.mocked(writeFileAtomic).mock.calls.filter(
      (call) => String(call[0]).endsWith('/meta.json')
    );
    expect(metaCalls).toHaveLength(2);

    const firstMeta = JSON.parse(String(metaCalls[0]![1])) as { status: string; endTime?: string };
    const secondMeta = JSON.parse(String(metaCalls[1]![1])) as { status: string; endTime?: string };
    expect(firstMeta.status).toBe('running');
    expect(firstMeta.endTime).toBeUndefined();
    expect(secondMeta.status).toBe('failed');
    expect(secondMeta.endTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should write trace.md on workflow completion', async () => {
    await executeWorkflow(makeConfig(), 'task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'test-report-dir',
    });

    const traceCalls = vi.mocked(writeFileAtomic).mock.calls.filter(
      (call) => String(call[0]).endsWith('/trace.md')
    );
    expect(traceCalls.length).toBeGreaterThan(0);
  });

  it('should write trace.md on workflow abort', async () => {
    await executeWorkflow(makeConfig(), 'abort-task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'test-report-dir',
    });

    const traceCalls = vi.mocked(writeFileAtomic).mock.calls.filter(
      (call) => String(call[0]).endsWith('/trace.md')
    );
    expect(traceCalls.length).toBeGreaterThan(0);
  });

  it('should sanitize sensitive fields before writing session NDJSON when trace mode is default', async () => {
    await executeWorkflow(makeConfig(), 'token=plain-secret', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'test-report-dir',
      interactiveMetadata: {
        confirmed: true,
        task: 'api_key=plain-secret',
      },
    });
    await executeWorkflow(makeConfig(), 'sensitive-content-task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'test-report-dir-2',
    });

    const records = vi.mocked(appendNdjsonLine).mock.calls.map((call) => call[1]);
    const recordText = JSON.stringify(records);
    expect(recordText).toContain('[REDACTED]');
    expect(recordText).not.toContain('plain-secret');
    expect(recordText).not.toContain('super-secret-token');
  });

  it('should keep phaseExecutionId bindings consistent in trace when completions arrive in reverse order', async () => {
    await executeWorkflow(makeConfig(), 'reverse-phase-complete-task', projectDir, {
      projectCwd: projectDir,
      reportDirName: 'test-report-dir',
    });

    const traceCall = vi.mocked(writeFileAtomic).mock.calls.find(
      (call) => String(call[0]).endsWith('/trace.md')
    );
    expect(traceCall).toBeDefined();
    const traceContent = String(traceCall?.[1]);
    const firstPromptIndex = traceContent.indexOf('phase prompt first');
    const firstResponseIndex = traceContent.indexOf('phase response first');
    const secondPromptIndex = traceContent.indexOf('phase prompt second');
    const secondResponseIndex = traceContent.indexOf('phase response second');

    expect(firstPromptIndex).toBeGreaterThan(-1);
    expect(firstResponseIndex).toBeGreaterThan(firstPromptIndex);
    expect(secondPromptIndex).toBeGreaterThan(firstResponseIndex);
    expect(secondResponseIndex).toBeGreaterThan(secondPromptIndex);
  });
});
