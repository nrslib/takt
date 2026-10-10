import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationPlan } from '../features/interactive/conversationPlan.js';
import type { ConversationStrategy, SummaryPromptOptions } from '../features/interactive/conversationLoop.js';
import { makeSessionContext } from './test-helpers.js';
import { describeExecutionResult } from '../features/interactive/operationFeedback.js';

const doubles = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  info: vi.fn(),
  plan: vi.fn(),
  loop: vi.fn(),
  line: vi.fn(),
  ai: vi.fn(),
  tell: vi.fn(),
  retry: vi.fn(),
  formalSpec: vi.fn(),
}));
vi.mock('../features/interactive/lineEditor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/lineEditor.js')>()),
  readPipedLine: doubles.line,
}));
vi.mock('../features/interactive/aiCaller.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/aiCaller.js')>()),
  callAIWithRetry: doubles.ai,
}));
vi.mock('../features/interactive/tellCommand.js', () => ({ runTellCommand: doubles.tell }));
vi.mock('../features/interactive/assistantRetryCommand.js', () => ({ runAssistantRetryCommand: doubles.retry }));
vi.mock('../features/interactive/imageAttachments.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/imageAttachments.js')>()),
  createSessionImageAttachmentStore: () => ({ listAttachments: () => [], seal: vi.fn(), cleanup: vi.fn() }),
}));

vi.mock('../shared/utils/private-file.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/private-file.js')>()),
  readPrivateFileState: doubles.read,
  writePrivateFileWithModeExpected: doubles.write,
}));
vi.mock('../infra/config/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/paths.js')>()),
  ensureDir: vi.fn(),
}));
vi.mock('../shared/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/ui/index.js')>()),
  info: doubles.info,
}));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/index.js')>()),
  hasInteractiveTerminal: () => false,
}));
vi.mock('../features/interactive/conversationPlan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/conversationPlan.js')>()),
  createAssistantConversationPlan: doubles.plan,
}));
vi.mock('../features/interactive/conversationLoop.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/interactive/conversationLoop.js')>()),
  runConversationLoop: doubles.loop,
}));
vi.mock('../features/interactive/taskInstructionFormat.js', () => ({
  resolveFormalSpecConfiguration: doubles.formalSpec,
}));

import { interactiveMode } from '../features/interactive/interactive.js';

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.clearAllMocks();
  doubles.formalSpec.mockResolvedValue({ mode: false, comments: true, modelCheckTimeoutSeconds: 300 });
  doubles.loop.mockResolvedValue({ action: 'save_task', task: 'current task' });
  doubles.read.mockImplementation((path: string) => ({
    state: { path, exists: true },
    content: Buffer.from(JSON.stringify({
      version: 1, publicationId: 'unrelated-run', status: 'pending',
      state: { status: 'error', errorMessage: 'unrelated provider unavailable',
        workflowName: 'unrelated-workflow', timestamp: '2026-10-09T00:00:00.000Z' },
    })),
  }));
});

describe('readline operation feedback', () => {
  const strategy: ConversationStrategy = {
    systemPrompt: 'system', formalSpec: false, modelCheckTimeoutSeconds: 300,
    allowedTools: [], transformPrompt: (message) => message, introMessage: 'Ready',
    enableTellCommand: true, enableAssistantRetryCommands: true,
  };

  async function run(lines: string[], overrides: Partial<ConversationStrategy> = {}) {
    doubles.line.mockReset();
    for (const line of lines) doubles.line.mockResolvedValueOnce(line);
    doubles.line.mockResolvedValue(null);
    vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
    const actual = await vi.importActual<typeof import('../features/interactive/conversationLoop.js')>(
      '../features/interactive/conversationLoop.js',
    );
    return actual.runConversationLoop('/test-project', makeSessionContext(), { ...strategy, ...overrides }, undefined, undefined);
  }

  beforeEach(() => {
    doubles.ai.mockReset().mockResolvedValue({
      result: { success: true, content: 'Original proposal' }, sessionId: 'conversation-session',
    });
    doubles.tell.mockReset();
    doubles.retry.mockReset();
  });

  it.each([
    ['tell', 'Sent to running-login-fix (instruction #3).'],
    ['tell', 'Tell cancelled. No instruction was sent.'],
    ['tell', 'Tell target is stale: running-login-fix.'],
    ['tell', 'Tell generation failed: provider unavailable.'],
    ['retry', 'Task saved: retried-login-fix.'],
    ['retry', 'Retry cancelled. No task was changed.'],
    ['retry', 'Retry target is stale: failed-login-fix.'],
    ['retry', 'Retry generation failed: provider unavailable.'],
    ['requeue', 'Task requeued: failed-login-fix.'],
    ['requeue', 'Requeue cancelled. No task was changed.'],
    ['requeue', 'Requeue target is stale: failed-login-fix.'],
    ['requeue', 'Requeue failed: task storage unavailable.'],
  ])('should record the /%s result "%s" and send it with the next question', async (command, notice) => {
    const handler = command === 'tell' ? doubles.tell : doubles.retry;
    handler.mockResolvedValue(notice);
    const summary = vi.fn((_options: SummaryPromptOptions) => 'Summary prompt');

    await run(['Prepare a login fix', `/${command}`, 'どうなった？', '/go', '/cancel'], {
      summaryPromptBuilder: summary, selectGoAction: vi.fn().mockResolvedValue('continue'),
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(doubles.info).toHaveBeenCalledWith(notice);
    expect(doubles.ai.mock.calls[1]?.[0]).toContain(notice);
    expect(doubles.ai.mock.calls[1]?.[0]).toContain('どうなった？');
    expect(summary.mock.calls[0]?.[0].history.map((message) => message.content)).toContain(notice);
    expect(doubles.ai).toHaveBeenCalledTimes(3);
  });

  it.each(['tell', 'retry', 'requeue'])('should accept the original proposal after /%s reports an operation', async (command) => {
    (command === 'tell' ? doubles.tell : doubles.retry).mockResolvedValue('Operation completed for login-fix.');

    const result = await run(['Prepare a login fix', `/${command}`, '/accept']);

    expect(result).toMatchObject({ action: 'execute', task: 'Original proposal' });
    expect(doubles.ai).toHaveBeenCalledTimes(1);
  });

  it.each(['save_task', 'create_issue'] as const)('should continue the same conversation after a /go %s exception', async (action) => {
    const failure = new Error('Active task target already exists: login-fix');
    const dispatch = vi.fn().mockRejectedValue(failure);
    const summary = vi.fn((_options: SummaryPromptOptions) => 'Summary prompt');

    await run(['Prepare a login fix', '/go', '積まれた？', '/go', '/cancel'], {
      selectGoAction: vi.fn().mockResolvedValueOnce(action).mockResolvedValue('continue'),
      dispatch, summaryPromptBuilder: summary,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(doubles.line).toHaveBeenCalledTimes(5);
    expect(doubles.info).toHaveBeenCalledWith(expect.stringContaining(failure.message));
    expect(doubles.ai.mock.calls[2]?.[0]).toContain(failure.message);
    expect(doubles.ai.mock.calls[2]?.[0]).toContain('積まれた？');
    expect(summary.mock.calls[1]?.[0].history.map((message) => message.content).join('\n')).toContain(failure.message);
  });

  it.each([
    ['save_task', 'Task saved: actual-login-fix.'],
    ['create_issue', 'Issue #42 created. Task saved: actual-issue-fix.'],
    ['create_issue', 'Issue #42 created. No task was saved: disk full.'],
    ['execute', 'Execution finished.'],
    ['execute', describeExecutionResult({ success: false, reason: 'workflow aborted' }, 'en').notice],
    ['execute', describeExecutionResult({ success: false, reason: 'workflow not found' }, 'en').notice],
  ] as const)('should continue after /go %s and deliver "%s" with the next question', async (action, notice) => {
    const dispatch = vi.fn().mockResolvedValue({ kind: 'dispatched', notice });
    const selectGoAction = vi.fn().mockResolvedValueOnce(action).mockResolvedValue('continue');
    const summary = vi.fn((_options: SummaryPromptOptions) => 'Summary prompt');

    const result = await run(['Prepare a login fix', '/go', 'どうなった？', '/go', '/cancel'], {
      selectGoAction, dispatch, summaryPromptBuilder: summary,
    });

    expect(result).toMatchObject({ action: 'cancel' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(doubles.info).toHaveBeenCalledWith(notice);
    expect(doubles.ai.mock.calls[2]?.[0]).toContain(notice);
    expect(doubles.ai.mock.calls[2]?.[0]).toContain('どうなった？');
    expect(summary.mock.calls[1]?.[0].history.map((message) => message.content)).toContain(notice);
  });

  it('should report a cancelled /go save and read the next question without selecting again', async () => {
    const notice = 'Task saving cancelled. No task was saved.';
    const dispatch = vi.fn().mockResolvedValue({ kind: 'cancelled', notice });
    const selectGoAction = vi.fn().mockResolvedValueOnce('save_task').mockResolvedValue('continue');
    const summary = vi.fn((_options: SummaryPromptOptions) => 'Summary prompt');

    await run(['Prepare a login fix', '/go', '積まれた？', '/go', '/cancel'], {
      selectGoAction, dispatch, summaryPromptBuilder: summary,
    });

    expect(selectGoAction).toHaveBeenCalledTimes(2);
    expect(selectGoAction.mock.invocationCallOrder[1]).toBeGreaterThan(doubles.ai.mock.invocationCallOrder[2]!);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(doubles.info).toHaveBeenCalledWith(notice);
    expect(doubles.ai.mock.calls[2]?.[0]).toContain(notice);
    expect(doubles.ai.mock.calls[2]?.[0]).toContain('積まれた？');
    expect(summary.mock.calls[1]?.[0].history.map((message) => message.content)).toContain(notice);
  });
});

describe('readline interactive entry', () => {
  it.each(['en', 'ja'] as const)('should return the current task in %s without displaying or consuming another run', async (lang) => {
    const plan: ConversationPlan = {
      ctx: makeSessionContext({ lang }),
      strategy: {
        systemPrompt: 'test prompt', formalSpec: false, modelCheckTimeoutSeconds: 300,
        allowedTools: [], transformPrompt: (message) => message, introMessage: 'conversation ready',
      },
    };
    doubles.plan.mockReturnValue(plan);

    expect(await interactiveMode('/test-project')).toEqual({ action: 'save_task', task: 'current task' });

    expect(doubles.info).not.toHaveBeenCalled();
    expect(doubles.read.mock.calls.filter(([path]) => String(path).endsWith('/session-state.json'))).toEqual([]);
    expect(doubles.write.mock.calls.filter(([path]) => String(path).endsWith('/session-state.json'))).toEqual([]);
  });
});
