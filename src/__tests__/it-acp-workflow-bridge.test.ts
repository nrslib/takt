import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSelectAndExecuteTask,
  mockExecuteDefaultAction,
} = vi.hoisted(() => ({
  mockSelectAndExecuteTask: vi.fn(),
  mockExecuteDefaultAction: vi.fn(),
}));

vi.mock('../features/tasks/execute/selectAndExecute.js', () => ({
  selectAndExecuteTask: (...args: unknown[]) => mockSelectAndExecuteTask(...args),
}));

vi.mock('../app/cli/routing.js', () => ({
  executeDefaultAction: (...args: unknown[]) => mockExecuteDefaultAction(...args),
}));

import { createTaktAcpAgent } from '../app/acp/agent.js';

describe('ACP conversation to workflow integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should bridge explicit natural language direct execution through conversation session and workflow API', async () => {
    const sendSessionUpdate = vi.fn();
    const runWorkflowExecution = vi.fn(async (request: {
      eventSink: (event: unknown) => void | Promise<void>;
    }) => {
      await request.eventSink({
        type: 'run_started',
        runDirectory: '/repo/.takt/runs/run-1',
      });
      await request.eventSink({
        type: 'step_started',
        step: 'draft',
        iteration: 1,
        maxSteps: 5,
      });
      await request.eventSink({
        type: 'output',
        outputType: 'text',
        message: 'streamed answer',
        step: 'draft',
      });
      await request.eventSink({
        type: 'completed',
        success: true,
        reportDirectory: '/repo/.takt/runs/run-1/reports',
      });
      return {
        success: true,
        lastStep: 'supervise',
        lastMessage: 'approved',
        runDirectory: '/repo/.takt/runs/run-1',
        reportDirectory: '/repo/.takt/runs/run-1/reports',
        ndjsonLogPath: '/repo/.takt/runs/run-1/logs/session.ndjson',
      };
    });
    const handleUserMessage = vi.fn().mockResolvedValue({
      kind: 'assistant_response',
      content: 'conversation path should not be used',
    });
    const createTaskInstruction = vi.fn().mockResolvedValue({
      kind: 'workflow_execution_requested',
      task: 'Implement ACP support',
      workflowIdentifier: 'takt-default',
      interactiveMetadata: {
        confirmed: true,
        task: 'Implement ACP support',
      },
    });
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({ handleUserMessage, createTaskInstruction })),
      runWorkflowExecution,
      sendSessionUpdate,
    });
    const { sessionId } = await agent.handleSessionNew({ cwd: '/repo', mcpServers: [] });

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '今すぐ実行して' }],
    });

    expect(createTaskInstruction).toHaveBeenCalledWith(expect.objectContaining({
      userNote: '今すぐ実行して',
      abortSignal: expect.any(AbortSignal),
    }));
    expect(handleUserMessage).not.toHaveBeenCalled();
    expect(runWorkflowExecution).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Implement ACP support',
      workflowIdentifier: 'takt-default',
      cwd: '/repo',
      projectCwd: '/repo',
      outputMode: 'silent',
      interactiveMetadata: {
        confirmed: true,
        task: 'Implement ACP support',
      },
      eventSink: expect.any(Function),
    }));
    const sessionUpdates = sendSessionUpdate.mock.calls
      .filter((call) => call[0] === sessionId)
      .map((call) => call[1]);
    expect(sessionUpdates.map((update) => (
      update.kind === 'workflow_event'
        ? update.event.type
        : update.kind
    ))).toEqual([
      'agent_message',
      'run_started',
      'step_started',
      'output',
      'completed',
      'agent_message',
    ]);
    expect(sessionUpdates[0]).toEqual({
      kind: 'agent_message',
      text: expect.stringMatching(/direct[\s\S]*workflow|workflow[\s\S]*direct/i),
    });
    const workflowEvents = sendSessionUpdate.mock.calls
      .filter((call) => call[0] === sessionId && call[1]?.kind === 'workflow_event')
      .map((call) => call[1].event);
    expect(workflowEvents.map((event) => event.type)).toEqual([
      'run_started',
      'step_started',
      'output',
      'completed',
    ]);
    expect(workflowEvents[0]).toEqual({
      type: 'run_started',
      runDirectory: '/repo/.takt/runs/run-1',
    });
    expect(workflowEvents[1]).toEqual({
      type: 'step_started',
      step: 'draft',
      iteration: 1,
      maxSteps: 5,
    });
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'workflow_event',
      event: {
        type: 'output',
        outputType: 'text',
        message: 'streamed answer',
        step: 'draft',
      },
    });
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'workflow_event',
      event: {
        type: 'completed',
        success: true,
        reportDirectory: '/repo/.takt/runs/run-1/reports',
      },
    });
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'agent_message',
      text: expect.stringContaining('/repo/.takt/runs/run-1/reports'),
    });
    expect(result).toEqual(expect.objectContaining({
      stopReason: 'end_turn',
    }));
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
    expect(mockExecuteDefaultAction).not.toHaveBeenCalled();
  });

  it('should abort workflow execution on session/cancel', async () => {
    let receivedSignal: AbortSignal | undefined;
    let resolveWorkflowStarted: (() => void) | undefined;
    const workflowStarted = new Promise<void>((resolve) => {
      resolveWorkflowStarted = resolve;
    });
    const runWorkflowExecution = vi.fn(async (request: { abortSignal: AbortSignal }) => {
      receivedSignal = request.abortSignal;
      resolveWorkflowStarted?.();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return {
        success: false,
        reason: 'cancelled',
      };
    });
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'workflow_execution_requested',
          task: 'Implement ACP support',
          workflowIdentifier: 'takt-default',
        }),
      })),
      runWorkflowExecution,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew({ cwd: '/repo', mcpServers: [] });
    const promptPromise = agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/play Implement ACP support' }],
    });

    await workflowStarted;
    await agent.handleSessionCancel({ sessionId });
    const result = await promptPromise;

    expect(receivedSignal?.aborted).toBe(true);
    expect(result).toEqual({
      stopReason: 'cancelled',
    });
  });
});
