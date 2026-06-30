import { describe, expect, it } from 'vitest';
import {
  CLAUDE_EDIT_TOOL_NAMES,
  keepsAllowedToolWithoutEdit,
  splitClaudeAllowedToolSpecs,
} from '../infra/providers/allowed-tool-edit-policy.js';
import {
  resolveAllowedToolsForProvider,
  resolvePartAllowedToolsForProvider,
} from '../core/workflow/engine/engine-provider-options.js';

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
    expect(keepsAllowedToolWithoutEdit('Bash')).toBe(false);
  });

  it('should remove Claude command and edit tool patterns by canonical tool name', () => {
    expect(keepsAllowedToolWithoutEdit('Bash(python3 -m pytest:*)')).toBe(false);
    expect(keepsAllowedToolWithoutEdit(' bash(which python3) ')).toBe(false);
    expect(keepsAllowedToolWithoutEdit('Write(file_path:*)')).toBe(false);
    expect(keepsAllowedToolWithoutEdit('Read(file_path:*)')).toBe(true);
  });

  it('should split Claude allowed tool entries by top-level comma', () => {
    expect(splitClaudeAllowedToolSpecs('Read,Bash(echo a,b), Grep')).toEqual([
      'Read',
      'Bash(echo a,b)',
      'Grep',
    ]);
  });

  it('should treat comma-separated Claude entries with unsafe tools as unsafe', () => {
    expect(keepsAllowedToolWithoutEdit('Read,Bash')).toBe(false);
    expect(keepsAllowedToolWithoutEdit('Read, Bash')).toBe(false);
    expect(keepsAllowedToolWithoutEdit('Read, Bash(echo a,b)')).toBe(false);
  });

  it('should remove Bash from Claude allowed tools for non-edit report steps', () => {
    expect(resolveAllowedToolsForProvider(
      {
        claude: {
          allowedTools: [
            'Read',
            'Bash',
            'Bash(python3 -m pytest:*)',
            ' bash(which python3) ',
            'Edit',
            'Grep',
          ],
        },
      },
      true,
      false,
      'claude',
    )).toEqual(['Read', 'Grep']);
  });

  it('should normalize comma-separated Claude allowed tools before removing command tools', () => {
    expect(resolveAllowedToolsForProvider(
      {
        claude: {
          allowedTools: [
            'Read,Bash',
            'Glob, Bash(which python3)',
            'Grep,Bash(echo a,b)',
          ],
        },
      },
      false,
      false,
      'claude',
    )).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('should remove Bash from Claude allowed tools when edit is false without output contracts', () => {
    expect(resolveAllowedToolsForProvider(
      { claude: { allowedTools: ['Read', 'Bash'] } },
      false,
      false,
      'claude',
    )).toEqual(['Read']);
  });

  it('should remove Bash from OpenCode allowed tools when edit is false without output contracts', () => {
    expect(resolveAllowedToolsForProvider(
      { opencode: { allowedTools: ['read', 'bash', ' Bash ', 'edit', 'grep'] } },
      false,
      false,
      'opencode',
    )).toEqual(['read', 'bash', ' Bash ', 'grep']);
  });

  it('should remove edit tools from Claude team leader part_allowed_tools when part_edit is false', () => {
    expect(resolvePartAllowedToolsForProvider(
      ['Read', 'Bash', 'Bash(python3 -m pytest:*)', 'Edit', 'Write', 'Grep'],
      false,
      'claude',
    )).toEqual(['Read', 'Grep']);
  });

  it('should normalize comma-separated Claude part_allowed_tools before removing command tools', () => {
    expect(resolvePartAllowedToolsForProvider(
      ['Read,Bash', 'Grep, Bash(which python3)'],
      false,
      'claude',
    )).toEqual(['Read', 'Grep']);
  });

  it('should remove edit tools from OpenCode team leader part_allowed_tools when part_edit is false', () => {
    expect(resolvePartAllowedToolsForProvider(
      ['read', 'bash', ' Bash ', 'edit', 'write', 'grep'],
      false,
      'opencode',
    )).toEqual(['read', 'bash', ' Bash ', 'grep']);
  });
});
