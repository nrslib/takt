import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2Event } from '@opencode/client';
import { createV2Transport } from '../infra/opencode/v2-transport.js';
import { v2EventTranslator } from '../infra/opencode/v2-events.js';
import { buildV2ServerConfig } from '../infra/opencode/v2-config.js';

const { api } = vi.hoisted(() => ({ api: {
  session: { create: vi.fn(), get: vi.fn(), update: vi.fn(), switchAgent: vi.fn(), switchModel: vi.fn(), prompt: vi.fn(), interrupt: vi.fn(), wait: vi.fn(), compact: vi.fn() },
  plugin: { list: vi.fn() }, event: { subscribe: vi.fn() }, message: { list: vi.fn() }, permission: { reply: vi.fn() },
  rpc: { call: vi.fn() }, mcp: { list: vi.fn() },
} }));
vi.mock('@opencode/client', () => ({ OpenCode: { make: () => api } }));
const prompt = {
  sessionID: 's1', directory: '/work', agent: 'takt-review', system: 'review persona',
  model: { providerID: 'probe', modelID: 'probe' }, parts: [{ type: 'text' as const, text: 'review' }],
  tools: { read: true, write: false, bash: false, task: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.plugin.list.mockResolvedValue({ data: [{ id: 'takt.session', state: { status: 'active' } }] });
  api.session.get.mockResolvedValue({ id: 's1', location: { directory: '/work' }, metadata: { preserved: 1 } });
});

describe('OpenCode v2 transport', () => {
  it('updates system and permissions for each phase on the same session', async () => {
    const transport = createV2Transport('http://localhost', 'password');
    await transport.session.promptAsync(prompt);
    expect(api.session.update).toHaveBeenLastCalledWith({ sessionID: 's1',
      permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }, { action: 'external_directory', resource: '*', effect: 'deny' }],
      metadata: { preserved: 1, takt: { system: 'review persona', tools: { read: true, write: false, shell: false, subagent: false } } },
    }, undefined);
    await transport.session.promptAsync({ ...prompt, system: 'report persona', tools: { write: true } });
    expect(api.session.update).toHaveBeenLastCalledWith(expect.objectContaining({
      permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'edit', resource: '*', effect: 'allow' }, { action: 'external_directory', resource: '*', effect: 'deny' }],
      metadata: { preserved: 1, takt: { system: 'report persona', tools: { write: true } } },
    }), undefined);
    expect(api.session.prompt).toHaveBeenCalledTimes(2);
    expect(transport.nativeStructuredOutput).toBe(false);
  });

  it('refuses prompts when the session policy plugin failed to activate', async () => {
    api.plugin.list.mockResolvedValue({ data: [{ id: 'takt.session', state: { status: 'failed' } }] });
    await expect(createV2Transport('http://localhost', '').session.promptAsync(prompt)).rejects.toThrow('refusing');
    expect(api.session.prompt).not.toHaveBeenCalled();
    expect(api.session.update).not.toHaveBeenCalled();
  });

  it('waits for cold plugin activation before sending the prompt', async () => {
    api.plugin.list.mockResolvedValueOnce({ data: [] });
    await createV2Transport('http://localhost', '').session.promptAsync(prompt);
    expect(api.plugin.list).toHaveBeenCalledTimes(2);
    expect(api.session.prompt).toHaveBeenCalledOnce();
  });

  it('waits for MCP catalog registration before exposing an allowed tool', async () => {
    api.rpc.call.mockResolvedValueOnce({ output: [] }).mockResolvedValue({ output: [{ id: 'probe_echo', namespace: 'probe' }] });
    await createV2Transport('http://localhost', '').session.promptAsync({ ...prompt, tools: { probe_echo: true } });
    expect(api.rpc.call).toHaveBeenCalledTimes(2);
    expect(api.session.update).toHaveBeenCalledWith(expect.objectContaining({ metadata: {
      preserved: 1, takt: { system: 'review persona', tools: { probe_echo: true } },
    } }), undefined);
  });

  it('exposes configured MCP tools only when discovery is explicitly enabled', async () => {
    api.rpc.call.mockResolvedValue({ output: [{ id: 'probe_echo', namespace: 'probe' }, { id: 'probe_other_tool', namespace: 'probe_other' }] });
    api.mcp.list.mockResolvedValue({ data: [{ name: 'probe', status: { status: 'connected' } }] });
    await createV2Transport('http://localhost', '', ['probe']).session.promptAsync({ ...prompt, allowConfiguredMcpTools: true });
    expect(api.session.update).toHaveBeenCalledWith(expect.objectContaining({ metadata: {
      preserved: 1, takt: { system: 'review persona', tools: { read: true, write: false, shell: false, subagent: false, probe_echo: true } },
    } }), undefined);
  });

  it('refuses a session from a different directory', async () => {
    api.session.get.mockResolvedValue({ location: { directory: '/other' } });
    await expect(createV2Transport('http://localhost', '').session.promptAsync(prompt)).rejects.toThrow('different directory');
    expect(api.session.prompt).not.toHaveBeenCalled();
  });

  it('routes only the selected session and maps successful execution to completion', async () => {
    api.event.subscribe.mockReturnValue((async function* () {
      yield { type: 'server.connected' };
      yield { type: 'session.execution.succeeded', data: { sessionID: 'other' } };
      yield { type: 'session.execution.succeeded', data: { sessionID: 's1' } };
    })());
    const { stream } = await createV2Transport('http://localhost', '').event.subscribe({ directory: '/work', sessionID: 's1' }, {});
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events).toEqual([{ type: 'session.idle', properties: { sessionID: 's1' } }]);
  });

  it('waits for interruption before completing abort', async () => {
    const order: string[] = [];
    api.session.interrupt.mockImplementation(async () => { order.push('interrupt'); });
    api.session.wait.mockImplementation(async () => { order.push('wait'); });
    await createV2Transport('http://localhost', '').session.abort({ sessionID: 's1', directory: '/work' }, {});
    expect(order).toEqual(['interrupt', 'wait']);
  });

  it('uses an opaque pagination cursor without resending the order', async () => {
    api.message.list.mockResolvedValueOnce({ data: [], cursor: { next: 'page2' } }).mockResolvedValueOnce({ data: [], cursor: { next: null } });
    await createV2Transport('http://localhost', '').session.messages({ sessionID: 's1', directory: '/work' });
    expect(api.message.list).toHaveBeenNthCalledWith(1, { sessionID: 's1', order: 'asc', limit: 100 }, undefined);
    expect(api.message.list).toHaveBeenNthCalledWith(2, { sessionID: 's1', cursor: 'page2', limit: 100 }, undefined);
  });

  it('drops session state records so the turn ends on the assistant message', async () => {
    const time = { created: 1 };
    api.message.list.mockResolvedValueOnce({ data: [
      { type: 'agent-switched', id: 'm1', time },
      { type: 'model-switched', id: 'm2', time },
      { type: 'system', id: 'm3', text: 'update', time },
      { type: 'user', id: 'm4', time },
      { type: 'assistant', id: 'm5', content: [{ type: 'text', text: 'done' }], time },
      { type: 'location-switched', id: 'm6', time },
      { type: 'idle', id: 'm7', time },
    ], cursor: { next: null } });
    const result = await createV2Transport('http://localhost', '').session.messages({ sessionID: 's1', directory: '/work' });
    expect(result.data?.map((message) => [message.info.id, message.info.role])).toEqual([
      ['m3', 'user'], ['m4', 'user'], ['m5', 'assistant'],
    ]);
  });

  it('carries the session ID and rejection decision on permissions', async () => {
    await createV2Transport('http://localhost', '').permission.reply({ sessionID: 's1', requestID: 'p1', reply: 'reject', directory: '/work' }, {});
    expect(api.permission.reply).toHaveBeenCalledWith({ sessionID: 's1', requestID: 'p1', decision: 'reject' }, {});
  });
});

describe('OpenCode v2 events and configuration', () => {
  it('preserves tool errors and successful tool output for the runner guards', () => {
    const translate = v2EventTranslator();
    const data = { sessionID: 's1', assistantMessageID: 'm1', id: 't1', name: 'shell' };
    const event = (type: string, extra = {}) => translate({ type, data: { ...data, ...extra } } as V2Event);
    event('session.tool.input.started');
    event('session.tool.called', { input: { command: 'pwd' } });
    expect(event('session.tool.failed', { error: { message: 'denied' } })).toMatchObject({ properties: { part: { tool: 'bash', state: { status: 'error', error: 'denied', input: { command: 'pwd' } } } } });
    event('session.tool.input.started');
    event('session.tool.called', { input: { command: 'pwd' } });
    expect(event('session.tool.success', { content: [{ type: 'text', text: '/work' }], metadata: {} })).toMatchObject({ properties: { part: { state: { status: 'completed', output: '/work' } } } });
  });

  it('preserves all MCP OAuth options including the callback port and redirect URI without enabling codemode', () => {
    const config = buildV2ServerConfig('p/m', undefined, '/plugin', {
      remote: {
        type: 'remote', url: 'https://example.test/mcp', enabled: false, timeout: 123,
        oauth: {
          clientId: 'client', clientSecret: 'secret', scope: 'scope',
          callbackPort: 19876, redirectUri: 'http://127.0.0.1:19876/oauth/callback',
        },
      },
    });
    expect(config.mcp?.servers?.remote).toEqual({
      type: 'remote', url: 'https://example.test/mcp', disabled: true, codemode: false, headers: undefined,
      timeout: { startup: 123, catalog: 123, execution: 123 },
      oauth: {
        client_id: 'client', client_secret: 'secret', scope: 'scope',
        callback_port: 19876, redirect_uri: 'http://127.0.0.1:19876/oauth/callback',
      },
    });
  });
});
