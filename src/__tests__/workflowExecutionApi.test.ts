import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockExecuteTaskWorkflow,
  mockExecuteWorkflow,
  mockExecuteWorkflowForRun,
  mockSelectAndExecuteTask,
} = vi.hoisted(() => ({
  mockExecuteTaskWorkflow: vi.fn(),
  mockExecuteWorkflow: vi.fn(),
  mockExecuteWorkflowForRun: vi.fn(),
  mockSelectAndExecuteTask: vi.fn(),
}));

vi.mock('../features/tasks/execute/taskWorkflowExecution.js', () => ({
  executeTaskWorkflow: (...args: unknown[]) => mockExecuteTaskWorkflow(...args),
}));

vi.mock('../features/tasks/execute/workflowExecution.js', () => ({
  executeWorkflow: (...args: unknown[]) => mockExecuteWorkflow(...args),
  executeWorkflowForRun: (...args: unknown[]) => mockExecuteWorkflowForRun(...args),
}));

vi.mock('../features/tasks/execute/selectAndExecute.js', () => ({
  selectAndExecuteTask: (...args: unknown[]) => mockSelectAndExecuteTask(...args),
}));

import { executeTaskWithResult } from '../features/tasks/execute/taskExecution.js';
import { runWorkflowExecution } from '../features/tasks/execute/workflowExecutionApi.js';

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
      { projectCwd: '/repo' },
      { ignoreIterationLimit: true },
    );
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });
});
