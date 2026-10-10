import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_FAILURE_CATEGORIES } from '../shared/types/agent-failure.js';
import type { StreamEvent } from '../shared/types/provider.js';
import { managedFailureResponse, managedFailureStream, withUpdateAdvice } from '../infra/managed-providers/messages.js';
import { managedProviderFor, MANAGED_PROVIDERS } from '../infra/managed-providers/definitions.js';
import { checkManagedProviders } from '../infra/managed-providers/preflight.js';
import { checkPendingTaskProviders, checkQueuedTaskProviders, checkTaskNameProvider } from '../features/tasks/execute/providerPreflight.js';
import type { TaskInfo } from '../infra/task/index.js';
import * as reusedWorktree from '../features/tasks/execute/reusedWorktree.js';
import * as config from '../infra/config/index.js';

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), install: vi.fn(), warn: vi.fn() }));
vi.mock('../infra/config/runtime-provider/execution-preparation.js', () => ({ checkWorkflowProviders: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../infra/managed-providers/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/managed-providers/loader.js')>()),
  inspectProviderInstallation: mocks.inspect,
  installProvider: mocks.install,
  warnStaleProvider: mocks.warn,
}));

describe('managed provider preflight and failure diagnostics', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.install.mockResolvedValue(undefined); });

  it.each([
    { slug: undefined, worktree: true, reuse: false, strategy: 'ai', required: true },
    { slug: undefined, worktree: '/clones', reuse: false, strategy: 'ai', required: true },
    { slug: 'ready-name', worktree: true, reuse: false, strategy: 'ai', required: false },
    { slug: '', worktree: true, reuse: false, strategy: 'ai', required: false },
    { slug: undefined, worktree: false, reuse: false, strategy: 'ai', required: false },
    { slug: undefined, worktree: true, reuse: false, strategy: 'romaji', required: false },
    { slug: undefined, worktree: true, reuse: true, strategy: 'ai', required: false },
  ])('checks naming only when needed: %j', async ({ slug, worktree, reuse, strategy, required }) => {
    const spies = [
      vi.spyOn(config, 'loadWorkflowByIdentifier').mockReturnValue({} as never),
      vi.spyOn(config, 'resolveProviderOptionsWithTrace').mockReturnValue({ value: {} } as never),
      vi.spyOn(config, 'resolveConfigValues').mockReturnValue({ branchNameStrategy: strategy } as never),
      vi.spyOn(config, 'resolveNonWorkflowProviderModel').mockReturnValue({ provider: 'pi', runtimeManaged: false }),
      vi.spyOn(reusedWorktree, 'inspectReusedWorktreeExecution').mockReturnValue(reuse ? { worktreePath: '/clones/reused', execCwd: '/clones/reused', isWorktree: true } : undefined),
    ];
    mocks.inspect.mockResolvedValue({ state: 'missing' });
    const task = { name: 'queued', slug, data: { worktree, workflow: 'mock' } } as TaskInfo;
    try {
      if (required) await expect(checkQueuedTaskProviders('/project', task, {}, undefined)).rejects.toThrow('takt install pi');
      else await checkQueuedTaskProviders('/project', task, {}, undefined);
      expect(mocks.inspect).toHaveBeenCalledTimes(required ? 1 : 0);
      expect(mocks.install).not.toHaveBeenCalled();
    } finally { for (const spy of spies) spy.mockRestore(); }
  });

  it('rechecks pending tasks added or changed during provider preparation', async () => {
    const first = { name: 'first', data: { workflow: 'mock', worktree: true } } as TaskInfo;
    const added = { name: 'added', data: { workflow: 'mock', worktree: true } } as TaskInfo;
    let pending = [first];
    const spies = [
      vi.spyOn(config, 'loadWorkflowByIdentifier').mockReturnValue({} as never),
      vi.spyOn(config, 'resolveProviderOptionsWithTrace').mockReturnValue({ value: {} } as never),
      vi.spyOn(config, 'resolveConfigValues').mockReturnValue({ branchNameStrategy: 'ai' } as never),
      vi.spyOn(config, 'resolveNonWorkflowProviderModel').mockReturnValue({ provider: 'pi', runtimeManaged: false }),
      vi.spyOn(reusedWorktree, 'inspectReusedWorktreeExecution').mockReturnValue(undefined),
    ];
    mocks.inspect.mockResolvedValue({ state: 'ready' });
    mocks.inspect.mockImplementationOnce(async () => {
      pending = [{ ...first, content: 'Changed while waiting' }, added];
      return { state: 'ready' };
    });
    try {
      await checkPendingTaskProviders({ listTasks: () => pending } as never, '/project', {}, undefined, []);
      expect(mocks.inspect).toHaveBeenCalledTimes(3);
    } finally { for (const spy of spies) spy.mockRestore(); }
  });

  it('normalizes the Claude alias and ignores external CLI providers', () => {
    expect(managedProviderFor('claude')).toBe('claude-sdk');
    expect(managedProviderFor('claude-headless')).toBeUndefined();
    expect(managedProviderFor('mock')).toBeUndefined();
  });

  it.each(['romaji', 'ai'] as const)('checks the naming provider only for %s task name generation', async (strategy) => {
    const configuration = vi.spyOn(config, 'resolveConfigValues').mockReturnValue({ branchNameStrategy: strategy } as never);
    const naming = vi.spyOn(config, 'resolveNonWorkflowProviderModel').mockReturnValue({ provider: 'pi', model: 'test-model', runtimeManaged: false });
    mocks.inspect.mockResolvedValue({ state: 'missing' });
    const confirm = vi.fn().mockResolvedValue(false);
    try {
      if (strategy === 'ai') {
        await expect(checkTaskNameProvider('/project', confirm)).rejects.toThrow('takt install pi');
        expect(naming).toHaveBeenCalledWith('/project');
        expect(confirm).toHaveBeenCalledOnce();
      } else {
        await checkTaskNameProvider('/project', confirm);
        expect(naming).not.toHaveBeenCalled();
        expect(mocks.inspect).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
      }
      expect(mocks.install).not.toHaveBeenCalled();
    } finally {
      configuration.mockRestore();
      naming.mockRestore();
    }
  });

  it.each(MANAGED_PROVIDERS)('does not install or confirm a ready %s SDK', async (provider) => {
    mocks.inspect.mockResolvedValue({ state: 'ready' });
    const confirm = vi.fn();
    await checkManagedProviders([provider, provider], confirm);
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('waits for accepted installation before returning', async () => {
    mocks.inspect.mockResolvedValue({ state: 'missing' });
    let finish!: () => void;
    mocks.install.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    let completed = false;
    const confirm = vi.fn().mockResolvedValue(true);
    const pending = checkManagedProviders(['codex'], confirm).then(() => { completed = true; });
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('340 MB'));
    finish();
    await pending;
    expect(completed).toBe(true);
  });

  it('rejects missing SDKs without running npm when confirmation is absent or declined', async () => {
    mocks.inspect.mockResolvedValue({ state: 'missing' });
    await expect(checkManagedProviders(['pi'], undefined)).rejects.toThrow('takt install pi');
    await expect(checkManagedProviders(['pi'], async () => false)).rejects.toThrow('takt install pi');
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('warns and preserves an intact older SDK without confirmation or after refusal', async () => {
    mocks.inspect.mockResolvedValue({ state: 'stale' });
    await checkManagedProviders(['pi'], undefined);
    await checkManagedProviders(['pi'], async () => false);
    expect(mocks.warn).toHaveBeenCalledTimes(2);
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('keeps the integrity failure as the cause of missing SDK install advice', async () => {
    const cause = new Error('SDK entry is damaged');
    mocks.inspect.mockResolvedValue({ state: 'missing', cause });
    await expect(checkManagedProviders(['pi'], undefined)).rejects.toMatchObject({
      message: expect.stringContaining('takt install pi'), cause,
    });
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('does not install after cancellation during confirmation', async () => {
    mocks.inspect.mockResolvedValue({ state: 'missing' });
    const controller = new AbortController();
    await expect(checkManagedProviders(['codex'], async () => { controller.abort(); return true; }, controller.signal)).rejects.toThrow();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('preserves failure category, session and result event while adding update advice exactly once', () => {
    const response = { persona: 'worker', status: 'error' as const, content: 'Original timeout', error: 'Original timeout', failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT, sessionId: 'session', timestamp: new Date() };
    expect(managedFailureResponse(response, false, 'pi')).toBe(response);
    const decorated = managedFailureResponse(response, true, 'pi');
    expect(decorated).toMatchObject({ failureCategory: response.failureCategory, sessionId: 'session', error: expect.stringContaining('Original timeout') });
    expect(decorated.error).toContain('takt update pi');
    expect(withUpdateAdvice(decorated.error!, 'pi')).toBe(decorated.error);
    const stream = vi.fn();
    managedFailureStream(stream, true, 'pi')!({ type: 'result', data: { result: 'Original timeout', success: false, sessionId: 'session', failureCategory: response.failureCategory } });
    expect(stream).toHaveBeenCalledWith({ type: 'result', data: { result: expect.stringContaining('takt update pi'), success: false, sessionId: 'session', failureCategory: response.failureCategory } });
    const success = { ...response, status: 'done' as const };
    expect(managedFailureResponse(success, true, 'pi')).toBe(success);
  });

  describe.each(['`', ''])('update advice with quote=%j', (quote) => {
    it.each(MANAGED_PROVIDERS)('adds %s update advice even when another provider is already advised', (provider) => {
      const other = provider === 'codex' ? 'opencode' : 'codex';
      const message = `controlled SDK failure. Run ${quote}takt update ${other}${quote}.`;
      const decorated = withUpdateAdvice(message, provider);
      expect(decorated).toContain(message);
      expect(decorated.split(`takt update ${provider}`)).toHaveLength(2);
      expect(withUpdateAdvice(decorated, provider)).toBe(decorated);
    });

    it.each(MANAGED_PROVIDERS)('preserves existing %s update advice without duplication', (provider) => {
      const message = `controlled SDK failure. Run ${quote}takt update ${provider}${quote}.`;
      expect(withUpdateAdvice(message, provider)).toBe(message);
    });

    it.each(['claude-sdk', 'claude', 'codex', 'claude-headless', 'claude-terminal'] as const)('recognizes the complete Claude update target: %s', (target) => {
      const message = `controlled SDK failure. Run ${quote}takt update ${target}${quote}.`;
      const decorated = withUpdateAdvice(message, 'claude-sdk');
      if (target === 'claude-sdk' || target === 'claude') {
        expect(decorated).toBe(message);
      } else {
        expect(decorated).toContain(message);
        expect(decorated.split('takt update claude-sdk')).toHaveLength(2);
      }
      expect(withUpdateAdvice(decorated, 'claude-sdk')).toBe(decorated);
    });

    it.each(['claude', 'opencode'] as const)('checks later update advice for the same target: %s', (target) => {
      const message = `controlled SDK failure. Run ${quote}takt update codex${quote}. Run ${quote}takt update ${target}${quote}.`;
      const decorated = withUpdateAdvice(message, 'claude-sdk');
      if (target === 'claude') expect(decorated).toBe(message);
      else {
        expect(decorated).toContain(message);
        expect(decorated.split('takt update claude-sdk')).toHaveLength(2);
      }
      expect(withUpdateAdvice(decorated, 'claude-sdk')).toBe(decorated);
    });

    it.each(['opencode', 'pi', 'opencode-other'] as const)('checks the complete later OpenCode update target: %s', (target) => {
      const message = `controlled SDK failure. Run ${quote}takt update codex${quote}. Run ${quote}takt update ${target}${quote}.`;
      const decorated = withUpdateAdvice(message, 'opencode');
      if (target === 'opencode') expect(decorated).toBe(message);
      else {
        expect(decorated).toContain(message);
        expect(decorated.split('`takt update opencode`')).toHaveLength(2);
      }
      expect(withUpdateAdvice(decorated, 'opencode')).toBe(decorated);
    });

    it.each([
      ['claude', 'claude'], ['claude', 'codex'], ['codex', 'claude'], ['codex', 'codex'],
    ] as const)('checks Claude response fields independently: content=%s, error=%s', (contentTarget, errorTarget) => {
      const content = `controlled SDK failure. Run ${quote}takt update ${contentTarget}${quote}.`;
      const error = `controlled SDK failure. Run ${quote}takt update ${errorTarget}${quote}.`;
      const response = { persona: 'worker', status: 'error' as const, content, error, failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR, sessionId: 'session', timestamp: new Date() };
      const decorated = managedFailureResponse(response, true, 'claude-sdk');
      for (const [field, original, target] of [[decorated.content, content, contentTarget], [decorated.error!, error, errorTarget]] as const) {
        expect(field).toContain(original);
        expect(field.split('takt update claude-sdk')).toHaveLength(target === 'claude' ? 1 : 2);
        if (target === 'claude') expect(field).toBe(original);
      }
      expect(decorated).toMatchObject({ status: response.status, failureCategory: response.failureCategory, sessionId: response.sessionId, timestamp: response.timestamp });
      expect(managedFailureResponse(decorated, true, 'claude-sdk')).toEqual(decorated);
    });

    it.each(['claude', 'codex'] as const)('checks Claude failure stream fields independently with %s advice', (target) => {
      const error = `controlled SDK failure. Run ${quote}takt update ${target}${quote}.`;
      const event: StreamEvent = { type: 'result', data: { result: '', error, success: false, sessionId: 'session' } };
      const stream = vi.fn();
      const wrap = managedFailureStream(stream, true, 'claude-sdk')!;
      wrap(event);
      const streamed = stream.mock.calls[0]![0] as typeof event;
      expect(streamed.type).toBe('result');
      expect(streamed.data.result.split('takt update claude-sdk')).toHaveLength(2);
      expect(streamed.data.error).toContain(error);
      expect(streamed.data.error!.split('takt update claude-sdk')).toHaveLength(target === 'claude' ? 1 : 2);
      if (target === 'claude') expect(streamed.data.error).toBe(error);
      expect(streamed.data).toMatchObject({ success: false, sessionId: event.data.sessionId });
      wrap(streamed);
      expect(stream.mock.calls[1]![0]).toEqual(streamed);
    });

    it.each([
      ['codex', 'codex'], ['codex', 'opencode'], ['opencode', 'codex'], ['opencode', 'opencode'],
    ] as const)('checks OpenCode failure fields independently: content=%s, error=%s', (contentTarget, errorTarget) => {
      const content = `controlled SDK failure. Run ${quote}takt update ${contentTarget}${quote}.`;
      const error = `controlled SDK failure. Run ${quote}takt update ${errorTarget}${quote}.`;
      const response = { persona: 'worker', status: 'error' as const, content, error, failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR, sessionId: 'session', timestamp: new Date() };
      const decorated = managedFailureResponse(response, true, 'opencode');
      for (const [field, original, target] of [[decorated.content, content, contentTarget], [decorated.error!, error, errorTarget]] as const) {
        expect(field).toContain(original);
        expect.soft(field.split('takt update opencode')).toHaveLength(2);
        if (target === 'opencode') expect.soft(field).toBe(original);
      }
      expect(decorated).toMatchObject({ status: 'error', failureCategory: response.failureCategory, sessionId: response.sessionId, timestamp: response.timestamp });
      expect(managedFailureResponse(decorated, true, 'opencode')).toEqual(decorated);
      const stream = vi.fn();
      const event: StreamEvent = { type: 'result', data: { result: content, error, success: false, sessionId: 'session', failureCategory: response.failureCategory } };
      managedFailureStream(stream, true, 'opencode')!(event);
      const streamed = stream.mock.calls[0]![0] as typeof event;
      for (const [field, original, target] of [[streamed.data.result, content, contentTarget], [streamed.data.error!, error, errorTarget]] as const) {
        expect(field).toContain(original);
        expect.soft(field.split('takt update opencode')).toHaveLength(2);
        if (target === 'opencode') expect.soft(field).toBe(original);
      }
      expect(streamed.data).toEqual({ ...event.data, result: decorated.content, error: decorated.error });
      managedFailureStream(stream, true, 'opencode')!(streamed);
      expect(stream.mock.calls[1]![0]).toEqual(streamed);
    });
  });

  it('preserves ready SDK failures, successful output, other events and absent error fields', () => {
    const message = 'controlled SDK failure. Run `takt update codex`.';
    const response = { persona: 'worker', status: 'error' as const, content: message, sessionId: 'session', timestamp: new Date() };
    expect(managedFailureResponse(response, false, 'opencode')).toEqual(response);
    const success = { ...response, status: 'done' as const };
    expect(managedFailureResponse(success, true, 'opencode')).toEqual(success);
    expect(managedFailureResponse(response, true, 'opencode')).not.toHaveProperty('error');
    const stream = vi.fn();
    const failure: StreamEvent = { type: 'result', data: { result: message, success: false, sessionId: 'session' } };
    managedFailureStream(stream, false, 'opencode')!(failure);
    expect(stream.mock.calls[0]![0]).toEqual(failure);
    const wrap = managedFailureStream(stream, true, 'opencode')!;
    const successEvent: StreamEvent = { type: 'result', data: { ...failure.data, success: true } };
    wrap(successEvent);
    expect(stream.mock.calls[1]![0]).toEqual(successEvent);
    const text: StreamEvent = { type: 'text', data: { text: message } };
    wrap(text);
    expect(stream.mock.calls[2]![0]).toEqual(text);
    wrap(failure);
    expect(stream.mock.calls[3]![0].data).not.toHaveProperty('error');
    expect(stream.mock.calls[3]![0].data.result).toContain('takt update opencode');
    expect(managedFailureStream(undefined, true, 'opencode')).toBeUndefined();
  });
});
