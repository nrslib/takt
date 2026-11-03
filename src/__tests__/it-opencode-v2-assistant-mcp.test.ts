vi.mock('../infra/managed-providers/loader.js', () => import('./helpers/managed-sdk.js'));
vi.mock('../infra/managed-providers/preflight.js', () => ({ checkManagedProviders: vi.fn(async () => undefined) }));
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { callAIWithRetry } from '../features/interactive/aiCaller.js';
import { createAssistantConversationPlan } from '../features/interactive/conversationPlan.js';
import { OpenCodeProvider } from '../infra/providers/opencode.js';
import { resetSharedServerPool } from '../infra/opencode/server-pool.js';
import { createV2Transport } from '../infra/opencode/v2-transport.js';
import type { OpenCodeRuntime } from '../infra/opencode/runtime.js';
import { deferred } from './helpers/opencode-client-test-helpers.js';

const { api, startServer } = vi.hoisted(() => ({
  api: {
    session: { create: vi.fn(), get: vi.fn(), update: vi.fn(), switchAgent: vi.fn(), switchModel: vi.fn(), prompt: vi.fn(), interrupt: vi.fn(), wait: vi.fn(), compact: vi.fn() },
    agent: { list: vi.fn() }, model: { default: vi.fn() },
    plugin: { list: vi.fn() }, event: { subscribe: vi.fn() }, message: { list: vi.fn() }, permission: { reply: vi.fn() },
    rpc: { call: vi.fn() }, mcp: { list: vi.fn() },
  },
  startServer: vi.fn(),
}));

vi.mock('@opencode/client', () => ({ OpenCode: { make: () => api } }));
vi.mock('node:net', () => ({ createServer: () => ({
  unref: vi.fn(), on: vi.fn(), listen: (_port: number, _host: string, ready: () => void) => ready(),
  address: () => ({ port: 62000 }), close: (done: (error?: Error) => void) => done(),
}) }));
vi.mock('../infra/opencode/server-process.js', () => ({ startOpenCodeServer: startServer }));
vi.mock('../infra/opencode/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/opencode/runtime.js')>();
  return { ...actual, resolveOpenCodeRuntime: async (): Promise<OpenCodeRuntime> => ({
    ...actual.openCodeRuntimeSelection(), version: 'opencode v2.0.18',
  }) };
});

const TAKT_READ_TOOLS = ['takt_takt_get_goal', 'takt_takt_get_run', 'takt_takt_list_goals', 'takt_takt_list_tasks'];

describe('assistant MCP servers through the default OpenCode v2 transport', () => {
  let projectCwd: string | undefined;
  let savedVersion: string | undefined;

  beforeEach(() => {
    resetSharedServerPool();
    vi.clearAllMocks();
    savedVersion = process.env.TAKT_OPENCODE_VERSION;
    delete process.env.TAKT_OPENCODE_VERSION;
    startServer.mockImplementation(async (options: { mcpServerNames?: readonly string[] }) => ({
      client: await createV2Transport('http://localhost', 'password', options.mcpServerNames),
      close: vi.fn(async () => {}),
      onError: () => () => {},
    }));
    api.plugin.list.mockResolvedValue({ data: [{ id: 'takt.session', state: { status: 'active' } }] });
    api.session.create.mockResolvedValue({ id: 'v2-assistant-session' });
    api.session.get.mockImplementation(async () => ({ id: 'v2-assistant-session', location: { directory: projectCwd }, metadata: {} }));
    api.session.update.mockResolvedValue(undefined);
    api.session.switchAgent.mockResolvedValue(undefined);
    api.session.switchModel.mockResolvedValue(undefined);
    api.permission.reply.mockResolvedValue(undefined);
    api.mcp.list.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    resetSharedServerPool();
    if (savedVersion === undefined) {
      delete process.env.TAKT_OPENCODE_VERSION;
    } else {
      process.env.TAKT_OPENCODE_VERSION = savedVersion;
    }
    if (projectCwd !== undefined) {
      rmSync(projectCwd, { recursive: true, force: true });
      projectCwd = undefined;
    }
  });

  it.each([
    { serverName: 'backlog', similarServerTool: undefined },
    { serverName: 'backlog__main', similarServerTool: 'backlog_get_issue' },
    { serverName: 'queue_', similarServerTool: 'backlog_get_issue' },
  ])(
    'lets a conversation reach the reply when the assigned server $serverName registers its tools, enabling only that server\'s tools',
    async ({ serverName, similarServerTool }) => {
      projectCwd = mkdtempSync(join(process.env.TAKT_CONFIG_DIR!, 'assistant-opencode-v2-'));
      mkdirSync(join(projectCwd, '.takt'));
      writeFileSync(join(projectCwd, '.takt', 'runtime.yaml'), stringify({ version: 1, mcp: {
        servers: { backlog: { type: 'stdio', command: 'backlog-fixture' }, [serverName]: { type: 'stdio', command: 'named-fixture' } },
        targets: { personas: { assistant: { servers: [serverName] } } },
      } }));
      const assignedTools = [`${serverName}_get_issue`, `${serverName}_add_issue`];
      const unassignedTools = [...(similarServerTool === undefined ? [] : [similarServerTool]), 'takt_takt_enqueue_goal_task'];
      const registry = [
        ...assignedTools.map((id) => ({ id, namespace: serverName })),
        ...(similarServerTool === undefined ? [] : [{ id: similarServerTool, namespace: 'backlog' }]),
        ...TAKT_READ_TOOLS.map((id) => ({ id, namespace: 'takt' })),
        { id: 'takt_takt_enqueue_goal_task', namespace: 'takt' },
      ];
      api.rpc.call.mockResolvedValueOnce({ output: [] }).mockResolvedValue({ output: registry });
      const promptSent = deferred();
      api.session.prompt.mockImplementation(async () => { promptSent.resolve(); });
      const asked = [...assignedTools, ...unassignedTools];
      api.event.subscribe.mockImplementation(() => (async function* () {
        yield { type: 'server.connected' };
        await promptSent.promise;
        for (const [index, action] of asked.entries()) {
          yield { type: 'permission.asked', data: { id: `permission-${index}`, sessionID: 'v2-assistant-session', action, resources: ['*'] } };
        }
        yield { type: 'session.text.ended', data: { sessionID: 'v2-assistant-session', assistantMessageID: 'message-1', ordinal: 0, text: 'assistant reply' } };
        yield { type: 'session.execution.succeeded', data: { sessionID: 'v2-assistant-session' } };
      })());
      const plan = createAssistantConversationPlan(projectCwd, {
        assistantMode: 'assistant', formalSpec: false, formalSpecComments: true, modelCheckTimeoutSeconds: 300,
        resolvedSessionContext: {
          provider: new OpenCodeProvider(), providerType: 'opencode', model: 'opencode/big-pickle',
          lang: 'en', personaName: 'interactive', sessionId: undefined,
        },
      });

      const outcome = await callAIWithRetry('read and register issues', plan.strategy.systemPrompt, plan.strategy.allowedTools,
        projectCwd, plan.ctx, { outputMode: 'silent', persistSession: false });

      expect(outcome.error).toBeUndefined();
      expect(outcome.result?.success).toBe(true);
      expect(api.rpc.call.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(api.session.prompt).toHaveBeenCalledOnce();
      const update = api.session.update.mock.calls[0]![0] as {
        permissions: Array<{ action: string; effect: string }>;
        metadata: { takt: { tools: Record<string, boolean> } };
      };
      const allowed = update.permissions.filter((rule) => rule.effect === 'allow').map((rule) => rule.action);
      expect(allowed).toEqual(expect.arrayContaining([...assignedTools, ...TAKT_READ_TOOLS]));
      for (const tool of unassignedTools) expect(allowed).not.toContain(tool);
      expect(allowed.filter((action) => action.includes('*'))).toEqual([]);
      const enabledTools = Object.entries(update.metadata.takt.tools).filter(([, enabled]) => enabled).map(([tool]) => tool);
      expect(enabledTools).toEqual(expect.arrayContaining([...assignedTools, ...TAKT_READ_TOOLS]));
      expect(enabledTools.filter((tool) => tool.includes('*'))).toEqual([]);
      for (const tool of unassignedTools) expect(enabledTools).not.toContain(tool);
      expect(api.permission.reply.mock.calls.map(([request]) => (request as { decision: string }).decision))
        .toEqual(['once', 'once', ...unassignedTools.map(() => 'reject')]);
    },
  );
});
