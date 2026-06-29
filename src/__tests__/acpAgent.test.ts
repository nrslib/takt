import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk';
import type { AskUserQuestionInput } from '../core/workflow/types.js';

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

import { createTaktAcpAgent, mapTaktAcpUpdateToSessionUpdate } from '../app/acp/agent.js';

function newSessionParams(overrides: Record<string, unknown> = {}) {
  return {
    cwd: '/repo',
    mcpServers: [],
    ...overrides,
  };
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

  it('should reject session/new when mcpServers is missing', async () => {
    const createConversationSession = vi.fn();
    const agent = createTaktAcpAgent({
      createConversationSession,
      runWorkflowExecution: vi.fn(),
      sendSessionUpdate: vi.fn(),
    });

    await expect(agent.handleSessionNew({
      cwd: '/repo',
    })).rejects.toThrow(/mcpServers is required/i);
    expect(createConversationSession).not.toHaveBeenCalled();
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

  it('should reject relative additionalDirectories before session creation', async () => {
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
    })).rejects.toThrow(/additionalDirectories must be an absolute path/i);
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
        command: 'docs-mcp',
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

  it('should not carry session/cancel into the next prompt when no turn is active', async () => {
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

    expect(receivedSignal?.aborted).toBe(false);
    expect(result).toEqual({
      stopReason: 'end_turn',
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
