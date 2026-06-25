/**
 * Tests for exec config override logic (applyExecOverrides).
 *
 * Covers:
 * - Provider/model overrides apply consistently to session, workers, and judges
 * - Effort is re-resolved when provider changes
 * - No-op when overrides are empty
 */

import { describe, it, expect } from 'vitest';
import { applyExecOverrides } from '../features/exec/configOps.js';
import type { ExecConfig } from '../features/exec/types.js';

function createTestConfig(): ExecConfig {
  return {
    session: { provider: 'claude', model: 'opus', effort: 'high' },
    replan: { instruction: 'exec-replan', knowledge: [], policy: [] },
    workers: [
      { name: 'w1', provider: 'claude', model: 'sonnet', effort: 'high', instruction: 'exec-worker', knowledge: [], policy: [] },
    ],
    judges: [
      { name: 'j1', provider: 'claude', model: 'opus', effort: 'high', instruction: 'exec-judge', knowledge: [], policy: [] },
    ],
    loop: { smallThreshold: 3, largeThreshold: 2, maxSteps: 20 },
  };
}

describe('applyExecOverrides', () => {
  it('should apply provider override consistently to session, workers, and judges', () => {
    const config = createTestConfig();

    const result = applyExecOverrides(config, { provider: 'codex' });

    expect(result.session.provider).toBe('codex');
    expect(result.workers[0]!.provider).toBe('codex');
    expect(result.judges[0]!.provider).toBe('codex');
  });

  it('should apply model override consistently to session, workers, and judges', () => {
    const config = createTestConfig();

    const result = applyExecOverrides(config, { model: 'haiku' });

    expect(result.session.model).toBe('haiku');
    expect(result.workers[0]!.model).toBe('haiku');
    expect(result.judges[0]!.model).toBe('haiku');
  });

  it('should re-resolve effort when provider changes', () => {
    const config = createTestConfig();

    const result = applyExecOverrides(config, { provider: 'codex' });

    // codex supports 'high' effort — verify with a fixed literal, not the function under test
    expect(result.session.effort).toBe('high');
    expect(result.workers[0]!.effort).toBe('high');
    expect(result.judges[0]!.effort).toBe('high');
  });

  it('should return original config when no overrides provided', () => {
    const config = createTestConfig();

    const result = applyExecOverrides(config, undefined);

    expect(result).toBe(config);
  });

  it('should return original config when overrides have no provider or model', () => {
    const config = createTestConfig();

    const result = applyExecOverrides(config, {});

    expect(result).toBe(config);
  });

  it('should not mutate original config', () => {
    const config = createTestConfig();
    const originalProvider = config.session.provider;

    applyExecOverrides(config, { provider: 'codex' });

    expect(config.session.provider).toBe(originalProvider);
  });
});
