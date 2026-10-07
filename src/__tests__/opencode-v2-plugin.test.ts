import { describe, expect, it, vi } from 'vitest';
import plugin from '../infra/opencode/plugins/v2-session/index.js';

describe('OpenCode v2 session policy plugin', () => {
  async function setup(policies: Record<string, unknown>) {
    const hooks = new Map<string, (input: Record<string, unknown>) => Promise<void> | void>();
    const dispose = vi.fn(async () => {});
    const hook = vi.fn(async (name: string, callback: (input: Record<string, unknown>) => Promise<void> | void) => {
      hooks.set(name, callback);
      return { dispose };
    });
    const context = { session: { hook, get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({ metadata: policies[sessionID] })) }, tool: { hook }, rpc: { register: vi.fn(async () => ({ dispose })) } };
    const cleanup = await plugin.setup(context as unknown as Parameters<typeof plugin.setup>[0]);
    return { hooks, cleanup, dispose };
  }

  it('keeps parallel session instructions and tool visibility isolated', async () => {
    const { hooks } = await setup({ a: { takt: { system: 'persona A', tools: { read: true } } }, b: { takt: { system: 'persona B', tools: { write: true } } } });
    const a = { sessionID: 'a', system: [], tools: { read: {}, write: {}, execute: {} } };
    const b = { sessionID: 'b', system: [], tools: { read: {}, write: {}, execute: {} } };
    await Promise.all([hooks.get('context')!(a), hooks.get('context')!(b)]);
    expect(a).toMatchObject({ system: [{ type: 'text', text: 'persona A' }], tools: { read: {} } });
    expect(Object.keys(a.tools)).toEqual(['read']);
    expect(b).toMatchObject({ system: [{ type: 'text', text: 'persona B' }] });
    expect(Object.keys(b.tools)).toEqual(['write']);
  });

  it.each(['forward', 'reverse'])('exposes exactly read and the five manager MCP tools with %s inventory order', async (order) => {
    const names = ['read', 'takt_takt_create_goal', 'takt_takt_list_goals', 'takt_takt_get_goal', 'takt_takt_list_tasks', 'takt_takt_get_run'];
    const { hooks } = await setup({ manager: { takt: { system: '', tools: Object.fromEntries(names.map((name) => [name, true])) } } });
    const inventory = [...names, 'shell', 'write', 'skill', 'ambient_extra'];
    const orderedInventory = order === 'reverse' ? [...inventory].reverse() : inventory;
    const input = { sessionID: 'manager', system: [], tools: Object.fromEntries(orderedInventory.map((name) => [name, {}])) };
    await hooks.get('context')!(input);
    expect(new Set(Object.keys(input.tools))).toEqual(new Set(names));
  });

  it.each([undefined, {}, { takt: { system: 'persona', tools: null } }])('fails closed when policy is absent or invalid: %j', async (metadata) => {
    const { hooks } = await setup({ a: metadata });
    await expect(hooks.get('context')!({ sessionID: 'a', system: [], tools: { write: {} } })).rejects.toThrow('TAKT session policy');
  });

  it('removes the Skill description on report calls and restores it on the same session', async () => {
    const policy = { takt: { system: 'persona', tools: { read: true, skill: true } } };
    const { hooks } = await setup({ a: policy });
    const contextHook = hooks.get('context')!;
    const skill = { description: '<available_skills><skill>fixture</skill></available_skills>' };
    const first = { sessionID: 'a', system: [], tools: { read: {}, skill } };
    await contextHook(first);
    expect(first.tools.skill).toEqual(skill);
    expect(JSON.stringify(first)).toContain('<available_skills>');

    policy.takt.tools.skill = false;
    const report = { sessionID: 'a', system: [], tools: { read: {}, skill } };
    await contextHook(report);
    expect(report.tools).not.toHaveProperty('skill');
    expect(JSON.stringify(report)).not.toContain('<available_skills>');
    expect(report.tools.read).toEqual({});

    policy.takt.tools.skill = true;
    const resumed = { sessionID: 'a', system: [], tools: { read: {}, skill } };
    await contextHook(resumed);
    expect(resumed.tools.skill).toEqual(skill);
    expect(JSON.stringify(resumed)).toContain('<available_skills>');
  });

  it('coerces only safe numeric tool arguments and disposes registrations', async () => {
    const { hooks, cleanup, dispose } = await setup({});
    const request = { tool: 'read', input: { offset: '1', limit: '10.0', path: '1' } };
    await hooks.get('execute.before')!(request);
    expect(request.input).toEqual({ offset: 1, limit: 10, path: '1' });
    const invalid = { tool: 'read', input: { offset: 'bad', limit: '999999999999999999999' } };
    await hooks.get('execute.before')!(invalid);
    expect(invalid.input).toEqual({ offset: 'bad', limit: '999999999999999999999' });
    if (typeof cleanup !== 'function') throw new Error('Plugin cleanup must be callable');
    await cleanup();
    expect(dispose).toHaveBeenCalledTimes(3);
  });

  it('preserves native system instructions and instruction updates when Skill is enabled', async () => {
    const { hooks } = await setup({ a: { takt: { system: 'persona', tools: { skill: true } } } });
    const system = [{ type: 'text', text: 'Ordinary instructions\n\n<available_skills><skill>fixture</skill></available_skills>' }];
    const messages = [{ role: 'system', content: [{ type: 'text', text: '<system-update>New skills are available: fixture</system-update>' }] }];
    const request = { sessionID: 'a', system: structuredClone(system), messages: structuredClone(messages), tools: { skill: {} } };
    await hooks.get('context')!(request);
    expect(request.system).toEqual([...system, { type: 'text', text: 'persona' }]);
    expect(request.messages).toEqual(messages);
    expect(request.tools).toEqual({ skill: {} });
  });

  it('preserves persona examples, user quotations and loaded Skill results across policy changes', async () => {
    const quoted = '<available_skills><skill>sample</skill></available_skills>';
    const policy = { takt: { system: `Persona example: ${quoted}`, tools: { read: true, skill: true } } };
    const { hooks } = await setup({ a: policy });
    const system = [{ type: 'text', text: `Instructions from: AGENTS.md\nOrdinary instructions\nExample: ${quoted}` }];
    const messages = [
      { role: 'user', content: [{ type: 'text', text: `Quotation: ${quoted}` }] },
      { role: 'tool', content: [{ type: 'tool-result', name: 'skill', id: 'loaded', result: { type: 'text', value: `<skill_content>Loaded instructions: ${quoted}</skill_content>` } }] },
    ];
    for (const enabled of [true, false, true]) {
      policy.takt.tools.skill = enabled;
      const request = { sessionID: 'a', system: structuredClone(system), messages: structuredClone(messages), tools: { read: {}, skill: {} } };
      await hooks.get('context')!(request);
      expect(request.system).toEqual([...system, { type: 'text', text: policy.takt.system }]);
      expect(request.messages).toEqual(messages);
      expect(new Set(Object.keys(request.tools))).toEqual(new Set(enabled ? ['read', 'skill'] : ['read']));
    }
  });
});
