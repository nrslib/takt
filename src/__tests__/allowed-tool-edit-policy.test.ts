import { describe, expect, it } from 'vitest';
import {
  CLAUDE_EDIT_TOOL_NAMES,
  keepsAllowedToolWithoutEdit,
} from '../infra/providers/allowed-tool-edit-policy.js';

describe('allowed-tool-edit-policy', () => {
  it('should export Claude edit tool names for provider policy checks', () => {
    expect(CLAUDE_EDIT_TOOL_NAMES).toEqual(new Set([
      'edit',
      'write',
      'apply_patch',
      'patch',
    ]));
  });

  it('should keep non-edit tools and remove edit tools from Claude allowed tools', () => {
    expect(keepsAllowedToolWithoutEdit('Read')).toBe(true);
    expect(keepsAllowedToolWithoutEdit(' Apply_Patch ')).toBe(false);
  });
});
