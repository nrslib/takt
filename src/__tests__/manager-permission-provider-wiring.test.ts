import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCallOptions } from '../infra/providers/types.js';
import type { ClaudeSpawnOptions, ToolPermissionDecisionHandler } from '../infra/claude/types.js';
import type { CodexCallOptions } from '../infra/codex/types.js';
import { CodexProvider } from '../infra/providers/codex.js';
import { ClaudeProvider } from '../infra/providers/claude.js';

const doubles = vi.hoisted(() => ({ execute: vi.fn(), codex: vi.fn(), codexCustom: vi.fn() }));
vi.mock('../infra/claude/process.js', () => ({ executeClaudeCli: doubles.execute }));
vi.mock('../infra/codex/index.js', () => ({ callCodex: doubles.codex, callCodexCustom: doubles.codexCustom }));
vi.mock('../infra/config/index.js', () => ({
  resolveAnthropicApiKey: () => undefined, resolveOpenaiApiKey: () => undefined, resolveCodexCliPath: () => '/fixture/codex', resolveClaudeCliPath: () => '/fixture/claude',
}));

beforeEach(() => {
  vi.resetAllMocks();
  doubles.execute.mockResolvedValue({ success: true, content: 'fixture reply' });
  const response = { persona: 'manager', status: 'done', content: 'fixture reply', timestamp: new Date() };
  doubles.codex.mockResolvedValue(response); doubles.codexCustom.mockResolvedValue(response);
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


describe('Codex manager permission handler transfer', () => {
  it.each([undefined, 'manager system prompt'])('preserves the handler and request through the Codex provider (system prompt: %s)', async (systemPrompt) => {
    const onToolPermissionDecision = vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue({ decision: 'deny', reason: 'fixture denial' });
    const agent = new CodexProvider().setup({ name: 'manager', systemPrompt });
    await agent.call('inspect', { cwd: '/fixture/configured', permissionMode: 'full', onToolPermissionDecision });
    const calls = systemPrompt === undefined ? doubles.codex.mock.calls : doubles.codexCustom.mock.calls;
    expect(calls).toHaveLength(1);
    const options = calls[0]![systemPrompt === undefined ? 2 : 3] as CodexCallOptions & { onToolPermissionDecision?: ToolPermissionDecisionHandler };
    expect(options.onToolPermissionDecision).toBeTypeOf('function');
    const request = { toolName: 'apply_patch', toolInput: { command: 'fixture patch' }, cwd: '/fixture/actual-tool', abortSignal: new AbortController().signal };
    await expect(options.onToolPermissionDecision!(request)).resolves.toEqual({ decision: 'deny', reason: 'fixture denial' });
    expect(onToolPermissionDecision).toHaveBeenCalledExactlyOnceWith(request);
  });

  it('keeps ordinary Codex task calls free of a manager handler', async () => {
    await new CodexProvider().setup({ name: 'coder' }).call('inspect', { cwd: '/fixture' });
    expect(doubles.codex.mock.calls[0]![2].onToolPermissionDecision).toBeUndefined();
  });
});
