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

  it.each([undefined, {}, { takt: { system: 'persona', tools: null } }])('fails closed when policy is absent or invalid: %j', async (metadata) => {
    const { hooks } = await setup({ a: metadata });
    await expect(hooks.get('context')!({ sessionID: 'a', system: [], tools: { write: {} } })).rejects.toThrow('TAKT session policy');
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
});
