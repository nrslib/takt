import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { callAIWithRetry } from '../features/interactive/aiCaller.js';
import { createAssistantConversationPlan } from '../features/interactive/conversationPlan.js';
import { MockProvider } from '../infra/providers/mock.js';
import { callMock } from '../infra/mock/client.js';
import { resetScenario, setMockScenario } from '../infra/mock/scenario.js';
import type { MockCallOptions } from '../infra/mock/types.js';

vi.mock('../infra/managed-providers/preflight.js', () => ({ checkManagedProviders: vi.fn(async () => undefined) }));

afterEach(() => {
  resetScenario();
  vi.unstubAllEnvs();
});

describe('assistant runtime MCP tools through real stdio', () => {
  it.each(['assistant', 'grill-me'] as const)('calls assigned read and write tools from a %s conversation', async (assistantMode) => {
    const cwd = mkdtempSync(join(process.env.TAKT_CONFIG_DIR!, 'assistant-mcp-stdio-'));
    const observedPath = join(cwd, 'observed.jsonl');
    const callLogPath = join(cwd, 'provider.jsonl');
    vi.stubEnv('TAKT_MOCK_CALL_LOG', callLogPath);
    const fixture = fileURLToPath(new URL('./helpers/assistant-mcp-server.mjs', import.meta.url));
    const calls = [
      { server: 'backlog', tool: 'get_issue', arguments: { issue: 'TEST-1' } },
      { server: 'backlog', tool: 'add_issue', arguments: { summary: 'New issue' } },
      { server: 'takt-full', tool: 'takt_enqueue_goal_task', arguments: { task: 'Follow up' } },
    ];
    try {
      mkdirSync(join(cwd, '.takt'));
      writeFileSync(join(cwd, '.takt', 'runtime.yaml'), stringify({ version: 1, mcp: {
        servers: Object.fromEntries(['backlog', 'takt-full'].map((name) => [name, {
          type: 'stdio', command: process.execPath, args: [fixture, observedPath, name],
        }])),
        targets: { personas: { assistant: { servers: ['backlog', 'takt-full'] } } },
      } }));
      setMockScenario([{ status: 'done', content: 'Issues handled', mcpToolCalls: calls }]);
      const plan = createAssistantConversationPlan(cwd, {
        assistantMode, formalSpec: false, formalSpecComments: true, modelCheckTimeoutSeconds: 300,
        resolvedSessionContext: {
          provider: new MockProvider(), providerType: 'mock', model: undefined,
          lang: 'en', personaName: 'interactive', sessionId: undefined,
        },
      });

      const outcome = await callAIWithRetry('Read and register an issue, then enqueue a follow-up',
        plan.strategy.systemPrompt, plan.strategy.allowedTools, cwd, plan.ctx,
        { outputMode: 'silent', persistSession: false });

      expect(outcome.error).toBeUndefined();
      expect(outcome.result).toMatchObject({ success: true, content: 'Issues handled' });
      expect(readFileSync(observedPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual(calls);
      const entries = readFileSync(callLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(entries.filter(({ event }) => event === 'mcp_tool_call').map(({ mcpToolCall }) => ({
        server: mcpToolCall.server, tool: mcpToolCall.tool,
        result: JSON.parse(mcpToolCall.result.content[0].text),
      }))).toEqual(calls.map((call) => ({ server: call.server, tool: call.tool, result: call })));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('mock MCP cancellation through the real SDK and stdio server', () => {
  it.each([
    { phase: 'call', enqueueFirst: false },
    { phase: 'call', enqueueFirst: true },
    { phase: 'initialize', enqueueFirst: false },
    { phase: 'cleanup', enqueueFirst: true },
  ])('returns blocked for cancellation during $phase with a prior successful call: $enqueueFirst', async ({ phase, enqueueFirst }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'mock-mcp-abort-'));
    const controller = new AbortController();
    const startedPath = join(cwd, 'started');
    const enqueuedPath = join(cwd, 'enqueued');
    const releasePath = join(cwd, 'release');
    const logPath = join(cwd, 'calls.jsonl');
    vi.stubEnv('TAKT_MOCK_CALL_LOG', logPath);
    const options: MockCallOptions = {
      cwd,
      abortSignal: controller.signal,
      allowedTools: ['mcp__fixture__enqueue', 'mcp__fixture__wait'],
      preparedMcp: {
        dispose: async () => {},
        resolvedServers: {
          enabled: true, identity: 'abort-fixture', serverNames: ['fixture'],
          servers: {
            fixture: {
              type: 'stdio', command: process.execPath,
              args: [fileURLToPath(new URL('./helpers/mock-mcp-abort-server.mjs', import.meta.url)), enqueuedPath, startedPath, phase, releasePath],
            },
          },
        },
      },
    };
    setMockScenario([{
      status: 'done',
      content: 'done',
      mcpToolCalls: [
        ...(enqueueFirst ? [{ server: 'fixture', tool: 'enqueue', arguments: {} }] : []),
        ...(phase === 'cleanup' ? [] : [{ server: 'fixture', tool: 'wait', arguments: {} }]),
      ],
    }]);
    const onStream = vi.fn();
    const response = callMock('manager', 'task', { ...options, onStream });
    // Attach immediately so a startup failure cannot become an unhandled rejection while polling.
    const completed = response.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true), { timeout: 10000 });
      const entriesBeforeAbort = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(entriesBeforeAbort.map(({ event }) => event)).toEqual(enqueueFirst ? ['start', 'mcp_tool_call'] : ['start']);
      expect(existsSync(enqueuedPath)).toBe(enqueueFirst);
      controller.abort(`stop during MCP ${phase}`);
      writeFileSync(releasePath, 'release cleanup');
      expect(await completed).toMatchObject({ value: { status: 'blocked', content: expect.stringContaining('[MOCK:ABORTED]') } });
      const entries = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(entries.at(-1)).toMatchObject({ event: 'complete', status: 'blocked', aborted: true });
      expect(entries.map(({ event }) => event)).toEqual(enqueueFirst ? ['start', 'mcp_tool_call', 'complete'] : ['start', 'complete']);
      if (enqueueFirst) {
        expect(entries[1].mcpToolCall).toEqual({
          server: 'fixture', transport: 'stdio', tool: 'enqueue',
          result: { content: [{ type: 'text', text: 'task enqueued' }] },
        });
      }
      expect(onStream).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      writeFileSync(releasePath, 'release cleanup');
      await completed;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
