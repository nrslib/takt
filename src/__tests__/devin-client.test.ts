import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn, mockExecFileSync, debugSpy } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  // `ps -eo pid=,ppid=,pgid=` for the descendant-process-group sweep; empty
  // table by default.
  mockExecFileSync: vi.fn((..._args: unknown[]) => ''),
  debugSpy: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  execFileSync: mockExecFileSync,
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
  pid: number;
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

// Fake pids above Linux pid_max, so the process-group kill path
// (`process.kill(-pid, ...)`) can never hit a real process group.
let nextFakePid = 2_100_000_000;

function createAcpChild(): MockAcpChild {
  const child = new EventEmitter() as MockAcpChild;
  child.pid = nextFakePid++;
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

/**
 * Mock ACP server whose leader dies mid-prompt while a detached descendant
 * still holds the stdio pipes: `exit` fires but `close` and stdout EOF never
 * arrive. The call must report the leader's exit rather than wait for a
 * `close` that cannot come.
 */
function mockLeaderExitWithoutClose(exitCode: number): void {
  mockSpawn.mockImplementation((...call: unknown[]) => {
    recordConfigArg(call);
    const child = createAcpChild();
    attachAcpServer(child, {
      initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'x', version: '0' } }),
      'session/new': () => ({ sessionId: 'keen-otter', modes: DEFAULT_MODES, configOptions: [] }),
      'session/prompt': (_params, _api, _id) => {
        queueMicrotask(() => child.emit('exit', exitCode, null));
        return undefined;
      },
    });
    return child;
  });
}

/**
 * Mock ACP server whose leader process dies mid-prompt. `endStdout`
 * reproduces the real failure shape: stdout EOFs first (which makes the SDK
 * reject in-flight requests with "ACP connection closed") and `exit`/`close`
 * land right after.
 */
function mockChildExitAfterPrompt(exitCode: number, stderrText: string, endStdout = true): void {
  mockSpawn.mockImplementation((...call: unknown[]) => {
    recordConfigArg(call);
    const child = createAcpChild();
    attachAcpServer(child, {
      initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'x', version: '0' } }),
      'session/new': () => ({ sessionId: 'keen-otter', modes: DEFAULT_MODES, configOptions: [] }),
      'session/prompt': (_params, _api, _id) => {
        queueMicrotask(() => {
          if (stderrText.length > 0) {
            child.stderr.write(stderrText);
          }
          if (endStdout) {
            child.stdout.end();
          }
          child.emit('exit', exitCode, null);
          queueMicrotask(() => child.emit('close', exitCode, null));
        });
        return undefined;
      },
    });
    return child;
  });
}

interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: unknown;
  shell?: boolean;
  detached?: boolean;
}

function spawnCall(index: number): [string, string[], SpawnOptions] {
  return mockSpawn.mock.calls[index] as [string, string[], SpawnOptions];
}

function mainSpawnCall(): [string, string[], SpawnOptions] {
  expect(mockSpawn).toHaveBeenCalledTimes(1);
  return spawnCall(0);
}

const restoredEnvKeys = [
  'ALL_PROXY',
  'DEVIN_API_URL',
  'DEVIN_MODEL',
  'GITHUB_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SERVICE_SECRET',
  'TAKT_DEVIN_CONFIG_DIR',
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

  it('Given a tiered model name on a new session, When the session resolved it, Then the call proceeds', async () => {
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

  it('Given a tiered model name the session did not resolve, When called, Then the call fails fast without prompting', async () => {
    const server = mockAcpServer();

    const result = await callDevin('coder', 'implement', { cwd: '/repo', model: 'swe-2-max' });

    expect(result.status).toBe('error');
    expect(result.error).toContain("Devin model 'swe-2-max' is not available");
    expect(requestsOf(server, 'session/prompt')).toHaveLength(0);
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

  it('Given a model on a resumed session, When called, Then the session keeps its model and reports it', async () => {
    const onStream = vi.fn();
    const server = mockAcpServer();

    const result = await callDevin('coder', 'implement', {
      cwd: '/repo',
      sessionId: 'rare-boater',
      model: 'swe-1-6',
      onStream,
    });

    expect(result.status).toBe('done');
    const [, args] = mainSpawnCall();
    expect(args).not.toContain('--model');
    expect(requestsOf(server, 'session/prompt')).toHaveLength(1);
    expect(onStream).toHaveBeenCalledWith({
      type: 'init',
      data: { model: 'swe-2-high@high', sessionId: 'rare-boater' },
    });
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
    process.env.DEVIN_API_URL = 'https://devin.example.test';
    process.env.DEVIN_MODEL = 'swe-2-high';
    process.env.WINDSURF_API_KEY = 'windsurf-key';
    process.env.XDG_DATA_HOME = '/xdg/data';
    mockAcpServer();

    await callDevin('coder', 'implement', { cwd: '/repo' });

    const [, , options] = mainSpawnCall();
    expect(options.env).not.toBe(process.env);
    expect(options.env?.GITHUB_TOKEN).toBeUndefined();
    expect(options.env?.SERVICE_SECRET).toBeUndefined();
    expect(options.env?.DEVIN_API_URL).toBe('https://devin.example.test');
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
      data: { id: 'exec:0', tool: 'Bash', input: { command: 'npm test' } },
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

  it('Given session/set_mode fails, When called, Then the prompt turn still completes', async () => {
    const server = mockAcpServer({
      setModeError: { code: -32603, message: 'mode not supported' },
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo', permissionMode: 'edit' });

    expect(result.status).toBe('done');
    expect(result.content).toBe('done');
    expect(result.sessionId).toBe('keen-otter');
    expect(requestsOf(server, 'session/set_mode')).toHaveLength(1);
    expect(requestsOf(server, 'session/prompt')).toHaveLength(1);
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

  it('Given runtime.prepare redirected XDG_CONFIG_HOME, When called, Then the generated config still seeds from the original user config', async () => {
    writeUserConfig(JSON.stringify({
      agent: { model: 'swe-2-max' },
      permissions: { allow: ['Exec(git)'], deny: ['Exec(sudo)'] },
    }));
    // runtime.prepare rewrites XDG_CONFIG_HOME to the worktree's runtime dir
    // and injects TAKT_DEVIN_CONFIG_DIR with the config dir resolved from the
    // original environment.
    process.env.TAKT_DEVIN_CONFIG_DIR = join(xdgConfigHome, 'devin');
    const runtimeConfigHome = mkdtempSync(join(tmpdir(), 'takt-devin-runtime-'));
    tmpDirs.push(runtimeConfigHome);
    process.env.XDG_CONFIG_HOME = runtimeConfigHome;
    mockAcpServer();

    await callDevin('coder', 'inspect', { cwd: '/repo', permissionMode: 'readonly' });

    const config = generatedConfig() as {
      agent?: { model?: string };
      permissions?: { allow?: string[]; deny?: string[] };
    };
    expect(config.agent?.model).toBe('swe-2-max');
    expect(config.permissions?.allow).toEqual(['Exec(git)']);
    expect(config.permissions?.deny).toEqual(
      expect.arrayContaining(['Exec(sudo)', 'exec', 'edit', 'Write(**)', 'mcp__*']),
    );
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

  it.each(['max_tokens', 'max_turn_requests', 'refusal'] as const)(
    'Given a %s stop reason with partial output, When called, Then returns an error naming the reason without treating the turn as done',
    async (stopReason) => {
      mockAcpServer({
        stopReason,
        updates: [
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial answer' } },
        ],
      });

      const result = await callDevin('coder', 'implement', { cwd: '/repo' });

      expect(result.status).toBe('error');
      expect(result.error).toBe(`devin returned incomplete output (stop reason: ${stopReason})`);
      expect(result.content).toBe('partial answer');
      expect(result.failureCategory).toBe('provider_error');
    },
  );

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

  it('Given stdout EOFs before the exit settles, When the process dies mid-prompt, Then the exit error wins over the connection close', async () => {
    mockChildExitAfterPrompt(2, 'fatal: could not load config\n');

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Devin CLI exited with code 2');
    expect(result.error).toContain('fatal: could not load config');
    expect(result.error).not.toContain('ACP connection closed');
  });

  it('Given a dead process breaks stdin, When called, Then the exit error still wins over the stream error', async () => {
    mockSpawn.mockImplementation((...call: unknown[]) => {
      recordConfigArg(call);
      const child = createAcpChild();
      // Die before the ACP handshake; the initialize write hits EPIPE.
      queueMicrotask(() => {
        child.stderr.write('fatal: could not load config\n');
        child.stdin.destroy(new Error('write EPIPE'));
        child.emit('exit', 2, null);
        queueMicrotask(() => child.emit('close', 2, null));
      });
      return child;
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Devin CLI exited with code 2');
    expect(result.error).toContain('fatal: could not load config');
    expect(result.error).not.toContain('EPIPE');
  });

  it('Given verbose stderr, When the process exits, Then the error keeps the tail with the reason', async () => {
    const head = Array.from({ length: 40 }, (_, i) => `INFO boot-${i} ${'x'.repeat(80)}`).join('\n');
    mockChildExitAfterPrompt(2, `${head}\nfatal: could not load config\n`);

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('fatal: could not load config');
    expect(result.error).not.toContain('boot-0 ');
    expect(result.error).not.toContain('boot-1 ');
  });

  it('Given the leader exits while a descendant holds the pipes, When called, Then reports the exit instead of waiting for close', async () => {
    mockLeaderExitWithoutClose(1);

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Devin CLI exited with code 1');
  });

  it('Given a detached descendant reparents after the leader exits, When terminate runs, Then the recorded group is still signaled', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let leaderPid = 0;
    let leaderAlive = true;
    // A setsid'd exec child (own pgid) exists only while the leader lives;
    // after the exit it reports ppid=1, so a post-death scan cannot find it.
    mockExecFileSync.mockImplementation((command: unknown) => {
      if (command !== 'ps' || leaderPid === 0) {
        return '';
      }
      return leaderAlive
        ? `${leaderPid} 1 ${leaderPid}\n${leaderPid + 1} ${leaderPid} ${leaderPid + 1}\n`
        : `${leaderPid + 1} 1 ${leaderPid + 1}\n`;
    });
    let spawned: MockAcpChild | undefined;
    mockSpawn.mockImplementation((...call: unknown[]) => {
      recordConfigArg(call);
      const child = createAcpChild();
      spawned = child;
      leaderPid = child.pid!;
      attachAcpServer(child, {
        initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'x', version: '0' } }),
        'session/new': () => ({ sessionId: 'keen-otter', modes: DEFAULT_MODES, configOptions: [] }),
        'session/prompt': (_params, api, _id) => {
          queueMicrotask(() => {
            api.notify('session/update', {
              sessionId: 'keen-otter',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } },
            });
          });
          return undefined;
        },
      });
      return child;
    });

    const result = await callDevin('coder', 'implement', {
      cwd: '/repo',
      // The text event means the update was processed and the descendant
      // snapshot is taken (init arrives before the snapshot). Kill the
      // leader now; the reparented descendant escapes a fresh scan.
      onStream: (event) => {
        if (event.type !== 'text') return;
        leaderAlive = false;
        spawned!.emit('exit', 1, null); // no close — descendant holds the pipes
      },
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Devin CLI exited with code 1');
    expect(killSpy).toHaveBeenCalledWith(-(leaderPid + 1), 'SIGTERM');
  });

  it('Given an intermediate process reparents a descendant while the leader lives, When terminate runs, Then earlier-recorded groups are still signaled', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const nowSpy = vi.spyOn(Date, 'now');
    let nowTick = 0;
    nowSpy.mockImplementation(() => (nowTick += 1_000));
    let leaderPid = 0;
    let midAlive = true;
    // While mid lives: leader -> mid -> descendant (descendant has its own
    // pgid). Once mid exits the descendant reports ppid=1, so later scans
    // rooted at the leader can no longer reach it.
    mockExecFileSync.mockImplementation((command: unknown) => {
      if (command !== 'ps' || leaderPid === 0) {
        return '';
      }
      const leaderRow = `${leaderPid} 1 ${leaderPid}\n`;
      const descendantRow = `${leaderPid + 2} ${midAlive ? leaderPid + 1 : 1} ${leaderPid + 2}\n`;
      return midAlive
        ? `${leaderRow}${leaderPid + 1} ${leaderPid} ${leaderPid + 1}\n${descendantRow}`
        : `${leaderRow}${descendantRow}`;
    });
    let spawned: MockAcpChild | undefined;
    let serverApi: AcpServerApi | undefined;
    mockSpawn.mockImplementation((...call: unknown[]) => {
      recordConfigArg(call);
      const child = createAcpChild();
      spawned = child;
      leaderPid = child.pid!;
      const textUpdate = (text: string) => ({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      });
      attachAcpServer(child, {
        initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'x', version: '0' } }),
        'session/new': () => ({ sessionId: 'keen-otter', modes: DEFAULT_MODES, configOptions: [] }),
        'session/prompt': (_params, api, _id) => {
          serverApi = api;
          queueMicrotask(() => {
            api.notify('session/update', { sessionId: 'keen-otter', update: textUpdate('one') });
          });
          return undefined;
        },
      });
      return child;
    });

    let updates = 0;
    const result = await callDevin('coder', 'implement', {
      cwd: '/repo',
      onStream: (event) => {
        if (event.type !== 'text') return;
        updates += 1;
        if (updates === 1) {
          // First refresh recorded mid's subtree; now mid exits and the
          // descendant reparents before the second refresh scans again.
          midAlive = false;
          queueMicrotask(() => {
            serverApi?.notify('session/update', {
              sessionId: 'keen-otter',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'two' } },
            });
          });
          return;
        }
        // Second refresh ran with mid already gone; kill the leader so
        // terminate() can only rely on the earlier recorded groups.
        spawned!.emit('exit', 1, null);
      },
    });
    nowSpy.mockRestore();

    expect(result.status).toBe('error');
    expect(result.error).toContain('Devin CLI exited with code 1');
    expect(killSpy).toHaveBeenCalledWith(-(leaderPid + 2), 'SIGTERM');
  });

  it('Given a descendant appears after termination starts, When stderr keeps flowing, Then the late group is still signaled', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const abort = new AbortController();
    let leaderPid = 0;
    let lateSpawnVisible = false;
    mockExecFileSync.mockImplementation((command: unknown) => {
      if (command !== 'ps' || leaderPid === 0) {
        return '';
      }
      const descendant = lateSpawnVisible
        ? `${leaderPid + 1} ${leaderPid} ${leaderPid + 1}\n`
        : '';
      return `${leaderPid} 1 ${leaderPid}\n${descendant}`;
    });
    mockSpawn.mockImplementation((...call: unknown[]) => {
      recordConfigArg(call);
      const child = createAcpChild();
      leaderPid = child.pid!;
      attachAcpServer(child, {
        initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'x', version: '0' } }),
        'session/new': () => ({ sessionId: 'keen-otter', modes: DEFAULT_MODES, configOptions: [] }),
        'session/prompt': (_params, _api, _id) => {
          queueMicrotask(() => {
            abort.abort(); // terminate() runs here: no descendants yet
            lateSpawnVisible = true; // a descendant appears during shutdown
            child.stderr.write('late\n');
            // Delay close so the post-terminate stderr chunk reaches the
            // refresh while `exit` is still unset.
            setTimeout(() => child.emit('close', null, 'SIGTERM'), 50);
          });
          return undefined;
        },
      });
      return child;
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo', abortSignal: abort.signal });

    expect(result.status).toBe('error');
    await vi.waitFor(() => {
      expect(killSpy).toHaveBeenCalledWith(-(leaderPid + 1), 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith(-(leaderPid + 1), 'SIGKILL');
    });
  });

  it('Given an exit with empty stderr, When the process dies mid-prompt, Then the error does not repeat the exit code', async () => {
    mockChildExitAfterPrompt(2, '');

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toBe('Devin CLI exited with code 2');
  });

  it('Given a clean exit racing an app-level error, When called, Then the app error is kept over the exit', async () => {
    mockSpawn.mockImplementation((...call: unknown[]) => {
      recordConfigArg(call);
      const child = createAcpChild();
      attachAcpServer(child, {
        initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'x', version: '0' } }),
        'session/new': () => ({ sessionId: 'keen-otter', modes: DEFAULT_MODES, configOptions: DEFAULT_CONFIG_OPTIONS }),
        'session/set_mode': () => ({}),
      });
      // Like the real devin: when the client hangs up after the model check
      // throws, stdin EOFs and the process exits 0.
      child.stdin.on('close', () => {
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
      return child;
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo', model: 'swe-2-max' });

    expect(result.status).toBe('error');
    expect(result.error).toContain("Devin model 'swe-2-max' is not available");
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

  it('Given the real unauthenticated JSON-RPC error, When called, Then reports the login requirement', async () => {
    mockAcpServer({
      promptError: {
        code: -32000,
        message: "Please log in to use Devin. Use '/login' to authenticate again.",
      },
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('devin auth login');
  });

  it.each(['auth_required', 'unauthenticated'] as const)(
    'Given an auth errorKind %s, When called, Then reports the login requirement',
    async (errorKind) => {
      mockAcpServer({
        promptError: {
          code: -32000,
          message: 'request failed',
          data: { 'cognition.ai/errorKind': errorKind },
        },
      });

      const result = await callDevin('coder', 'implement', { cwd: '/repo' });

      expect(result.status).toBe('error');
      expect(result.error).toContain('devin auth login');
    },
  );

  it('Given Devin prints Authentication required on stderr and exits, When called, Then reports the login requirement', async () => {
    mockChildExitAfterPrompt(1, 'WARN affogato::acp Authentication required\n');

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('devin auth login');
  });

  it('Given unrelated stderr mentioning an api key, When the process exits, Then the real stderr is reported instead of an auth error', async () => {
    mockChildExitAfterPrompt(1, 'ERROR mcp-server-filesystem failed: invalid api key provided\n');

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Devin CLI exited with code 1');
    expect(result.error).toContain('invalid api key provided');
    expect(result.error).not.toContain('devin auth login');
  });

  it('Given an abort signal, When called, Then kills the whole process group and returns the aborted error', async () => {
    const abortController = new AbortController();
    const groupKills: { pid: number; signal: unknown }[] = [];
    let spawned: MockAcpChild | undefined;
    const realKill = process.kill.bind(process);
    // Intercept only process-group signals (negative pid): record them and
    // simulate the leader dying on SIGTERM.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid < 0) {
        if (signal === undefined || signal === 0) {
          const missing = new Error('kill ESRCH') as NodeJS.ErrnoException;
          missing.code = 'ESRCH';
          throw missing;
        }
        groupKills.push({ pid, signal });
        queueMicrotask(() => {
          spawned?.emit('exit', null, signal as NodeJS.Signals);
          spawned?.emit('close', null, signal as NodeJS.Signals);
        });
        return true;
      }
      return realKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);
    // A descendant the leader spawned with setsid — own process group, which
    // is how devin's exec tool daemonizes commands.
    const descendantPid = nextFakePid + 500_000;
    mockExecFileSync.mockImplementation((command: unknown, args?: unknown) => {
      if (command === 'ps' && Array.isArray(args) && args.includes('pid=,ppid=,pgid=')) {
        const leader = spawned!.pid;
        return `${leader} 1 ${leader}\n${descendantPid} ${leader} ${descendantPid}\n`;
      }
      return '';
    });
    try {
      mockSpawn.mockImplementation((...call: unknown[]) => {
        recordConfigArg(call);
        const child = createAcpChild();
        spawned = child;
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
      // Process-tree termination: spawn detached as a group leader and signal
      // the group (negative pid), not just the devin leader — plus the
      // detached descendant's own group.
      const [, , options] = mainSpawnCall();
      expect(options.detached).toBe(true);
      expect(groupKills).toContainEqual({ pid: -spawned!.pid, signal: 'SIGTERM' });
      expect(groupKills).toContainEqual({ pid: -descendantPid, signal: 'SIGTERM' });
    } finally {
      killSpy.mockRestore();
      mockExecFileSync.mockImplementation(() => '');
    }
  });

  it('Given an abort and EPERM failures signalling the process group, When called, Then the abort result is preserved', async () => {
    const abortController = new AbortController();
    let spawned: MockAcpChild | undefined;
    const realKill = process.kill.bind(process);
    // Every process-group signal fails with EPERM (non-ESRCH): the descendant
    // sweep and managed termination must degrade to a logged failure instead
    // of masking the abort result or surfacing an unhandled rejection.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid < 0) {
        const denied = new Error(`kill ${String(signal ?? 0)} EPERM`) as NodeJS.ErrnoException;
        denied.code = 'EPERM';
        throw denied;
      }
      return realKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);
    const descendantPid = nextFakePid + 500_000;
    mockExecFileSync.mockImplementation((command: unknown, args?: unknown) => {
      if (command === 'ps' && Array.isArray(args) && args.includes('pid=,ppid=,pgid=')) {
        const leader = spawned!.pid;
        return `${leader} 1 ${leader}\n${descendantPid} ${leader} ${descendantPid}\n`;
      }
      return '';
    });
    try {
      mockSpawn.mockImplementation((...call: unknown[]) => {
        recordConfigArg(call);
        const child = createAcpChild();
        spawned = child;
        attachAcpServer(child, {
          initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'x', version: '0' } }),
          'session/new': () => ({ sessionId: 'keen-otter', modes: DEFAULT_MODES, configOptions: [] }),
          'session/prompt': (_params, _api, _id) => {
            queueMicrotask(() => abortController.abort());
            return undefined;
          },
        });
        // The group signal cannot reach the leader, so it exits itself once
        // the session/cancel notification arrives on the wire.
        child.stdin.on('data', (chunk: Buffer) => {
          if (chunk.toString('utf-8').includes('session/cancel')) {
            queueMicrotask(() => {
              child.emit('exit', null, 'SIGTERM');
              child.emit('close', null, 'SIGTERM');
            });
          }
        });
        return child;
      });

      const result = await callDevin('coder', 'implement', {
        cwd: '/repo',
        abortSignal: abortController.signal,
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('Devin execution aborted');
      // The descendant sweep saw the EPERM and logged it rather than throwing.
      expect(debugSpy).toHaveBeenCalledWith(
        'Devin descendant process group signal failed',
        expect.objectContaining({ pgid: descendantPid, signal: 'SIGTERM' }),
      );
      // managed.terminate() rejects on the same EPERM (SIGTERM grace is
      // 250ms); the failure must land in the log, not an unhandled rejection.
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(debugSpy).toHaveBeenCalledWith(
        'Devin process termination failed',
        expect.objectContaining({ error: expect.stringContaining('EPERM') }),
      );
    } finally {
      killSpy.mockRestore();
      mockExecFileSync.mockImplementation(() => '');
    }
  });

  it('Given an answer that discusses rate limits, When called, Then the text is returned as a normal response', async () => {
    mockAcpServer({
      updates: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'The API returned HTTP 429 (too many requests); retry with exponential backoff.',
          },
        },
      ],
    });

    const result = await callDevin('coder', 'explain rate limits', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.content).toContain('HTTP 429');
    expect(result.content).toContain('too many requests');
  });

  it('Given a rate limit error from the agent, When called, Then returns a rate_limited response', async () => {
    mockAcpServer({
      promptError: { code: -32000, message: 'HTTP status 429: rate limit exceeded' },
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('rate_limited');
  });

  it.each([
    'resource_exhausted',
    'quota_exhausted',
    'subscription_limit_reached',
    'rate_limited',
  ] as const)(
    'Given a JSON-RPC quota error with errorKind %s, When called, Then returns a rate_limited response',
    async (errorKind) => {
      mockAcpServer({
        promptError: {
          code: -32011,
          message: 'Quota exhausted.',
          data: { 'cognition.ai/errorKind': errorKind, 'cognition.ai/retryable': true },
        },
      });

      const result = await callDevin('coder', 'implement', { cwd: '/repo' });

      expect(result.status).toBe('rate_limited');
      expect(result.errorKind).toBe('rate_limit');
      expect(result.error).toContain('Quota exhausted');
      expect(result.sessionId).toBe('keen-otter');
    },
  );

  it.each(['Usage limit reached', 'Organization usage limit reached'] as const)(
    'Given the quota message "%s" without errorKind, When called, Then returns a rate_limited response',
    async (message) => {
      mockAcpServer({
        promptError: { code: -32011, message },
      });

      const result = await callDevin('coder', 'implement', { cwd: '/repo' });

      expect(result.status).toBe('rate_limited');
    },
  );

  it('Given a non-quota errorKind, When called, Then returns a generic error', async () => {
    mockAcpServer({
      promptError: {
        code: -32010,
        message: 'engine stalled',
        data: { 'cognition.ai/errorKind': 'unavailable' },
      },
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('engine stalled');
  });

  it('Given a prompt failure after session/new, When called, Then the created session id is still reported', async () => {
    const onStream = vi.fn();
    mockAcpServer({
      sessionId: 'fresh-otter',
      promptError: { code: -32603, message: 'engine exploded' },
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo', onStream });

    expect(result.status).toBe('error');
    expect(result.sessionId).toBe('fresh-otter');
    const resultEvent = onStream.mock.calls.at(-1)?.[0] as {
      type: string;
      data: { sessionId: string; success: boolean };
    };
    expect(resultEvent.type).toBe('result');
    expect(resultEvent.data.sessionId).toBe('fresh-otter');
    expect(resultEvent.data.success).toBe(false);
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

  it('Given preparedMcp, When the call succeeds, Then dispose runs during cleanup', async () => {
    const dispose = vi.fn(async () => {});
    mockAcpServer();

    const result = await callDevin('coder', 'implement', {
      cwd: '/repo',
      preparedMcp: { dispose },
    });

    expect(result.status).toBe('done');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('Given preparedMcp, When the call fails, Then dispose still runs during cleanup', async () => {
    const dispose = vi.fn(async () => {});
    mockAcpServer({ promptError: { code: -32603, message: 'boom' } });

    const result = await callDevin('coder', 'implement', {
      cwd: '/repo',
      preparedMcp: { dispose },
    });

    expect(result.status).toBe('error');
    expect(dispose).toHaveBeenCalledOnce();
  });
});
