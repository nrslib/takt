import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk';
import type { AskUserQuestionInput } from '../core/workflow/types.js';
import { saveTaskFile } from '../features/tasks/add/index.js';

const {
  mockSelectAndExecuteTask,
  mockExecuteDefaultAction,
  mockCallAIWithRetry,
} = vi.hoisted(() => ({
  mockSelectAndExecuteTask: vi.fn(),
  mockExecuteDefaultAction: vi.fn(),
  mockCallAIWithRetry: vi.fn(),
}));

vi.mock('../features/tasks/execute/selectAndExecute.js', () => ({
  selectAndExecuteTask: (...args: unknown[]) => mockSelectAndExecuteTask(...args),
}));

vi.mock('../app/cli/routing.js', () => ({
  executeDefaultAction: (...args: unknown[]) => mockExecuteDefaultAction(...args),
}));

vi.mock('../features/interactive/aiCaller.js', () => ({
  callAIWithRetry: (...args: unknown[]) => mockCallAIWithRetry(...args),
}));

import { createTaktAcpAgent, mapTaktAcpUpdateToSessionUpdate } from '../app/acp/agent.js';
import { createConversationSession } from '../features/interactive/conversationSession.js';

function newSessionParams(overrides: Record<string, unknown> = {}) {
  return {
    cwd: '/repo',
    mcpServers: [],
    ...overrides,
  };
}

function createTaskInstructionResult(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'workflow_execution_requested',
    task: 'Implement ACP support',
    interactiveMetadata: {
      confirmed: true,
      task: 'Implement ACP support',
    },
    ...overrides,
  };
}

function createRealConversationSessionForAcp(input: {
  cwd: string;
  outputMode?: 'terminal' | 'silent';
}) {
  return createConversationSession({
    cwd: input.cwd,
    outputMode: input.outputMode,
    ctx: {
      provider: {
        setup: vi.fn(),
        getRuntimeInstructions: vi.fn(() => null),
      },
      providerType: 'mock',
      model: 'mock-model',
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    },
    strategy: {
      systemPrompt: 'system prompt',
      allowedTools: ['Read'],
      transformPrompt: (message: string) => `transformed: ${message}`,
      summaryPromptContext: 'summary context',
    },
  });
}

async function captureElicitationRequest(
  question: AskUserQuestionInput['questions'][number],
  answer: string | string[],
): Promise<CreateElicitationRequest> {
  const createElicitation = vi.fn().mockResolvedValue({
    action: 'accept',
    content: { answer },
  });
  const runWorkflowExecution = vi.fn(async (request) => {
    const answers = await request.onAskUserQuestion?.({
      questions: [question],
    });
    expect(answers).toEqual({
      [question.question]: Array.isArray(answer) ? answer.join(', ') : answer,
    });
    return {
      success: true,
      reportDirectory: '/repo/.takt/runs/run-1/reports',
    };
  });
  const agent = createTaktAcpAgent({
    createConversationSession: vi.fn(() => ({
      handleUserMessage: vi.fn().mockResolvedValue({
        kind: 'workflow_execution_requested',
        task: 'Implement ACP support',
      }),
    })),
    runWorkflowExecution,
    createElicitation,
  });
  await agent.handleInitialize({
    protocolVersion: 1,
    clientCapabilities: {
      elicitation: {
        form: {},
      },
    },
  });
  const { sessionId } = await agent.handleSessionNew(newSessionParams());

  await agent.handleSessionPrompt({
    sessionId,
    prompt: [{ type: 'text', text: '/play Implement ACP support' }],
  });

  const request = createElicitation.mock.calls[0]?.[0] as CreateElicitationRequest | undefined;
  if (!request) {
    throw new Error('ACP elicitation was not requested');
  }
  return request;
}

describe('TAKT ACP agent adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize as a TAKT ACP agent with prompt sessions', async () => {
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(),
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });

    const result = await agent.handleInitialize({});

    expect(result).toEqual(expect.objectContaining({
      agentInfo: expect.objectContaining({
        name: 'TAKT',
      }),
      agentCapabilities: expect.objectContaining({
        promptCapabilities: {},
        sessionCapabilities: {},
      }),
    }));
  });

  it('should map workflow events to typed ACP session updates instead of JSON text', () => {
    expect(mapTaktAcpUpdateToSessionUpdate({
      kind: 'workflow_event',
      event: {
        type: 'tool_started',
        toolCallId: 'tool-1',
        tool: 'Read',
        input: { file_path: 'src/index.ts' },
      },
    })).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Read',
      kind: 'other',
      status: 'in_progress',
      rawInput: { file_path: 'src/index.ts' },
    });

    expect(mapTaktAcpUpdateToSessionUpdate({
      kind: 'workflow_event',
      event: {
        type: 'tool_completed',
        toolCallId: 'tool-1',
        message: 'done',
        isError: false,
      },
    })).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'completed',
      content: [{
        type: 'content',
        content: { type: 'text', text: 'done' },
      }],
    });
  });

  it('should map confirmation events with caller-provided unique tool call IDs', () => {
    expect(mapTaktAcpUpdateToSessionUpdate({
      kind: 'workflow_event',
      event: {
        type: 'confirmation_requested',
        confirmationId: 'confirmation-1',
        message: 'Choose a file',
        step: 'review',
      },
    })).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'confirmation-1',
      title: 'Confirmation requested',
      kind: 'other',
      status: 'pending',
      content: [{
        type: 'content',
        content: { type: 'text', text: 'Choose a file' },
      }],
    });
  });

  it('should map permission lifecycle to a pending tool call and matching completion update', () => {
    expect(mapTaktAcpUpdateToSessionUpdate({
      kind: 'workflow_event',
      event: {
        type: 'confirmation_requested',
        confirmationId: 'perm-1',
        message: 'Permission requested: edit',
        step: 'review',
      },
    })).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'perm-1',
      title: 'Confirmation requested',
      kind: 'other',
      status: 'pending',
      content: [{
        type: 'content',
        content: { type: 'text', text: 'Permission requested: edit' },
      }],
    });

    expect(mapTaktAcpUpdateToSessionUpdate({
      kind: 'workflow_event',
      event: {
        type: 'tool_completed',
        toolCallId: 'perm-1',
        message: 'Permission summary: 1 resolved permissions',
        step: 'review',
        isError: false,
      },
    })).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'perm-1',
      status: 'completed',
      content: [{
        type: 'content',
        content: { type: 'text', text: 'Permission summary: 1 resolved permissions' },
      }],
    });
  });

  it('should map failed workflow completion with the required reason', () => {
    expect(mapTaktAcpUpdateToSessionUpdate({
      kind: 'workflow_event',
      event: {
        type: 'completed',
        success: false,
        reason: 'Provider is not configured.',
      },
    })).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Workflow failed: Provider is not configured.' },
    });
  });

  it('should map successful workflow completion without an undefined report path', () => {
    expect(mapTaktAcpUpdateToSessionUpdate({
      kind: 'workflow_event',
      event: {
        type: 'completed',
        success: true,
      },
    })).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Workflow completed.' },
    });
  });

  it('should create a session from root session/new params', async () => {
    const createConversationSession = vi.fn(() => ({
      handleUserMessage: vi.fn(),
    }));
    const agent = createTaktAcpAgent({
      createConversationSession,
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });

    const result = await agent.handleSessionNew({
      cwd: '/repo',
      mcpServers: [],
    });

    expect(result).toEqual({
      sessionId: expect.any(String),
    });
    expect(createConversationSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
    }));
  });

  it('should reject session/new when cwd is missing', async () => {
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(),
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });

    await expect(agent.handleSessionNew({
      additionalDirectories: [],
      mcpServers: [],
    })).rejects.toThrow(/cwd/i);
  });

  it('should create a session without mcpServers', async () => {
    const createConversationSession = vi.fn(() => ({
      handleUserMessage: vi.fn(),
    }));
    const agent = createTaktAcpAgent({
      createConversationSession,
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });

    const result = await agent.handleSessionNew({
      cwd: '/repo',
    });

    expect(result).toEqual({
      sessionId: expect.any(String),
    });
    expect(createConversationSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
    }));
  });

  it('should reject session/new when cwd is relative', async () => {
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(),
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });

    await expect(agent.handleSessionNew({
      cwd: 'relative/repo',
      mcpServers: [],
    })).rejects.toThrow(/cwd must be an absolute path/i);
  });

  it('should reject non-empty additionalDirectories without path validation', async () => {
    const createConversationSession = vi.fn();
    const agent = createTaktAcpAgent({
      createConversationSession,
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });

    await expect(agent.handleSessionNew({
      cwd: '/repo',
      additionalDirectories: ['../other'],
      mcpServers: [],
    })).rejects.toThrow(/additionalDirectories is not supported/i);
    expect(createConversationSession).not.toHaveBeenCalled();
  });

  it('should reject non-empty additionalDirectories because TAKT ACP does not support that capability yet', async () => {
    const createConversationSession = vi.fn();
    const agent = createTaktAcpAgent({
      createConversationSession,
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });

    await expect(agent.handleSessionNew({
      cwd: '/repo',
      additionalDirectories: ['/repo/packages/app'],
      mcpServers: [],
    })).rejects.toThrow(/additionalDirectories is not supported/i);
    expect(createConversationSession).not.toHaveBeenCalled();
  });

  it('should reject unsupported ACP MCP transports before session creation', async () => {
    const createConversationSession = vi.fn();
    const agent = createTaktAcpAgent({
      createConversationSession,
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });

    await expect(agent.handleSessionNew({
      cwd: '/repo',
      mcpServers: [{
        type: 'http',
        name: 'docs',
        url: 'https://example.test/mcp',
        headers: [],
      }],
    })).rejects.toThrow(/Unsupported ACP MCP server transport: http/i);
    expect(createConversationSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      title: 'empty name',
      mcpServers: [{ name: '   ', command: 'docs-mcp', args: [], env: [] }],
      error: /mcpServers name is required/i,
    },
    {
      title: 'empty command',
      mcpServers: [{ name: 'docs', command: '   ', args: [], env: [] }],
      error: /mcpServers "docs" command is required/i,
    },
    {
      title: 'duplicate name',
      mcpServers: [
        { name: 'docs', command: 'docs-mcp', args: [], env: [] },
        { name: 'docs', command: 'other-mcp', args: [], env: [] },
      ],
      error: /Duplicate MCP server name: docs/i,
    },
    {
      title: 'duplicate trimmed env name',
      mcpServers: [{
        name: 'docs',
        command: 'docs-mcp',
        args: [],
        env: [
          { name: ' DOCS_TOKEN ', value: 'x' },
          { name: 'DOCS_TOKEN', value: 'y' },
        ],
      }],
      error: /Duplicate MCP server env name: DOCS_TOKEN/i,
    },
    {
      title: 'empty env name',
      mcpServers: [{
        name: 'docs',
        command: 'docs-mcp',
        args: [],
        env: [{ name: ' ', value: 'x' }],
      }],
      error: /mcpServers env name is required/i,
    },
  ])('should reject ACP MCP stdio boundary: $title', async ({ mcpServers, error }) => {
    const createConversationSession = vi.fn();
    const agent = createTaktAcpAgent({
      createConversationSession,
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });

    await expect(agent.handleSessionNew({
      cwd: '/repo',
      mcpServers,
    })).rejects.toThrow(error);
    expect(createConversationSession).not.toHaveBeenCalled();
  });

  it('should pass stdio ACP MCP servers into workflow execution', async () => {
    const runWorkflowExecution = vi.fn().mockResolvedValue({
      success: true,
      reportDirectory: '/repo/.takt/runs/run-1/reports',
    });
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'workflow_execution_requested',
          task: 'Use docs MCP',
          interactiveMetadata: {
            confirmed: true,
            task: 'Use docs MCP',
          },
        }),
      })),
      runWorkflowExecution,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew({
      cwd: '/repo',
      mcpServers: [{
        name: 'docs',
        command: ' docs-mcp ',
        args: ['serve'],
        env: [{ name: 'DOCS_TOKEN', value: 'token' }],
      }],
    });

    await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/play Use docs MCP' }],
    });

    expect(runWorkflowExecution).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers: {
        docs: {
          type: 'stdio',
          command: 'docs-mcp',
          args: ['serve'],
          env: { DOCS_TOKEN: 'token' },
        },
      },
    }));
  });

  it('should trim ACP MCP server env names before passing them into workflow execution', async () => {
    const runWorkflowExecution = vi.fn().mockResolvedValue({
      success: true,
      reportDirectory: '/repo/.takt/runs/run-1/reports',
    });
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'workflow_execution_requested',
          task: 'Use docs MCP',
        }),
      })),
      runWorkflowExecution,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew({
      cwd: '/repo',
      mcpServers: [{
        name: 'docs',
        command: 'docs-mcp',
        args: [],
        env: [{ name: ' DOCS_TOKEN ', value: 'token' }],
      }],
    });

    await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/play Use docs MCP' }],
    });

    expect(runWorkflowExecution).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers: {
        docs: {
          type: 'stdio',
          command: 'docs-mcp',
          args: [],
          env: { DOCS_TOKEN: 'token' },
        },
      },
    }));
  });

  it('should pass session/prompt text to the conversation session without response-envelope parsing', async () => {
    const sendSessionUpdate = vi.fn();
    const handleUserMessage = vi.fn().mockResolvedValue({
      kind: 'assistant_response',
      content: 'What should TAKT run?',
      sessionId: 'provider-session-1',
    });
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({ handleUserMessage })),
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate,
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'Implement ACP support' },
      ],
    });

    expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Implement ACP support',
      abortSignal: expect.any(AbortSignal),
    }));
    expect(result).toEqual(expect.objectContaining({
      stopReason: 'end_turn',
    }));
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'agent_message',
      text: 'What should TAKT run?',
    });
    expect(mockSelectAndExecuteTask).not.toHaveBeenCalled();
    expect(mockExecuteDefaultAction).not.toHaveBeenCalled();
  });

  it('should enqueue an explicit natural language task request without running the workflow', async () => {
    const sendSessionUpdate = vi.fn();
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: '20260701-implement-acp-support',
      tasksFile: '/repo/.takt/tasks.yaml',
    });
    const handleUserMessage = vi.fn().mockResolvedValue({
      kind: 'assistant_response',
      content: 'conversation path should not be used',
    });
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult({
      workflowIdentifier: 'review',
    }));
    const deps = {
      createConversationSession: vi.fn(() => ({
        handleUserMessage,
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate,
    };
    const agent = createTaktAcpAgent(deps);
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: 'この会話をタスクに積んで' }],
    });

    expect(createTaskInstruction).toHaveBeenCalledWith(expect.objectContaining({
      userNote: 'この会話をタスクに積んで',
      abortSignal: expect.any(AbortSignal),
    }));
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement ACP support', {
      workflow: 'review',
      worktree: true,
      autoPr: false,
    });
    expect(createTaskInstruction.mock.invocationCallOrder[0]).toBeLessThan(
      saveTaskFile.mock.invocationCallOrder[0],
    );
    expect(saveTaskFile.mock.invocationCallOrder[0]).toBeLessThan(
      sendSessionUpdate.mock.invocationCallOrder[0],
    );
    expect(runWorkflowExecution).not.toHaveBeenCalled();
    expect(handleUserMessage).not.toHaveBeenCalled();
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'agent_message',
      text: expect.stringMatching(/pending[\s\S]*worktree: true[\s\S]*workflow: review[\s\S]*takt run/i),
    });
    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('should pass explicit PR context from enqueue prompt text to task saving', async () => {
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: '20260701-implement-acp-support',
      tasksFile: '/repo/.takt/tasks.yaml',
    });
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{
        type: 'text',
        text: 'この内容をタスクに積んで branch: takt/123/fix-acp base_branch: main PR #123',
      }],
    });

    expect(createTaskInstruction).toHaveBeenCalledWith(expect.objectContaining({
      userNote: 'この内容をタスクに積んで branch: takt/123/fix-acp base_branch: main PR #123',
      abortSignal: expect.any(AbortSignal),
    }));
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement ACP support', {
      workflow: 'default',
      worktree: true,
      autoPr: false,
      branch: 'takt/123/fix-acp',
      baseBranch: 'main',
      prNumber: 123,
    });
    expect(runWorkflowExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('should create an issue and enqueue the generated task instruction', async () => {
    const sendSessionUpdate = vi.fn();
    const runWorkflowExecution = vi.fn();
    const createIssueFromTask = vi.fn().mockReturnValue(913);
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: '20260701-implement-acp-support',
      tasksFile: '/repo/.takt/tasks.yaml',
    });
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult({
      workflowIdentifier: 'review',
    }));
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      createIssueFromTask,
      sendSessionUpdate,
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: 'Issueを作ってタスクに積んで' }],
    });

    expect(createTaskInstruction).toHaveBeenCalledWith(expect.objectContaining({
      userNote: 'Issueを作ってタスクに積んで',
      abortSignal: expect.any(AbortSignal),
    }));
    expect(createIssueFromTask).toHaveBeenCalledWith('Implement ACP support', {
      cwd: '/repo',
      outputMode: 'silent',
    });
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement ACP support', {
      workflow: 'review',
      worktree: true,
      autoPr: false,
      issue: 913,
    });
    expect(createIssueFromTask.mock.invocationCallOrder[0]).toBeLessThan(
      saveTaskFile.mock.invocationCallOrder[0],
    );
    expect(runWorkflowExecution).not.toHaveBeenCalled();
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'agent_message',
      text: expect.stringMatching(/issue: #913[\s\S]*workflow: review[\s\S]*takt run/i),
    });
    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('should not enqueue when ACP issue creation fails', async () => {
    const sendSessionUpdate = vi.fn();
    const runWorkflowExecution = vi.fn();
    const createIssueFromTask = vi.fn().mockReturnValue(undefined);
    const saveTaskFile = vi.fn();
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      createIssueFromTask,
      sendSessionUpdate,
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: 'create an issue and enqueue' }],
    });

    expect(createIssueFromTask).toHaveBeenCalledWith('Implement ACP support', {
      cwd: '/repo',
      outputMode: 'silent',
    });
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(runWorkflowExecution).not.toHaveBeenCalled();
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'agent_message',
      text: 'Failed to enqueue task: Issue creation failed',
    });
    expect(result).toEqual({ stopReason: 'refusal' });
  });

  it.each([
    'pending task にして prNumber: -1',
    'タスクに積んで。今すぐ実行して PR #0',
  ])('should reject invalid explicit PR number prompt text before side effects: %s', async (text) => {
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn();
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await expect(agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text }],
    })).rejects.toThrow('ACP prNumber must be a positive integer.');

    expect(createTaskInstruction).not.toHaveBeenCalled();
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(runWorkflowExecution).not.toHaveBeenCalled();
  });

  it('should reject refspec branch context from enqueue prompt text before task saving', async () => {
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn();
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await expect(agent.handleSessionPrompt({
      sessionId,
      prompt: [{
        type: 'text',
        text: 'この内容をタスクに積んで branch=HEAD:refs/heads/takt/injected',
      }],
    })).rejects.toThrow('ACP branch must be a branch name, not a refspec');

    expect(createTaskInstruction).not.toHaveBeenCalled();
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(runWorkflowExecution).not.toHaveBeenCalled();
  });

  it('should reject reflog branch context from enqueue prompt text before task saving', async () => {
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn();
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await expect(agent.handleSessionPrompt({
      sessionId,
      prompt: [{
        type: 'text',
        text: 'この内容をタスクに積んで branch=@{-1}',
      }],
    })).rejects.toThrow('ACP branch must be a plain branch name, not a reflog selector');

    expect(createTaskInstruction).not.toHaveBeenCalled();
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(runWorkflowExecution).not.toHaveBeenCalled();
  });

  it('should reject Git option branch context from enqueue prompt text before task saving', async () => {
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn();
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await expect(agent.handleSessionPrompt({
      sessionId,
      prompt: [{
        type: 'text',
        text: 'この内容をタスクに積んで branch=--upload-pack=echo',
      }],
    })).rejects.toThrow('ACP branch must be a plain local branch name, not a Git option');

    expect(createTaskInstruction).not.toHaveBeenCalled();
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(runWorkflowExecution).not.toHaveBeenCalled();
  });

  it('should reject remote-tracking baseBranch context from enqueue prompt text before task saving', async () => {
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn();
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await expect(agent.handleSessionPrompt({
      sessionId,
      prompt: [{
        type: 'text',
        text: 'この内容をタスクに積んで baseBranch=origin/main',
      }],
    })).rejects.toThrow('ACP branch must be a branch name, not a remote-tracking ref');

    expect(createTaskInstruction).not.toHaveBeenCalled();
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(runWorkflowExecution).not.toHaveBeenCalled();
  });

  it('should keep the session usable after invalid enqueue branch rejection', async () => {
    let receivedSignal: AbortSignal | undefined;
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn();
    const handleUserMessage = vi.fn((input: { abortSignal?: AbortSignal }) => {
      receivedSignal = input.abortSignal;
      return Promise.resolve({
        kind: 'assistant_response' as const,
        content: 'ready',
      });
    });
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage,
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await expect(agent.handleSessionPrompt({
      sessionId,
      prompt: [{
        type: 'text',
        text: 'この内容をタスクに積んで branch=--help',
      }],
    })).rejects.toThrow('ACP branch must be a plain local branch name, not a Git option');

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '次の通常会話です' }],
    });

    expect(receivedSignal?.aborted).toBe(false);
    expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: '次の通常会話です',
    }));
    expect(createTaskInstruction).not.toHaveBeenCalled();
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(runWorkflowExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('should reject reflog branch context from session/new before task saving', async () => {
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn(),
        createTaskInstruction: vi.fn(),
      })),
      runWorkflowExecution: vi.fn(),
      saveTaskFile: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });

    await expect(agent.handleSessionNew(newSessionParams({
      taskContext: {
        branch: '@{-1}',
      },
    }))).rejects.toThrow('ACP branch must be a plain branch name, not a reflog selector');
  });

  it('should reject Git option branch context from session/new before task saving', async () => {
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn(),
        createTaskInstruction: vi.fn(),
      })),
      runWorkflowExecution: vi.fn(),
      saveTaskFile: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });

    await expect(agent.handleSessionNew(newSessionParams({
      taskContext: {
        branch: '--upload-pack=echo',
      },
    }))).rejects.toThrow('ACP branch must be a plain local branch name, not a Git option');
  });

  it('should reject remote-tracking baseBranch context from session/new before task saving', async () => {
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn(),
        createTaskInstruction: vi.fn(),
      })),
      runWorkflowExecution: vi.fn(),
      saveTaskFile: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });

    await expect(agent.handleSessionNew(newSessionParams({
      taskContext: {
        baseBranch: 'origin/main',
      },
    }))).rejects.toThrow('ACP branch must be a branch name, not a remote-tracking ref');
  });

  it('should reject invalid PR number context from session/new before session state is created', async () => {
    const createTaskInstruction = vi.fn();
    const saveTaskFile = vi.fn();
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn(),
        createTaskInstruction,
      })),
      runWorkflowExecution: vi.fn(),
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });

    await expect(agent.handleSessionNew(newSessionParams({
      taskContext: {
        prNumber: 0,
      },
    }))).rejects.toThrow('ACP prNumber must be a positive integer.');

    expect(createTaskInstruction).not.toHaveBeenCalled();
    expect(saveTaskFile).not.toHaveBeenCalled();
  });

  it('should use PR context from session state when enqueue prompt has no PR context', async () => {
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: '20260701-implement-acp-support',
      tasksFile: '/repo/.takt/tasks.yaml',
    });
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams({
      taskContext: {
        branch: 'takt/321/session-context',
        baseBranch: 'develop',
        prNumber: 321,
      },
    }));

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: 'pending task にして' }],
    });

    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement ACP support', {
      workflow: 'default',
      worktree: true,
      autoPr: false,
      branch: 'takt/321/session-context',
      baseBranch: 'develop',
      prNumber: 321,
    });
    expect(runWorkflowExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('should enqueue mixed intent text when the direct phrase is negated', async () => {
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: '20260701-implement-acp-support',
      tasksFile: '/repo/.takt/tasks.yaml',
    });
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '今すぐ実行してではなくタスクに積んで' }],
    });

    expect(createTaskInstruction).toHaveBeenCalledWith(expect.objectContaining({
      userNote: '今すぐ実行してではなくタスクに積んで',
      abortSignal: expect.any(AbortSignal),
    }));
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement ACP support', {
      workflow: 'default',
      worktree: true,
      autoPr: false,
    });
    expect(runWorkflowExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('should directly execute mixed intent text when direct execution is positively explicit', async () => {
    const runWorkflowExecution = vi.fn().mockResolvedValue({
      success: true,
      reportDirectory: '/repo/.takt/runs/run-1/reports',
    });
    const saveTaskFile = vi.fn();
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: 'タスクに積んで。今すぐ実行して' }],
    });

    expect(createTaskInstruction).toHaveBeenCalledWith(expect.objectContaining({
      userNote: 'タスクに積んで。今すぐ実行して',
      abortSignal: expect.any(AbortSignal),
    }));
    expect(runWorkflowExecution).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Implement ACP support',
      workflowIdentifier: 'default',
      outputMode: 'silent',
    }));
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('should retain direct prompt PR context for a later enqueue prompt', async () => {
    const runWorkflowExecution = vi.fn().mockResolvedValue({
      success: true,
      reportDirectory: '/repo/.takt/runs/run-1/reports',
    });
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: '20260701-implement-acp-support',
      tasksFile: '/repo/.takt/tasks.yaml',
    });
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const directResult = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{
        type: 'text',
        text: '今すぐ実行して。 branch: takt/654/direct-context baseBranch=main prNumber=654',
      }],
    });
    const enqueueResult = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: 'pending task にして' }],
    });

    expect(runWorkflowExecution).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Implement ACP support',
      workflowIdentifier: 'default',
      outputMode: 'silent',
    }));
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement ACP support', {
      workflow: 'default',
      worktree: true,
      autoPr: false,
      branch: 'takt/654/direct-context',
      baseBranch: 'main',
      prNumber: 654,
    });
    expect(directResult).toEqual({ stopReason: 'end_turn' });
    expect(enqueueResult).toEqual({ stopReason: 'end_turn' });
  });

  it('should reject invalid branch context from direct prompt before workflow execution', async () => {
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn();
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await expect(agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '今すぐ実行して。 branch=--help' }],
    })).rejects.toThrow('ACP branch must be a plain local branch name, not a Git option');

    expect(createTaskInstruction).not.toHaveBeenCalled();
    expect(runWorkflowExecution).not.toHaveBeenCalled();
    expect(saveTaskFile).not.toHaveBeenCalled();
  });

  it('should default /go task instructions to enqueue instead of direct execution', async () => {
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: '20260701-implement-acp-support',
      tasksFile: '/repo/.takt/tasks.yaml',
    });
    const handleUserMessage = vi.fn().mockResolvedValue({
      kind: 'assistant_response',
      content: 'conversation path should not be used',
    });
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage,
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/go include progress updates' }],
    });

    expect(createTaskInstruction).toHaveBeenCalledWith(expect.objectContaining({
      userNote: 'include progress updates',
      abortSignal: expect.any(AbortSignal),
    }));
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement ACP support', {
      workflow: 'default',
      worktree: true,
      autoPr: false,
    });
    expect(runWorkflowExecution).not.toHaveBeenCalled();
    expect(handleUserMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('should use dependency defaultAction direct for /go when session does not override it', async () => {
    const runWorkflowExecution = vi.fn().mockResolvedValue({
      success: true,
      reportDirectory: '/repo/.takt/runs/run-1/reports',
    });
    const saveTaskFile = vi.fn();
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const agent = createTaktAcpAgent({
      defaultAction: 'direct',
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn(),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/go include progress updates' }],
    });

    expect(createTaskInstruction).toHaveBeenCalledWith(expect.objectContaining({
      userNote: 'include progress updates',
      abortSignal: expect.any(AbortSignal),
    }));
    expect(runWorkflowExecution).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Implement ACP support',
      workflowIdentifier: 'default',
      outputMode: 'silent',
    }));
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('should write a pending task file through the ACP enqueue path', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-acp-save-'));
    const sendSessionUpdate = vi.fn();
    const runWorkflowExecution = vi.fn();
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult({
      task: 'Implement ACP support with queue storage',
      workflowIdentifier: 'review',
      interactiveMetadata: {
        confirmed: true,
        task: 'Implement ACP support with queue storage',
      },
    }));
    try {
      const agent = createTaktAcpAgent({
        createConversationSession: vi.fn(() => ({
          handleUserMessage: vi.fn().mockResolvedValue({
            kind: 'assistant_response',
            content: 'conversation path should not be used',
          }),
          createTaskInstruction,
        })),
        runWorkflowExecution,
        saveTaskFile,
        sendSessionUpdate,
      });
      const { sessionId } = await agent.handleSessionNew(newSessionParams({ cwd: projectDir }));

      const result = await agent.handleSessionPrompt({
        sessionId,
        prompt: [{ type: 'text', text: 'この内容をタスクに積んで。workflow: review' }],
      });

      const tasksFile = join(projectDir, '.takt', 'tasks.yaml');
      const parsed = parseYaml(readFileSync(tasksFile, 'utf-8')) as {
        tasks: Array<Record<string, unknown>>;
      };
      expect(parsed.tasks).toHaveLength(1);
      expect(parsed.tasks[0]).toEqual(expect.objectContaining({
        status: 'pending',
        workflow: 'review',
        worktree: true,
        auto_pr: false,
      }));
      expect(parsed.tasks[0]?.content).toBeUndefined();
      expect(parsed.tasks[0]?.task_dir).toBeTypeOf('string');
      expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
        kind: 'agent_message',
        text: expect.stringMatching(/pending[\s\S]*worktree: true[\s\S]*workflow: review[\s\S]*takt run/i),
      });
      expect(runWorkflowExecution).not.toHaveBeenCalled();
      expect(result).toEqual({ stopReason: 'end_turn' });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('should preserve PR context in tasks.yaml through the ACP enqueue path', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-acp-pr-context-'));
    const runWorkflowExecution = vi.fn();
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult({
      task: 'Fix ACP review comments',
      interactiveMetadata: {
        confirmed: true,
        task: 'Fix ACP review comments',
      },
    }));
    try {
      const agent = createTaktAcpAgent({
        createConversationSession: vi.fn(() => ({
          handleUserMessage: vi.fn().mockResolvedValue({
            kind: 'assistant_response',
            content: 'conversation path should not be used',
          }),
          createTaskInstruction,
        })),
        runWorkflowExecution,
        saveTaskFile,
        sendSessionUpdate: vi.fn(),
      });
      const { sessionId } = await agent.handleSessionNew(newSessionParams({ cwd: projectDir }));

      const result = await agent.handleSessionPrompt({
        sessionId,
        prompt: [{
          type: 'text',
          text: 'この内容をタスクに積んで branch=takt/456/acp-review baseBranch=main prNumber=456',
        }],
      });

      const tasksFile = join(projectDir, '.takt', 'tasks.yaml');
      const parsed = parseYaml(readFileSync(tasksFile, 'utf-8')) as {
        tasks: Array<Record<string, unknown>>;
      };
      expect(parsed.tasks).toHaveLength(1);
      expect(parsed.tasks[0]).toEqual(expect.objectContaining({
        status: 'pending',
        workflow: 'default',
        worktree: true,
        auto_pr: false,
        branch: 'takt/456/acp-review',
        base_branch: 'main',
        source: 'pr_review',
        pr_number: 456,
      }));
      expect(runWorkflowExecution).not.toHaveBeenCalled();
      expect(result).toEqual({ stopReason: 'end_turn' });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('should save a workflow specified in conversation history through the real conversation and queue path', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-acp-real-chain-'));
    const sendSessionUpdate = vi.fn();
    const runWorkflowExecution = vi.fn();
    mockCallAIWithRetry
      .mockResolvedValueOnce({
        result: {
          success: true,
          content: 'I can help turn that into a task.',
          sessionId: 'provider-session-1',
        },
        sessionId: 'provider-session-1',
      })
      .mockResolvedValueOnce({
        result: {
          success: true,
          content: 'Implement ACP support with queue storage.',
          sessionId: 'provider-session-2',
        },
        sessionId: 'provider-session-2',
      });

    try {
      const agent = createTaktAcpAgent({
        createConversationSession: createRealConversationSessionForAcp,
        runWorkflowExecution,
        saveTaskFile,
        sendSessionUpdate,
      });
      const { sessionId } = await agent.handleSessionNew(newSessionParams({ cwd: projectDir }));

      await agent.handleSessionPrompt({
        sessionId,
        prompt: [{ type: 'text', text: 'workflow: review で ACP の実装方針を相談したい' }],
      });
      const result = await agent.handleSessionPrompt({
        sessionId,
        prompt: [{ type: 'text', text: 'この内容をタスクに積んで' }],
      });

      const tasksFile = join(projectDir, '.takt', 'tasks.yaml');
      const parsed = parseYaml(readFileSync(tasksFile, 'utf-8')) as {
        tasks: Array<Record<string, unknown>>;
      };
      expect(parsed.tasks).toHaveLength(1);
      expect(parsed.tasks[0]).toEqual(expect.objectContaining({
        status: 'pending',
        workflow: 'review',
        worktree: true,
        auto_pr: false,
      }));
      const taskOrderFile = join(projectDir, String(parsed.tasks[0]?.task_dir), 'order.md');
      expect(readFileSync(taskOrderFile, 'utf-8')).toBe('Implement ACP support with queue storage.');
      expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
        kind: 'agent_message',
        text: expect.stringMatching(/pending[\s\S]*workflow: review[\s\S]*takt run/i),
      });
      expect(runWorkflowExecution).not.toHaveBeenCalled();
      expect(result).toEqual({ stopReason: 'end_turn' });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('should return refusal and report the cause when enqueue saving fails', async () => {
    const sendSessionUpdate = vi.fn();
    const saveTaskFile = vi.fn().mockRejectedValue(new Error('disk full'));
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const runWorkflowExecution = vi.fn();
    const deps = {
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate,
    };
    const agent = createTaktAcpAgent(deps);
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: 'pending task にして' }],
    });

    expect(result).toEqual({ stopReason: 'refusal' });
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'agent_message',
      text: expect.stringContaining('disk full'),
    });
    expect(runWorkflowExecution).not.toHaveBeenCalled();
    expect(sendSessionUpdate).not.toHaveBeenCalledWith(sessionId, {
      kind: 'agent_message',
      text: expect.stringMatching(/Task added|status: pending|takt run/i),
    });
  });

  it('should report success when session/cancel happens after enqueue saving completes', async () => {
    let resolveSave: ((value: { taskName: string; tasksFile: string }) => void) | undefined;
    const saveTaskFile = vi.fn(() => new Promise<{ taskName: string; tasksFile: string }>((resolve) => {
      resolveSave = resolve;
    }));
    const sendSessionUpdate = vi.fn();
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult());
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn(),
        createTaskInstruction,
      })),
      runWorkflowExecution: vi.fn(),
      saveTaskFile,
      sendSessionUpdate,
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const promptPromise = agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: 'この内容をタスクに積んで' }],
    });
    await vi.waitFor(() => {
      expect(saveTaskFile).toHaveBeenCalled();
    });
    await agent.handleSessionCancel({ sessionId });
    resolveSave?.({
      taskName: '20260701-implement-acp-support',
      tasksFile: '/repo/.takt/tasks.yaml',
    });
    const result = await promptPromise;

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'agent_message',
      text: expect.stringMatching(/Task added|pending|takt run/i),
    });
  });

  it('should keep ambiguous prompts in normal conversation without enqueueing or executing', async () => {
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn();
    const handleUserMessage = vi.fn().mockResolvedValue({
      kind: 'assistant_response',
      content: 'Let us discuss the approach.',
    });
    const deps = {
      createConversationSession: vi.fn(() => ({
        handleUserMessage,
        createTaskInstruction: vi.fn(),
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    };
    const agent = createTaktAcpAgent(deps);
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: 'この修正方針を相談したい' }],
    });

    expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'この修正方針を相談したい',
    }));
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(runWorkflowExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('should keep branch-like text in normal conversation without task context validation', async () => {
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn();
    const handleUserMessage = vi.fn().mockResolvedValue({
      kind: 'assistant_response',
      content: 'Branch syntax can be discussed here.',
    });
    const createTaskInstruction = vi.fn();
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage,
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: 'branch=HEAD:refs/heads/foo とは何ですか' }],
    });

    expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'branch=HEAD:refs/heads/foo とは何ですか',
    }));
    expect(createTaskInstruction).not.toHaveBeenCalled();
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(runWorkflowExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('should keep advisory enqueue phrasing in normal conversation', async () => {
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn();
    const handleUserMessage = vi.fn().mockResolvedValue({
      kind: 'assistant_response',
      content: 'Let us discuss whether to enqueue it.',
    });
    const createTaskInstruction = vi.fn();
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage,
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: 'タスクに積んでいいか相談したい' }],
    });

    expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'タスクに積んでいいか相談したい',
    }));
    expect(createTaskInstruction).not.toHaveBeenCalled();
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(runWorkflowExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('should keep advisory direct phrasing in normal conversation', async () => {
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn();
    const handleUserMessage = vi.fn().mockResolvedValue({
      kind: 'assistant_response',
      content: 'Let us discuss whether to run it.',
    });
    const createTaskInstruction = vi.fn();
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage,
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '今すぐ実行していいか相談したい' }],
    });

    expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: '今すぐ実行していいか相談したい',
    }));
    expect(createTaskInstruction).not.toHaveBeenCalled();
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(runWorkflowExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('should directly execute only when natural language explicitly requests immediate execution', async () => {
    const sendSessionUpdate = vi.fn();
    const runWorkflowExecution = vi.fn().mockResolvedValue({
      success: true,
      reportDirectory: '/repo/.takt/runs/run-1/reports',
    });
    const saveTaskFile = vi.fn();
    const handleUserMessage = vi.fn().mockResolvedValue({
      kind: 'assistant_response',
      content: 'conversation path should not be used',
    });
    const createTaskInstruction = vi.fn().mockResolvedValue(createTaskInstructionResult({
      workflowIdentifier: 'takt-default',
    }));
    const deps = {
      createConversationSession: vi.fn(() => ({
        handleUserMessage,
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
      sendSessionUpdate,
    };
    const agent = createTaktAcpAgent(deps);
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '今すぐ実行して' }],
    });

    expect(createTaskInstruction).toHaveBeenCalledWith(expect.objectContaining({
      userNote: '今すぐ実行して',
      abortSignal: expect.any(AbortSignal),
    }));
    expect(runWorkflowExecution).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Implement ACP support',
      workflowIdentifier: 'takt-default',
      outputMode: 'silent',
      eventSink: expect.any(Function),
    }));
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(handleUserMessage).not.toHaveBeenCalled();
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'agent_message',
      text: expect.stringMatching(/direct[\s\S]*workflow|workflow[\s\S]*direct/i),
    });
    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it.each([
    [[{ type: 'image', data: 'base64', mimeType: 'image/png' }]],
    [[{ type: 'audio', data: 'base64', mimeType: 'audio/wav' }]],
    [[{ type: 'resource', resource: { text: 'inline', uri: 'file:///repo/order.md' } }]],
  ] as const)('should reject unsupported ACP prompt block %o before conversation', async (prompt) => {
    const handleUserMessage = vi.fn();
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({ handleUserMessage })),
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await expect(agent.handleSessionPrompt({
      sessionId,
      prompt,
    })).rejects.toThrow(/Unsupported ACP prompt content block/i);
    expect(handleUserMessage).not.toHaveBeenCalled();
  });

  it.each([
    [[]],
    [[{ type: 'text', text: '   ' }]],
  ] as const)('should reject empty ACP prompt %o before conversation', async (prompt) => {
    const handleUserMessage = vi.fn();
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({ handleUserMessage })),
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await expect(agent.handleSessionPrompt({
      sessionId,
      prompt,
    })).rejects.toThrow(/prompt text is required/i);
    expect(handleUserMessage).not.toHaveBeenCalled();
  });

  it('should include ACP resource links in the conversation message', async () => {
    const handleUserMessage = vi.fn().mockResolvedValue({
      kind: 'assistant_response',
      content: 'I can read the referenced task.',
    });
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({ handleUserMessage })),
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await agent.handleSessionPrompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'Use this file.' },
        {
          type: 'resource_link',
          name: 'order.md',
          uri: 'file:///repo/order.md',
          description: 'Task order',
        },
      ],
    });

    expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: [
        'Use this file.',
        'Resource: order.md',
        'URI: file:///repo/order.md',
        'Description: Task order',
      ].join('\n'),
    }));
  });

  it('should accept a prompt made only from an ACP resource link', async () => {
    const handleUserMessage = vi.fn().mockResolvedValue({
      kind: 'assistant_response',
      content: 'I can inspect the resource.',
    });
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({ handleUserMessage })),
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await agent.handleSessionPrompt({
      sessionId,
      prompt: [
        {
          type: 'resource_link',
          name: 'order.md',
          uri: 'file:///repo/order.md',
        },
      ],
    });

    expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: [
        'Resource: order.md',
        'URI: file:///repo/order.md',
      ].join('\n'),
    }));
  });

  it('should abort an active conversation turn on session/cancel', async () => {
    let receivedSignal: AbortSignal | undefined;
    let resolveMessage: ((value: { kind: 'error'; message: string }) => void) | undefined;
    const handleUserMessage = vi.fn((input: { abortSignal?: AbortSignal }) => {
      receivedSignal = input.abortSignal;
      return new Promise((resolve) => {
        resolveMessage = resolve;
      });
    });
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({ handleUserMessage })),
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const promptPromise = agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: 'keep thinking' }],
    });
    await agent.handleSessionCancel({ sessionId });
    resolveMessage?.({ kind: 'error', message: 'cancelled' });
    const result = await promptPromise;

    expect(receivedSignal?.aborted).toBe(true);
    expect(result).toEqual({
      stopReason: 'cancelled',
    });
  });

  it('should carry idle session/cancel into the next prompt', async () => {
    let receivedSignal: AbortSignal | undefined;
    const handleUserMessage = vi.fn((input: { abortSignal?: AbortSignal }) => {
      receivedSignal = input.abortSignal;
      return Promise.resolve({
        kind: 'assistant_response' as const,
        content: 'ready',
      });
    });
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({ handleUserMessage })),
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await agent.handleSessionCancel({ sessionId });
    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(receivedSignal?.aborted).toBe(true);
    expect(result).toEqual({
      stopReason: 'cancelled',
    });
  });

  it('should return refusal for workflow failures not caused by session/cancel', async () => {
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'workflow_execution_requested',
          task: 'Implement ACP support',
        }),
      })),
      runWorkflowExecution: vi.fn().mockResolvedValue({
        success: false,
        reason: 'Step "draft" failed',
        reportDirectory: '/repo/.takt/runs/run-1/reports',
      }),
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/play Implement ACP support' }],
    });

    expect(result).toEqual({
      stopReason: 'refusal',
    });
  });

  it('should use the default workflow when the ACP conversation does not specify one', async () => {
    const runWorkflowExecution = vi.fn().mockResolvedValue({
      success: true,
      reportDirectory: '/repo/.takt/runs/run-1/reports',
    });
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'workflow_execution_requested',
          task: 'Implement ACP support',
          interactiveMetadata: {
            confirmed: true,
            task: 'Implement ACP support',
          },
        }),
      })),
      runWorkflowExecution,
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/play Implement ACP support' }],
    });

    expect(runWorkflowExecution).toHaveBeenCalledWith(expect.objectContaining({
      workflowIdentifier: 'default',
    }));
  });

  it('should return ACP elicitation answers to workflow AskUserQuestion', async () => {
    const sendSessionUpdate = vi.fn();
    const createElicitation = vi.fn().mockResolvedValue({
      action: 'accept',
      content: { answer: 'src/index.ts' },
    });
    const runWorkflowExecution = vi.fn(async (request) => {
      const answers = await request.onAskUserQuestion?.({
        questions: [{ question: 'Which file should be updated?' }],
      });
      expect(answers).toEqual({
        'Which file should be updated?': 'src/index.ts',
      });
      return {
        success: true,
        reportDirectory: '/repo/.takt/runs/run-1/reports',
      };
    });
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'workflow_execution_requested',
          task: 'Implement ACP support',
        }),
      })),
      runWorkflowExecution,
      sendSessionUpdate,
      createElicitation,
    });
    await agent.handleInitialize({
      protocolVersion: 1,
      clientCapabilities: {
        elicitation: {
          form: {},
        },
      },
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/play Implement ACP support' }],
    });

    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'workflow_event',
      event: {
        type: 'confirmation_requested',
        confirmationId: 'confirmation-1',
        message: 'Which file should be updated?',
      },
    });
    expect(createElicitation).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'form',
      sessionId,
      toolCallId: 'confirmation-1',
      message: 'Which file should be updated?',
    }));
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'workflow_event',
      event: {
        type: 'tool_completed',
        toolCallId: 'confirmation-1',
        message: 'Confirmation accepted',
        isError: false,
      },
    });
  });

  it('should request a free-text ACP elicitation schema for open questions', async () => {
    const request = await captureElicitationRequest({
      header: 'Target file',
      question: 'Which file should be updated?',
    }, 'src/index.ts');

    expect(request.requestedSchema).toEqual({
      type: 'object',
      required: ['answer'],
      properties: {
        answer: {
          type: 'string',
          title: 'Target file',
          minLength: 1,
        },
      },
    });
  });

  it('should request a single-select ACP elicitation schema for option questions', async () => {
    const request = await captureElicitationRequest({
      header: 'Mode',
      question: 'Choose a mode',
      options: [
        { label: 'fast', description: 'Prefer speed' },
        { label: 'safe' },
      ],
    }, 'fast');

    expect(request.requestedSchema).toEqual({
      type: 'object',
      required: ['answer'],
      properties: {
        answer: {
          type: 'string',
          title: 'Mode',
          oneOf: [
            { const: 'fast', title: 'fast - Prefer speed' },
            { const: 'safe', title: 'safe' },
          ],
        },
      },
    });
  });

  it('should request a multi-select ACP elicitation schema for multi option questions', async () => {
    const request = await captureElicitationRequest({
      header: 'Areas',
      question: 'Which areas should be reviewed?',
      multiSelect: true,
      options: [
        { label: 'frontend', description: 'UI and client behavior' },
        { label: 'backend' },
      ],
    }, ['frontend', 'backend']);

    expect(request.requestedSchema).toEqual({
      type: 'object',
      required: ['answer'],
      properties: {
        answer: {
          type: 'array',
          title: 'Areas',
          minItems: 1,
          items: {
            anyOf: [
              { const: 'frontend', title: 'frontend - UI and client behavior' },
              { const: 'backend', title: 'backend' },
            ],
          },
        },
      },
    });
  });

  it('should reject single-select ACP elicitation answers outside the advertised options', async () => {
    const sendSessionUpdate = vi.fn();
    const createElicitation = vi.fn().mockResolvedValue({
      action: 'accept',
      content: { answer: 'unsafe' },
    });
    const runWorkflowExecution = vi.fn(async (request) => {
      await expect(request.onAskUserQuestion?.({
        questions: [{
          question: 'Choose a mode',
          options: [{ label: 'safe' }],
        }],
      })).rejects.toThrow(/unsupported answer: unsafe/i);
      return {
        success: false,
        reason: 'invalid answer',
      };
    });
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'workflow_execution_requested',
          task: 'Implement ACP support',
        }),
      })),
      runWorkflowExecution,
      sendSessionUpdate,
      createElicitation,
    });
    await agent.handleInitialize({
      protocolVersion: 1,
      clientCapabilities: {
        elicitation: {
          form: {},
        },
      },
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/play Implement ACP support' }],
    });

    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'workflow_event',
      event: {
        type: 'tool_completed',
        toolCallId: 'confirmation-1',
        message: 'ACP elicitation response included unsupported answer: unsafe',
        isError: true,
      },
    });
  });

  it('should reject multi-select ACP elicitation answers outside the advertised options', async () => {
    const sendSessionUpdate = vi.fn();
    const createElicitation = vi.fn().mockResolvedValue({
      action: 'accept',
      content: { answer: ['safe', 'unsafe'] },
    });
    const runWorkflowExecution = vi.fn(async (request) => {
      await expect(request.onAskUserQuestion?.({
        questions: [{
          question: 'Choose areas',
          multiSelect: true,
          options: [{ label: 'safe' }],
        }],
      })).rejects.toThrow(/unsupported answer: unsafe/i);
      return {
        success: false,
        reason: 'invalid answer',
      };
    });
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'workflow_execution_requested',
          task: 'Implement ACP support',
        }),
      })),
      runWorkflowExecution,
      sendSessionUpdate,
      createElicitation,
    });
    await agent.handleInitialize({
      protocolVersion: 1,
      clientCapabilities: {
        elicitation: {
          form: {},
        },
      },
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/play Implement ACP support' }],
    });

    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'workflow_event',
      event: {
        type: 'tool_completed',
        toolCallId: 'confirmation-1',
        message: 'ACP elicitation response included unsupported answer: unsafe',
        isError: true,
      },
    });
  });

  it('should reject empty multi-select ACP elicitation answers', async () => {
    const sendSessionUpdate = vi.fn();
    const createElicitation = vi.fn().mockResolvedValue({
      action: 'accept',
      content: { answer: [] },
    });
    const runWorkflowExecution = vi.fn(async (request) => {
      await expect(request.onAskUserQuestion?.({
        questions: [{
          question: 'Choose areas',
          multiSelect: true,
          options: [{ label: 'safe' }],
        }],
      })).rejects.toThrow(/valid answer/i);
      return {
        success: false,
        reason: 'invalid answer',
      };
    });
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'workflow_execution_requested',
          task: 'Implement ACP support',
        }),
      })),
      runWorkflowExecution,
      sendSessionUpdate,
      createElicitation,
    });
    await agent.handleInitialize({
      protocolVersion: 1,
      clientCapabilities: {
        elicitation: {
          form: {},
        },
      },
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/play Implement ACP support' }],
    });

    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'workflow_event',
      event: {
        type: 'tool_completed',
        toolCallId: 'confirmation-1',
        message: 'ACP elicitation response did not include a valid answer',
        isError: true,
      },
    });
  });

  it('should cancel pending ACP elicitation without waiting for the client response', async () => {
    const sendSessionUpdate = vi.fn();
    let resolveWorkflowStarted: (() => void) | undefined;
    const workflowStarted = new Promise<void>((resolve) => {
      resolveWorkflowStarted = resolve;
    });
    const createElicitation = vi.fn(() => new Promise<never>(() => undefined));
    const runWorkflowExecution = vi.fn(async (request) => {
      const questionPromise = request.onAskUserQuestion?.({
        questions: [{ question: 'Proceed?' }],
      });
      resolveWorkflowStarted?.();
      await expect(questionPromise).rejects.toThrow(/confirmation cancelled/i);
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
        }),
      })),
      runWorkflowExecution,
      sendSessionUpdate,
      createElicitation,
    });
    await agent.handleInitialize({
      protocolVersion: 1,
      clientCapabilities: {
        elicitation: {
          form: {},
        },
      },
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const promptPromise = agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/play Implement ACP support' }],
    });
    await workflowStarted;
    await agent.handleSessionCancel({ sessionId });
    const result = await promptPromise;

    expect(result).toEqual({ stopReason: 'cancelled' });
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'workflow_event',
      event: {
        type: 'tool_completed',
        toolCallId: 'confirmation-1',
        message: 'ACP confirmation cancelled',
        isError: true,
      },
    });
  });

  it('should not create stale ACP elicitation when confirmation is already cancelled', async () => {
    const sendSessionUpdate = vi.fn();
    const createElicitation = vi.fn().mockResolvedValue({
      action: 'accept',
      content: { answer: 'yes' },
    });
    let resolveWorkflowStarted: (() => void) | undefined;
    let resolveAskAfterCancel: (() => void) | undefined;
    const workflowStarted = new Promise<void>((resolve) => {
      resolveWorkflowStarted = resolve;
    });
    const askAfterCancel = new Promise<void>((resolve) => {
      resolveAskAfterCancel = resolve;
    });
    const runWorkflowExecution = vi.fn(async (request) => {
      resolveWorkflowStarted?.();
      await askAfterCancel;
      await expect(request.onAskUserQuestion?.({
        questions: [{ question: 'Proceed?' }],
      })).rejects.toThrow(/confirmation cancelled/i);
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
        }),
      })),
      runWorkflowExecution,
      sendSessionUpdate,
      createElicitation,
    });
    await agent.handleInitialize({
      protocolVersion: 1,
      clientCapabilities: {
        elicitation: {
          form: {},
        },
      },
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const promptPromise = agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/play Implement ACP support' }],
    });
    await workflowStarted;
    await agent.handleSessionCancel({ sessionId });
    resolveAskAfterCancel?.();
    const result = await promptPromise;

    expect(result).toEqual({ stopReason: 'cancelled' });
    expect(createElicitation).not.toHaveBeenCalled();
    expect(sendSessionUpdate).not.toHaveBeenCalledWith(sessionId, expect.objectContaining({
      kind: 'workflow_event',
      event: expect.objectContaining({
        type: 'confirmation_requested',
      }),
    }));
  });

  it('should not create stale ACP elicitation when cancellation happens during confirmation update', async () => {
    let resolveConfirmationUpdateStarted: (() => void) | undefined;
    let releaseConfirmationUpdate: (() => void) | undefined;
    const confirmationUpdateStarted = new Promise<void>((resolve) => {
      resolveConfirmationUpdateStarted = resolve;
    });
    const confirmationUpdateReleased = new Promise<void>((resolve) => {
      releaseConfirmationUpdate = resolve;
    });
    const sendSessionUpdate = vi.fn(async (_sessionId, update) => {
      if (
        update.kind === 'workflow_event'
        && update.event.type === 'confirmation_requested'
      ) {
        resolveConfirmationUpdateStarted?.();
        await confirmationUpdateReleased;
      }
    });
    const createElicitation = vi.fn().mockResolvedValue({
      action: 'accept',
      content: { answer: 'yes' },
    });
    const runWorkflowExecution = vi.fn(async (request) => {
      await expect(request.onAskUserQuestion?.({
        questions: [{ question: 'Proceed?' }],
      })).rejects.toThrow(/confirmation cancelled/i);
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
        }),
      })),
      runWorkflowExecution,
      sendSessionUpdate,
      createElicitation,
    });
    await agent.handleInitialize({
      protocolVersion: 1,
      clientCapabilities: {
        elicitation: {
          form: {},
        },
      },
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const promptPromise = agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/play Implement ACP support' }],
    });
    await confirmationUpdateStarted;
    await agent.handleSessionCancel({ sessionId });
    releaseConfirmationUpdate?.();
    const result = await promptPromise;

    expect(result).toEqual({ stopReason: 'cancelled' });
    expect(createElicitation).not.toHaveBeenCalled();
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'workflow_event',
      event: {
        type: 'tool_completed',
        toolCallId: 'confirmation-1',
        message: 'ACP confirmation cancelled',
        isError: true,
      },
    });
  });

  it('should deny workflow AskUserQuestion when ACP elicitation is cancelled', async () => {
    const sendSessionUpdate = vi.fn();
    const createElicitation = vi.fn().mockResolvedValue({ action: 'cancel' });
    const runWorkflowExecution = vi.fn(async (request) => {
      await expect(request.onAskUserQuestion?.({
        questions: [{ question: 'Proceed?' }],
      })).rejects.toThrow(/AskUserQuestion is not available/i);
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
        }),
      })),
      runWorkflowExecution,
      sendSessionUpdate,
      createElicitation,
    });
    await agent.handleInitialize({
      protocolVersion: 1,
      clientCapabilities: {
        elicitation: {
          form: {},
        },
      },
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/play Implement ACP support' }],
    });

    expect(result.stopReason).toBe('refusal');
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'workflow_event',
      event: {
        type: 'tool_completed',
        toolCallId: 'confirmation-1',
        message: 'Confirmation cancel',
        isError: true,
      },
    });
  });

  it('should deny AskUserQuestion without sending elicitation when client lacks form capability', async () => {
    const sendSessionUpdate = vi.fn();
    const createElicitation = vi.fn();
    const runWorkflowExecution = vi.fn(async (request) => {
      await expect(request.onAskUserQuestion?.({
        questions: [{ question: 'Proceed?' }],
      })).rejects.toThrow(/AskUserQuestion is not available/i);
      return {
        success: false,
        reason: 'form elicitation unsupported',
      };
    });
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'workflow_execution_requested',
          task: 'Implement ACP support',
        }),
      })),
      runWorkflowExecution,
      sendSessionUpdate,
      createElicitation,
    });
    await agent.handleInitialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/play Implement ACP support' }],
    });

    expect(createElicitation).not.toHaveBeenCalled();
    expect(sendSessionUpdate).not.toHaveBeenCalledWith(sessionId, expect.objectContaining({
      kind: 'workflow_event',
      event: expect.objectContaining({
        type: 'confirmation_requested',
      }),
    }));
  });

  it('should convert workflow execution exceptions into ACP refusal updates', async () => {
    const sendSessionUpdate = vi.fn();
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'workflow_execution_requested',
          task: 'Implement ACP support',
          interactiveMetadata: {
            confirmed: true,
            task: 'Implement ACP support',
          },
        }),
      })),
      runWorkflowExecution: vi.fn().mockRejectedValue(new Error('Provider is not configured.')),
      sendSessionUpdate,
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());

    const result = await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/play Implement ACP support' }],
    });

    expect(result).toEqual({ stopReason: 'refusal' });
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'workflow_event',
      event: expect.objectContaining({
        type: 'completed',
        success: false,
        reason: 'Provider is not configured.',
      }),
    });
    expect(sendSessionUpdate).not.toHaveBeenCalledWith(sessionId, {
      kind: 'workflow_event',
      event: expect.objectContaining({
        type: 'completed',
        reportDirectory: '',
      }),
    });
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'workflow_event',
      event: {
        type: 'error',
        message: 'Workflow failed: Provider is not configured.',
      },
    });
    expect(sendSessionUpdate).toHaveBeenCalledWith(sessionId, {
      kind: 'agent_message',
      text: 'Workflow failed: Provider is not configured.',
    });
  });

  it('should clear cancellation state after an active workflow cancel before the next prompt', async () => {
    let workflowSignal: AbortSignal | undefined;
    let nextPromptSignal: AbortSignal | undefined;
    let resolveWorkflowStarted: (() => void) | undefined;
    const workflowStarted = new Promise<void>((resolve) => {
      resolveWorkflowStarted = resolve;
    });
    const handleUserMessage = vi.fn()
      .mockResolvedValueOnce({
        kind: 'workflow_execution_requested',
        task: 'Implement ACP support',
      })
      .mockImplementationOnce((input: { abortSignal?: AbortSignal }) => {
        nextPromptSignal = input.abortSignal;
        return Promise.resolve({
          kind: 'assistant_response',
          content: 'ready',
        });
      });
    const agent = createTaktAcpAgent({
      createConversationSession: vi.fn(() => ({ handleUserMessage })),
      runWorkflowExecution: vi.fn(async (request: { abortSignal: AbortSignal }) => {
        workflowSignal = request.abortSignal;
        resolveWorkflowStarted?.();
        await new Promise((resolve) => setTimeout(resolve, 1));
        return {
          success: false,
          reason: 'cancelled',
        };
      }),
      sendSessionUpdate: vi.fn(),
    });
    const { sessionId } = await agent.handleSessionNew(newSessionParams());
    const promptPromise = agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: '/play Implement ACP support' }],
    });

    await workflowStarted;
    await agent.handleSessionCancel({ sessionId });
    await promptPromise;
    await agent.handleSessionPrompt({
      sessionId,
      prompt: [{ type: 'text', text: 'hello again' }],
    });

    expect(workflowSignal?.aborted).toBe(true);
    expect(nextPromptSignal?.aborted).toBe(false);
  });
});
