import { beforeEach, describe, expect, it, vi } from 'vitest';

const { compactOpenCodeSessionMock, resolveOpencodeApiKeyMock } = vi.hoisted(() => ({
  compactOpenCodeSessionMock: vi.fn().mockResolvedValue(undefined),
  resolveOpencodeApiKeyMock: vi.fn().mockReturnValue('configured-opencode-key'),
}));

vi.mock('../infra/opencode/index.js', () => ({
  callOpenCode: vi.fn(),
  callOpenCodeCustom: vi.fn(),
  compactOpenCodeSession: compactOpenCodeSessionMock,
}));

vi.mock('../infra/config/index.js', () => ({
  resolveOpencodeApiKey: resolveOpencodeApiKeyMock,
}));

import { OpenCodeProvider } from '../infra/providers/opencode.js';

describe('OpenCodeProvider compactSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
