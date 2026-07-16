import { describe, it, expect } from 'vitest';
import {
  buildOpenCodePromptTools,
  buildOpenCodeSessionPermission,
  OPEN_CODE_MANAGED_TOOL_IDS,
} from '../infra/opencode/types.js';

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
