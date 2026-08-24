/**
 * Tests for the TUI session connection layer: the provider stays silent, the
 * React tree receives assistant text through the chunk sink, and every slash
 * command lands on the right outcome — locally or through the session.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantInteractiveMode, PermissionMode } from '../core/models/index.js';
import { SlashCommand } from '../shared/constants.js';
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

function lastCallSystemPrompt(): string {
  const call = mockCallAIWithRetry.mock.calls.at(-1);
  if (!call) {
    throw new Error('callAIWithRetry was not called');
  }
  return call[1] as string;
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
    attachmentStore: createSessionImageAttachmentStore('/repo'),
    enableSettingsCommands: true,
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

    expect(outcome).toMatchObject({ kind: 'assistant_response', content: 'Assistant answer' });
    expect(chunks).toEqual(['chunk-1', 'chunk-2']);
    expect(lastCallOptions().outputMode).toBe('silent');
  });

  it('should forward disabled session persistence to the real session factory', async () => {
    const conversation = createConversation({ persistSession: false });

    await send(conversation, 'use the temporary provider', []);

    expect(lastCallOptions().persistSession).toBe(false);
  });

  it('should forward handoff history through the real session factory only once', async () => {
    const conversation = createConversation({
      handoffHistory: [
        { role: 'user', content: 'distinct prior request' },
        { role: 'assistant', content: 'distinct prior answer' },
      ],
    });

    await send(conversation, 'first new message', []);
    await send(conversation, 'second new message', []);

    const firstPrompt = String(mockCallAIWithRetry.mock.calls[0]?.[0]);
    const secondPrompt = String(mockCallAIWithRetry.mock.calls[1]?.[0]);
    expect(firstPrompt).toContain('User: distinct prior request');
    expect(firstPrompt).toContain('Assistant: distinct prior answer');
    expect(secondPrompt).not.toContain('User: distinct prior request');
    expect(secondPrompt).not.toContain('Assistant: distinct prior answer');
    expect(conversation.snapshotHistory?.()).toEqual([
      { role: 'user', content: 'distinct prior request' },
      { role: 'assistant', content: 'distinct prior answer' },
      { role: 'user', content: 'first new message' },
      { role: 'assistant', content: 'Assistant answer' },
      { role: 'user', content: 'second new message' },
      { role: 'assistant', content: 'Assistant answer' },
    ]);
  });

  it('should pass pending handoff history on a manual retry after a provider failure', async () => {
    const handoffHistory = [
      { role: 'user' as const, content: 'distinct prior request' },
      { role: 'assistant' as const, content: 'distinct prior answer' },
    ];
    const conversation = createConversation({ handoffHistory });
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'unsupported model', sessionId: undefined, success: false },
      sessionId: undefined,
    });
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'recovered answer', sessionId: 'session-2', success: true },
      sessionId: 'session-2',
    });

    const failed = await send(conversation, 'retry this', []);
    const recovered = await send(conversation, 'retry this manually', []);

    expect(failed).toMatchObject({ kind: 'error', message: 'unsupported model' });
    expect(recovered).toMatchObject({ kind: 'assistant_response', content: 'recovered answer' });
    const retryPrompt = String(mockCallAIWithRetry.mock.calls[1]?.[0]);
    expect(retryPrompt).toContain('User: distinct prior request');
    expect(retryPrompt).toContain('Assistant: distinct prior answer');
    expect(conversation.snapshotHistory?.()).toEqual([
      ...handoffHistory,
      { role: 'user', content: 'retry this manually' },
      { role: 'assistant', content: 'recovered answer' },
    ]);
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

    expect(outcome).toMatchObject({ kind: 'task_instruction', task: 'Task instruction' });
  });

  it('should report /go without any conversation as a localized error', async () => {
    const chunks: string[] = [];

    const outcome = await submit('/go', chunks);

    expect(outcome).toMatchObject({
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

    expect(outcome).toMatchObject({ kind: 'task_instruction', task: 'Task instruction' });
    expect(summaryTemplateVars().conversation).toContain('ship the login page');
  });

  it('should summarize the source context when /go is the first input', async () => {
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'Task instruction', sessionId: undefined, success: true },
      sessionId: undefined,
    });
    const chunks: string[] = [];

    const outcome = await submit('/go', chunks, { sourceContext: 'Issue #12 body' });

    expect(outcome).toMatchObject({ kind: 'task_instruction', task: 'Task instruction' });
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

    expect(outcome).toMatchObject({ kind: 'task_instruction', task: 'Task instruction' });
    expect(summaryTemplateVars().conversation).toContain('keep it small');
  });

  it('should localize a fixed session failure', async () => {
    mockCallAIWithRetry.mockResolvedValueOnce({ result: null, sessionId: undefined });
    const chunks: string[] = [];

    const outcome = await submit('hello', chunks);

    expect(outcome).toMatchObject({
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

    expect(outcome).toMatchObject({ kind: 'error', message: 'rate limit reached' });
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

describe('chunks from a turn the user left behind', () => {
  it('should not draw them into the turn that followed', async () => {
    let releaseFirst!: (content: string) => void;
    let firstStream: ((event: { type: string; data: { text: string } }) => void) | undefined;
    mockCallAIWithRetry.mockImplementationOnce((...args: unknown[]) => {
      const options = args[5] as { onStream?: (event: unknown) => void };
      firstStream = options.onStream as never;
      return new Promise((resolve) => {
        releaseFirst = (content: string) => resolve({
          result: { content, sessionId: 'session-1', success: true },
          sessionId: 'session-1',
        });
      });
    });
    const conversation = createConversation();

    const firstChunks: string[] = [];
    const first = conversation.submit({
      text: 'first question',
      abortSignal: new AbortController().signal,
      onAssistantChunk: (chunk) => firstChunks.push(chunk),
    });
    firstStream?.({ type: 'text', data: { text: 'from the first turn' } });
    expect(firstChunks).toEqual(['from the first turn']);

    // The user interrupts and asks something else; the old call answers anyway.
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'second answer', sessionId: 'session-1', success: true },
      sessionId: 'session-1',
    });
    const secondChunks: string[] = [];
    const second = conversation.submit({
      text: 'second question',
      abortSignal: new AbortController().signal,
      onAssistantChunk: (chunk) => secondChunks.push(chunk),
    });
    firstStream?.({ type: 'text', data: { text: 'late chunk' } });

    expect(secondChunks, 'a chunk from the abandoned turn must not be drawn').toEqual([]);

    releaseFirst('first answer');
    await first;
    await second;
  });
});

describe('notices from a turn the user left behind', () => {
  it('should not attach them to the turn that followed', async () => {
    let releaseFirst!: (content: string) => void;
    let firstNotice: ((message: string) => void) | undefined;
    mockCallAIWithRetry.mockImplementationOnce((...args: unknown[]) => {
      const options = args[5] as { onNotice?: (message: string) => void };
      firstNotice = options.onNotice;
      return new Promise((resolve) => {
        releaseFirst = (content: string) => resolve({
          result: { content, sessionId: undefined, success: true },
          sessionId: undefined,
        });
      });
    });
    const conversation = createConversation();

    const first = conversation.submit({
      text: 'first question',
      abortSignal: new AbortController().signal,
      onAssistantChunk: vi.fn(),
    });

    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'second answer', sessionId: undefined, success: true },
      sessionId: undefined,
    });
    const second = conversation.submit({
      text: 'second question',
      abortSignal: new AbortController().signal,
      onAssistantChunk: vi.fn(),
    });
    // The abandoned call reports something after the next turn already started.
    firstNotice?.('images went as paths');

    expect(await second).toMatchObject({ kind: 'assistant_response', notices: [] });

    releaseFirst('first answer');
    await first;
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

  it.each([
    ['/workflow', { kind: 'handoff', id: 'workflow' }],
    ['/mode', { kind: 'handoff', id: 'mode' }],
    ['/provider', { kind: 'handoff', id: 'provider' }],
    ['/model custom-model', { kind: 'handoff', id: 'model', text: 'custom-model' }],
    ['/effort custom-effort', { kind: 'handoff', id: 'effort', text: 'custom-effort' }],
  ])('should hand the setting command %s to the TUI runner without calling AI', (input, expected) => {
    const conversation = createConversation();

    expect(conversation.resolveLocalCommand(input)).toEqual(expected);
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
  });

  it.each([
    '/workflow default',
    '/mode persona',
    '/model',
    '/effort',
  ])('should reject invalid setting command syntax locally: %s', (input) => {
    const conversation = createConversation();

    expect(conversation.resolveLocalCommand(input)).toEqual({
      kind: 'notice',
      message: expect.any(String),
    });
    expect(mockCallAIWithRetry).not.toHaveBeenCalled();
  });

  it.each([
    'please use /workflow later',
    '`/mode`',
    '> /workflow',
    '```text\n/mode\n```',
    '```text\n/workflow',
  ])('should send non-command text containing a setting command to the provider: %s', async (input) => {
    const conversation = createConversation();

    expect(conversation.resolveLocalCommand(input)).toBeNull();
    await send(conversation, input, []);

    expect(mockCallAIWithRetry).toHaveBeenCalledTimes(1);
  });

  it('should remain usable for a manual resend after a provider error', async () => {
    const conversation = createConversation();
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'unsupported model', success: false },
      sessionId: 'session-existing',
    });

    const failed = await send(conversation, 'send once', []);

    expect(failed).toEqual({
      kind: 'error',
      message: 'unsupported model',
      notices: [],
    });
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'manual retry succeeded', success: true },
      sessionId: 'session-existing',
    });
    const retried = await send(conversation, 'send once', []);

    expect(retried).toMatchObject({
      kind: 'assistant_response',
      content: 'manual retry succeeded',
    });
    expect(mockCallAIWithRetry).toHaveBeenCalledTimes(2);
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

    expect(outcome).toMatchObject({ kind: 'task_instruction', task: 'Task instruction' });
    expect(summaryTemplateVars().conversation).toContain('No local transcript');
  });

  it('should re-resolve formal specification mode and apply it after /resume', async () => {
    const plan = createPlan();
    const resolveResumedSessionConfiguration = vi.fn().mockResolvedValue({
      systemPrompt: 'resumed system prompt',
      formalSpec: true,
    });
    const conversation = createConversation({
      plan: {
        ...plan,
        strategy: {
          ...plan.strategy,
          systemPrompt: 'initial system prompt',
          formalSpec: false,
          resolveResumedSessionConfiguration,
        },
      },
    });
    const chunks: string[] = [];

    await conversation.resumeSession('resumed-session');
    expect(resolveResumedSessionConfiguration).toHaveBeenCalledOnce();

    await send(conversation, 'continue the task', chunks);
    const regularCall = mockCallAIWithRetry.mock.calls.at(-1);
    expect(lastCallSystemPrompt()).toBe('resumed system prompt');
    expect(regularCall?.[4]).toMatchObject({ sessionId: 'resumed-session' });

    await send(conversation, '/go', chunks);
    expect(mockLoadTemplate).toHaveBeenCalledWith('score_summary_formal_spec_instructions', 'en');
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
      enableSettingsCommands: true,
    });
  });

  it('should treat an empty previous order as no order, like the readline loop', () => {
    const plan = createPlan();
    const conversation = createTuiConversation({
      cwd: '/repo',
      plan: {
        ...plan,
        strategy: { ...plan.strategy, previousOrderContent: '', enableRetryCommand: true },
      },
      attachmentStore: createSessionImageAttachmentStore('/repo'),
    });

    expect(conversation.resolveLocalCommand('/replay')).toEqual({
      kind: 'notice',
      message: 'Previous order (order.md) not found',
    });
    expect(conversation.resolveLocalCommand('/retry')).toEqual({
      kind: 'notice',
      message: 'No previous order (order.md) found. /retry is only available during retry.',
    });
    expect(conversation.commandAvailability).toEqual({
      enableRetryCommand: true,
      hasPreviousOrder: false,
    });
  });

  it('should resubmit a previous order that has content', () => {
    const plan = createPlan();
    const conversation = createTuiConversation({
      cwd: '/repo',
      plan: {
        ...plan,
        strategy: {
          ...plan.strategy,
          previousOrderContent: '# Previous order',
          enableRetryCommand: true,
        },
      },
      attachmentStore: createSessionImageAttachmentStore('/repo'),
    });

    expect(conversation.resolveLocalCommand('/replay'))
      .toEqual({ kind: 'execute', task: '# Previous order', origin: 'replay' });
    expect(conversation.resolveLocalCommand('/retry'))
      .toEqual({ kind: 'choose_action', task: '# Previous order', origin: 'retry' });
    expect(conversation.commandAvailability).toEqual({
      enableRetryCommand: true,
      hasPreviousOrder: true,
    });
  });

  it('should build /go from the mode prompt builder and mark where the task came from', async () => {
    // Retry and Instruct revise the task's order.md instead of writing a new
    // instruction, and they record that the task came from `/go` so the caller
    // knows to persist the revision.
    const plan = createPlan();
    const summaryPromptBuilder = vi.fn(() => 'revise this order');
    const conversation = createTuiConversation({
      cwd: '/repo',
      plan: {
        ...plan,
        strategy: { ...plan.strategy, summaryPromptBuilder, trackResultSource: true },
      },
      attachmentStore: createSessionImageAttachmentStore('/repo'),
    });

    await send(conversation, 'describe the change', []);
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'Revised order', sessionId: undefined, success: true },
      sessionId: undefined,
    });
    const outcome = await send(conversation, '/go', []);

    expect(summaryPromptBuilder).toHaveBeenCalledWith(expect.objectContaining({
      history: [
        { role: 'user', content: 'describe the change' },
        { role: 'assistant', content: 'Assistant answer' },
      ],
      userNote: '',
      lang: 'en',
    }));
    expect(mockCallAIWithRetry.mock.calls.at(-1)?.[0]).toBe('revise this order');
    expect(outcome).toEqual({
      kind: 'task_instruction',
      task: 'Revised order',
      origin: 'go',
      notices: [],
    });
  });

  it('should say a task came from /go even where the mode does not publish it', async () => {
    const conversation = createConversation();

    await send(conversation, 'describe the change', []);
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'Task instruction', sessionId: undefined, success: true },
      sessionId: undefined,
    });

    // The origin decides which selector runs and what a rejected draft means, so
    // it travels with every task; only publishing it on the result is optional.
    expect(await send(conversation, '/go', []))
      .toEqual({ kind: 'task_instruction', task: 'Task instruction', origin: 'go', notices: [] });
    expect(conversation.tracksResultSource).toBe(false);
  });

  it('should put a rejected /go draft back into the conversation', async () => {
    const plan = createPlan();
    const summaryPromptBuilder = vi.fn(() => 'revise this order');
    const conversation = createTuiConversation({
      cwd: '/repo',
      plan: { ...plan, strategy: { ...plan.strategy, summaryPromptBuilder } },
      attachmentStore: createSessionImageAttachmentStore('/repo'),
    });

    conversation.recordRejectedDraft?.('rejected draft');
    mockCallAIWithRetry.mockResolvedValueOnce({
      result: { content: 'Second order', sessionId: undefined, success: true },
      sessionId: undefined,
    });
    await send(conversation, '/go', []);

    // The next revision starts from what was proposed, not from nothing.
    expect(summaryPromptBuilder).toHaveBeenLastCalledWith(expect.objectContaining({
      history: [{ role: 'assistant', content: 'rejected draft' }],
    }));
  });

  it('should refuse the commands a guarded mode did not enable', () => {
    const plan = createPlan();
    const conversation = createTuiConversation({
      cwd: '/repo',
      plan: {
        ...plan,
        strategy: {
          ...plan.strategy,
          previousOrderContent: 'previous order',
          trackResultSource: true,
          enabledCommands: [
            SlashCommand.Go,
            SlashCommand.Replay,
            SlashCommand.Cancel,
            SlashCommand.Resume,
            SlashCommand.PasteImage,
          ],
        },
      },
      attachmentStore: createSessionImageAttachmentStore('/repo'),
    });

    // Not on the mode's list: the line is text, exactly as the readline loop
    // treats it once `enabledCommands` is set.
    expect(conversation.isCommandLine('/accept')).toBe(false);
    expect(conversation.resolveLocalCommand('/accept')).toBeNull();
    expect(conversation.isCommandLine('/replay')).toBe(true);
    expect(conversation.resolveLocalCommand('/replay'))
      .toEqual({ kind: 'execute', task: 'previous order', origin: 'replay' });
    expect(conversation.tracksResultSource).toBe(true);
  });

  it('should send a command the mode disabled to the provider as text', async () => {
    const plan = createPlan();
    const conversation = createTuiConversation({
      cwd: '/repo',
      plan: {
        ...plan,
        strategy: {
          ...plan.strategy,
          enabledCommands: [SlashCommand.Go, SlashCommand.Cancel],
        },
      },
      attachmentStore: createSessionImageAttachmentStore('/repo'),
    });

    const outcome = await send(conversation, '/accept', []);

    // The session reads the same allow-list as the front-end, so a line the mode
    // disabled is not re-read as a command it happens to understand.
    expect(outcome).toMatchObject({ kind: 'assistant_response' });
    expect(mockCallAIWithRetry.mock.calls.at(-1)?.[0]).toContain('/accept');
  });

  it('should send /retry through the mode selector with its own source', () => {
    const plan = createPlan();
    const conversation = createTuiConversation({
      cwd: '/repo',
      plan: {
        ...plan,
        strategy: {
          ...plan.strategy,
          enableRetryCommand: true,
          previousOrderContent: 'previous order',
          trackResultSource: true,
        },
      },
      attachmentStore: createSessionImageAttachmentStore('/repo'),
    });

    expect(conversation.resolveLocalCommand('/retry'))
      .toEqual({ kind: 'choose_action', task: 'previous order', origin: 'retry' });
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
      origin: 'accept',
    });
  });
});
