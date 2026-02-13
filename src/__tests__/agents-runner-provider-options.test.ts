import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse, MovementProviderOptions } from '../core/models/index.js';

const {
  mockGetProvider,
  mockLoadGlobalConfig,
  mockLoadProjectConfig,
} = vi.hoisted(() => ({
  mockGetProvider: vi.fn(),
  mockLoadGlobalConfig: vi.fn(),
  mockLoadProjectConfig: vi.fn(),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: mockGetProvider,
}));

vi.mock('../infra/config/index.js', () => ({
  loadCustomAgents: vi.fn(() => new Map()),
  loadAgentPrompt: vi.fn(() => ''),
  loadGlobalConfig: mockLoadGlobalConfig,
  loadProjectConfig: mockLoadProjectConfig,
}));

const { runAgent } = await import('../agents/runner.js');

function doneResponse(): AgentResponse {
  return {
    persona: 'default',
    status: 'done',
    content: 'ok',
    timestamp: new Date('2026-02-13T00:00:00.000Z'),
  };
}

describe('runAgent providerOptions resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockLoadGlobalConfig.mockReturnValue({
      providerOptions: { codex: { networkAccess: false } },
    });
    mockLoadProjectConfig.mockReturnValue({
      provider_options: { codex: { networkAccess: false } },
    });
  });

  it('step providerOptions をそのまま provider call に渡し、global/local を参照しない', async () => {
    const call = vi.fn().mockResolvedValue(doneResponse());
    const setup = vi.fn().mockReturnValue({ call });
    mockGetProvider.mockReturnValue({ setup });

    const stepOptions: MovementProviderOptions = {
      codex: { networkAccess: true },
      claude: { sandbox: { allowUnsandboxedCommands: true } },
    };

    await runAgent(undefined, 'task', {
      cwd: '/tmp/project',
      provider: 'mock',
      model: 'mock/model',
      providerOptions: stepOptions,
    });

    const passedCallOptions = call.mock.calls[0]?.[1];
    expect(passedCallOptions?.providerOptions).toBe(stepOptions);
  });

  it('step providerOptions が未指定なら undefined を渡す', async () => {
    const call = vi.fn().mockResolvedValue(doneResponse());
    const setup = vi.fn().mockReturnValue({ call });
    mockGetProvider.mockReturnValue({ setup });

    await runAgent(undefined, 'task', {
      cwd: '/tmp/project',
      provider: 'mock',
      model: 'mock/model',
    });

    const passedCallOptions = call.mock.calls[0]?.[1];
    expect(passedCallOptions?.providerOptions).toBeUndefined();
  });
});
