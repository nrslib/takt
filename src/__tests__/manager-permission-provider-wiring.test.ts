import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCallOptions } from '../infra/providers/types.js';
import type { ClaudeSpawnOptions, ToolPermissionDecisionHandler } from '../infra/claude/types.js';
import { ClaudeProvider } from '../infra/providers/claude.js';

const doubles = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../infra/claude/process.js', () => ({ executeClaudeCli: doubles.execute }));
vi.mock('../infra/config/index.js', () => ({
  resolveAnthropicApiKey: () => undefined, resolveClaudeCliPath: () => '/fixture/claude',
}));

beforeEach(() => {
  vi.resetAllMocks();
  doubles.execute.mockResolvedValue({ success: true, content: 'fixture reply' });
});

describe('manager permission handler provider and client transfer', () => {
  it.each([undefined, 'manager system prompt'])('transfers the handler through provider and client conversion (system prompt: %s)', async (systemPrompt) => {
    const onToolPermissionDecision = vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue({ decision: 'deny', reason: 'fixture denial' });
    const options: ProviderCallOptions & { onToolPermissionDecision: ToolPermissionDecisionHandler } = {
      cwd: '/fixture/configured', permissionMode: 'full', onToolPermissionDecision,
    };
    const agent = new ClaudeProvider().setup({ name: 'manager', systemPrompt });

    await agent.call('inspect', options);

    expect(doubles.execute).toHaveBeenCalledOnce();
    const spawn = doubles.execute.mock.calls[0]![1] as ClaudeSpawnOptions;
    expect(spawn.onToolPermissionDecision).toBeTypeOf('function');
    const abortSignal = new AbortController().signal;
    const request = { toolName: 'Bash', toolInput: { command: 'pwd' }, cwd: '/fixture/actual-tool', abortSignal };
    await expect(spawn.onToolPermissionDecision!(request)).resolves.toEqual({ decision: 'deny', reason: 'fixture denial' });
    expect(onToolPermissionDecision).toHaveBeenCalledExactlyOnceWith(request);
  });
  it('keeps calls without a handler unchanged', async () => {
    await new ClaudeProvider().setup({ name: 'coder' }).call('inspect', { cwd: '/fixture' });
    const spawn = doubles.execute.mock.calls[0]![1] as ClaudeSpawnOptions;
    expect(spawn.onToolPermissionDecision).toBeUndefined();
  });
});
