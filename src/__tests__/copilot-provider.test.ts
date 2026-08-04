/**
 * Tests for Copilot and Cursor provider implementations.
 *
 * The two providers are template clones of each other, so the shared
 * behavior is parameterized; provider-specific behavior (Copilot's strict
 * internal-agent isolation rejection) keeps dedicated tests.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const {
  mockCallCopilot,
  mockCallCopilotCustom,
  mockCallCursor,
  mockCallCursorCustom,
} = vi.hoisted(() => ({
  mockCallCopilot: vi.fn(),
  mockCallCopilotCustom: vi.fn(),
  mockCallCursor: vi.fn(),
  mockCallCursorCustom: vi.fn(),
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const {
  mockResolveCopilotGithubToken,
  mockResolveCopilotCliPath,
  mockResolveCursorApiKey,
  mockResolveCursorCliPath,
  mockLoadProjectConfig,
} = vi.hoisted(() => ({
  mockResolveCopilotGithubToken: vi.fn(() => undefined),
  mockResolveCopilotCliPath: vi.fn(() => undefined),
  mockResolveCursorApiKey: vi.fn(() => undefined),
  mockResolveCursorCliPath: vi.fn(() => undefined),
  mockLoadProjectConfig: vi.fn(() => ({})),
}));

vi.mock('../infra/copilot/index.js', () => ({
  callCopilot: mockCallCopilot,
  callCopilotCustom: mockCallCopilotCustom,
}));

vi.mock('../infra/cursor/index.js', () => ({
  callCursor: mockCallCursor,
  callCursorCustom: mockCallCursorCustom,
}));

vi.mock('../infra/config/index.js', () => ({
  resolveCopilotGithubToken: mockResolveCopilotGithubToken,
  resolveCopilotCliPath: mockResolveCopilotCliPath,
  resolveCursorApiKey: mockResolveCursorApiKey,
  resolveCursorCliPath: mockResolveCursorCliPath,
  loadProjectConfig: mockLoadProjectConfig,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

import { CopilotProvider } from '../infra/providers/copilot.js';
import { CursorProvider } from '../infra/providers/cursor.js';
import { ProviderRegistry } from '../infra/providers/index.js';
import type { Provider } from '../infra/providers/index.js';

function doneResponse(persona: string) {
  return {
    persona,
    status: 'done' as const,
    content: 'ok',
    timestamp: new Date(),
  };
}

interface CliProviderCase {
  suiteName: string;
  registryName: 'copilot' | 'cursor';
  providerClass: new () => Provider;
  createProvider: () => Provider;
  mockCall: Mock;
  mockCallCustom: Mock;
  mockResolveKey: Mock;
  mockResolveCliPath: Mock;
  callName: string;
  keyOption: 'copilotGithubToken' | 'cursorApiKey';
  keyLabel: string;
  cliPathOption: 'copilotCliPath' | 'cursorCliPath';
  model: string;
  resolvedKey: string;
  explicitKey: string;
  resolvedCliPath: string;
  imageLogMessage: string;
}

const cases: CliProviderCase[] = [
  {
    suiteName: 'CopilotProvider',
    registryName: 'copilot',
    providerClass: CopilotProvider,
    createProvider: () => new CopilotProvider(),
    mockCall: mockCallCopilot,
    mockCallCustom: mockCallCopilotCustom,
    mockResolveKey: mockResolveCopilotGithubToken,
    mockResolveCliPath: mockResolveCopilotCliPath,
    callName: 'callCopilot',
    keyOption: 'copilotGithubToken',
    keyLabel: 'resolved token',
    cliPathOption: 'copilotCliPath',
    model: 'claude-sonnet-4.6',
    resolvedKey: 'resolved-token',
    explicitKey: 'explicit-token',
    resolvedCliPath: '/custom/bin/copilot',
    imageLogMessage: 'Copilot provider does not support imageAttachments; ignoring',
  },
  {
    suiteName: 'CursorProvider',
    registryName: 'cursor',
    providerClass: CursorProvider,
    createProvider: () => new CursorProvider(),
    mockCall: mockCallCursor,
    mockCallCustom: mockCallCursorCustom,
    mockResolveKey: mockResolveCursorApiKey,
    mockResolveCliPath: mockResolveCursorCliPath,
    callName: 'callCursor',
    keyOption: 'cursorApiKey',
    keyLabel: 'resolved cursor key',
    cliPathOption: 'cursorCliPath',
    model: 'cursor/gpt-5',
    resolvedKey: 'resolved-key',
    explicitKey: 'explicit-key',
    resolvedCliPath: '/custom/bin/cursor-agent',
    imageLogMessage: 'Cursor provider does not support imageAttachments; ignoring',
  },
];

for (const c of cases) {
  describe(c.suiteName, () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockResolveCopilotGithubToken.mockReturnValue(undefined);
      mockResolveCopilotCliPath.mockReturnValue(undefined);
      mockResolveCursorApiKey.mockReturnValue(undefined);
      mockResolveCursorCliPath.mockReturnValue(undefined);
      mockLoadProjectConfig.mockReturnValue({});
    });

    it('should mark supportsStructuredOutput as false', () => {
      const provider = c.createProvider() as { supportsStructuredOutput?: boolean };
      expect(provider.supportsStructuredOutput).toBe(false);
    });

    it(`should pass model/session/permission and ${c.keyLabel} to ${c.callName}`, async () => {
      c.mockResolveKey.mockReturnValue(c.resolvedKey);
      c.mockCall.mockResolvedValue(doneResponse('coder'));

      const provider = c.createProvider();
      const agent = provider.setup({ name: 'coder' });

      await agent.call('implement', {
        cwd: '/tmp/work',
        model: c.model,
        sessionId: 'sess-1',
        permissionMode: 'full',
      });

      expect(c.mockCall).toHaveBeenCalledWith(
        'coder',
        'implement',
        expect.objectContaining({
          cwd: '/tmp/work',
          model: c.model,
          sessionId: 'sess-1',
          permissionMode: 'full',
          [c.keyOption]: c.resolvedKey,
        }),
      );
    });

    it(`should prefer explicit ${c.keyOption} over resolver`, async () => {
      c.mockResolveKey.mockReturnValue(c.resolvedKey);
      c.mockCall.mockResolvedValue(doneResponse('coder'));

      const provider = c.createProvider();
      const agent = provider.setup({ name: 'coder' });

      await agent.call('implement', {
        cwd: '/tmp/work',
        [c.keyOption]: c.explicitKey,
      });

      expect(c.mockCall).toHaveBeenCalledWith(
        'coder',
        'implement',
        expect.objectContaining({
          [c.keyOption]: c.explicitKey,
        }),
      );
    });

    it(`should delegate to ${c.callName}Custom when systemPrompt is specified`, async () => {
      c.mockCallCustom.mockResolvedValue(doneResponse('reviewer'));

      const provider = c.createProvider();
      const agent = provider.setup({
        name: 'reviewer',
        systemPrompt: 'You are a strict reviewer.',
      });

      await agent.call('review this', {
        cwd: '/tmp/work',
      });

      expect(c.mockCallCustom).toHaveBeenCalledWith(
        'reviewer',
        'review this',
        'You are a strict reviewer.',
        expect.objectContaining({ cwd: '/tmp/work' }),
      );
    });

    it(`should pass resolved ${c.cliPathOption} to ${c.callName}`, async () => {
      c.mockResolveCliPath.mockReturnValue(c.resolvedCliPath);
      c.mockCall.mockResolvedValue(doneResponse('coder'));

      const provider = c.createProvider();
      const agent = provider.setup({ name: 'coder' });

      await agent.call('implement', { cwd: '/tmp/work' });

      expect(c.mockCall).toHaveBeenCalledWith(
        'coder',
        'implement',
        expect.objectContaining({
          [c.cliPathOption]: c.resolvedCliPath,
        }),
      );
    });

    it(`should pass childProcessEnv to ${c.callName}`, async () => {
      c.mockCall.mockResolvedValue(doneResponse('coder'));
      const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };

      const provider = c.createProvider();
      const agent = provider.setup({ name: 'coder' });

      await agent.call('implement', {
        cwd: '/tmp/work',
        childProcessEnv,
      });

      expect(c.mockCall).toHaveBeenCalledWith(
        'coder',
        'implement',
        expect.objectContaining({ childProcessEnv }),
      );
    });

    it(`should pass undefined ${c.cliPathOption} when resolver returns undefined`, async () => {
      c.mockResolveCliPath.mockReturnValue(undefined);
      c.mockCall.mockResolvedValue(doneResponse('coder'));

      const provider = c.createProvider();
      const agent = provider.setup({ name: 'coder' });

      await agent.call('implement', { cwd: '/tmp/work' });

      const opts = c.mockCall.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(opts[c.cliPathOption]).toBeUndefined();
    });

    it('should ignore unsupported image attachments and log only when non-empty', async () => {
      c.mockCall.mockResolvedValue(doneResponse('coder'));

      const provider = c.createProvider();
      const agent = provider.setup({ name: 'coder' });

      await agent.call('implement', {
        cwd: '/tmp/work',
        imageAttachments: [{ placeholder: '[Image #1]', path: '/tmp/image-1.png' }],
      });

      const options = c.mockCall.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(options.imageAttachments).toBeUndefined();
      expect(mockLogger.info).toHaveBeenCalledWith(c.imageLogMessage);

      mockLogger.info.mockClear();
      await agent.call('implement', { cwd: '/tmp/work', imageAttachments: [] });
      await agent.call('implement', { cwd: '/tmp/work' });

      expect(mockLogger.info).not.toHaveBeenCalledWith(c.imageLogMessage);
    });
  });
}

describe('CopilotProvider strict internal-agent isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject strict internal-agent isolation before invoking Copilot', async () => {
    const provider = new CopilotProvider();
    const agent = provider.setup({ name: 'selector' });

    await expect(agent.call('select reviewers', {
      cwd: '/tmp/work',
      sessionId: 'ambient-session',
      internalAgentIsolation: 'strict-readonly',
      permissionMode: 'readonly',
      allowedTools: [],
      mcpServers: {},
    })).rejects.toThrow(
      'Provider "copilot" does not support strict internal-agent isolation required by dynamic parallel selector',
    );

    expect(mockCallCopilot).not.toHaveBeenCalled();
    expect(mockCallCopilotCustom).not.toHaveBeenCalled();
  });

  it('should declare strict internal-agent isolation as unsupported', () => {
    expect(new CopilotProvider().supportsStrictInternalAgentIsolation).toBe(false);
  });
});

for (const c of cases) {
  describe(`ProviderRegistry with ${c.suiteName.replace('Provider', '')}`, () => {
    it(`should return ${c.suiteName.replace('Provider', '')} provider from registry`, () => {
      ProviderRegistry.resetInstance();
      const registry = ProviderRegistry.getInstance();
      const provider = registry.get(c.registryName);

      expect(provider).toBeDefined();
      expect(provider).toBeInstanceOf(c.providerClass);
    });
  });
}
