import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USAGE_MISSING_REASONS } from '../core/logging/contracts.js';

const {
  mockCallClaudeTerminal,
  mockResolveClaudeCliPath,
} = vi.hoisted(() => ({
  mockCallClaudeTerminal: vi.fn(),
  mockResolveClaudeCliPath: vi.fn(),
}));

vi.mock('../infra/claude-terminal/client.js', () => ({
  callClaudeTerminal: mockCallClaudeTerminal,
}));

vi.mock('../infra/config/index.js', () => ({
  resolveClaudeCliPath: mockResolveClaudeCliPath,
  loadProjectConfig: vi.fn(() => ({})),
}));

import { ClaudeTerminalProvider } from '../infra/providers/claude-terminal.js';

const SCHEMA = {
  type: 'object',
  properties: { decision: { type: 'string' } },
  required: ['decision'],
  additionalProperties: false,
};

function doneResponse(structuredOutput?: Record<string, unknown>) {
  return {
    persona: 'coder',
    status: 'done' as const,
    content: 'ok',
    timestamp: new Date(),
    structuredOutput,
  };
}

describe('ClaudeTerminalProvider wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveClaudeCliPath.mockReturnValue('/opt/claude/bin/claude');
    mockCallClaudeTerminal.mockResolvedValue(doneResponse({ decision: 'approved' }));
  });

  it('Given provider instance, When supportsStructuredOutput is read, Then it is true', () => {
    const provider = new ClaudeTerminalProvider();

    expect(provider.supportsStructuredOutput).toBe(true);
  });

  it('Given ProviderCallOptions, When call is invoked, Then workflow options are mapped to terminal call options', async () => {
    const provider = new ClaudeTerminalProvider();
    const agent = provider.setup({ name: 'coder' });
    const controller = new AbortController();
    const onStream = vi.fn();
    const onPermissionRequest = vi.fn();
    const onAskUserQuestion = vi.fn();
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };
    const mcpServers = {
      docs: { type: 'stdio' as const, command: 'docs-mcp', args: ['serve'] },
    };

    const result = await agent.call('implement this', {
      cwd: '/tmp/worktree',
      abortSignal: controller.signal,
      sessionId: 'session-123',
      model: 'opus',
      allowedTools: ['Read', 'Edit', 'Bash'],
      mcpServers,
      maxTurns: 4,
      permissionMode: 'edit',
      bypassPermissions: true,
      providerOptions: {
        claude: {
          effort: 'high',
          allowedTools: ['Read'],
        },
        claudeTerminal: {
          backend: 'tmux',
          timeoutMs: 900000,
          keepSession: false,
          transcriptPollIntervalMs: 500,
        },
      } as never,
      onStream,
      onPermissionRequest,
      onAskUserQuestion,
      outputSchema: SCHEMA,
      childProcessEnv,
    });

    expect(result.structuredOutput).toEqual({ decision: 'approved' });
    expect(mockCallClaudeTerminal).toHaveBeenCalledWith('coder', 'implement this', expect.objectContaining({
      cwd: '/tmp/worktree',
      abortSignal: controller.signal,
      sessionId: 'session-123',
      model: 'opus',
      effort: 'high',
      allowedTools: ['Read', 'Edit', 'Bash'],
      mcpServers,
      maxTurns: 4,
      permissionMode: 'edit',
      bypassPermissions: true,
      backend: 'tmux',
      timeoutMs: 900000,
      keepSession: false,
      transcriptPollIntervalMs: 500,
      onStream,
      onPermissionRequest,
      onAskUserQuestion,
      outputSchema: SCHEMA,
      pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
      childProcessEnv,
    }));
  });

  it('Given maxTurns is omitted, When call is invoked, Then terminal call options omit maxTurns property', async () => {
    const provider = new ClaudeTerminalProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement this', {
      cwd: '/tmp/worktree',
      model: 'opus',
    });

    const terminalOptions = mockCallClaudeTerminal.mock.calls[0]?.[2];
    expect(Object.prototype.hasOwnProperty.call(terminalOptions, 'maxTurns')).toBe(false);
  });

  it('Given claude sandbox provider option, When call is invoked, Then terminal provider ignores sandbox and continues', async () => {
    const provider = new ClaudeTerminalProvider();
    const agent = provider.setup({ name: 'coder' });

    const result = await agent.call('implement this', {
      cwd: '/tmp/worktree',
      sessionId: 'session-123',
      providerOptions: {
        claude: {
          sandbox: {
            allowUnsandboxedCommands: true,
          },
        },
      } as never,
    });

    expect(result.status).toBe('done');
    expect(mockCallClaudeTerminal).toHaveBeenCalledWith('coder', 'implement this', expect.objectContaining({
      cwd: '/tmp/worktree',
      sessionId: 'session-123',
    }));
    const terminalOptions = mockCallClaudeTerminal.mock.calls[0]?.[2];
    expect(Object.prototype.hasOwnProperty.call(terminalOptions, 'sandbox')).toBe(false);
  });

  it('Given incompatible claude effort, When call is invoked, Then provider error is returned before terminal client call', async () => {
    const provider = new ClaudeTerminalProvider();
    const agent = provider.setup({ name: 'coder' });

    const result = await agent.call('implement this', {
      cwd: '/tmp/worktree',
      sessionId: 'session-123',
      model: 'claude-sonnet-4-5',
      providerOptions: {
        claude: {
          effort: 'xhigh',
        },
      } as never,
    });

    expect(mockCallClaudeTerminal).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      persona: 'coder',
      status: 'error',
      sessionId: 'session-123',
      failureCategory: 'provider_error',
      providerUsage: {
        usageMissing: true,
        reason: USAGE_MISSING_REASONS.NOT_SUPPORTED_BY_PROVIDER,
      },
    });
    expect(result.error).toContain('Claude terminal provider failed:');
    expect(result.error).toContain("provider_options.claude.effort 'xhigh' is not supported");
  });

  it('Given terminal client rejects, When call is invoked, Then provider error response is returned', async () => {
    mockCallClaudeTerminal.mockRejectedValueOnce(new Error('terminal failed'));
    const provider = new ClaudeTerminalProvider();
    const agent = provider.setup({ name: 'coder' });

    const result = await agent.call('implement this', {
      cwd: '/tmp/worktree',
      sessionId: 'session-123',
      model: 'opus',
    });

    expect(mockCallClaudeTerminal).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      persona: 'coder',
      status: 'error',
      sessionId: 'session-123',
      content: 'Claude terminal provider failed: terminal failed',
      error: 'Claude terminal provider failed: terminal failed',
      failureCategory: 'provider_error',
    });
  });

  it('Given systemPrompt setup, When call is invoked, Then systemPrompt is passed to terminal client', async () => {
    const provider = new ClaudeTerminalProvider();
    const agent = provider.setup({ name: 'judge', systemPrompt: 'You are a judge.' });

    await agent.call('judge this', {
      cwd: '/tmp/worktree',
    });

    expect(mockCallClaudeTerminal).toHaveBeenCalledWith('judge', 'judge this', expect.objectContaining({
      systemPrompt: 'You are a judge.',
    }));
  });
});
