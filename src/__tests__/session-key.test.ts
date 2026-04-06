import { describe, it, expect } from 'vitest';
import { buildSessionKey } from '../core/piece/session-key.js';
import type { PieceMovement } from '../core/models/types.js';

function createMovement(overrides: Partial<PieceMovement> = {}): PieceMovement {
  return {
    name: 'test-movement',
    personaDisplayName: 'test',
    edit: false,
    instruction: '',
    passPreviousResponse: true,
    ...overrides,
  };
}

describe('buildSessionKey', () => {
  it('should use persona as base key when persona is set', () => {
    const step = createMovement({ persona: 'coder', name: 'implement' });
    expect(buildSessionKey(step)).toBe('coder');
  });

  it('should use name as base key when persona is not set', () => {
    const step = createMovement({ persona: undefined, name: 'plan' });
    expect(buildSessionKey(step)).toBe('plan');
  });

  it('should append provider when provider is specified', () => {
    const step = createMovement({ persona: 'coder', provider: 'claude' });
    expect(buildSessionKey(step)).toBe('coder:claude');
  });

  it('should use name with provider when persona is not set', () => {
    const step = createMovement({ persona: undefined, name: 'review', provider: 'codex' });
    expect(buildSessionKey(step)).toBe('review:codex');
  });

  it('should produce different keys for same persona with different providers', () => {
    const claudeStep = createMovement({ persona: 'coder', provider: 'claude', name: 'claude-eye' });
    const codexStep = createMovement({ persona: 'coder', provider: 'codex', name: 'codex-eye' });
    expect(buildSessionKey(claudeStep)).not.toBe(buildSessionKey(codexStep));
    expect(buildSessionKey(claudeStep)).toBe('coder:claude');
    expect(buildSessionKey(codexStep)).toBe('coder:codex');
  });

  it('should separate claude-sdk from headless claude in session key', () => {
    const sdkStep = createMovement({
      persona: 'coder',
      name: 'sdk-eye',
      provider: 'claude-sdk',
    });
    const headlessStep = createMovement({ persona: 'coder', provider: 'claude', name: 'cli-eye' });

    expect(buildSessionKey(sdkStep)).toBe('coder:claude-sdk');
    expect(buildSessionKey(headlessStep)).toBe('coder:claude');
    expect(buildSessionKey(sdkStep)).not.toBe(buildSessionKey(headlessStep));
  });

  it('should not append provider when provider is undefined', () => {
    const step = createMovement({ persona: 'coder', provider: undefined });
    expect(buildSessionKey(step)).toBe('coder');
  });
});
