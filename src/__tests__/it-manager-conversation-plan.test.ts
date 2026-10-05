import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagerConversationPlan } from '../features/manager/conversationPlan.js';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { createGoalConfirmation } from '../features/manager/goalConfirmation.js';
import { resolveAssistantProviderModel } from '../features/interactive/assistantConfig.js';
import * as providers from '../infra/providers/index.js';
import { MockProvider } from '../infra/providers/mock.js';
import { makeProvider } from './test-helpers.js';
import type { ProviderAgent } from '../infra/providers/types.js';

const toolNames = ['takt_create_goal', 'takt_list_goals', 'takt_get_goal', 'takt_list_tasks', 'takt_get_run'];

describe('manager conversation configuration and provider boundary', () => {
  let cwd: string;

  beforeEach(() => {
    const root = join(process.cwd(), '.tmp');
    mkdirSync(root, { recursive: true });
    cwd = mkdtempSync(join(root, 'manager-plan-'));
    mkdirSync(join(cwd, '.takt'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmodel: legacy-manager\nlanguage: en\n');
  });

  afterEach(() => { vi.restoreAllMocks(); rmSync(cwd, { recursive: true, force: true }); });

  it.each([
    ['legacy configuration', false, {}, 'mock'],
    ['runtime assistant profile', true, {}, 'mock'],
    ['CLI model override', true, { model: 'cli-model' }, 'mock'],
    ['CLI provider override', true, { provider: 'mock' as const }, 'claude-sdk'],
  ])('uses the assistant resolver for %s', (_description, runtime, overrides, profileProvider) => {
    if (runtime) {
      writeFileSync(join(cwd, '.takt', 'config.yaml'), 'language: en\n');
      writeFileSync(join(cwd, '.takt', 'runtime.yaml'), [
        'version: 1', 'provider:', '  profiles:', '    assistant-profile:',
        `      provider: ${profileProvider}`, '      model: runtime-manager',
        '  defaults:', '    profile: assistant-profile',
        '  targets:', '    internal_agents:', '      assistant:', '        profile: assistant-profile',
      ].join('\n'));
    }
    const expected = resolveAssistantProviderModel(cwd, overrides);

    const plan = createManagerConversationPlan(cwd, { language: 'en', ...overrides });

    expect(plan.ctx.providerType).toBe(expected.provider);
    expect(plan.ctx.model).toBe(expected.model);
  });

  it('preserves nonpermission runtime options while imposing manager restrictions', () => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'language: en\n');
    writeFileSync(join(cwd, '.takt', 'runtime.yaml'), [
      'version: 1', 'provider:', '  profiles:', '    assistant-profile:',
      '      provider: claude-sdk', '      model: runtime-manager',
      '      options:', '        effort: high',
      '  defaults:', '    profile: assistant-profile',
      '  targets:', '    internal_agents:', '      assistant:', '        profile: assistant-profile',
    ].join('\n'));
    const expected = resolveAssistantProviderModel(cwd);

    const plan = createManagerConversationPlan(cwd, { language: 'en' });

    expect(plan.ctx.providerType).toBe(expected.provider);
    expect(plan.ctx.model).toBe(expected.model);
    expect(expected.providerOptions?.claude?.effort).toBe('high');
    expect(plan.ctx.providerOptions?.claude?.effort).toBe(expected.providerOptions?.claude?.effort);
  });

  it.each(['ja', 'en'] as const)('loads the %s manager persona and instruction into the actual provider prompt', async (language) => {
    const persona = readFileSync(join(process.cwd(), 'builtins', language, 'facets', 'personas', 'manager.md'), 'utf8');
    const instruction = readFileSync(join(process.cwd(), 'builtins', language, 'facets', 'instructions', 'manager.md'), 'utf8');
    const provider = new MockProvider();
    const call = vi.fn<ProviderAgent['call']>().mockResolvedValue({ persona: 'manager', status: 'done', timestamp: new Date('2026-10-05T12:00:00Z'), content: JSON.stringify({ message: 'question', summary: null }), structuredOutput: { message: 'question', summary: null } });
    const setup = vi.spyOn(provider, 'setup').mockReturnValue({ call });
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider);
    const plan = createManagerConversationPlan(cwd, { language });
    const session = createManagerConversationSession({ cwd, plan, confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() } });

    await session.handleUserMessage({ text: 'ゴールを相談したい' });

    expect(persona.trim().length).toBeGreaterThan(0);
    expect(instruction.trim().length).toBeGreaterThan(0);
    expect(setup.mock.calls[0]?.[0].systemPrompt).toContain(persona.trim());
    expect(setup.mock.calls[0]?.[0].systemPrompt).toContain(instruction.trim());
  });

  it('passes only file reading and the five manager MCP tools to the mock provider', async () => {
    const provider = new MockProvider();
    const call = vi.fn<ProviderAgent['call']>().mockResolvedValue({ persona: 'manager', status: 'done', timestamp: new Date('2026-10-05T12:00:00Z'), content: JSON.stringify({ message: 'question', summary: null }), structuredOutput: { message: 'question', summary: null } });
    vi.spyOn(provider, 'setup').mockReturnValue({ call });
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider);
    const plan = createManagerConversationPlan(cwd, { language: 'en' });
    const confirmation = createGoalConfirmation(cwd);
    const session = createManagerConversationSession({ cwd, plan, confirmation, mcpClient: { callTool: vi.fn() } });

    await session.handleUserMessage({ text: 'ソースを読み、既存のゴールを確認してください' });

    expect(call).toHaveBeenCalledTimes(1);
    const options = call.mock.calls[0]![1];
    expect([...(options.allowedTools ?? [])].sort()).toEqual(['Read', ...toolNames.map((name) => `mcp__takt__${name}`)].sort());
    expect(options.permissionMode).toBe('readonly');
    expect(options.outputSchema).toBeDefined();
    expect(options.sessionId).toBeUndefined();
    expect(JSON.stringify(call.mock.calls).includes('PRIVATE KEY')).toBe(false);
  });

  it('rejects a provider that cannot enforce the requested restrictions before setup or conversation', () => {
    const setup = vi.fn();
    const provider = makeProvider({
      supportsStructuredOutput: true, supportedMcpTransports: new Set(['stdio']),
      supportsStrictToolAllowlist: false,
      supportsStrictMcpConfig: false, supportsPermissionControls: () => false, setup,
    });
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider);

    expect(() => createManagerConversationPlan(cwd, { language: 'en' })).toThrow();
    expect(setup).not.toHaveBeenCalled();
  });

  it.each(['codex'] as const)('rejects unsupported %s restrictions before provider setup', (provider) => {
    const instance = providers.getProvider(provider);
    const setup = vi.spyOn(instance, 'setup');
    expect(() => createManagerConversationPlan(cwd, { provider })).toThrow('cannot enforce');
    expect(setup).not.toHaveBeenCalled();
  });

  it('accepts OpenCode with verified strict tool capabilities', () => {
    const plan = createManagerConversationPlan(cwd, { provider: 'opencode', model: 'probe/probe' });
    expect(plan.ctx.providerType).toBe('opencode');
    expect(plan.ctx.model).toBe('probe/probe');
    expect([...plan.strategy.allowedTools].sort()).toEqual(['Read', ...toolNames.map((name) => `mcp__takt__${name}`)].sort());
  });

  it('rejects permission-widening provider options', () => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nprovider_options:\n  claude:\n    allowed_tools: [Read, Bash]\n');
    expect(() => createManagerConversationPlan(cwd, {})).toThrow('conflict');
  });

  it('rejects a capability override that exposes shell commands', () => {
    mkdirSync(join(cwd, '.takt', 'provider-options'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'provider-options', 'manager.yaml'), 'claude:\n  allowed_tools: [Read, Bash]\n');
    expect(() => createManagerConversationPlan(cwd, {})).toThrow('do not preserve');
  });
});
