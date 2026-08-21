/**
 * Tests for the TUI session connection layer: the provider stays silent, the
 * React tree receives assistant text through the chunk sink, and every slash
 * command lands on the right outcome — locally or through the session.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantInteractiveMode, PermissionMode } from '../core/models/index.js';
import type { StreamCallback } from '../shared/types/provider.js';
import type { WorkflowContext } from '../features/interactive/interactive-summary-types.js';

const {
  mockCallAIWithRetry,
  mockInitializeSession,
  mockLoadTemplate,
  mockLoadAssistantInitContext,
} = vi.hoisted(() => ({
  mockCallAIWithRetry: vi.fn(),
  mockInitializeSession: vi.fn(),
  mockLoadTemplate: vi.fn(),
  mockLoadAssistantInitContext: vi.fn(),
}));

vi.mock('../features/interactive/aiCaller.js', () => ({
  callAIWithRetry: (...args: unknown[]) => mockCallAIWithRetry(...args),
}));

vi.mock('../features/interactive/sessionInitialization.js', () => ({
  initializeSession: (...args: unknown[]) => mockInitializeSession(...args),
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: (...args: unknown[]) => mockLoadTemplate(...args),
}));

vi.mock('../features/interactive/assistantInitFiles.js', () => ({
  loadAssistantInitContext: (...args: unknown[]) => mockLoadAssistantInitContext(...args),
}));

import {
  createAssistantConversationPlan,
  type ConversationPlan,
} from '../features/interactive/conversationPlan.js';
import { createSessionImageAttachmentStore } from '../features/interactive/imageAttachments.js';
import {
  createTuiConversation,
  type TuiConversation,
  type TuiConversationOptions,
} from '../features/tui/tuiConversation.js';

interface CallAIOptions {
  outputMode?: 'terminal' | 'silent';
  onStream?: StreamCallback;
  persistSession?: boolean;
  permissionMode?: PermissionMode;
}

const WORKFLOW_CONTEXT: WorkflowContext = {
  name: 'default',
  description: 'default workflow',
  workflowStructure: '1. plan',
};

function lastCallOptions(): CallAIOptions {
  const call = mockCallAIWithRetry.mock.calls.at(-1);
  if (!call) {
    throw new Error('callAIWithRetry was not called');
  }
  return call[5] as CallAIOptions;
}

function lastCallAllowedTools(): string[] {
  const call = mockCallAIWithRetry.mock.calls.at(-1);
  if (!call) {
    throw new Error('callAIWithRetry was not called');
  }
  return call[2] as string[];
}

function summaryTemplateVars(): Record<string, unknown> {
  const call = mockLoadTemplate.mock.calls.find((args) => args[0] === 'score_summary_system_prompt');
  if (!call) {
    throw new Error('summary prompt template was not rendered');
  }
  return call[2] as Record<string, unknown>;
}

function createPlan(assistantMode: AssistantInteractiveMode = 'assistant'): ConversationPlan {
  return createAssistantConversationPlan('/repo', {
    assistantMode,
    workflowContext: WORKFLOW_CONTEXT,
  });
}

function createConversation(overrides?: Partial<TuiConversationOptions>): TuiConversation {
  return createTuiConversation({
    cwd: '/repo',
    plan: createPlan(),
    workflowContext: WORKFLOW_CONTEXT,
    attachmentStore: createSessionImageAttachmentStore(),
    ...overrides,
  });
}

function send(conversation: TuiConversation, text: string, chunks: string[]) {
  return conversation.submit({
    text,
    abortSignal: new AbortController().signal,
    onAssistantChunk: (chunk) => chunks.push(chunk),
  });
}

async function submit(text: string, chunks: string[], overrides?: Partial<TuiConversationOptions>) {
  return send(createConversation(overrides), text, chunks);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInitializeSession.mockReturnValue({
    provider: { setup: vi.fn(), getRuntimeInstructions: vi.fn(() => null) },
    providerType: 'mock',
    model: 'mock-model',
    lang: 'en',
    personaName: 'interactive',
    sessionId: undefined,
  });
  mockLoadTemplate.mockReturnValue('rendered template');
  mockLoadAssistantInitContext.mockReturnValue(undefined);
  mockCallAIWithRetry.mockImplementation((...args: unknown[]) => {
    const options = args[5] as CallAIOptions;
    options.onStream?.({ type: 'text', data: { text: 'chunk-1' } });
    options.onStream?.({ type: 'thinking', data: { thinking: 'ignored' } });
    options.onStream?.({ type: 'text', data: { text: 'chunk-2' } });
    return Promise.resolve({
      result: { content: 'Assistant answer', sessionId: 'session-1', success: true },
      sessionId: 'session-1',
    });
  });
});

describe('TUI conversation layer', () => {
  it('should run the provider in silent mode and forward text chunks to the caller', async () => {
    const chunks: string[] = [];

    const outcome = await submit('hello', chunks);

    expect(outcome).toEqual({ kind: 'assistant_response', content: 'Assistant answer' });
    expect(chunks).toEqual(['chunk-1', 'chunk-2']);
    expect(lastCallOptions().outputMode).toBe('silent');
  });

  it('should stop forwarding chunks once the submission settled', async () => {
    const chunks: string[] = [];
    let captured: StreamCallback | undefined;
    mockCallAIWithRetry.mockImplementationOnce((...args: unknown[]) => {
      captured = (args[5] as CallAIOptions).onStream;
      return Promise.resolve({
        result: { content: 'done', sessionId: undefined, success: true },
        sessionId: undefined,
      });
    });

    await submit('hello', chunks);
    captured?.({ type: 'text', data: { text: 'late chunk' } });

    expect(chunks).toEqual([]);
  });

  it('should turn /go into a task instruction built from the summary call', async () => {
    const conversation = createConversation();
    const chunks: string[] = [];
    await send(conversation, 'add a login page', chunks);
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'Task instruction', sessionId: 'session-2', success: true },
      sessionId: 'session-2',
    });

    const outcome = await send(conversation, '/go', chunks);

    expect(outcome).toEqual({ kind: 'task_instruction', task: 'Task instruction' });
  });

  it('should report /go without any conversation as a localized error', async () => {
    const chunks: string[] = [];

    const outcome = await submit('/go', chunks);

    expect(outcome).toEqual({
      kind: 'error',
      message: 'No conversation yet. Describe your task first.',
    });
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
  });

  it('should summarize a seeded task message when /go is the first input', async () => {
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'Task instruction', sessionId: undefined, success: true },
      sessionId: undefined,
    });
    const chunks: string[] = [];

    const outcome = await submit('/go', chunks, { userMessage: 'ship the login page' });

    expect(outcome).toEqual({ kind: 'task_instruction', task: 'Task instruction' });
    expect(summaryTemplateVars().conversation).toContain('ship the login page');
  });

  it('should summarize the source context when /go is the first input', async () => {
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'Task instruction', sessionId: undefined, success: true },
      sessionId: undefined,
    });
    const chunks: string[] = [];

    const outcome = await submit('/go', chunks, { sourceContext: 'Issue #12 body' });

    expect(outcome).toEqual({ kind: 'task_instruction', task: 'Task instruction' });
    expect(summaryTemplateVars().sourceContext).toContain('Issue #12 body');
  });

  it('should carry the workflow context into the summary prompt', async () => {
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'Task instruction', sessionId: undefined, success: true },
      sessionId: undefined,
    });
    const chunks: string[] = [];

    await submit('/go', chunks, { userMessage: 'ship the login page' });

    expect(summaryTemplateVars()).toMatchObject({
      hasWorkflowPreview: true,
      workflowName: 'default',
      workflowDescription: 'default workflow',
    });
  });

  it('should build a task instruction directly, skipping the chat turn', async () => {
    const conversation = createConversation({ userMessage: 'ship the login page' });
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'Task instruction', sessionId: undefined, success: true },
      sessionId: undefined,
    });
    const chunks: string[] = [];

    const outcome = await conversation.createInstruction({
      text: 'keep it small',
      abortSignal: new AbortController().signal,
      onAssistantChunk: (chunk) => chunks.push(chunk),
    });

    expect(outcome).toEqual({ kind: 'task_instruction', task: 'Task instruction' });
    expect(summaryTemplateVars().conversation).toContain('keep it small');
  });

  it('should localize a fixed session failure', async () => {
    mockCallAIWithRetry.mockResolvedValueOnce({ result: null, sessionId: undefined });
    const chunks: string[] = [];

    const outcome = await submit('hello', chunks);

    expect(outcome).toEqual({
      kind: 'error',
      message: 'The assistant returned no response.',
    });
  });

  it('should surface provider failure text unchanged', async () => {
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'rate limit reached', sessionId: undefined, success: false },
      sessionId: undefined,
    });
    const chunks: string[] = [];

    const outcome = await submit('hello', chunks);

    expect(outcome).toEqual({ kind: 'error', message: 'rate limit reached' });
  });

  it('should carry the Grill Me read-only permission mode into the provider call', async () => {
    const chunks: string[] = [];
    const grillMe = createConversation({ plan: createPlan('grill-me') });

    await send(grillMe, 'hello', chunks);

    expect(lastCallOptions().permissionMode).toBe('readonly');
    expect(lastCallAllowedTools()).not.toContain('Bash');

    await submit('hello', chunks);

    expect(lastCallOptions().permissionMode).toBeUndefined();
    expect(lastCallAllowedTools()).toContain('Bash');
  });
});

describe('TUI local commands', () => {
  it('should resolve /cancel locally and defer /go and plain text to the session', () => {
    const conversation = createConversation();

    expect(conversation.resolveLocalCommand('/cancel')).toEqual({ kind: 'cancel' });
    expect(conversation.resolveLocalCommand('  /cancel  ')).toEqual({ kind: 'cancel' });
    expect(conversation.resolveLocalCommand('/go')).toBeNull();
    expect(conversation.resolveLocalCommand('hello')).toBeNull();
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
  });

  it('should turn an inline /play command into an execute command', () => {
    const conversation = createConversation();

    expect(conversation.resolveLocalCommand('/play ship the feature')).toEqual({
      kind: 'execute',
      task: 'ship the feature',
    });
    expect(conversation.resolveLocalCommand('/play')).toEqual({
      kind: 'notice',
      message: 'Please specify task content: /play <task>',
    });
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
  });

  it('should summarize a resumed session that has no local transcript yet', async () => {
    mockInitializeSession.mockReturnValue({
      provider: { setup: vi.fn(), getRuntimeInstructions: vi.fn(() => null) },
      providerType: 'mock',
      model: 'mock-model',
      lang: 'en',
      personaName: 'interactive',
      sessionId: 'resumed-session',
    });
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'Task instruction', sessionId: 'resumed-session', success: true },
      sessionId: 'resumed-session',
    });
    const chunks: string[] = [];

    const outcome = await submit('/go', chunks);

    expect(outcome).toEqual({ kind: 'task_instruction', task: 'Task instruction' });
    expect(summaryTemplateVars().conversation).toContain('No local transcript');
  });

  it('should report /replay and /retry as unavailable, matching the readline loop', () => {
    const conversation = createConversation();

    expect(conversation.resolveLocalCommand('/replay')).toEqual({
      kind: 'notice',
      message: 'Previous order (order.md) not found',
    });
    expect(conversation.resolveLocalCommand('/retry')).toEqual({
      kind: 'notice',
      message: '/retry is only available in Retry mode from `takt list`.',
    });
    expect(conversation.commandAvailability).toEqual({
      enableRetryCommand: false,
      hasPreviousOrder: false,
    });
  });

  it('should hand /resume and /paste-image back to the caller', () => {
    const conversation = createConversation();

    expect(conversation.resolveLocalCommand('/resume')).toEqual({ kind: 'resume_session' });
    expect(conversation.resolveLocalCommand('/paste-image')).toEqual({ kind: 'paste_image' });
  });

  it('should accept the latest assistant response only after one exists', async () => {
    const conversation = createConversation();

    expect(conversation.resolveLocalCommand('/accept')).toEqual({
      kind: 'notice',
      message: 'No assistant response found. Please describe your task first.',
    });

    await send(conversation, 'hello', []);

    expect(conversation.resolveLocalCommand('/accept')).toEqual({
      kind: 'execute',
      task: 'Assistant answer',
    });
  });
});
