import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callOpenCodeMock, callOpenCodeCustomMock, compactOpenCodeSessionMock, resolveOpencodeApiKeyMock } = vi.hoisted(() => ({
  callOpenCodeMock: vi.fn().mockResolvedValue({
    status: 'done',
    content: '',
    persona: 'coder',
    timestamp: new Date(),
  }),
  callOpenCodeCustomMock: vi.fn(),
  compactOpenCodeSessionMock: vi.fn().mockResolvedValue(undefined),
  resolveOpencodeApiKeyMock: vi.fn().mockReturnValue('configured-opencode-key'),
}));

vi.mock('../infra/opencode/index.js', () => ({
  callOpenCode: callOpenCodeMock,
  callOpenCodeCustom: callOpenCodeCustomMock,
  compactOpenCodeSession: compactOpenCodeSessionMock,
}));

vi.mock('../infra/config/index.js', () => ({
  resolveOpencodeApiKey: resolveOpencodeApiKeyMock,
}));

import { OpenCodeProvider } from '../infra/providers/opencode.js';

describe('OpenCodeProvider compactSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOpenCodeMock.mockResolvedValue({
      status: 'done',
      content: '',
      persona: 'coder',
      timestamp: new Date(),
    });
    compactOpenCodeSessionMock.mockResolvedValue(undefined);
    resolveOpencodeApiKeyMock.mockReturnValue('configured-opencode-key');
  });

  it('Given compaction options When compactSession runs Then it delegates only SDK compaction options to the OpenCode client', async () => {
    const abortController = new AbortController();
    const provider = new OpenCodeProvider();

    await provider.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
      abortSignal: abortController.signal,
      childProcessEnv: {
        TAKT_OBSERVABILITY: '{"enabled":true}',
      },
    });

    expect(resolveOpencodeApiKeyMock).toHaveBeenCalledTimes(1);
    expect(compactOpenCodeSessionMock).toHaveBeenCalledWith({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
      abortSignal: abortController.signal,
      childProcessEnv: {
        TAKT_OBSERVABILITY: '{"enabled":true}',
      },
      opencodeApiKey: 'configured-opencode-key',
    });
  });

  it('Given no explicit OpenCode API key When compactSession runs Then it resolves the configured key once', async () => {
    const provider = new OpenCodeProvider();

    await provider.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
    });

    expect(resolveOpencodeApiKeyMock).toHaveBeenCalledTimes(1);
    expect(compactOpenCodeSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      opencodeApiKey: 'configured-opencode-key',
    }));
  });

  it('Given model is missing When compactSession runs Then it fails before calling the client', async () => {
    const provider = new OpenCodeProvider();

    await expect(provider.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
    })).rejects.toThrow("OpenCode provider requires model in 'provider/model' format");

    expect(compactOpenCodeSessionMock).not.toHaveBeenCalled();
  });

  it('Given model is missing When the regular OpenCode agent call runs Then it fails with the same model validation before calling the client', async () => {
    const provider = new OpenCodeProvider();
    const agent = provider.setup({ name: 'coder' });

    await expect(agent.call('implement task', {
      cwd: '/repo',
    })).rejects.toThrow("OpenCode provider requires model in 'provider/model' format");

    expect(callOpenCodeMock).not.toHaveBeenCalled();
    expect(compactOpenCodeSessionMock).not.toHaveBeenCalled();
  });

  it('Given model is missing When the custom OpenCode agent call runs Then it fails with the same model validation before calling the client', async () => {
    const provider = new OpenCodeProvider();
    const agent = provider.setup({
      name: 'coder',
      systemPrompt: 'Follow the system prompt.',
    });

    await expect(agent.call('implement task', {
      cwd: '/repo',
    })).rejects.toThrow("OpenCode provider requires model in 'provider/model' format");

    expect(callOpenCodeCustomMock).not.toHaveBeenCalled();
    expect(callOpenCodeMock).not.toHaveBeenCalled();
    expect(compactOpenCodeSessionMock).not.toHaveBeenCalled();
  });
});
