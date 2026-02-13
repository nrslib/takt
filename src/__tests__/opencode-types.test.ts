/**
 * Tests for OpenCode type definitions and permission mapping
 */

import { describe, it, expect } from 'vitest';
import {
  buildOpenCodePermissionConfig,
  buildOpenCodePermissionRuleset,
  mapToOpenCodePermissionReply,
  mapToOpenCodeTools,
} from '../infra/opencode/types.js';
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

describe('mapToOpenCodeTools', () => {
  it('should map built-in tool names to OpenCode tool IDs', () => {
    expect(mapToOpenCodeTools(['Read', 'Edit', 'Bash', 'WebSearch', 'WebFetch'])).toEqual({
      read: true,
      edit: true,
      bash: true,
      websearch: true,
      webfetch: true,
    });
  });

  it('should keep unknown tool names as-is', () => {
    expect(mapToOpenCodeTools(['mcp__github__search', 'custom_tool'])).toEqual({
      mcp__github__search: true,
      custom_tool: true,
    });
  });

  it('should return undefined when tools are not provided', () => {
    expect(mapToOpenCodeTools(undefined)).toBeUndefined();
  });

  it('should return empty tool map when explicit empty tools are provided', () => {
    expect(mapToOpenCodeTools([])).toEqual({});
  });
});

describe('OpenCode permissions', () => {
  it('should build allow config for full mode', () => {
    expect(buildOpenCodePermissionConfig('full')).toBe('allow');
  });

  it('should build deny config for readonly mode', () => {
    expect(buildOpenCodePermissionConfig('readonly')).toBe('deny');
  });

  it('should build ruleset for edit mode', () => {
    const ruleset = buildOpenCodePermissionRuleset('edit');
    expect(ruleset.length).toBeGreaterThan(0);
    expect(ruleset.find((rule) => rule.permission === 'edit')).toEqual({
      permission: 'edit',
      pattern: '**',
      action: 'allow',
    });
    expect(ruleset.find((rule) => rule.permission === 'question')).toEqual({
      permission: 'question',
      pattern: '**',
      action: 'deny',
    });
  });

  it('should force allow web tools when networkAccess=true', () => {
    const ruleset = buildOpenCodePermissionRuleset('readonly', true);
    expect(ruleset.find((rule) => rule.permission === 'webfetch')?.action).toBe('allow');
    expect(ruleset.find((rule) => rule.permission === 'websearch')?.action).toBe('allow');
  });

  it('should force deny web tools when networkAccess=false', () => {
    const ruleset = buildOpenCodePermissionRuleset('full', false);
    expect(ruleset.find((rule) => rule.permission === 'webfetch')?.action).toBe('deny');
    expect(ruleset.find((rule) => rule.permission === 'websearch')?.action).toBe('deny');
  });
});
