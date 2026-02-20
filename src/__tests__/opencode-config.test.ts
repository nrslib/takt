/**
 * Tests for OpenCode integration in schemas and global config
 */

import { describe, it, expect } from 'vitest';
import {
  GlobalConfigSchema,
  ProjectConfigSchema,
  CustomAgentConfigSchema,
  PieceMovementRawSchema,
  ParallelSubMovementRawSchema,
} from '../core/models/index.js';

describe('Schemas accept opencode provider', () => {
  it('should accept opencode in GlobalConfigSchema provider field', () => {
    const result = GlobalConfigSchema.parse({ provider: 'opencode' });
    expect(result.provider).toBe('opencode');
  });

  it('should accept opencode in GlobalConfigSchema persona_providers field', () => {
    const result = GlobalConfigSchema.parse({
      persona_providers: { coder: { provider: 'opencode' } },
    });
    expect(result.persona_providers).toEqual({ coder: { provider: 'opencode' } });
  });

  it('should accept opencode_api_key in GlobalConfigSchema', () => {
    const result = GlobalConfigSchema.parse({
      opencode_api_key: 'test-key-123',
    });
    expect(result.opencode_api_key).toBe('test-key-123');
  });

  it('should accept opencode in ProjectConfigSchema', () => {
    const result = ProjectConfigSchema.parse({ provider: 'opencode' });
    expect(result.provider).toBe('opencode');
  });

  it('should accept opencode in CustomAgentConfigSchema', () => {
    const result = CustomAgentConfigSchema.parse({
      name: 'test',
      prompt: 'You are a test agent',
      provider: 'opencode',
    });
    expect(result.provider).toBe('opencode');
  });

  it('should accept opencode in PieceMovementRawSchema', () => {
    const result = PieceMovementRawSchema.parse({
      name: 'test-movement',
      provider: 'opencode',
    });
    expect(result.provider).toBe('opencode');
  });

  it('should accept opencode in ParallelSubMovementRawSchema', () => {
    const result = ParallelSubMovementRawSchema.parse({
      name: 'sub-1',
      provider: 'opencode',
    });
    expect(result.provider).toBe('opencode');
  });

  it('should still accept existing providers (claude, codex, mock)', () => {
    for (const provider of ['claude', 'codex', 'mock']) {
      const result = GlobalConfigSchema.parse({ provider });
      expect(result.provider).toBe(provider);
    }
  });
});
