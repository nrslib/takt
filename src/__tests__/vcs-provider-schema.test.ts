/**
 * Tests for vcs_provider field in ProjectConfigSchema.
 *
 * Validates that the schema correctly accepts 'github' and 'gitlab',
 * rejects invalid values, and treats the field as optional.
 */

import { describe, it, expect } from 'vitest';
import { ProjectConfigSchema } from '../core/models/index.js';

describe('ProjectConfigSchema vcs_provider', () => {
  it('vcs_provider: "github" を受け入れる', () => {
    // Given
    const config = { vcs_provider: 'github' };

    // When
    const result = ProjectConfigSchema.safeParse(config);

    // Then
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vcs_provider).toBe('github');
    }
  });

  it('vcs_provider: "gitlab" を受け入れる', () => {
    // Given
    const config = { vcs_provider: 'gitlab' };

    // When
    const result = ProjectConfigSchema.safeParse(config);

    // Then
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vcs_provider).toBe('gitlab');
    }
  });

  it('vcs_provider が未指定の場合は省略可能', () => {
    // Given
    const config = {};

    // When
    const result = ProjectConfigSchema.safeParse(config);

    // Then
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vcs_provider).toBeUndefined();
    }
  });

  it('無効な vcs_provider 値を拒否する', () => {
    // Given
    const config = { vcs_provider: 'bitbucket' };

    // When
    const result = ProjectConfigSchema.safeParse(config);

    // Then
    expect(result.success).toBe(false);
  });

  it('vcs_provider に空文字を拒否する', () => {
    // Given
    const config = { vcs_provider: '' };

    // When
    const result = ProjectConfigSchema.safeParse(config);

    // Then
    expect(result.success).toBe(false);
  });

  it('.strict() により未知のフィールドを拒否する（vcs_provider の typo 検出）', () => {
    // Given
    const config = { vcs_provder: 'github' };

    // When
    const result = ProjectConfigSchema.safeParse(config);

    // Then
    expect(result.success).toBe(false);
  });
});
