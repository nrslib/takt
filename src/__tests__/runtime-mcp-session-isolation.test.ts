import { describe, expect, it } from 'vitest';
// Module under test: session-key.ts (existing) will gain mcpServerIdentity support.
import { buildSessionKey } from '../core/workflow/session-key.js';
import type { WorkflowStep } from '../core/models/types.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-SESSION-ISOLATION` (要件71,72,73,74,75,109)
 *   - effective server 集合は agent/thread/session 開始前に確定する
 *   - session/cache/pool は異なる解決済み MCP server 集合を共有しない
 *   - session/cache/pool の識別情報やログへ token/header/env 解決値を含めない
 *   - session resume 時の集合変更挙動を provider 別に明示する
 *   - identity は server 名と秘密値を除いた server 構造を含む
 *
 * 反例:
 *   - session key に MCP 集合を含めない → 異なる集合が同じ session を共有
 *   - resume 時に集合変更を黙って許可する
 *   - identity に秘密値を含める
 */

function createStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: 'test-step',
    personaDisplayName: 'test',
    edit: false,
    instruction: '',
    passPreviousResponse: true,
    ...overrides,
  } as unknown as WorkflowStep;
}

describe('buildSessionKey with MCP identity (MCP-SESSION-ISOLATION)', () => {
  it('Given two steps with the same persona/provider but different MCP server sets, Then session keys differ (要件74)', () => {
    const step = createStep({ persona: 'coder', provider: 'claude' });
    const noMcp = buildSessionKey(step, { provider: 'claude' });
    const withMcp = buildSessionKey(step, { provider: 'claude', mcpServerIdentity: 'common:stdio' });
    expect(noMcp).not.toBe(withMcp);
  });

  it('Given two steps with different MCP server sets, Then session keys differ for each set', () => {
    const step = createStep({ persona: 'coder', provider: 'claude' });
    const setA = buildSessionKey(step, { provider: 'claude', mcpServerIdentity: 'common:stdio' });
    const setB = buildSessionKey(step, { provider: 'claude', mcpServerIdentity: 'common:stdio,github:http' });
    expect(setA).not.toBe(setB);
  });

  it('Given two steps with the same MCP server set in different order, Then session keys are equal (identity is order-independent)', () => {
    const step = createStep({ persona: 'coder', provider: 'claude' });
    const setA = buildSessionKey(step, { provider: 'claude', mcpServerIdentity: 'common:stdio,github:http' });
    const setB = buildSessionKey(step, { provider: 'claude', mcpServerIdentity: 'github:http,common:stdio' });
    // Identity is a sorted/normalized representation; order does not change the key.
    expect(setA).toBe(setB);
  });

  it('Given a session key with MCP identity, Then the key does NOT contain token/header/env resolved values (要件75)', () => {
    const step = createStep({ persona: 'coder', provider: 'claude' });
    // The identity may include non-secret server structure, but never secrets.
    const key = buildSessionKey(step, { provider: 'claude', mcpServerIdentity: 'common:stdio' });
    expect(key).not.toContain('Bearer');
    expect(key).not.toContain('secret');
    expect(key).not.toContain('token');
  });

  it('Given a session key with the same transport but different server name, Then keys differ', () => {
    const step = createStep({ persona: 'coder', provider: 'claude' });
    const a = buildSessionKey(step, { provider: 'claude', mcpServerIdentity: 'common:stdio' });
    const b = buildSessionKey(step, { provider: 'claude', mcpServerIdentity: 'other:stdio' });
    expect(a).not.toBe(b);
  });

  it('Given the same server name but different transport, Then keys differ', () => {
    const step = createStep({ persona: 'coder', provider: 'claude' });
    const stdio = buildSessionKey(step, { provider: 'claude', mcpServerIdentity: 'common:stdio' });
    const http = buildSessionKey(step, { provider: 'claude', mcpServerIdentity: 'common:http' });
    expect(stdio).not.toBe(http);
  });

  it('Given canonical identities with comma-containing arguments, Then their structure is not split', () => {
    const step = createStep({ persona: 'coder', provider: 'claude' });
    const setA = '[\"common\",{\"type\":\"stdio\",\"command\":\"node\",\"args\":[\"--value\",\"a,b\"]}]';
    const setB = '[\"common\",{\"type\":\"stdio\",\"command\":\"node\",\"args\":[\"--value\",\"a,c\"]}]';
    expect(buildSessionKey(step, { provider: 'claude', mcpServerIdentity: setA }))
      .not.toBe(buildSessionKey(step, { provider: 'claude', mcpServerIdentity: setB }));
  });

  it('Given an empty MCP identity, Then the session key equals the key without MCP (treated as MCP-disabled)', () => {
    const step = createStep({ persona: 'coder', provider: 'claude' });
    const withoutMcp = buildSessionKey(step, { provider: 'claude' });
    const emptyMcp = buildSessionKey(step, { provider: 'claude', mcpServerIdentity: '' });
    expect(emptyMcp).toBe(withoutMcp);
  });

  it('Given a session key, Then MCP identity is appended after provider and model so legacy keys are still distinct', () => {
    const step = createStep({ persona: 'coder', provider: 'claude', model: 'sonnet' });
    const key = buildSessionKey(step, { provider: 'claude', model: 'sonnet', mcpServerIdentity: 'common:stdio' });
    // Legacy key without MCP must still be a distinct prefix so resume detection works.
    const legacyKey = JSON.stringify(['coder', 'claude', 'sonnet']);
    expect(key).not.toBe(legacyKey);
    // The legacy tuple must still be parseable from the key (key extends it).
    expect(key).toContain(legacyKey.slice(0, -1));
  });
});
