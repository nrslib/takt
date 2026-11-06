import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTuiConversation, type TuiConversationRunOptions } from '../features/tui/conversationRunner.js';
import { createTuiConversation } from '../features/tui/tuiConversation.js';
import { createExecTuiConversation } from '../features/exec/tuiConversation.js';
import type { ConversationViewProps } from '../features/tui/ConversationView.js';
import { makeProvider, makeSessionContext } from './test-helpers.js';
import { ManagedProviderInstallRequiredError } from '../infra/managed-providers/loader.js';
import { callAIWithRetry } from '../features/interactive/aiCaller.js';

const mocks = vi.hoisted(() => ({
  mount: vi.fn(), inspect: vi.fn(), install: vi.fn(), warn: vi.fn(), confirm: vi.fn(), selectSession: vi.fn(),
}));
vi.mock('../features/interactive/sessionSelector.js', () => ({ selectRecentSession: mocks.selectSession }));
vi.mock('../features/tui/inkMount.js', () => ({ mountInk: mocks.mount }));
vi.mock('../features/tui/terminalColors.js', () => ({
  resolveUserMessageColors: async () => ({ colors: { background: '#000000', foreground: '#ffffff' } }),
}));
vi.mock('../infra/managed-providers/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/managed-providers/loader.js')>()),
  inspectProviderInstallation: mocks.inspect,
  installProvider: mocks.install,
  warnStaleProvider: mocks.warn,
}));
vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/prompt/index.js')>()),
  confirm: mocks.confirm,
}));

const attachmentStore = () => ({
  saveImage: vi.fn(), listAttachments: () => [], cleanup: vi.fn(), seal: vi.fn(),
});
function createConversation() {
  const call = vi.fn().mockResolvedValue({
    persona: 'interactive', status: 'done', content: 'assistant answer', timestamp: new Date(),
  });
  const ctx = makeSessionContext({
    providerType: 'claude-sdk', provider: makeProvider({ setup: () => ({ call }) }),
  });
  const conversation = createTuiConversation({
    cwd: '/repo', persistSession: false, attachmentStore: attachmentStore(),
    userMessage: 'initial task',
    plan: { ctx, strategy: {
      systemPrompt: 'system', introMessage: 'intro', formalSpec: false,
      modelCheckTimeoutSeconds: 30, allowedTools: [], transformPrompt: (text) => text,
    } },
  });
  return { conversation, ctx, call };
}
function runOptions(): TuiConversationRunOptions {
  return {
    cwd: '/repo', lang: 'en', conversation: createConversation().conversation,
    getProvider: () => 'claude-sdk', initialEntries: [], submitMode: 'chat', autoSubmit: false,
    modelLabel: () => 'model', chooseAction: async () => null, continuePrompt: 'continue',
  };
}
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const cancelled = {
  exit: { kind: 'result', result: { action: 'cancel', task: '' } },
  carried: { history: [], queue: [] },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CI', '');
  vi.stubEnv('TAKT_NO_TTY', '0');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  mocks.inspect.mockResolvedValue({ state: 'ready', directory: '/managed' });
  mocks.mount.mockResolvedValue(cancelled);
});
afterEach(() => {
  if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
  else Reflect.deleteProperty(process.stdout, 'isTTY');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('managed provider preparation around TUI mounts', () => {
  it.each(['missing', 'stale'])('waits for ordinary confirmation and %s SDK installation before mounting Ink', async (state) => {
    const events: string[] = [];
    mocks.inspect.mockResolvedValue({ state });
    mocks.confirm.mockImplementation(async (_message: string, defaultValue: boolean) => {
      expect(defaultValue).toBe(false);
      expect(mocks.mount).not.toHaveBeenCalled();
      events.push('confirm');
      return true;
    });
    mocks.install.mockImplementation(async () => {
      expect(mocks.mount).not.toHaveBeenCalled();
      events.push('install');
    });
    mocks.mount.mockImplementationOnce(async () => {
      events.push('mount');
      return { exit: { kind: 'handoff', id: 'tell' }, carried: { history: [], queue: [] } };
    }).mockImplementation(async () => { events.push('mount'); return cancelled; });

    await runTuiConversation({ ...runOptions(), onHandoff: async () => ({ kind: 'continue' }) });

    expect(events).toEqual(['confirm', 'install', 'mount', 'mount']);
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledOnce();
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(mocks.install).toHaveBeenCalledWith('claude-sdk', { signal: undefined });
  });

  it.each(['stale', 'missing'])('handles declined %s preparation before Ink starts', async (state) => {
    mocks.inspect.mockResolvedValue({ state });
    mocks.confirm.mockResolvedValue(false);
    const run = runTuiConversation(runOptions());
    if (state === 'missing') {
      await expect(run).rejects.toBeInstanceOf(ManagedProviderInstallRequiredError);
      expect(mocks.mount).not.toHaveBeenCalled();
    } else {
      await expect(run).resolves.toEqual(cancelled.exit.result);
      expect(mocks.warn).toHaveBeenCalledWith('claude-sdk');
      expect(mocks.warn.mock.invocationCallOrder[0]).toBeLessThan(mocks.mount.mock.invocationCallOrder[0]!);
    }
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it.each(['provider', 'exec-setup'])('prepares a changed provider after a bare-terminal %s handoff and before the next mount', async (id) => {
    let provider = 'claude-sdk';
    const events: string[] = [];
    mocks.inspect.mockImplementation(async (value: string) => {
      events.push(`inspect:${value}`);
      return { state: value === 'pi' ? 'missing' : 'ready' };
    });
    mocks.confirm.mockImplementation(async () => { events.push('confirm'); return true; });
    mocks.install.mockImplementation(async () => { events.push('install'); });
    mocks.mount.mockImplementationOnce(async () => {
      events.push('mount:1');
      return { exit: { kind: 'handoff', id }, carried: { history: [], queue: [] } };
    }).mockImplementationOnce(async () => { events.push('mount:2'); return cancelled; });
    await runTuiConversation({
      ...runOptions(), getProvider: () => provider,
      onHandoff: async () => { events.push('handoff'); provider = 'pi'; return { kind: 'continue' }; },
    });
    expect(events).toEqual([
      'inspect:claude-sdk', 'mount:1', 'handoff', 'inspect:pi', 'confirm', 'install', 'mount:2',
    ]);
  });

  it('retains completed provider preparation after resuming a session', async () => {
    const options = runOptions();
    const resume = vi.spyOn(options.conversation, 'resumeSession').mockResolvedValue(undefined);
    mocks.selectSession.mockResolvedValue('saved-session');
    mocks.mount.mockResolvedValueOnce({ exit: { kind: 'resume_session' }, carried: { history: [], queue: [] } });

    await runTuiConversation(options);

    expect(resume).toHaveBeenCalledWith('saved-session');
    expect(mocks.inspect.mock.calls).toEqual([['claude-sdk']]);
    expect(mocks.mount).toHaveBeenCalledTimes(2);
  });

  it.each(['continue', 'handoff'] as const)('does not repeat a declined update after %s and resets preparation for another run', async (route) => {
    mocks.inspect.mockResolvedValue({ state: 'stale', directory: '/managed' });
    mocks.confirm.mockResolvedValue(false);
    mocks.mount.mockResolvedValueOnce({
      exit: route === 'continue'
        ? { kind: 'choose_action', task: 'task', origin: 'go' }
        : { kind: 'handoff', id: 'tell' },
      carried: { history: [], queue: [] },
    });
    const options: TuiConversationRunOptions = {
      ...runOptions(),
      chooseAction: async () => ({ action: 'continue', task: 'task' }),
      onHandoff: async () => ({ kind: 'continue' }),
    };

    await runTuiConversation(options);

    expect(mocks.mount).toHaveBeenCalledTimes(2);
    expect(mocks.inspect.mock.calls).toEqual([['claude-sdk']]);
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.install).not.toHaveBeenCalled();

    await runTuiConversation(options);

    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(mocks.inspect.mock.calls).toEqual([['claude-sdk'], ['claude-sdk']]);
  });

  it.each(['claude-sdk', 'claude'])('confirms a new provider but does not repeat a declined update on returning to %s', async (originalProvider) => {
    let provider = 'claude-sdk';
    mocks.inspect.mockResolvedValue({ state: 'stale', directory: '/managed' });
    mocks.confirm.mockResolvedValue(false);
    mocks.mount.mockResolvedValueOnce({
      exit: { kind: 'handoff', id: 'provider', text: 'pi' }, carried: { history: [], queue: [] },
    }).mockResolvedValueOnce({
      exit: { kind: 'handoff', id: 'provider', text: originalProvider }, carried: { history: [], queue: [] },
    });
    const onHandoff = vi.fn(async (_id: string, text: string) => {
      provider = text;
      return { kind: 'continue' as const };
    });

    await runTuiConversation({ ...runOptions(), getProvider: () => provider, onHandoff });

    expect(mocks.mount).toHaveBeenCalledTimes(3);
    expect(mocks.inspect.mock.calls).toEqual([['claude-sdk'], ['pi']]);
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(mocks.inspect.mock.invocationCallOrder[1]).toBeGreaterThan(onHandoff.mock.invocationCallOrder[0]!);
    expect(mocks.inspect.mock.invocationCallOrder[1]).toBeLessThan(mocks.mount.mock.invocationCallOrder[1]!);
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('does not mount Ink after installation fails', async () => {
    mocks.inspect.mockResolvedValue({ state: 'missing' });
    mocks.confirm.mockResolvedValue(true);
    const failure = new Error('installation failed');
    mocks.install.mockRejectedValue(failure);
    await expect(runTuiConversation(runOptions())).rejects.toBe(failure);
    expect(mocks.mount).not.toHaveBeenCalled();
  });

  it.each(['submit', 'createInstruction', 'exec'] as const)(
    'never prompts during %s turns even if the SDK becomes stale or missing after mounting', async (method) => {
      const { conversation, ctx, call } = createConversation();
      const active = method === 'exec' ? createExecTuiConversation({
        cwd: '/repo', attachmentStore: attachmentStore(),
        session: () => ({ ...ctx, facetLookupConfig: { enableBuiltinWorkflows: true, language: 'en' },
          codexSkillInheritance: { repo: false, user: false } }),
        systemPrompt: () => 'system', onTurn: vi.fn(), onInterruptedMessage: vi.fn(),
      }) : conversation;
      mocks.mount.mockImplementation(async (
        buildTree: (handlers: { settle: () => void; fail: () => void }) => ReactElement<ConversationViewProps>,
      ) => {
        buildTree({ settle: vi.fn(), fail: vi.fn() });
        const input = { text: 'question', abortSignal: new AbortController().signal, onAssistantChunk: vi.fn() };
        mocks.inspect.mockResolvedValue({ state: 'stale', directory: '/managed' });
        const stale = await (method === 'createInstruction' ? active.createInstruction(input) : active.submit(input));
        expect(stale.kind).toBe(method === 'createInstruction' ? 'task_instruction' : 'assistant_response');
        expect(mocks.warn).toHaveBeenCalledWith('claude-sdk');
        expect(call).toHaveBeenCalledOnce();
        mocks.inspect.mockResolvedValue({ state: 'missing' });
        const missing = await (method === 'createInstruction' ? active.createInstruction(input) : active.submit(input));
        expect(missing.kind).toBe('error');
        expect(call).toHaveBeenCalledOnce();
        return cancelled;
      });
      await runTuiConversation({ ...runOptions(), conversation: active });
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
    },
  );

  it('preserves ordinary confirmation for a caller outside the TUI', async () => {
    const { ctx, call } = createConversation();
    mocks.inspect.mockResolvedValue({ state: 'missing' });
    mocks.confirm.mockResolvedValue(true);

    const result = await callAIWithRetry('question', 'system', [], '/repo', ctx, {
      outputMode: 'silent', persistSession: false,
    });

    expect(result.result?.success).toBe(true);
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledOnce();
  });
});
