import { describe, expect, it } from 'vitest';
import { isProviderType, PROVIDER_TYPES } from '../shared/types/provider.js';

describe('PROVIDER_TYPES', () => {
  it('contains all expected provider identifiers', () => {
    expect(PROVIDER_TYPES).toContain('claude');
    expect(PROVIDER_TYPES).toContain('claude-sdk');
    expect(PROVIDER_TYPES).toContain('claude-terminal');
    expect(PROVIDER_TYPES).toContain('codex');
    expect(PROVIDER_TYPES).toContain('opencode');
    expect(PROVIDER_TYPES).toContain('cursor');
    expect(PROVIDER_TYPES).toContain('copilot');
    expect(PROVIDER_TYPES).toContain('kiro');
    expect(PROVIDER_TYPES).toContain('mock');
  });

  it('is a non-empty tuple', () => {
    expect(PROVIDER_TYPES.length).toBeGreaterThan(0);
  });
});

describe('isProviderType', () => {
  it('returns true for all known provider types', () => {
    for (const provider of PROVIDER_TYPES) {
      expect(isProviderType(provider)).toBe(true);
    }
  });

  it('returns false for unknown string values', () => {
    expect(isProviderType('unknown-provider')).toBe(false);
    expect(isProviderType('gpt-4')).toBe(false);
    expect(isProviderType('')).toBe(false);
    expect(isProviderType('CLAUDE')).toBe(false);
    expect(isProviderType('Claude')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isProviderType(null)).toBe(false);
    expect(isProviderType(undefined)).toBe(false);
    expect(isProviderType(42)).toBe(false);
    expect(isProviderType({})).toBe(false);
    expect(isProviderType([])).toBe(false);
    expect(isProviderType(true)).toBe(false);
  });

  it('returns false for a string that is a prefix of a valid provider', () => {
    expect(isProviderType('claud')).toBe(false);
    expect(isProviderType('claude-')).toBe(false);
    expect(isProviderType('code')).toBe(false);
  });

  it('acts as a type guard narrowing unknown to ProviderType', () => {
    const value: unknown = 'codex';
    if (isProviderType(value)) {
      // TypeScript should narrow to ProviderType here; this line verifies runtime behavior
      expect(value).toBe('codex');
    } else {
      throw new Error('Expected isProviderType to return true for "codex"');
    }
  });
});