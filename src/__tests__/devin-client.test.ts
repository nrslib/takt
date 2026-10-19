import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn, debugSpy } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  debugSpy: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: vi.fn(() => ({
    debug: debugSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    enter: vi.fn(),
    exit: vi.fn(),
  })),
}));

import { callDevin } from '../infra/devin/client.js';

interface WireMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type MockAcpChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

interface AcpServerApi {
  respond(id: number, result: unknown): void;
  fail(id: number, code: number, message: string, data?: unknown): void;
  notify(method: string, params: unknown): void;
  sendRequest(method: string, params: unknown, onResponse: (msg: WireMessage) => void): number;
}

// Handler return value is written back as the JSON-RPC result. Returning
// `undefined` defers the response — the handler must later call
// `api.respond(id, ...)` / `api.fail(id, ...)` itself.
type AcpRequestHandler = (
  params: Record<string, unknown>,
  api: AcpServerApi,
  id: number,
) => unknown;

interface AcpScenario {
  sessionId?: string;
  configOptions?: unknown[];
  modes?: unknown;
  updates?: Record<string, unknown>[];
  stopReason?: string;
  usage?: Record<string, unknown> | null;
  promptError?: { code: number; message: string; data?: unknown };
  loadError?: { code: number; message: string; data?: unknown };
  setModeError?: { code: number; message: string };
  stderr?: string;
}

const DEFAULT_USAGE = {
  totalTokens: 175,
  inputTokens: 160,
  outputTokens: 15,
  cachedReadTokens: 52,
};

const DEFAULT_MODES = {
  currentModeId: 'accept-edits',
  availableModes: [
    { id: 'accept-edits', name: 'Accept Edits' },
    { id: 'smart', name: 'Smart' },
    { id: 'ask', name: 'Ask' },
    { id: 'plan', name: 'Plan' },
    { id: 'bypass', name: 'Bypass' },
  ],
};

const DEFAULT_CONFIG_OPTIONS = [
  {
    type: 'select',
    id: 'model',
    name: 'Model',
    currentValue: 'swe-2-high',
    options: [
      { value: 'swe-2-high', name: 'SWE-2' },
      { value: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5' },
      { value: 'swe-1-6', name: 'SWE-1.6' },
    ],
  },
  {
    type: 'select',
    id: 'thought_level',
    name: 'Thought Level',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
      { value: 'xhigh', name: 'XHigh' },
      { value: 'max', name: 'Max' },
    ],
  },
];

interface ConfigOptionState {
  type: string;
  id: string;
  currentValue: unknown;
  options: ({ value: string; name: string } | { options: { value: string }[] })[];
}

function defaultHandlers(scenario: AcpScenario): Record<string, AcpRequestHandler> {
  const configState = JSON.parse(
    JSON.stringify(scenario.configOptions ?? DEFAULT_CONFIG_OPTIONS),
  ) as ConfigOptionState[];
  return {
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'devin-browser', name: 'Devin Browser' }],
      agentInfo: { name: 'affogato', version: '0.0.0-test' },
    }),
    'session/new': () => ({
      sessionId: scenario.sessionId ?? 'keen-otter',
      modes: scenario.modes ?? DEFAULT_MODES,
      configOptions: configState,
    }),
    'session/load': (_params, api, id) => {
      if (scenario.loadError) {
        api.fail(id, scenario.loadError.code, scenario.loadError.message, scenario.loadError.data);
        return undefined;
      }
      return {
        modes: scenario.modes ?? DEFAULT_MODES,
        configOptions: configState,
      };
    },
    'session/set_mode': (_params, api, id) => {
      if (scenario.setModeError) {
        api.fail(id, scenario.setModeError.code, scenario.setModeError.message);
        return undefined;
      }
      return {};
    },
    'session/set_config_option': (params, api, id) => {
      const option = configState.find((entry) => entry.id === params.configId);
      const values = option?.options.flatMap((entry) => ('options' in entry ? entry.options : [entry]));
      if (!option || !values?.some((value) => value.value === params.value)) {
        api.fail(id, -32602, `Invalid value '${String(params.value)}' for config option '${String(params.configId)}'`);
        return undefined;
      }
      option.currentValue = params.value;
      return { configOptions: configState };
    },
    'session/prompt': (params, api, id) => {
      const sid = params.sessionId as string;
      for (const update of scenario.updates ?? [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
      ]) {
        api.notify('session/update', { sessionId: sid, update });
      }
      if (scenario.promptError) {
        api.fail(id, scenario.promptError.code, scenario.promptError.message, scenario.promptError.data);
        return undefined;
      }
      return {
        stopReason: scenario.stopReason ?? 'end_turn',
        ...(scenario.usage === null ? {} : { usage: scenario.usage ?? DEFAULT_USAGE }),
      };
    },
  };
}

function createAcpChild(): MockAcpChild {
  const child = new EventEmitter() as MockAcpChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn((signal?: string) => {
    queueMicrotask(() => {
      child.emit('close', null, signal ?? 'SIGTERM');
    });
    return true;
  });
  return child;
}

function attachAcpServer(
  child: MockAcpChild,
  handlers: Record<string, AcpRequestHandler>,
): void {
  const pendingServerRequests = new Map<number, (msg: WireMessage) => void>();
  let nextServerRequestId = 10_000;
  const write = (msg: Record<string, unknown>): void => {
    child.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const api: AcpServerApi = {
    respond: (id, result) => write({ jsonrpc: '2.0', id, result }),
    fail: (id, code, message, data) =>
      write({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }),
    notify: (method, params) => write({ jsonrpc: '2.0', method, params }),
    sendRequest: (method, params, onResponse) => {
      const id = nextServerRequestId++;
      pendingServerRequests.set(id, onResponse);
      write({ jsonrpc: '2.0', id, method, params });
      return id;
    },
  };

  let buffer = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length === 0) {
        continue;
      }
      const msg = JSON.parse(line) as WireMessage;
      if (msg.method === undefined) {
        if (msg.id !== undefined) {
          pendingServerRequests.get(msg.id)?.(msg);
          pendingServerRequests.delete(msg.id);
        }
        continue;
      }
      if (msg.id === undefined) {
        continue; // notification
      }
      const handler = handlers[msg.method];
      if (!handler) {
        api.fail(msg.id, -32601, `method not found: ${msg.method}`);
        continue;
      }
      try {
        const result = handler(msg.params ?? {}, api, msg.id);
        if (result !== undefined) {
          api.respond(msg.id, result);
        }
      } catch (error) {
        api.fail(msg.id, -32603, error instanceof Error ? error.message : String(error));
      }
    }
  });
}

/** Spawn-time file contents captured before the tmp dir is deleted. */
const spawnFiles = new Map<string, string>();

function recordConfigArg(call: unknown[]): void {
  const args = call[1] as string[];
  const index = args.indexOf('--config');
  const path = index >= 0 ? args[index + 1] : undefined;
  if (path === undefined) {
    return;
  }
  try {
    spawnFiles.set('config', readFileSync(path, 'utf-8'));
  } catch {
    // path may not exist in mocked envs
  }
}

interface MockAcpServer {
  requests: WireMessage[];
  /** The most recently spawned child, for manual close/error simulation. */
  lastChild: () => MockAcpChild;
}

function mockAcpServer(scenario: AcpScenario = {}, overrides: Record<string, AcpRequestHandler> = {}): MockAcpServer {
  const requests: WireMessage[] = [];
  const children: MockAcpChild[] = [];
  mockSpawn.mockImplementation((...call: unknown[]) => {
    recordConfigArg(call);
    const child = createAcpChild();
    children.push(child);
    const handlers = { ...defaultHandlers(scenario), ...overrides };
    const wrapped: Record<string, AcpRequestHandler> = {};
    for (const [method, handler] of Object.entries(handlers)) {
      wrapped[method] = (params, api, id) => {
        requests.push({ id, method, params });
        return handler(params, api, id);
      };
    }
    attachAcpServer(child, wrapped);
    if (scenario.stderr !== undefined) {
      queueMicrotask(() => child.stderr.write(scenario.stderr!));
    }
    return child;
  });
  return { requests, lastChild: () => children[children.length - 1]! };
}

function requestsOf(server: MockAcpServer, method: string): WireMessage[] {
  return server.requests.filter((request) => request.method === method);
}

function spawnCall(index: number): [string, string[], { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown; shell?: boolean }] {
  return mockSpawn.mock.calls[index] as [string, string[], { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown; shell?: boolean }];
}

function mainSpawnCall(): [string, string[], { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown; shell?: boolean }] {
  expect(mockSpawn).toHaveBeenCalledTimes(1);
  return spawnCall(0);
}

const restoredEnvKeys = [
  'ALL_PROXY',
  'DEVIN_MODEL',
  'GITHUB_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SERVICE_SECRET',
  'WINDSURF_API_KEY',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

const originalEnvValues = new Map(
  restoredEnvKeys.map((key) => [key, process.env[key]]),
);

function restoreEnv(): void {
  for (const [key, value] of originalEnvValues) {
    if (value !== undefined) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
}

describe('callDevin', () => {
  let xdgConfigHome: string;
  const tmpDirs: string[] = [];

  function writeUserConfig(content: string): void {
    const dir = join(xdgConfigHome, 'devin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), content, 'utf-8');
  }

  function generatedConfig(): Record<string, unknown> {
    return JSON.parse(spawnFiles.get('config') ?? '{}') as Record<string, unknown>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    spawnFiles.clear();
    xdgConfigHome = mkdtempSync(join(tmpdir(), 'takt-devin-test-'));
    tmpDirs.push(xdgConfigHome);
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
  });

  afterEach(() => {
    restoreEnv();
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Given a session, When called, Then spawns devin acp with the merged config and loads the session', async () => {
    const onActivity = vi.fn();
    const server = mockAcpServer();

    const result = await callDevin('coder', 'implement feature', {
      cwd: '/repo',
      sessionId: 'rare-boater',
      permissionMode: 'full',
      onActivity,
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('done');
    expect(result.sessionId).toBe('rare-boater');
    expect(onActivity).toHaveBeenCalledOnce();

    const [command, args, options] = mainSpawnCall();
    expect(command).toBe('devin');
    expect(args).toContain('acp');
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--prompt-file');
    expect(args).not.toContain('--export');
    expect(args).not.toContain('--permission-mode');
    expect(args).toEqual(expect.arrayContaining(['--respect-workspace-trust', 'false']));
    expect(args).toContain('--config');
    expect(options.cwd).toBe('/repo');
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(options.shell).toBeUndefined();

    expect(requestsOf(server, 'initialize')).toHaveLength(1);
    expect(requestsOf(server, 'session/new')).toHaveLength(0);
    const loads = requestsOf(server, 'session/load');
    expect(loads).toHaveLength(1);
    expect(loads[0]?.params).toEqual(
      expect.objectContaining({ sessionId: 'rare-boater', cwd: '/repo' }),
    );
    const prompts = requestsOf(server, 'session/prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.params?.sessionId).toBe('rare-boater');
  });

  it('Given no session, When called, Then session/new returns the session ID', async () => {
    const server = mockAcpServer({ sessionId: 'keen-otter' });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('keen-otter');
    expect(requestsOf(server, 'session/new')).toHaveLength(1);
    expect(requestsOf(server, 'session/load')).toHaveLength(0);
  });

  it('Given a prompt, When called, Then the prompt text is delivered through session/prompt without shell execution', async () => {
    const server = mockAcpServer();

    await callDevin('coder', 'inspect & whoami | cat', { cwd: '/repo' });

    const [, args, options] = mainSpawnCall();
    expect(args).not.toContain('inspect & whoami | cat');
    expect(options.shell).toBeUndefined();
    const prompt = requestsOf(server, 'session/prompt')[0]?.params;
    expect(prompt?.prompt).toEqual([{ type: 'text', text: 'inspect & whoami | cat' }]);
  });

  it('Given system prompt, When called, Then prepends it to the prompt content', async () => {
    const server = mockAcpServer();

    await callDevin('reviewer', 'custom user prompt', {
      cwd: '/repo',
      systemPrompt: 'custom system prompt',
    });

    const prompt = requestsOf(server, 'session/prompt')[0]?.params;
    expect(prompt?.prompt).toEqual([
      { type: 'text', text: 'custom system prompt\n\ncustom user prompt' },
    ]);
  });

  it('Given a large prompt, When called, Then it is sent over JSON-RPC instead of argv', async () => {
    const server = mockAcpServer();
    const largePrompt = 'x'.repeat(150 * 1024);

    await callDevin('coder', largePrompt, { cwd: '/repo' });

    const [, args] = mainSpawnCall();
    expect(args).not.toContain(largePrompt);
    const prompt = requestsOf(server, 'session/prompt')[0]?.params;
    expect((prompt?.prompt as { text: string }[])[0]?.text).toBe(largePrompt);
  });

  it('Given a model option, When called, Then passes --model to devin acp', async () => {
    mockAcpServer();

    await callDevin('coder', 'implement', { cwd: '/repo', model: 'swe-2-max' });

    const [, args] = mainSpawnCall();
    const modelFlagIndex = args.indexOf('--model');
    expect(modelFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[modelFlagIndex + 1]).toBe('swe-2-max');
  });

  it('Given a tiered model name on a new session, When the session already resolved it, Then no correction is needed', async () => {
    const onStream = vi.fn();
    const resolvedOptions = JSON.parse(JSON.stringify(DEFAULT_CONFIG_OPTIONS)) as { id: string; currentValue: string }[];
    resolvedOptions.find((option) => option.id === 'thought_level')!.currentValue = 'max';
    const server = mockAcpServer({ configOptions: resolvedOptions });

    const result = await callDevin('coder', 'implement', { cwd: '/repo', model: 'swe-2-max', onStream });

    expect(result.status).toBe('done');
    expect(requestsOf(server, 'session/set_config_option')).toHaveLength(0);
    expect(onStream).toHaveBeenCalledWith({
      type: 'init',
      data: { model: 'swe-2-high@max', sessionId: 'keen-otter' },
    });
  });

  it('Given a tiered model name on a new session, When the session did not apply the level, Then set_config_option corrects it', async () => {
    const server = mockAcpServer();

    const result = await callDevin('coder', 'implement', { cwd: '/repo', model: 'swe-2-max' });

    expect(result.status).toBe('done');
    const sets = requestsOf(server, 'session/set_config_option');
    expect(sets).toHaveLength(1);
    expect(sets[0]?.params).toEqual(
      expect.objectContaining({ configId: 'thought_level', value: 'max' }),
    );
  });

  it('Given an unresolvable model on a new session, When the CLI silently defaulted, Then the call fails fast', async () => {
    const server = mockAcpServer();

    const result = await callDevin('coder', 'implement', { cwd: '/repo', model: 'garbage-name' });

    expect(result.status).toBe('error');
    expect(result.error).toContain("Devin model 'garbage-name' is not available");
    expect(requestsOf(server, 'session/prompt')).toHaveLength(0);
  });

  it('Given a fuzzy alias on a new session, When the CLI resolved it to a matching model, Then the call proceeds', async () => {
    const resolvedOptions = JSON.parse(JSON.stringify(DEFAULT_CONFIG_OPTIONS)) as { id: string; currentValue: string }[];
    resolvedOptions.find((option) => option.id === 'model')!.currentValue = 'claude-opus-5-5-medium';
    resolvedOptions.find((option) => option.id === 'thought_level')!.currentValue = 'medium';
    mockAcpServer({ configOptions: resolvedOptions });

    const result = await callDevin('coder', 'implement', { cwd: '/repo', model: 'opus' });

    expect(result.status).toBe('done');
  });

  it('Given a model override on a resumed session, When the option value is selectable, Then set_config_option applies it', async () => {
    const server = mockAcpServer();

    await callDevin('coder', 'implement', {
      cwd: '/repo',
      sessionId: 'rare-boater',
      model: 'swe-1-6',
    });

    const sets = requestsOf(server, 'session/set_config_option');
    expect(sets).toHaveLength(1);
    expect(sets[0]?.params).toEqual(
      expect.objectContaining({ sessionId: 'rare-boater', configId: 'model', value: 'swe-1-6' }),
    );
  });

  it('Given a tiered model name on a resumed session, When loaded, Then model and thought level are applied', async () => {
    const server = mockAcpServer();

    const result = await callDevin('coder', 'implement', {
      cwd: '/repo',
      sessionId: 'rare-boater',
      model: 'claude-opus-5-5-medium',
    });

    expect(result.status).toBe('done');
    const sets = requestsOf(server, 'session/set_config_option');
    expect(sets.map((request) => request.params)).toEqual([
      expect.objectContaining({ sessionId: 'rare-boater', configId: 'model', value: 'claude-opus-5-5-medium' }),
      expect.objectContaining({ sessionId: 'rare-boater', configId: 'thought_level', value: 'medium' }),
    ]);
  });

  it('Given a level-only model difference on a resumed session, When loaded, Then only the thought level is applied', async () => {
    const server = mockAcpServer();

    const result = await callDevin('coder', 'implement', {
      cwd: '/repo',
      sessionId: 'rare-boater',
      model: 'swe-2-max',
    });

    expect(result.status).toBe('done');
    const sets = requestsOf(server, 'session/set_config_option');
    expect(sets).toHaveLength(1);
    expect(sets[0]?.params).toEqual(
      expect.objectContaining({ sessionId: 'rare-boater', configId: 'thought_level', value: 'max' }),
    );
  });

  it('Given an unresolvable model on a resumed session, When loaded, Then the call fails fast before prompting', async () => {
    const server = mockAcpServer();

    const result = await callDevin('coder', 'implement', {
      cwd: '/repo',
      sessionId: 'rare-boater',
      model: 'garbage-name',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain("Devin model 'garbage-name' is not available");
    expect(requestsOf(server, 'session/prompt')).toHaveLength(0);
  });

  it('Given custom CLI path, When called, Then uses it as the executable', async () => {
    mockAcpServer();

    await callDevin('coder', 'implement', { cwd: '/repo', devinCliPath: '/custom/bin/devin' });

    const [command] = mainSpawnCall();
    expect(command).toBe('/custom/bin/devin');
  });

  it('Given env vars outside the allowlist, When called, Then only the Devin child env allowlist is passed', async () => {
    process.env.GITHUB_TOKEN = 'github-token';
    process.env.SERVICE_SECRET = 'service-secret';
    process.env.DEVIN_MODEL = 'swe-2-high';
    process.env.WINDSURF_API_KEY = 'windsurf-key';
    process.env.XDG_DATA_HOME = '/xdg/data';
    mockAcpServer();

    await callDevin('coder', 'implement', { cwd: '/repo' });

    const [, , options] = mainSpawnCall();
    expect(options.env).not.toBe(process.env);
    expect(options.env?.GITHUB_TOKEN).toBeUndefined();
    expect(options.env?.SERVICE_SECRET).toBeUndefined();
    expect(options.env?.DEVIN_MODEL).toBe('swe-2-high');
    expect(options.env?.WINDSURF_API_KEY).toBe('windsurf-key');
    expect(options.env?.XDG_DATA_HOME).toBe('/xdg/data');
  });

  it('Given streaming updates, When called, Then text deltas, thinking and tool events stream before the result', async () => {
    const onStream = vi.fn();
    mockAcpServer({
      updates: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial ' } },
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'exec:0',
          title: 'Ran npm',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: 'npm test' },
          _meta: { 'cognition.ai/inferenceToolName': 'exec' },
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'exec:0',
          status: 'in_progress',
          content: [{ type: 'content', content: { type: 'text', text: 'running...' } }],
        },
        // A completed update arrives without content; the result carries the
        // last cumulative output seen while the call was running.
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'exec:0',
          status: 'completed',
        },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
      ],
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo', onStream });

    expect(result.status).toBe('done');
    expect(result.content).toBe('partial answer');
    const types = onStream.mock.calls.map((call) => (call[0] as { type: string }).type);
    expect(types).toEqual(['init', 'text', 'thinking', 'tool_use', 'tool_output', 'tool_result', 'text', 'result']);
    expect(onStream).toHaveBeenCalledWith({
      type: 'tool_use',
      data: { id: 'exec:0', tool: 'exec', input: { command: 'npm test' } },
    });
    expect(onStream).toHaveBeenCalledWith({
      type: 'tool_result',
      data: { id: 'exec:0', content: 'running...', isError: false },
    });
    const resultCall = onStream.mock.calls.at(-1)?.[0] as { data: { result: string; sessionId: string; success: boolean } };
    expect(resultCall.data).toEqual({ result: 'partial answer', sessionId: 'keen-otter', success: true });
  });

  it('Given cumulative tool_call_update content, When called, Then only the appended suffix streams as tool_output', async () => {
    const onStream = vi.fn();
    const text = (t: string): unknown => ({ type: 'content', content: { type: 'text', text: t } });
    mockAcpServer({
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'exec:0',
          status: 'in_progress',
          _meta: { 'cognition.ai/inferenceToolName': 'exec' },
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'exec:0',
          status: 'in_progress',
          content: [text('line1')],
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'exec:0',
          status: 'in_progress',
          content: [text('line1\nline2')],
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'exec:0',
          status: 'in_progress',
          content: [text('line1\nline2\nline3')],
        },
        // A repeated snapshot of the same output produces no new event.
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'exec:0',
          status: 'in_progress',
          content: [text('line1\nline2\nline3')],
        },
        { sessionUpdate: 'tool_call_update', toolCallId: 'exec:0', status: 'completed' },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
      ],
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo', onStream });

    expect(result.status).toBe('done');
    const events = onStream.mock.calls.map((call) => call[0] as { type: string; data: Record<string, unknown> });
    const outputs = events.filter((event) => event.type === 'tool_output').map((event) => event.data.output);
    expect(outputs).toEqual(['line1', '\nline2', '\nline3']);
    const results = events.filter((event) => event.type === 'tool_result');
    expect(results).toEqual([
      { type: 'tool_result', data: { id: 'exec:0', content: 'line1\nline2\nline3', isError: false } },
    ]);
  });

  it('Given a tool_call_update whose content is replaced rather than extended, When called, Then the new content streams whole', async () => {
    const onStream = vi.fn();
    const text = (t: string): unknown => ({ type: 'content', content: { type: 'text', text: t } });
    mockAcpServer({
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'exec:0',
          status: 'in_progress',
          content: [text('line1\nline2')],
          _meta: { 'cognition.ai/inferenceToolName': 'exec' },
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'exec:0',
          status: 'in_progress',
          content: [text('rewritten')],
        },
        { sessionUpdate: 'tool_call_update', toolCallId: 'exec:0', status: 'failed' },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
      ],
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo', onStream });

    expect(result.status).toBe('done');
    const events = onStream.mock.calls.map((call) => call[0] as { type: string; data: Record<string, unknown> });
    const outputs = events.filter((event) => event.type === 'tool_output').map((event) => event.data.output);
    expect(outputs).toEqual(['line1\nline2', 'rewritten']);
    expect(events.filter((event) => event.type === 'tool_result')).toEqual([
      { type: 'tool_result', data: { id: 'exec:0', content: 'rewritten', isError: true } },
    ]);
  });

  it('Given updates replayed during session/load, When called, Then history is not re-emitted', async () => {
    const onStream = vi.fn();
    mockAcpServer({}, {
      'session/load': (_params, api, id) => {
        api.notify('session/update', {
          sessionId: 'rare-boater',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old message' } },
        });
        api.respond(id, { modes: DEFAULT_MODES, configOptions: DEFAULT_CONFIG_OPTIONS });
        return undefined;
      },
    });

    const result = await callDevin('coder', 'implement', {
      cwd: '/repo',
      sessionId: 'rare-boater',
      onStream,
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('done');
    const texts = onStream.mock.calls
      .map((call) => call[0] as { type: string; data?: { text?: string } })
      .filter((event) => event.type === 'text')
      .map((event) => event.data?.text);
    expect(texts).toEqual(['done']);
  });

  it('Given full permission, When a permission request arrives, Then allow_once is selected', async () => {
    let answered: WireMessage | undefined;
    mockAcpServer({}, {
      'session/prompt': (params, api, id) => {
        api.sendRequest('session/request_permission', {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'exec:0', title: 'Ran rm', kind: 'execute' },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          ],
        }, (msg) => {
          answered = msg;
          api.respond(id, { stopReason: 'end_turn', usage: DEFAULT_USAGE });
        });
        api.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
        });
        return undefined;
      },
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo', permissionMode: 'full' });

    expect(result.status).toBe('done');
    expect(answered?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
  });

  it('Given edit permission, When a permission request arrives, Then reject_once is selected', async () => {
    let answered: WireMessage | undefined;
    mockAcpServer({}, {
      'session/prompt': (params, api, id) => {
        api.sendRequest('session/request_permission', {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'webfetch:0', title: 'Fetch', kind: 'fetch' },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          ],
        }, (msg) => {
          answered = msg;
          api.respond(id, { stopReason: 'end_turn', usage: DEFAULT_USAGE });
        });
        api.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
        });
        return undefined;
      },
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo', permissionMode: 'edit' });

    expect(result.status).toBe('done');
    expect(answered?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject_once' },
    });
  });

  it.each([
    ['readonly', 'ask'],
    ['edit', 'accept-edits'],
    ['full', 'bypass'],
    [undefined, 'accept-edits'],
  ] as const)('Given %s permission, When called, Then session mode %s is requested', async (permissionMode, expectedMode) => {
    const server = mockAcpServer();

    await callDevin('coder', 'implement', { cwd: '/repo', permissionMode });

    const modes = requestsOf(server, 'session/set_mode');
    expect(modes).toHaveLength(1);
    expect(modes[0]?.params).toEqual(expect.objectContaining({ modeId: expectedMode }));
  });

  it('Given edit permission, When called, Then injects allow rules for exec through --config', async () => {
    mockAcpServer();

    await callDevin('coder', 'implement', { cwd: '/repo', permissionMode: 'edit' });

    const [, args] = mainSpawnCall();
    expect(args).toContain('--config');
    const config = generatedConfig() as { permissions?: { allow?: string[] } };
    expect(config.permissions?.allow).toEqual(expect.arrayContaining(['exec', 'edit', 'Write(**)']));
  });

  it('Given readonly permission, When called, Then injects deny rules through --config', async () => {
    mockAcpServer();

    await callDevin('coder', 'inspect', { cwd: '/repo', permissionMode: 'readonly' });

    const config = generatedConfig() as { permissions?: { deny?: string[] }; shell?: { setup_complete?: boolean } };
    expect(config.permissions?.deny).toEqual(expect.arrayContaining(['exec', 'edit', 'Write(**)', 'mcp__*']));
    expect(config.permissions?.deny).not.toContain('Fetch(**)');
    expect(config.shell?.setup_complete).toBe(true);
  });

  it('Given strict-readonly isolation, When called, Then deny rules also block fetch access', async () => {
    mockAcpServer();

    await callDevin('verifier', 'inspect', {
      cwd: '/repo',
      permissionMode: 'readonly',
      internalAgentIsolation: 'strict-readonly',
    });

    const config = generatedConfig() as { permissions?: { deny?: string[] } };
    expect(config.permissions?.deny).toContain('Fetch(**)');
  });

  it('Given no permission mode, When called, Then the merged user config gains write deny rules', async () => {
    writeUserConfig(JSON.stringify({
      agent: { model: 'claude-opus-5-5-medium' },
      permissions: { allow: ['Exec(git)'], deny: ['Exec(sudo)'] },
    }));
    mockAcpServer();

    await callDevin('coder', 'inspect', { cwd: '/repo' });

    const config = generatedConfig() as {
      agent?: { model?: string };
      permissions?: { allow?: string[]; deny?: string[] };
    };
    expect(config.agent?.model).toBe('claude-opus-5-5-medium');
    expect(config.permissions?.allow).toEqual(['Exec(git)']);
    expect(config.permissions?.deny).toEqual(['Exec(sudo)', 'edit', 'Write(**)']);
  });

  it('Given full permission, When called, Then the generated config keeps user settings without added rules', async () => {
    writeUserConfig(JSON.stringify({
      agent: { model: 'swe-2-max' },
      permissions: { allow: ['Exec(git)'], ask: ['Write(.env*)'] },
      theme_mode: 'dark',
    }));
    mockAcpServer();

    await callDevin('coder', 'implement', { cwd: '/repo', permissionMode: 'full' });

    const config = generatedConfig() as {
      agent?: { model?: string };
      theme_mode?: string;
      shell?: { setup_complete?: boolean };
      permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
    };
    expect(config.agent?.model).toBe('swe-2-max');
    expect(config.theme_mode).toBe('dark');
    expect(config.shell?.setup_complete).toBe(true);
    expect(config.permissions).toEqual({ allow: ['Exec(git)'], ask: ['Write(.env*)'] });
  });

  it('Given a user config with its own rules, When edit mode runs, Then TAKT allow rules are appended after user rules', async () => {
    writeUserConfig(JSON.stringify({
      permissions: { allow: ['Exec(git)'], deny: ['Fetch(domain:evil.example)'] },
    }));
    mockAcpServer();

    await callDevin('coder', 'implement', { cwd: '/repo', permissionMode: 'edit' });

    const config = generatedConfig() as { permissions?: { allow?: string[]; deny?: string[] } };
    expect(config.permissions?.allow).toEqual(['Exec(git)', 'exec', 'edit', 'Write(**)']);
    expect(config.permissions?.deny).toEqual(['Fetch(domain:evil.example)']);
  });

  it('Given a user config with JSONC comments and trailing commas, When called, Then it is still merged', async () => {
    writeUserConfig(`{
      // user's chosen model
      "agent": { "model": "claude-opus-5-5-medium", },
      "permissions": {
        "allow": ["Fetch(https://api.example.com/*)"], // URL keeps its //
      },
    }`);
    mockAcpServer();

    await callDevin('coder', 'inspect', { cwd: '/repo' });

    const config = generatedConfig() as {
      agent?: { model?: string };
      permissions?: { allow?: string[] };
    };
    expect(config.agent?.model).toBe('claude-opus-5-5-medium');
    expect(config.permissions?.allow).toEqual(['Fetch(https://api.example.com/*)']);
  });

  it('Given an unparseable user config, When called, Then the generated config falls back to defaults', async () => {
    writeUserConfig('not json at all {{{');
    mockAcpServer();

    await callDevin('coder', 'inspect', { cwd: '/repo', permissionMode: 'readonly' });

    const config = generatedConfig() as {
      version?: number;
      shell?: { setup_complete?: boolean };
      permissions?: { deny?: string[] };
    };
    expect(config.version).toBe(1);
    expect(config.shell?.setup_complete).toBe(true);
    expect(config.permissions?.deny).toEqual(expect.arrayContaining(['exec', 'edit', 'Write(**)', 'mcp__*']));
  });

  it('Given parallel calls in the same directory, When each finishes, Then each resolves only its own session', async () => {
    let next = 0;
    const ids = ['session-a', 'session-b'];
    mockSpawn.mockImplementation((...call: unknown[]) => {
      recordConfigArg(call);
      const child = createAcpChild();
      const id = ids[next++] ?? 'unexpected';
      attachAcpServer(child, defaultHandlers({ sessionId: id }));
      return child;
    });

    const [a, b] = await Promise.all([
      callDevin('coder', 'task a', { cwd: '/repo' }),
      callDevin('coder', 'task b', { cwd: '/repo' }),
    ]);

    expect(a.content).toBe('done');
    expect(a.sessionId).toBe('session-a');
    expect(b.content).toBe('done');
    expect(b.sessionId).toBe('session-b');
  });

  it('Given an invalid session ID, When called, Then returns an error without spawning', async () => {
    const result = await callDevin('coder', 'implement', {
      cwd: '/repo',
      sessionId: 'bad;rm -rf',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Invalid Devin session ID');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('Given a session/load failure, When called, Then the JSON-RPC error surfaces', async () => {
    mockAcpServer({
      loadError: { code: -32016, message: 'Session not found', data: { 'cognition.ai/errorKind': 'session_not_found' } },
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo', sessionId: 'gone-session' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Session not found');
  });

  it('Given empty assistant output, When called, Then returns an error response', async () => {
    mockAcpServer({ updates: [] });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toBe('devin returned empty output');
  });

  it('Given the process exits mid-turn, When called, Then returns an error with stderr detail', async () => {
    mockSpawn.mockImplementation((...call: unknown[]) => {
      recordConfigArg(call);
      const child = createAcpChild();
      attachAcpServer(child, {
        initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'x', version: '0' } }),
        'session/new': () => ({ sessionId: 'keen-otter', modes: DEFAULT_MODES, configOptions: [] }),
        'session/prompt': (_params, _api, _id) => {
          queueMicrotask(() => {
            child.stderr.write('something exploded');
            child.emit('close', 2, null);
          });
          return undefined;
        },
      });
      return child;
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Devin CLI exited with code 2');
    expect(result.error).toContain('something exploded');
  });

  it('Given ENOENT, When called, Then reports the missing devin binary', async () => {
    mockSpawn.mockImplementation(() => {
      const child = createAcpChild();
      queueMicrotask(() => {
        child.emit('error', Object.assign(new Error('spawn devin ENOENT'), { code: 'ENOENT' }));
      });
      return child;
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('devin binary not found');
  });

  it('Given an authentication failure, When called, Then reports the login requirement', async () => {
    mockAcpServer({
      promptError: { code: -32000, message: 'authentication required: not logged in' },
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('devin auth login');
  });

  it('Given an abort signal, When called, Then cancels the session and returns the aborted error', async () => {
    const abortController = new AbortController();
    let killSignal: string | undefined;
    mockSpawn.mockImplementation(() => {
      const child = createAcpChild();
      child.kill = vi.fn((signal?: string) => {
        killSignal = signal;
        queueMicrotask(() => child.emit('close', null, signal ?? 'SIGTERM'));
        return true;
      });
      attachAcpServer(child, {
        initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'x', version: '0' } }),
        'session/new': (_params, api, id) => {
          api.respond(id, { sessionId: 'keen-otter', modes: DEFAULT_MODES, configOptions: [] });
          queueMicrotask(() => abortController.abort());
          return undefined;
        },
      });
      return child;
    });

    const result = await callDevin('coder', 'implement', {
      cwd: '/repo',
      abortSignal: abortController.signal,
    });

    expect(result.status).toBe('error');
    expect(result.error).toBe('Devin execution aborted');
    expect(killSignal).toBe('SIGTERM');
  });

  it('Given a rate limit response, When called, Then returns a rate_limited response', async () => {
    mockAcpServer({
      updates: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'too many requests' } },
      ],
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('rate_limited');
  });

  it('Given a rate limit error from the agent, When called, Then returns a rate_limited response', async () => {
    mockAcpServer({
      promptError: { code: -32000, message: 'HTTP status 429: rate limit exceeded' },
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('rate_limited');
  });

  it('Given a prompt response with usage, When called, Then reports provider token usage for this turn', async () => {
    mockAcpServer({
      usage: {
        totalTokens: 175,
        inputTokens: 160,
        outputTokens: 15,
        cachedReadTokens: 40,
        cachedWriteTokens: 12,
      },
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.providerUsage).toEqual({
      inputTokens: 160,
      outputTokens: 15,
      totalTokens: 175,
      cachedInputTokens: 52,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 12,
      usageMissing: false,
    });
  });

  it('Given a prompt response without cached tokens, When called, Then cached fields are omitted', async () => {
    mockAcpServer({
      usage: { totalTokens: 12, inputTokens: 10, outputTokens: 2 },
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.providerUsage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      usageMissing: false,
    });
  });

  it('Given a prompt response without usage, When called, Then providerUsage is marked missing', async () => {
    mockAcpServer({ usage: null });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.providerUsage).toEqual({ usageMissing: true, reason: 'usage_not_available' });
  });

  it('Given a process error, When called, Then providerUsage is marked missing', async () => {
    mockAcpServer({ promptError: { code: -32603, message: 'boom' } });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.providerUsage).toEqual({ usageMissing: true, reason: 'usage_not_available' });
  });
});
