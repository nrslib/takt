/**
 * Unit tests for normalizeRuntime() shared normalizer function.
 *
 * Tests dedup, empty-to-undefined normalization, and passthrough behavior.
 */

import { describe, it, expect } from 'vitest';
import { normalizeRuntime } from '../infra/config/configNormalizers.js';

describe('normalizeRuntime', () => {
  it('should return undefined when input is undefined', () => {
    const result = normalizeRuntime(undefined);
    expect(result).toBeUndefined();
  });

  it('should return undefined when prepare is not specified', () => {
    const result = normalizeRuntime({});
    expect(result).toBeUndefined();
  });

  it('should return undefined when prepare is undefined', () => {
    const result = normalizeRuntime({ prepare: undefined });
    expect(result).toBeUndefined();
  });

  it('should return undefined when prepare is empty array', () => {
    const result = normalizeRuntime({ prepare: [] });
    expect(result).toBeUndefined();
  });

  it('should pass through single preset entry', () => {
    const result = normalizeRuntime({ prepare: ['node'] });
    expect(result).toEqual({ prepare: ['node'] });
  });

  it('should pass through multiple preset entries', () => {
    const result = normalizeRuntime({ prepare: ['node', 'gradle'] });
    expect(result).toEqual({ prepare: ['node', 'gradle'] });
  });

  it('should pass through custom script paths', () => {
    const result = normalizeRuntime({ prepare: ['./setup.sh'] });
    expect(result).toEqual({ prepare: ['./setup.sh'] });
  });

  it('should deduplicate repeated entries', () => {
    const result = normalizeRuntime({ prepare: ['node', 'node'] });
    expect(result).toEqual({ prepare: ['node'] });
  });

  it('should deduplicate while preserving first-occurrence order', () => {
    const result = normalizeRuntime({ prepare: ['gradle', 'node', 'gradle'] });
    expect(result).toEqual({ prepare: ['gradle', 'node'] });
  });

  it('should handle mixed presets and custom scripts', () => {
    const result = normalizeRuntime({ prepare: ['node', 'gradle', './custom-setup.sh'] });
    expect(result).toEqual({ prepare: ['node', 'gradle', './custom-setup.sh'] });
  });
});
