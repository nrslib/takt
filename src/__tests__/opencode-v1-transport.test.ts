import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@opencode-ai/sdk/v2', () => ({ createOpencodeClient: createClient }));

import { createV1Transport } from '../infra/opencode/v1-transport.js';
import { prepareSharedServerPoolForForcedShutdown } from '../infra/opencode/server-pool.js';

function createClientMock(overrides: Record<string, unknown> = {}) {
  const client = {
    app: { agents: vi.fn().mockResolvedValue({ data: [{ name: 'takt' }] }) },
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: 'model-selection-session' } }),
      get: vi.fn().mockResolvedValue({ data: {} }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
      prompt: vi.fn().mockResolvedValue({ data: { info: { model: { providerID: 'probe', modelID: 'selected' } } } }),
      delete: vi.fn().mockResolvedValue({ data: true }),
    },
    ...overrides,
  };
  createClient.mockReturnValue(client);
  return client;
}

describe('OpenCode v1 model resolution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the selected agent model before session state or the runtime default', async () => {
    const client = createClientMock({
      app: { agents: vi.fn().mockResolvedValue({ data: [{ name: 'takt', model: { providerID: 'probe', modelID: 'agent-model', variant: 'high' } }] }) },
      session: {
        get: vi.fn(), messages: vi.fn(), create: vi.fn(), prompt: vi.fn(), delete: vi.fn(),
      },
    });
    const transport = createV1Transport('http://localhost');

    await expect(transport.resolveModel?.({ directory: '/work', agent: 'takt' })).resolves.toEqual({
      providerID: 'probe', modelID: 'agent-model', variant: 'high',
    });
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it('uses the stored session model and variant before message history', async () => {
    const client = createClientMock({
      session: {
        get: vi.fn().mockResolvedValue({ data: { model: { providerID: 'probe', id: 'session-model', variant: 'high' } } }),
        create: vi.fn(),
        messages: vi.fn().mockResolvedValue({ data: [
          { info: { role: 'user', model: { providerID: 'probe', modelID: 'old' } } },
          { info: { role: 'assistant' } },
          { info: { role: 'user', model: { providerID: 'probe', modelID: 'session-model' } } },
        ] }),
        prompt: vi.fn(),
        delete: vi.fn(),
      },
    });
    const transport = createV1Transport('http://localhost');

    await expect(transport.resolveModel?.({ directory: '/work', sessionID: 'existing', agent: 'takt' })).resolves.toEqual({
      providerID: 'probe', modelID: 'session-model',
      variant: 'high',
    });
    expect(client.session.messages).not.toHaveBeenCalled();
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it('uses the most recent stored user message when the session has no model', async () => {
    const client = createClientMock({
      session: {
        get: vi.fn().mockResolvedValue({ data: {} }),
        create: vi.fn(),
        messages: vi.fn().mockResolvedValue({ data: [
          { info: { role: 'user', model: { providerID: 'probe', modelID: 'old' } } },
          { info: { role: 'assistant' } },
          { info: { role: 'user', model: { providerID: 'probe', modelID: 'session-model', variant: 'high' } } },
        ] }),
        prompt: vi.fn(),
        delete: vi.fn(),
      },
    });
    const transport = createV1Transport('http://localhost');

    await expect(transport.resolveModel?.({ directory: '/work', sessionID: 'existing', agent: 'takt' })).resolves.toEqual({
      providerID: 'probe', modelID: 'session-model', variant: 'high',
    });
    expect(client.session.messages).toHaveBeenCalledOnce();
  });

  it('selects a runtime default in a temporary noReply session and deletes that session', async () => {
    const client = createClientMock();
    const transport = createV1Transport('http://localhost');

    await expect(transport.resolveModel?.({ directory: '/work', agent: 'takt' })).resolves.toEqual({
      providerID: 'probe', modelID: 'selected',
    });
    expect(client.session.prompt).toHaveBeenCalledWith({
      sessionID: 'model-selection-session',
      directory: '/work',
      agent: 'takt',
      noReply: true,
      parts: [],
    }, undefined);
    expect(client.session.delete).toHaveBeenCalledWith({
      sessionID: 'model-selection-session',
      directory: '/work',
    }, { signal: expect.any(AbortSignal) });
    expect(client.session.prompt.mock.calls[0]?.[0]).not.toHaveProperty('model');
  });

  it('fails if the temporary model-selection session cannot be removed', async () => {
    const client = createClientMock({
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'model-selection-session' } }),
        messages: vi.fn().mockResolvedValue({ data: [] }),
        prompt: vi.fn().mockResolvedValue({ data: { info: { model: { providerID: 'probe', modelID: 'selected' } } } }),
        delete: vi.fn().mockResolvedValue({ data: false }),
      },
    });
    const transport = createV1Transport('http://localhost');

    await expect(transport.resolveModel?.({ directory: '/work' })).rejects.toThrow('was not deleted');
    expect(client.session.delete).toHaveBeenCalledOnce();
  });

  it('propagates a temporary session create failure without attempting deletion', async () => {
    const createFailure = new Error('temporary session create failed');
    const client = createClientMock();
    client.session.create.mockRejectedValueOnce(createFailure);
    const transport = createV1Transport('http://localhost');

    await expect(transport.resolveModel?.({ directory: '/work' })).rejects.toBe(createFailure);
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it('deletes the temporary session and propagates a prompt failure', async () => {
    const promptFailure = new Error('model-selection prompt failed');
    const client = createClientMock();
    client.session.prompt.mockRejectedValueOnce(promptFailure);
    const transport = createV1Transport('http://localhost');

    await expect(transport.resolveModel?.({ directory: '/work' })).rejects.toBe(promptFailure);
    expect(client.session.delete).toHaveBeenCalledWith({
      sessionID: 'model-selection-session',
      directory: '/work',
    }, { signal: expect.any(AbortSignal) });
  });

  it('deletes the temporary session with an independent signal after cancellation', async () => {
    const controller = new AbortController();
    const cancellation = new DOMException('model selection cancelled', 'AbortError');
    let markPromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    const client = createClientMock();
    client.session.prompt.mockImplementationOnce((_input, options) => {
      markPromptStarted();
      const signal = options?.signal;
      if (signal === undefined) return Promise.reject(new Error('prompt signal was not passed'));
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const transport = createV1Transport('http://localhost');
    const resolution = transport.resolveModel?.({ directory: '/work' }, { signal: controller.signal });

    await promptStarted;
    controller.abort(cancellation);

    await expect(resolution).rejects.toBe(cancellation);
    expect(client.session.delete).toHaveBeenCalledOnce();
    const cleanupSignal = client.session.delete.mock.calls[0]?.[1]?.signal;
    expect(cleanupSignal).toBeInstanceOf(AbortSignal);
    expect(cleanupSignal).not.toBe(controller.signal);
    expect(cleanupSignal?.aborted).toBe(false);
  });

  it('lets forced shutdown delete an in-flight model-selection session once', async () => {
    const controller = new AbortController();
    const cancellation = new DOMException('model selection cancelled', 'AbortError');
    let markPromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    const client = createClientMock();
    client.session.prompt.mockImplementationOnce((_input, options) => {
      markPromptStarted();
      const signal = options?.signal;
      if (signal === undefined) return Promise.reject(new Error('prompt signal was not passed'));
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const transport = createV1Transport('http://localhost');
    const resolution = transport.resolveModel?.({ directory: '/work' }, { signal: controller.signal });

    await promptStarted;
    await prepareSharedServerPoolForForcedShutdown();

    expect(client.session.delete).toHaveBeenCalledOnce();
    controller.abort(cancellation);
    await expect(resolution).rejects.toBe(cancellation);
    expect(client.session.delete).toHaveBeenCalledOnce();
  });

  it('registers forced cleanup before the temporary session create response returns', async () => {
    const client = createClientMock();
    let markCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    let returnCreateResponse!: () => void;
    const createResponse = new Promise((resolve) => {
      returnCreateResponse = () => resolve({ data: { id: 'model-selection-session' } });
    });
    client.session.create.mockImplementationOnce(() => {
      markCreateStarted();
      return createResponse as never;
    });
    const transport = createV1Transport('http://localhost');
    const resolution = transport.resolveModel?.({ directory: '/work', agent: 'takt' });
    await createStarted;

    const forcedCleanup = prepareSharedServerPoolForForcedShutdown();
    returnCreateResponse();

    await forcedCleanup;
    await expect(resolution).resolves.toEqual({ providerID: 'probe', modelID: 'selected' });
    expect(client.session.delete).toHaveBeenCalledOnce();
  });

  it('preserves both prompt and cleanup failures', async () => {
    const promptFailure = new Error('model-selection prompt failed');
    const cleanupFailure = new Error('temporary session cleanup failed');
    const client = createClientMock();
    client.session.prompt.mockRejectedValueOnce(promptFailure);
    client.session.delete.mockRejectedValueOnce(cleanupFailure);
    const transport = createV1Transport('http://localhost');

    let thrown: unknown;
    try {
      await transport.resolveModel?.({ directory: '/work' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([promptFailure, cleanupFailure]);
  });
});
