/**
 * Tests for OpenCode provider implementation
 */

import { describe, it, expect } from 'vitest';
import { OpenCodeProvider } from '../infra/providers/opencode.js';
import { ProviderRegistry } from '../infra/providers/index.js';

describe('OpenCodeProvider', () => {
  it('should throw when claudeAgent is specified', () => {
    const provider = new OpenCodeProvider();

    expect(() => provider.setup({
      name: 'test',
      claudeAgent: 'some-agent',
    })).toThrow('Claude Code agent calls are not supported by the OpenCode provider');
  });

  it('should throw when claudeSkill is specified', () => {
    const provider = new OpenCodeProvider();

    expect(() => provider.setup({
      name: 'test',
      claudeSkill: 'some-skill',
    })).toThrow('Claude Code skill calls are not supported by the OpenCode provider');
  });

  it('should return a ProviderAgent when setup with name only', () => {
    const provider = new OpenCodeProvider();
    const agent = provider.setup({ name: 'test' });

    expect(agent).toBeDefined();
    expect(typeof agent.call).toBe('function');
  });

  it('should return a ProviderAgent when setup with systemPrompt', () => {
    const provider = new OpenCodeProvider();
    const agent = provider.setup({
      name: 'test',
      systemPrompt: 'You are a helpful assistant.',
    });

    expect(agent).toBeDefined();
    expect(typeof agent.call).toBe('function');
  });
});

describe('ProviderRegistry with OpenCode', () => {
  it('should return OpenCode provider from registry', () => {
    ProviderRegistry.resetInstance();
    const registry = ProviderRegistry.getInstance();
    const provider = registry.get('opencode');

    expect(provider).toBeDefined();
    expect(provider).toBeInstanceOf(OpenCodeProvider);
  });

  it('should setup an agent through the registry', () => {
    ProviderRegistry.resetInstance();
    const registry = ProviderRegistry.getInstance();
    const provider = registry.get('opencode');
    const agent = provider.setup({ name: 'test' });

    expect(agent).toBeDefined();
    expect(typeof agent.call).toBe('function');
  });
});
