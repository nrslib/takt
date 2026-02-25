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

  it('should accept concurrency in ProjectConfigSchema', () => {
    const result = ProjectConfigSchema.parse({ concurrency: 3 });
    expect(result.concurrency).toBe(3);
  });

  it('should accept submodules all in ProjectConfigSchema', () => {
    const result = ProjectConfigSchema.parse({ submodules: 'ALL' });
    expect(result.submodules).toBe('ALL');
  });

  it('should accept explicit submodule path list in ProjectConfigSchema', () => {
    const result = ProjectConfigSchema.parse({ submodules: ['path/a', 'path/b'] });
    expect(result.submodules).toEqual(['path/a', 'path/b']);
  });

  it('should accept with_submodules in ProjectConfigSchema', () => {
    const result = ProjectConfigSchema.parse({ with_submodules: true });
    expect(result.with_submodules).toBe(true);
  });

  it('should reject wildcard path in ProjectConfigSchema submodules', () => {
    expect(() => ProjectConfigSchema.parse({ submodules: ['libs/*'] })).toThrow();
  });

  it('should reject non-all string in ProjectConfigSchema submodules', () => {
    expect(() => ProjectConfigSchema.parse({ submodules: 'libs' })).toThrow();
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
