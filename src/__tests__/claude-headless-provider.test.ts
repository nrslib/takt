import { describe, it, expect } from 'vitest';
import { ClaudeHeadlessProvider } from '../infra/providers/claude-headless.js';
import { ProviderRegistry } from '../infra/providers/index.js';

describe('ClaudeHeadlessProvider', () => {
  it('should throw when claudeAgent is specified', () => {
    const provider = new ClaudeHeadlessProvider();

    expect(() => provider.setup({
      name: 'test',
      claudeAgent: 'some-agent',
    })).toThrow(
      'claudeAgent and claudeSkill require provider claude-sdk; headless claude does not support them.',
    );
  });

  it('should throw when claudeSkill is specified', () => {
    const provider = new ClaudeHeadlessProvider();

    expect(() => provider.setup({
      name: 'test',
      claudeSkill: 'some-skill',
    })).toThrow(
      'claudeAgent and claudeSkill require provider claude-sdk; headless claude does not support them.',
    );
  });

  it('should return a ProviderAgent when setup with name only', () => {
    const provider = new ClaudeHeadlessProvider();
    const agent = provider.setup({ name: 'test' });

    expect(agent).toBeDefined();
    expect(typeof agent.call).toBe('function');
  });

  it('should return a ProviderAgent when setup with systemPrompt', () => {
    const provider = new ClaudeHeadlessProvider();
    const agent = provider.setup({
      name: 'test',
      systemPrompt: 'You are a helpful assistant.',
    });

    expect(agent).toBeDefined();
    expect(typeof agent.call).toBe('function');
  });
});

describe('ProviderRegistry with Claude headless', () => {
  it('should return ClaudeHeadlessProvider for claude', () => {
    ProviderRegistry.resetInstance();
    const registry = ProviderRegistry.getInstance();
    const provider = registry.get('claude');

    expect(provider).toBeDefined();
    expect(provider).toBeInstanceOf(ClaudeHeadlessProvider);
  });

  it('should setup an agent through the registry', () => {
    ProviderRegistry.resetInstance();
    const registry = ProviderRegistry.getInstance();
    const provider = registry.get('claude');
    const agent = provider.setup({ name: 'test' });

    expect(agent).toBeDefined();
    expect(typeof agent.call).toBe('function');
  });
});
