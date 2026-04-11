import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockResolveAssistantConfigLayers,
  mockResolveAssistantProviderModelFromConfig,
  mockLoadTemplate,
  mockResolveConfigValues,
  mockGetProvider,
  mockAgentCall,
} = vi.hoisted(() => ({
  mockResolveAssistantConfigLayers: vi.fn(),
  mockResolveAssistantProviderModelFromConfig: vi.fn(),
  mockLoadTemplate: vi.fn(),
  mockResolveConfigValues: vi.fn(),
  mockGetProvider: vi.fn(),
  mockAgentCall: vi.fn(),
}));

vi.mock('../features/interactive/assistantConfig.js', () => ({
  resolveAssistantConfigLayers: (...args: unknown[]) => mockResolveAssistantConfigLayers(...args),
}));

vi.mock('../core/config/provider-resolution.js', () => ({
  resolveAssistantProviderModelFromConfig: (...args: unknown[]) =>
    mockResolveAssistantProviderModelFromConfig(...args),
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: (...args: unknown[]) => mockLoadTemplate(...args),
}));

vi.mock('../infra/config/index.js', () => ({
  getLanguage: vi.fn(() => 'ja'),
  resolveConfigValues: (...args: unknown[]) => mockResolveConfigValues(...args),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: (...args: unknown[]) => mockGetProvider(...args),
}));

import { runSyncConflictResolver } from '../infra/service/runSyncConflictResolver.js';

describe('runSyncConflictResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAssistantConfigLayers.mockReturnValue({ local: {}, global: {} });
    mockResolveAssistantProviderModelFromConfig.mockReturnValue({ provider: 'codex', model: 'gpt-5.4' });
    mockLoadTemplate.mockImplementation((name: string, _lang: string, vars?: Record<string, string>) => {
      if (name === 'sync_conflict_resolver_system_prompt') {
        return 'system-prompt';
      }
      if (name === 'sync_conflict_resolver_message') {
        return `message:${vars?.originalInstruction ?? ''}`;
      }
      throw new Error(`Unexpected template: ${name}`);
    });
    mockResolveConfigValues.mockReturnValue({ syncConflictResolver: undefined });
    mockGetProvider.mockReturnValue({
      setup: vi.fn(() => ({ call: mockAgentCall })),
    });
    mockAgentCall.mockResolvedValue({
      status: 'done',
      content: 'resolved',
      persona: 'conflict-resolver',
      timestamp: new Date(),
    });
  });

  it('resolves prompt and provider once, then calls the shared conflict-resolver agent', async () => {
    const onStream = vi.fn();

    await runSyncConflictResolver({
      projectCwd: '/repo',
      cwd: '/repo/worktree',
      originalInstruction: 'Resolve conflicts',
      onStream,
    });

    expect(mockResolveAssistantConfigLayers).toHaveBeenCalledWith('/repo');
    expect(mockResolveAssistantProviderModelFromConfig).toHaveBeenCalledWith({ local: {}, global: {} });
    expect(mockResolveConfigValues).toHaveBeenCalledWith('/repo', ['syncConflictResolver']);
    expect(mockGetProvider).toHaveBeenCalledWith('codex');
    expect(mockAgentCall).toHaveBeenCalledWith('message:Resolve conflicts', {
      cwd: '/repo/worktree',
      model: 'gpt-5.4',
      permissionMode: 'edit',
      onPermissionRequest: undefined,
      onStream,
    });
  });

  it('passes the shared auto-approve handler only when sync_conflict_resolver enables it', async () => {
    mockResolveConfigValues.mockReturnValue({
      syncConflictResolver: { autoApproveTools: true },
    });

    await runSyncConflictResolver({
      projectCwd: '/repo',
      cwd: '/repo/worktree',
      originalInstruction: 'Resolve conflicts',
    });

    const [, callOptions] = mockAgentCall.mock.calls[0] as [string, { onPermissionRequest?: (request: { input: Record<string, unknown> }) => Promise<unknown> }];
    expect(callOptions.onPermissionRequest).toEqual(expect.any(Function));
    await expect(callOptions.onPermissionRequest?.({ input: { command: 'git status' } })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'git status' },
    });
  });

  it('fails fast when no provider is configured', async () => {
    mockResolveAssistantProviderModelFromConfig.mockReturnValue({ provider: undefined, model: 'gpt-5.4' });

    await expect(
      runSyncConflictResolver({
        projectCwd: '/repo',
        cwd: '/repo/worktree',
        originalInstruction: 'Resolve conflicts',
      }),
    ).rejects.toThrow('No provider configured. Set "provider" in ~/.takt/config.yaml');
  });
});
