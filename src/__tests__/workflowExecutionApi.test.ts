import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockExecuteTaskWorkflow,
  mockExecuteWorkflow,
  mockExecuteWorkflowForRun,
  mockSelectAndExecuteTask,
  mockCreateLoopAnalysisScheduler,
} = vi.hoisted(() => ({
  mockExecuteTaskWorkflow: vi.fn(),
  mockExecuteWorkflow: vi.fn(),
  mockExecuteWorkflowForRun: vi.fn(),
  mockSelectAndExecuteTask: vi.fn(),
  mockCreateLoopAnalysisScheduler: vi.fn(),
}));

vi.mock('../features/tasks/execute/taskWorkflowExecution.js', () => ({
  executeTaskWorkflow: (...args: unknown[]) => mockExecuteTaskWorkflow(...args),
}));

vi.mock('../features/tasks/execute/workflowExecution.js', () => ({
  executeWorkflow: (...args: unknown[]) => mockExecuteWorkflow(...args),
  executeWorkflowForRun: (...args: unknown[]) => mockExecuteWorkflowForRun(...args),
}));

vi.mock('../features/tasks/execute/loopAnalysis.js', () => ({
  LOOP_ANALYSIS_WORKFLOW: 'loop-analysis',
  createLoopAnalysisScheduler: (...args: unknown[]) => mockCreateLoopAnalysisScheduler(...args),
}));

vi.mock('../features/tasks/execute/selectAndExecute.js', () => ({
  selectAndExecuteTask: (...args: unknown[]) => mockSelectAndExecuteTask(...args),
}));

import { executeTaskWithResult } from '../features/tasks/execute/taskExecution.js';
import {
  runLoopAnalysisWorkflowExecution,
  runWorkflowExecution,
} from '../features/tasks/execute/workflowExecutionApi.js';

describe('runWorkflowExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectAndExecuteTask.mockRejectedValue(new Error('CLI routing must not be called'));
    mockExecuteTaskWorkflow.mockImplementation(async (request, executor) => {
      return executor(
        { name: 'takt-default', steps: [], maxSteps: 3 },
        request.task,
        request.cwd,
        {
          projectCwd: request.projectCwd,
          outputMode: request.outputMode,
          eventSink: request.eventSink,
          abortSignal: request.abortSignal,
          mcpServers: request.mcpServers,
          provider: request.agentOverrides?.provider,
          model: request.agentOverrides?.model,
          ...(request.loopAnalysisPublication === undefined
            ? {}
            : { loopAnalysisPublication: request.loopAnalysisPublication }),
        },
      );
    });
    mockExecuteWorkflow.mockResolvedValue({
      success: true,
      lastStep: 'supervise',
      lastMessage: 'done',
      runDirectory: '/repo/.takt/runs/run-1',
      reportDirectory: '/repo/.takt/runs/run-1/reports',
      ndjsonLogPath: '/repo/.takt/runs/run-1/logs/session.ndjson',
    });
    mockExecuteWorkflowForRun.mockResolvedValue({
      success: true,
      runDirectory: '/repo/.takt/runs/run-1',
      reportDirectory: '/repo/.takt/runs/run-1/reports',
      ndjsonLogPath: '/repo/.takt/runs/run-1/logs/session.ndjson',
    });
    mockCreateLoopAnalysisScheduler.mockReturnValue(vi.fn());
  });

  it('should run a workflow through the application API without CLI routing', async () => {
    const eventSink = vi.fn();
    const abortController = new AbortController();

    const result = await runWorkflowExecution({
      task: 'Implement ACP support',
      cwd: '/repo',
      projectCwd: '/repo',
      workflowIdentifier: 'takt-default',
      agentOverrides: {
        provider: 'mock',
        model: 'mock-model',
      },
      outputMode: 'silent',
      eventSink,
      abortSignal: abortController.signal,
      mcpServers: {
        docs: { type: 'stdio', command: 'docs-mcp', args: ['serve'] },
      },
    });

    expect(result).toEqual({
      success: true,
      lastStep: 'supervise',
      lastMessage: 'done',
      runDirectory: '/repo/.takt/runs/run-1',
      reportDirectory: '/repo/.takt/runs/run-1/reports',
      ndjsonLogPath: '/repo/.takt/runs/run-1/logs/session.ndjson',
    });
    expect(mockExecuteTaskWorkflow).toHaveBeenCalledWith(
      {
        task: 'Implement ACP support',
        cwd: '/repo',
        projectCwd: '/repo',
        workflowIdentifier: 'takt-default',
        agentOverrides: {
          provider: 'mock',
          model: 'mock-model',
        },
        outputMode: 'silent',
        eventSink,
        abortSignal: abortController.signal,
        mcpServers: {
          docs: { type: 'stdio', command: 'docs-mcp', args: ['serve'] },
        },
      },
      expect.any(Function),
    );
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalledWith(
      { name: 'takt-default', steps: [], maxSteps: 3 },
      'Implement ACP support',
      '/repo',
      expect.objectContaining({
        projectCwd: '/repo',
        outputMode: 'silent',
        eventSink,
        abortSignal: abortController.signal,
        mcpServers: {
          docs: { type: 'stdio', command: 'docs-mcp', args: ['serve'] },
        },
        provider: 'mock',
        model: 'mock-model',
      }),
    );
  });

  it('should fail before execution when cwd is missing', async () => {
    await expect(runWorkflowExecution({
      task: 'Implement ACP support',
      cwd: '',
      projectCwd: '/repo',
      workflowIdentifier: 'takt-default',
      outputMode: 'silent',
    })).rejects.toThrow(/cwd/i);

    expect(mockExecuteTaskWorkflow).not.toHaveBeenCalled();
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
  });

  it('should fail before execution when cwd is relative', async () => {
    await expect(runWorkflowExecution({
      task: 'Implement ACP support',
      cwd: '../repo',
      projectCwd: '/repo',
      workflowIdentifier: 'takt-default',
      outputMode: 'silent',
    })).rejects.toThrow(/cwd must be an absolute path/i);

    expect(mockExecuteTaskWorkflow).not.toHaveBeenCalled();
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
  });

  it('should fail before execution when projectCwd is relative', async () => {
    await expect(runWorkflowExecution({
      task: 'Implement ACP support',
      cwd: '/repo',
      projectCwd: 'repo',
      workflowIdentifier: 'takt-default',
      outputMode: 'silent',
    })).rejects.toThrow(/projectCwd must be an absolute path/i);

    expect(mockExecuteTaskWorkflow).not.toHaveBeenCalled();
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
  });

  it.each([
    ['workflowIdentifier', ''],
    ['workflowIdentifier', '   '],
    ['task', ''],
    ['task', '   '],
  ] as const)('should fail before execution when %s is empty', async (fieldName, value) => {
    await expect(runWorkflowExecution({
      task: fieldName === 'task' ? value : 'Implement ACP support',
      cwd: '/repo',
      projectCwd: '/repo',
      workflowIdentifier: fieldName === 'workflowIdentifier' ? value : 'takt-default',
      outputMode: 'silent',
    })).rejects.toThrow(new RegExp(`${fieldName} is required`, 'i'));

    expect(mockExecuteTaskWorkflow).not.toHaveBeenCalled();
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
  });

  it('should return structured failure information without process exit', async () => {
    mockExecuteTaskWorkflow.mockResolvedValueOnce({
      success: false,
      reason: 'Step "draft" failed',
      lastStep: 'draft',
      lastMessage: 'provider error',
      runDirectory: '/repo/.takt/runs/run-2',
      reportDirectory: '/repo/.takt/runs/run-2/reports',
      ndjsonLogPath: '/repo/.takt/runs/run-2/logs/session.ndjson',
    });

    const result = await runWorkflowExecution({
      task: 'Implement ACP support',
      cwd: '/repo',
      projectCwd: '/repo',
      workflowIdentifier: 'takt-default',
      outputMode: 'silent',
    });

    expect(result).toEqual({
      success: false,
      reason: 'Step "draft" failed',
      lastStep: 'draft',
      lastMessage: 'provider error',
      runDirectory: '/repo/.takt/runs/run-2',
      reportDirectory: '/repo/.takt/runs/run-2/reports',
      ndjsonLogPath: '/repo/.takt/runs/run-2/logs/session.ndjson',
    });
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
  });

  it('should route executeTaskWithResult through the workflow execution application API', async () => {
    const result = await executeTaskWithResult({
      task: 'Run from CLI path',
      cwd: '/repo',
      projectCwd: '/repo',
      workflowIdentifier: 'default',
      outputMode: 'terminal',
    });

    expect(result.success).toBe(true);
    expect(mockExecuteTaskWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'Run from CLI path',
        cwd: '/repo',
        projectCwd: '/repo',
        workflowIdentifier: 'default',
        outputMode: 'terminal',
      }),
      expect.any(Function),
    );
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
  });

  it('should pass run context through the workflow execution application API', async () => {
    mockExecuteTaskWorkflow.mockImplementationOnce(async (_request, executor) => {
      await executor(
        { name: 'default', steps: [], maxSteps: 3 },
        'Run from watch path',
        '/repo',
        { projectCwd: '/repo' },
      );
      return {
        success: true,
        runDirectory: '/repo/.takt/runs/run-1',
        reportDirectory: '/repo/.takt/runs/run-1/reports',
        ndjsonLogPath: '/repo/.takt/runs/run-1/logs/session.ndjson',
      };
    });

    await runWorkflowExecution({
      task: 'Run from watch path',
      cwd: '/repo',
      projectCwd: '/repo',
      workflowIdentifier: 'default',
      outputMode: 'terminal',
    }, {
      ignoreIterationLimit: true,
    });

    expect(mockExecuteWorkflowForRun).toHaveBeenCalledWith(
      { name: 'default', steps: [], maxSteps: 3 },
      'Run from watch path',
      '/repo',
      expect.objectContaining({ projectCwd: '/repo' }),
      { ignoreIterationLimit: true },
    );
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  it('Given a normal workflow request, When execution is configured, Then the terminal hook receives the loop analysis scheduler', async () => {
    const scheduler = vi.fn();
    const publication = {
      branch: 'takt/analyze-after-completion',
      register: vi.fn(),
      settle: vi.fn(),
    };
    mockCreateLoopAnalysisScheduler.mockReturnValueOnce(scheduler);

    await runWorkflowExecution({
      task: 'Analyze after completion',
      cwd: '/repo',
      projectCwd: '/repo',
      workflowIdentifier: 'default',
      outputMode: 'silent',
      loopAnalysisPublication: publication,
    });

    expect(mockCreateLoopAnalysisScheduler).toHaveBeenCalledWith({
      projectCwd: '/repo',
      publication,
    });
    expect(mockExecuteWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      '/repo',
      expect.objectContaining({ loopAnalysisScheduler: scheduler }),
    );
  });

  it.each([
    ['the builtin name', 'loop-analysis'],
    ['an absolute path', '/repo/.takt/workflows/loop-analysis.yaml'],
    ['a repertoire scope reference', '@nrslib/takt-ensemble/loop-analysis'],
  ])(
    'Given %s resolves to the loop analysis workflow, When it executes, Then no scheduler is created',
    async (_label, workflowIdentifier) => {
      mockExecuteTaskWorkflow.mockImplementationOnce(async (request, executor) => executor(
        { name: 'loop-analysis', steps: [], maxSteps: 3 },
        request.task,
        request.cwd,
        { projectCwd: request.projectCwd },
      ));

      await runWorkflowExecution({
        task: 'Analyze a source run',
        cwd: '/repo',
        projectCwd: '/repo',
        workflowIdentifier,
        outputMode: 'silent',
      });

      expect(mockCreateLoopAnalysisScheduler).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'loop-analysis' }),
        expect.any(String),
        '/repo',
        expect.not.objectContaining({ loopAnalysisScheduler: expect.anything() }),
      );
    },
  );

  it('Given an internal analysis execution resolves to an overridden workflow name, When it executes, Then no scheduler is created', async () => {
    mockExecuteTaskWorkflow.mockImplementationOnce(async (request, executor) => executor(
      { name: 'project-loop-analysis-override', steps: [], maxSteps: 3 },
      request.task,
      request.cwd,
      { projectCwd: request.projectCwd },
    ));

    await runLoopAnalysisWorkflowExecution({
      task: 'Analyze a source run',
      cwd: '/repo',
      projectCwd: '/repo',
      workflowIdentifier: 'loop-analysis',
      outputMode: 'silent',
    });

    expect(mockCreateLoopAnalysisScheduler).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'project-loop-analysis-override' }),
      expect.any(String),
      '/repo',
      expect.not.objectContaining({ loopAnalysisScheduler: expect.anything() }),
    );
  });

  it('Given an internal analysis execution, When its options are built, Then report persistence receives the publication sanitizer', async () => {
    mockExecuteTaskWorkflow.mockImplementationOnce(async (request, executor) => executor(
      { name: 'project-loop-analysis-override', steps: [], maxSteps: 3 },
      request.task,
      request.cwd,
      { projectCwd: request.projectCwd },
    ));

    await runLoopAnalysisWorkflowExecution({
      task: 'Analyze a source run',
      cwd: '/repo',
      projectCwd: '/repo',
      workflowIdentifier: 'loop-analysis',
      outputMode: 'silent',
    });

    const options = mockExecuteWorkflow.mock.calls[0]?.[3] as {
      reportContentSanitizer?: (content: string) => string;
    } | undefined;
    expect(options?.reportContentSanitizer).toEqual(expect.any(Function));
    const sanitized = options?.reportContentSanitizer?.(
      'token=analysis-secret\nWindows path: C:/Users/jane/private/report.md',
    );
    expect(sanitized).not.toMatch(/analysis-secret|C:\/Users\/jane/);
  });
});

describe('runWorkflowExecution silent output', () => {
  const tempDirectories: string[] = [];

  function spyOnCliOutput() {
    return {
      consoleLog: vi.spyOn(console, 'log').mockImplementation(() => undefined),
      consoleError: vi.spyOn(console, 'error').mockImplementation(() => undefined),
      consoleWarn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      stdoutWrite: vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      stderrWrite: vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
    };
  }

  function expectNoCliOutput(spies: ReturnType<typeof spyOnCliOutput>): void {
    expect(spies.consoleLog).not.toHaveBeenCalled();
    expect(spies.consoleError).not.toHaveBeenCalled();
    expect(spies.consoleWarn).not.toHaveBeenCalled();
    expect(spies.stdoutWrite).not.toHaveBeenCalled();
    expect(spies.stderrWrite).not.toHaveBeenCalled();
  }

  async function createProjectDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'takt-workflow-api-'));
    tempDirectories.push(directory);
    return directory;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const actual = await vi.importActual<typeof import('../features/tasks/execute/taskWorkflowExecution.js')>(
      '../features/tasks/execute/taskWorkflowExecution.js',
    );
    mockExecuteTaskWorkflow.mockImplementation(
      (...args: Parameters<typeof actual.executeTaskWorkflow>) => actual.executeTaskWorkflow(...args),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ));
  });

  it('should not write CLI output when workflow lookup fails in silent mode', async () => {
    const projectCwd = await createProjectDirectory();
    const cliOutput = spyOnCliOutput();
    const eventSink = vi.fn();

    const result = await runWorkflowExecution({
      task: 'Task: missing workflow',
      cwd: projectCwd,
      projectCwd,
      workflowIdentifier: 'missing-workflow-for-silent-api',
      outputMode: 'silent',
      eventSink,
    });

    expect(result).toEqual({
      success: false,
      reason: 'Workflow "missing-workflow-for-silent-api" not found.',
    });
    expect(eventSink).toHaveBeenCalledWith({
      type: 'completed',
      success: false,
      reason: 'Workflow "missing-workflow-for-silent-api" not found.',
    });
    expect(mockCreateLoopAnalysisScheduler).not.toHaveBeenCalled();
    expectNoCliOutput(cliOutput);
  });

  it('should dispatch terminal failure without CLI output when workflow file lookup fails in silent mode', async () => {
    const projectCwd = await createProjectDirectory();
    const cliOutput = spyOnCliOutput();
    const eventSink = vi.fn();

    const result = await runWorkflowExecution({
      task: 'Task: missing workflow file',
      cwd: projectCwd,
      projectCwd,
      workflowIdentifier: './custom-workflow.yaml',
      outputMode: 'silent',
      eventSink,
    });

    expect(result).toEqual({
      success: false,
      reason: 'Workflow file not found: ./custom-workflow.yaml',
    });
    expect(eventSink).toHaveBeenCalledWith({
      type: 'completed',
      success: false,
      reason: 'Workflow file not found: ./custom-workflow.yaml',
    });
    expectNoCliOutput(cliOutput);
  });

  it('Given a publication coordinator, When the actual task workflow adapter resolves a workflow, Then the scheduler receives that coordinator', async () => {
    const projectCwd = await createProjectDirectory();
    const scheduler = vi.fn();
    const publication = {
      branch: 'takt/analyze-after-publication',
      register: vi.fn(),
      settle: vi.fn(),
    };
    mockCreateLoopAnalysisScheduler.mockReturnValueOnce(scheduler);
    mockExecuteWorkflow.mockResolvedValueOnce({ success: true });

    await runWorkflowExecution({
      task: 'Analyze after PR publication',
      cwd: projectCwd,
      projectCwd,
      workflowIdentifier: 'default',
      outputMode: 'silent',
      loopAnalysisPublication: publication,
    });

    expect(mockCreateLoopAnalysisScheduler).toHaveBeenCalledWith({
      projectCwd,
      publication,
    });
    expect(mockExecuteWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'default' }),
      'Analyze after PR publication',
      projectCwd,
      expect.objectContaining({ loopAnalysisScheduler: scheduler }),
    );
  });
});
