/**
 * Tests for OpenCode type definitions and permission mapping
 */

import { describe, it, expect } from 'vitest';
import { mapToOpenCodePermissionReply } from '../infra/opencode/types.js';
import type { PermissionMode } from '../core/models/index.js';

describe('mapToOpenCodePermissionReply', () => {
  it('should map readonly to reject', () => {
    expect(mapToOpenCodePermissionReply('readonly')).toBe('reject');
  });

  it('should map edit to once', () => {
    expect(mapToOpenCodePermissionReply('edit')).toBe('once');
  });

  it('should map full to always', () => {
    expect(mapToOpenCodePermissionReply('full')).toBe('always');
  });

  it('should handle all PermissionMode values', () => {
    const modes: PermissionMode[] = ['readonly', 'edit', 'full'];
    const expectedReplies = ['reject', 'once', 'always'];

    modes.forEach((mode, index) => {
      expect(mapToOpenCodePermissionReply(mode)).toBe(expectedReplies[index]);
    });
  });
});
