/**
 * Tests for OpenCode type definitions and permission mapping
 */

import { describe, it, expect } from 'vitest';
import {
  buildOpenCodePermissionConfig,
  buildOpenCodePermissionRuleset,
  mapToOpenCodePermissionReply,
  mapToOpenCodeTools,
  resolveOpenCodePermissionReply,
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

describe('resolveOpenCodePermissionReply', () => {
  it('should keep readonly tool permissions rejected', () => {
    expect(resolveOpenCodePermissionReply('readonly', 'bash')).toBe('reject');
  });

  it('should allow OpenCode doom loop continuation once even in readonly mode', () => {
    expect(resolveOpenCodePermissionReply('readonly', 'doom_loop')).toBe('once');
  });

  it('should allow OpenCode doom loop continuation once in edit mode', () => {
    expect(resolveOpenCodePermissionReply('edit', 'doom_loop')).toBe('once');
  });

  it('should allow OpenCode doom loop continuation once in full mode', () => {
    expect(resolveOpenCodePermissionReply('full', 'doom_loop')).toBe('once');
  });

  it('should default to once when permission mode is not configured', () => {
    expect(resolveOpenCodePermissionReply(undefined, 'bash')).toBe('once');
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

  it('should build read-only config for readonly mode', () => {
    expect(buildOpenCodePermissionConfig('readonly')).toMatchObject({
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      edit: 'deny',
      write: 'deny',
      bash: 'deny',
      task: 'deny',
      question: 'deny',
    });
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

  it('should build ruleset for readonly mode with read-only tools allowed', () => {
    const ruleset = buildOpenCodePermissionRuleset('readonly');
    expect(ruleset.find((rule) => rule.permission === 'read')).toEqual({
      permission: 'read',
      pattern: '**',
      action: 'allow',
    });
    expect(ruleset.find((rule) => rule.permission === 'glob')?.action).toBe('allow');
    expect(ruleset.find((rule) => rule.permission === 'grep')?.action).toBe('allow');
    expect(ruleset.find((rule) => rule.permission === 'edit')?.action).toBe('deny');
    expect(ruleset.find((rule) => rule.permission === 'write')?.action).toBe('deny');
    expect(ruleset.find((rule) => rule.permission === 'bash')?.action).toBe('deny');
    expect(ruleset.find((rule) => rule.permission === 'task')?.action).toBe('deny');
    expect(ruleset.find((rule) => rule.permission === 'question')?.action).toBe('deny');
  });

  it('should force allow web tools when networkAccess=true', () => {
    const ruleset = buildOpenCodePermissionRuleset('readonly', true);
    expect(ruleset.find((rule) => rule.permission === 'webfetch')?.action).toBe('allow');
    expect(ruleset.find((rule) => rule.permission === 'websearch')?.action).toBe('allow');
    expect(ruleset.find((rule) => rule.permission === 'read')?.action).toBe('allow');
    expect(ruleset.find((rule) => rule.permission === 'edit')?.action).toBe('deny');
  });

  it('should force deny web tools when networkAccess=false', () => {
    const ruleset = buildOpenCodePermissionRuleset('full', false);
    expect(ruleset.find((rule) => rule.permission === 'webfetch')?.action).toBe('deny');
    expect(ruleset.find((rule) => rule.permission === 'websearch')?.action).toBe('deny');
  });
});
