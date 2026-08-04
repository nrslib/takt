/**
 * Tests for OpenCode type definitions and permission mapping
 */

import { describe, it, expect } from 'vitest';
import {
  buildOpenCodePermissionRuleset,
  buildOpenCodePromptTools,
  buildOpenCodeSessionPermission,
  mapToOpenCodePermissionReply,
  OPEN_CODE_MANAGED_TOOL_IDS,
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

  it('should allow OpenCode doom loop continuation before applying allowed tools ruleset', () => {
    expect(resolveOpenCodePermissionReply('readonly', 'doom_loop', [
      { permission: 'read', pattern: '**', action: 'deny' },
    ])).toBe('once');
  });

  it('should default to once when permission mode is not configured', () => {
    expect(resolveOpenCodePermissionReply(undefined, 'bash')).toBe('once');
  });

  it('should reject unknown permissions in edit mode', () => {
    expect(resolveOpenCodePermissionReply('edit', 'mcp__github__search')).toBe('reject');
  });

  it('should reject unknown permissions in full mode', () => {
    expect(resolveOpenCodePermissionReply('full', 'mcp__github__search')).toBe('reject');
  });

  it('should keep known full mode permissions always allowed', () => {
    expect(resolveOpenCodePermissionReply('full', 'bash')).toBe('always');
  });
});

describe('OpenCode permissions', () => {
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
    expect(ruleset.find((rule) => rule.permission === 'todowrite')?.action).toBe('deny');
    expect(ruleset.find((rule) => rule.permission === 'question')?.action).toBe('deny');
  });

  it('should build todowrite permissions for each permission mode', () => {
    expect(buildOpenCodePermissionRuleset('readonly')
      .find((rule) => rule.permission === 'todowrite')?.action).toBe('deny');
    expect(buildOpenCodePermissionRuleset('edit')
      .find((rule) => rule.permission === 'todowrite')?.action).toBe('allow');
    expect(buildOpenCodePermissionRuleset(undefined)
      .find((rule) => rule.permission === 'todowrite')?.action).toBe('ask');
  });

  it('should keep full mode without tool or network overrides as allow all', () => {
    expect(buildOpenCodePermissionRuleset('full')).toEqual([
      { permission: '*', pattern: '*', action: 'allow' },
    ]);
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

  it('should build an explicit whitelist ruleset when allowed tools are provided', () => {
    const ruleset = buildOpenCodePermissionRuleset('full', true, [
      'Read',
      'Write',
      'apply_patch',
      'TodoWrite',
      'todo_write',
      'todowrite',
      'Bash',
      'mcp__github__search',
    ]);

    expect(ruleset).toEqual([
      { permission: '*', pattern: '*', action: 'deny' },
      { permission: 'read', pattern: '*', action: 'allow' },
      { permission: 'edit', pattern: '*', action: 'allow' },
      { permission: 'todowrite', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: '*', action: 'allow' },
    ]);
  });

  it('should default-deny unknown allowed tools in edit mode', () => {
    const ruleset = buildOpenCodePermissionRuleset('edit', undefined, [
      'Read',
      'mcp__github__search',
    ]);

    expect(ruleset).toEqual([
      { permission: '*', pattern: '*', action: 'deny' },
      { permission: 'read', pattern: '*', action: 'allow' },
    ]);
  });

  it('should keep readonly mode from widening to explicitly whitelisted edit tools but allow bash', () => {
    const ruleset = buildOpenCodePermissionRuleset('readonly', undefined, [
      'Read',
      'Bash',
      'Edit',
    ]);

    expect(ruleset).toEqual([
      { permission: '*', pattern: '*', action: 'deny' },
      { permission: 'read', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: '*', action: 'allow' },
    ]);
  });

  it('should allow whitelisted tools when permission mode is not set', () => {
    const ruleset = buildOpenCodePermissionRuleset(undefined, undefined, [
      'Read',
      'Bash',
    ]);

    expect(ruleset).toEqual([
      { permission: '*', pattern: '*', action: 'deny' },
      { permission: 'read', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: '*', action: 'allow' },
    ]);
  });

  it('should reject wildcard allowed tools', () => {
    expect(() => buildOpenCodePermissionRuleset('full', false, ['*']))
      .toThrow('OpenCode allowedTools does not accept wildcard permission: *');
  });

  it('should keep readonly mode from widening to custom allowed permissions', () => {
    const ruleset = buildOpenCodePermissionRuleset('readonly', undefined, [
      'Read',
      'mcp__github__search',
    ]);

    expect(ruleset).toEqual([
      { permission: '*', pattern: '*', action: 'deny' },
      { permission: 'read', pattern: '*', action: 'allow' },
    ]);
  });

  it('should treat an explicit empty allowed tools list as wildcard deny', () => {
    const ruleset = buildOpenCodePermissionRuleset('edit', undefined, []);

    expect(ruleset).toEqual([
      { permission: '*', pattern: '*', action: 'deny' },
    ]);
  });

  it('should not widen a whitelist when network access is enabled', () => {
    const ruleset = buildOpenCodePermissionRuleset('readonly', true, ['Read']);

    expect(ruleset).toEqual([
      { permission: '*', pattern: '*', action: 'deny' },
      { permission: 'read', pattern: '*', action: 'allow' },
    ]);
  });

  it('should remove web tools from a whitelist when network access is disabled', () => {
    const ruleset = buildOpenCodePermissionRuleset('full', false, [
      'Read',
      'WebSearch',
      'WebFetch',
    ]);

    expect(ruleset).toEqual([
      { permission: '*', pattern: '*', action: 'deny' },
      { permission: 'read', pattern: '*', action: 'allow' },
    ]);
  });
});

describe('buildOpenCodeSessionPermission', () => {
  it('relaxes edit/write denies so later phases can write on the shared session', () => {
    const rules = buildOpenCodeSessionPermission('readonly');
    const byPermission = new Map(rules.map((r) => [r.permission, r.action]));
    expect(byPermission.get('edit')).toBe('allow');
    expect(byPermission.get('write')).toBe('allow');
    expect(byPermission.get('read')).toBe('allow');
    expect(byPermission.get('bash')).toBe('deny');
  });

  it('appends edit/write allows to an allowlist ruleset that lacks them', () => {
    const rules = buildOpenCodeSessionPermission('full', undefined, ['Read', 'Bash']);
    expect(rules).toContainEqual({ permission: 'edit', pattern: '*', action: 'allow' });
    expect(rules).toContainEqual({ permission: 'write', pattern: '*', action: 'allow' });
    expect(rules).toContainEqual({ permission: '*', pattern: '*', action: 'deny' });
  });

  it('keeps non-edit rules untouched', () => {
    const rules = buildOpenCodeSessionPermission('edit');
    const byPermission = new Map(rules.map((r) => [r.permission, r.action]));
    expect(byPermission.get('question')).toBe('deny');
    expect(byPermission.get('bash')).toBe('allow');
  });

  it('preserves ask rules so the per-phase auto-reply keeps deciding them', () => {
    const rules = buildOpenCodeSessionPermission(undefined);
    const byPermission = new Map(rules.map((r) => [r.permission, r.action]));
    expect(byPermission.get('edit')).toBe('ask');
    expect(byPermission.get('read')).toBe('ask');
  });

  it('denies external directory access at session scope', () => {
    for (const rules of [
      buildOpenCodeSessionPermission('readonly'),
      buildOpenCodeSessionPermission('full', undefined, ['Read', 'Write']),
    ]) {
      expect(rules).toContainEqual({ permission: 'external_directory', pattern: '*', action: 'deny' });
    }
  });
});

describe('buildOpenCodePromptTools', () => {
  it('maps an explicit Write-only allowlist to edit-family tools only', () => {
    const tools = buildOpenCodePromptTools('edit', undefined, ['Write']);
    expect(tools).toMatchObject({
      edit: true,
      write: true,
      patch: true,
      read: false,
      glob: false,
      grep: false,
      bash: false,
      task: false,
    });
  });

  it('disables everything for an empty allowlist', () => {
    const tools = buildOpenCodePromptTools('edit', undefined, []);
    expect(Object.values(tools).every((enabled) => enabled === false)).toBe(true);
  });

  it('mirrors the readonly permission map when no allowlist is given', () => {
    const tools = buildOpenCodePromptTools('readonly');
    expect(tools).toMatchObject({
      read: true,
      list: true,
      glob: true,
      grep: true,
      edit: false,
      write: false,
      bash: false,
      webfetch: false,
    });
  });

  it('enables the full toolset in full mode except task', () => {
    const tools = buildOpenCodePromptTools('full');
    expect(tools.task).toBe(false);
    expect(tools.edit).toBe(true);
    expect(tools.bash).toBe(true);
    expect(tools.webfetch).toBe(true);
  });

  it('applies the networkAccess override to web tools', () => {
    const tools = buildOpenCodePromptTools('full', false);
    expect(tools.webfetch).toBe(false);
    expect(tools.websearch).toBe(false);
    expect(tools.bash).toBe(true);
  });

  it('never enables the task tool even when listed', () => {
    const tools = buildOpenCodePromptTools('full', undefined, ['Task', 'Read']);
    expect(tools.task).toBe(false);
    expect(tools.read).toBe(true);
  });

  it.each([
    ['readonly mode', buildOpenCodePromptTools('readonly')],
    ['full mode', buildOpenCodePromptTools('full')],
    ['Write allowlist', buildOpenCodePromptTools('edit', undefined, ['Write'])],
    ['empty allowlist', buildOpenCodePromptTools('edit', undefined, [])],
  ])('always covers the exact managed tool id set (%s)', (_label, tools) => {
    // 固着リーク防止の契約: 毎プロンプト全キーを明示する。
    // キーが欠けると前フェーズの値がセッションに残る。
    expect(Object.keys(tools).sort()).toEqual([...OPEN_CODE_MANAGED_TOOL_IDS].sort());
  });
});
