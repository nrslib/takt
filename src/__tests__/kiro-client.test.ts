import { EventEmitter } from 'node:events';
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

import { callKiro } from '../infra/kiro/client.js';

type SpawnScenario = {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Partial<NodeJS.ErrnoException> & { message: string };
};

type MockChildProcess = EventEmitter & {
  stdin: { end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

const restoredEnvKeys = [
  'ALL_PROXY',
  'GITHUB_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'KIRO_API_KEY',
  'KIRO_HOME',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'TAKT_OPENAI_API_KEY',
  'SERVICE_SECRET',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'TAKT_OBSERVABILITY',
  'TAKT_OBSERVABILITY_ENABLED',
  'TAKT_OBSERVABILITY_MONITOR',
  'TAKT_OBSERVABILITY_SESSION_LOG_EXPORTER',
  'TAKT_OBSERVABILITY_USAGE_EVENTS_PHASE',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

const kiroNetworkEnvCases: Array<[typeof restoredEnvKeys[number], string]> = [
  ['ALL_PROXY', 'http://all-proxy.example'],
  ['HTTP_PROXY', 'http://http-proxy.example'],
  ['HTTPS_PROXY', 'http://https-proxy.example'],
  ['NO_PROXY', 'localhost,127.0.0.1'],
  ['NODE_EXTRA_CA_CERTS', '/certs/node-extra.pem'],
  ['SSL_CERT_DIR', '/certs/dir'],
  ['SSL_CERT_FILE', '/certs/file.pem'],
  ['all_proxy', 'http://lower-all-proxy.example'],
  ['http_proxy', 'http://lower-http-proxy.example'],
  ['https_proxy', 'http://lower-https-proxy.example'],
  ['no_proxy', 'localhost,.internal'],
];

const kiroObservabilityEnvCases: Array<[typeof restoredEnvKeys[number], string]> = [
  ['TAKT_OBSERVABILITY', '{"enabled":true,"monitor":true,"session_log_exporter":true,"usage_events_phase":true}'],
  ['TAKT_OBSERVABILITY_ENABLED', 'true'],
  ['TAKT_OBSERVABILITY_MONITOR', 'true'],
  ['TAKT_OBSERVABILITY_SESSION_LOG_EXPORTER', 'true'],
  ['TAKT_OBSERVABILITY_USAGE_EVENTS_PHASE', 'true'],
  ['OTEL_EXPORTER_OTLP_ENDPOINT', 'http://otel.example:4318'],
  ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'http://otel.example:4318/v1/traces'],
  ['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'http://otel.example:4318/v1/metrics'],
];

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

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = { end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

function mockSpawnWithScenario(scenario: SpawnScenario): void {
  mockSpawn.mockImplementation((_cmd: string, _args: string[], _options: object) => {
    const child = createMockChildProcess();

    queueMicrotask(() => {
      if (scenario.stdout) {
        child.stdout.emit('data', Buffer.from(scenario.stdout, 'utf-8'));
      }
      if (scenario.stderr) {
        child.stderr.emit('data', Buffer.from(scenario.stderr, 'utf-8'));
      }

      if (scenario.error) {
        const error = Object.assign(new Error(scenario.error.message), scenario.error);
        child.emit('error', error);
        return;
      }

      child.emit('close', scenario.code ?? 0, scenario.signal ?? null);
    });

    return child;
  });
}

function mockSpawnSequence(scenarios: SpawnScenario[]): void {
  let callIndex = 0;
  mockSpawn.mockImplementation((_cmd: string, _args: string[], _options: object) => {
    const scenario = scenarios[callIndex];
    callIndex += 1;
    const child = createMockChildProcess();

    queueMicrotask(() => {
      if (!scenario) {
        const error = Object.assign(new Error(`Unexpected spawn call #${callIndex} (only ${scenarios.length} scenarios defined)`), {
          code: 'ERR_TEST_UNEXPECTED_SPAWN',
        });
        child.emit('error', error);
        return;
      }

      if (scenario.stdout) {
        child.stdout.emit('data', Buffer.from(scenario.stdout, 'utf-8'));
      }
      if (scenario.stderr) {
        child.stderr.emit('data', Buffer.from(scenario.stderr, 'utf-8'));
      }

      if (scenario.error) {
        const error = Object.assign(new Error(scenario.error.message), scenario.error);
        child.emit('error', error);
        return;
      }

      child.emit('close', scenario.code ?? 0, scenario.signal ?? null);
    });

    return child;
  });
}

describe('callKiro', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KIRO_API_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreEnv();
  });

  it('Given full permission and a session, When called, Then invokes kiro-cli headless with trust-all and resume-id', async () => {
    mockSpawnWithScenario({
      stdout: 'Implementation complete.',
      code: 0,
    });

    const result = await callKiro('coder', 'implement feature', {
      cwd: '/repo',
      sessionId: 'sess-prev',
      permissionMode: 'full',
      kiroApiKey: 'kiro-secret',
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('Implementation complete.');
    expect(result.sessionId).toBe('sess-prev');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown; shell?: boolean },
    ];
    const child = mockSpawn.mock.results[0]?.value as MockChildProcess;

    expect(command).toBe('kiro-cli');
    expect(args).toEqual([
      'chat',
      '--no-interactive',
      '--trust-all-tools',
      '--resume-id',
      'sess-prev',
      'implement feature',
    ]);
    expect(child.stdin.end).toHaveBeenCalledWith();
    expect(options.cwd).toBe('/repo');
    expect(options.env?.KIRO_API_KEY).toBe('kiro-secret');
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(options.shell).toBeUndefined();
  });

  it('Given edit permission, When called, Then maps to conservative Kiro trust tools', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callKiro('coder', 'implement feature', {
      cwd: '/repo',
      permissionMode: 'edit',
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).toContain('--trust-tools=read,grep,write,shell');
    expect(args).not.toContain('--trust-all-tools');
  });

  it('Given readonly permission, When called, Then maps to read-only Kiro trust tools', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callKiro('coder', 'inspect', {
      cwd: '/repo',
      permissionMode: 'readonly',
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).toContain('--trust-tools=read,grep');
    expect(args).not.toContain('--trust-tools=read,grep,write,shell');
  });

  it('Given no permission mode, When called, Then does not add Kiro trust flags', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callKiro('coder', 'inspect', { cwd: '/repo' });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--trust-all-tools');
    expect(args.some((arg) => arg.startsWith('--trust-tools'))).toBe(false);
  });

  it('Given system prompt, When called, Then prepends it to the user prompt', async () => {
    mockSpawnWithScenario({
      stdout: 'reviewed',
      code: 0,
    });

    await callKiro('reviewer', 'review this code', {
      cwd: '/repo',
      systemPrompt: 'You are a strict reviewer.',
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args.at(-1)).toBe('You are a strict reviewer.\n\nreview this code');
  });

  it('Given Kiro home, network env, and run-local child process env, When called, Then passes only the Kiro child env allowlist', async () => {
    process.env.GITHUB_TOKEN = 'github-token';
    process.env.TAKT_OPENAI_API_KEY = 'openai-token';
    process.env.SERVICE_SECRET = 'service-secret';
    process.env.KIRO_HOME = '/kiro/home';
    for (const [key, value] of kiroNetworkEnvCases) {
      process.env[key] = value;
    }
    for (const [key, value] of kiroObservabilityEnvCases) {
      process.env[key] = value;
    }
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    const result = await callKiro('coder', 'implement feature', {
      cwd: '/repo',
      childProcessEnv: {
        TAKT_OBSERVABILITY: '{"enabled":true,"monitor":true,"session_log_exporter":true,"usage_events_phase":true}',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://snapshot-otel.example:4318',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://snapshot-otel.example:4318/v1/traces',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://snapshot-otel.example:4318/v1/metrics',
        SERVICE_SECRET: 'service-secret-from-overlay',
      },
    });

    expect(result.status).toBe('done');

    const [, , options] = mockSpawn.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(options.env).not.toBe(process.env);
    expect(options.env?.GITHUB_TOKEN).toBeUndefined();
    expect(options.env?.TAKT_OPENAI_API_KEY).toBeUndefined();
    expect(options.env?.SERVICE_SECRET).toBeUndefined();
    expect(options.env?.KIRO_API_KEY).toBeUndefined();
    expect(options.env?.KIRO_HOME).toBe('/kiro/home');
    for (const [key, value] of kiroNetworkEnvCases) {
      expect(options.env?.[key]).toBe(value);
    }
    expect(options.env?.TAKT_OBSERVABILITY).toBe(
      '{"enabled":true,"monitor":true,"session_log_exporter":true,"usage_events_phase":true}',
    );
    expect(options.env?.TAKT_OBSERVABILITY_ENABLED).toBeUndefined();
    expect(options.env?.TAKT_OBSERVABILITY_MONITOR).toBeUndefined();
    expect(options.env?.TAKT_OBSERVABILITY_SESSION_LOG_EXPORTER).toBeUndefined();
    expect(options.env?.TAKT_OBSERVABILITY_USAGE_EVENTS_PHASE).toBeUndefined();
    expect(options.env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://snapshot-otel.example:4318');
    expect(options.env?.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe('https://snapshot-otel.example:4318/v1/traces');
    expect(options.env?.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe('https://snapshot-otel.example:4318/v1/metrics');
  });

  it('Given ambient observability env and no child process env, When called, Then does not inherit ambient observability env', async () => {
    for (const [key, value] of kiroObservabilityEnvCases) {
      process.env[key] = value;
    }
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callKiro('coder', 'implement feature', { cwd: '/repo' });

    const [, , options] = mockSpawn.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    for (const [key] of kiroObservabilityEnvCases) {
      expect(options.env?.[key]).toBeUndefined();
    }
  });

  it('Given parent KIRO_API_KEY, When called without a resolved key, Then passes it to Kiro child env', async () => {
    process.env.KIRO_API_KEY = 'parent-kiro-secret';
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callKiro('coder', 'implement feature', { cwd: '/repo' });

    const [, , options] = mockSpawn.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(options.env?.KIRO_API_KEY).toBe('parent-kiro-secret');
  });

  it('Given parent and explicit KIRO_API_KEY, When called, Then explicit key wins', async () => {
    process.env.KIRO_API_KEY = 'parent-kiro-secret';
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callKiro('coder', 'implement feature', {
      cwd: '/repo',
      kiroApiKey: 'explicit-kiro-secret',
    });

    const [, , options] = mockSpawn.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(options.env?.KIRO_API_KEY).toBe('explicit-kiro-secret');
  });

  it('Given KIRO_API_KEY resolved at config boundary, When called with resolved key, Then passes it to Kiro child env', async () => {
    process.env.GITHUB_TOKEN = 'github-token';
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callKiro('coder', 'implement feature', {
      cwd: '/repo',
      kiroApiKey: 'inherited-kiro-secret',
    });

    const [, , options] = mockSpawn.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(options.env?.KIRO_API_KEY).toBe('inherited-kiro-secret');
    expect(options.env?.GITHUB_TOKEN).toBeUndefined();
  });

  it('Given custom CLI path, When called, Then uses it as the executable', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callKiro('coder', 'implement', {
      cwd: '/repo',
      kiroCliPath: '/custom/bin/kiro-cli',
    });

    const [command] = mockSpawn.mock.calls[0] as [string];
    expect(command).toBe('/custom/bin/kiro-cli');
  });

  it('Given no MCP-related options, When called, Then does not add MCP flags', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callKiro('coder', 'implement', {
      cwd: '/repo',
      permissionMode: 'full',
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args.some((arg) => arg.includes('mcp'))).toBe(false);
  });

  it('Given a model option, When called, Then adds --model with the given value', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callKiro('coder', 'implement', {
      cwd: '/repo',
      model: 'some-model',
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    const modelFlagIndex = args.indexOf('--model');
    expect(modelFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[modelFlagIndex + 1]).toBe('some-model');
  });

  it('Given no model option, When called, Then does not add a --model flag', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callKiro('coder', 'implement', {
      cwd: '/repo',
      permissionMode: 'full',
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--model');
  });

  it('Given prompt starts with a Markdown list marker, When called, Then passes it as safe positional input', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    const result = await callKiro('coder', '- fix the Kiro provider', {
      cwd: '/repo',
      permissionMode: 'readonly',
    });

    expect(result.status).toBe('done');
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).toEqual([
      'chat',
      '--no-interactive',
      '--trust-tools=read,grep',
      '\n- fix the Kiro provider',
    ]);
  });

  it('Given prompt looks like a CLI option, When called, Then keeps it positional without relying on an option separator', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    const result = await callKiro('coder', '--help is part of the task text', {
      cwd: '/repo',
    });

    expect(result.status).toBe('done');
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).toEqual([
      'chat',
      '--no-interactive',
      '\n--help is part of the task text',
    ]);
  });

  it('Given prompt contains shell metacharacters, When called, Then passes prompt as an argv element without shell execution', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callKiro('coder', 'inspect & whoami | cat', {
      cwd: '/repo',
      permissionMode: 'readonly',
    });

    const [, args, options] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      { shell?: boolean },
    ];
    expect(args).toEqual([
      'chat',
      '--no-interactive',
      '--trust-tools=read,grep',
      'inspect & whoami | cat',
    ]);
    expect(options.shell).toBeUndefined();
  });

  it('Given session ID contains shell metacharacters, When called, Then rejects it before spawn', async () => {
    const result = await callKiro('coder', 'inspect', {
      cwd: '/repo',
      sessionId: 'sess & whoami | cat',
      permissionMode: 'readonly',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Invalid Kiro session ID');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('Given agent option, When called, Then passes --agent with the agent name before the positional input', async () => {
    mockSpawnWithScenario({
      stdout: 'planned',
      code: 0,
    });

    const result = await callKiro('planner', 'plan the feature', {
      cwd: '/repo',
      permissionMode: 'readonly',
      agent: 'planner-agent',
    });

    expect(result.status).toBe('done');
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    const agentFlagIndex = args.indexOf('--agent');
    expect(agentFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[agentFlagIndex + 1]).toBe('planner-agent');
    expect(agentFlagIndex + 1).toBeLessThan(args.length - 1);
    expect(args.at(-1)).toBe('plan the feature');
  });

  it('Given agent option with session and permission, When called, Then combines --agent with existing flags', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callKiro('coder', 'implement feature', {
      cwd: '/repo',
      sessionId: 'sess-prev',
      permissionMode: 'full',
      agent: 'coder-agent',
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).toContain('--trust-all-tools');
    expect(args).toContain('--resume-id');
    expect(args).toContain('sess-prev');
    const agentFlagIndex = args.indexOf('--agent');
    expect(agentFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[agentFlagIndex + 1]).toBe('coder-agent');
  });

  it('Given no agent option, When called, Then does not add an --agent flag', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    await callKiro('coder', 'implement feature', {
      cwd: '/repo',
      permissionMode: 'full',
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--agent');
  });

  it('Given agent name with dot, underscore, and hyphen, When called, Then accepts it', async () => {
    mockSpawnWithScenario({
      stdout: 'done',
      code: 0,
    });

    const result = await callKiro('coder', 'implement', {
      cwd: '/repo',
      agent: 'my.team_agent-v2',
    });

    expect(result.status).toBe('done');
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    const agentFlagIndex = args.indexOf('--agent');
    expect(args[agentFlagIndex + 1]).toBe('my.team_agent-v2');
  });

  it('Given agent name contains shell metacharacters, When called, Then rejects it before spawn', async () => {
    const result = await callKiro('coder', 'inspect', {
      cwd: '/repo',
      agent: 'agent & whoami | cat',
      permissionMode: 'readonly',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Invalid Kiro agent');
    expect(result.error).toBe(result.content);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('Given agent name with a space, When called, Then rejects it before spawn', async () => {
    const result = await callKiro('coder', 'inspect', {
      cwd: '/repo',
      agent: 'my agent',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Invalid Kiro agent');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('Given plain text stdout, When command succeeds, Then returns stdout without JSON parsing', async () => {
    const output = 'Here is the implementation:\n\n```typescript\nconsole.log("hello");\n```';
    mockSpawnWithScenario({
      stdout: output,
      code: 0,
    });

    const result = await callKiro('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.content).toBe(output);
  });

  it('Given onStream callback, When command succeeds, Then emits text and successful result events', async () => {
    mockSpawnWithScenario({
      stdout: 'stream content',
      code: 0,
    });

    const onStream = vi.fn();
    await callKiro('coder', 'implement', {
      cwd: '/repo',
      onStream,
    });

    expect(onStream).toHaveBeenCalledTimes(2);
    expect(onStream).toHaveBeenNthCalledWith(1, {
      type: 'text',
      data: { text: 'stream content' },
    });
    expect(onStream).toHaveBeenNthCalledWith(2, {
      type: 'result',
      data: expect.objectContaining({
        result: 'stream content',
        success: true,
      }),
    });
  });

  it('Given missing Kiro CLI binary, When spawn emits ENOENT, Then returns an actionable error', async () => {
    mockSpawnWithScenario({
      error: { code: 'ENOENT', message: 'spawn kiro-cli ENOENT' },
    });

    const result = await callKiro('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('kiro-cli binary not found');
    expect(result.error).toContain('kiro-cli binary not found');
    expect(result.content).toContain('TAKT_KIRO_CLI_PATH');
  });

  it('Given authentication stderr, When command fails, Then returns an authentication error without exposing the key', async () => {
    mockSpawnWithScenario({
      code: 1,
      stderr: 'Authentication failed for API key kiro-secret',
    });

    const result = await callKiro('coder', 'implement feature', {
      cwd: '/repo',
      kiroApiKey: 'kiro-secret',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Kiro authentication failed');
    expect(result.error).toContain('Kiro authentication failed');
    expect(result.content).toContain('TAKT_KIRO_API_KEY');
    expect(result.content).toContain('KIRO_API_KEY');
    expect(result.content).not.toContain('kiro-secret');
  });

  it('Given non-zero exit, When command fails, Then returns exit code and redacted detail', async () => {
    mockSpawnWithScenario({
      code: 3,
      stderr: 'MCP startup failure: token kiro-secret was rejected',
    });

    const result = await callKiro('coder', 'implement feature', {
      cwd: '/repo',
      kiroApiKey: 'kiro-secret',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('code 3');
    expect(result.content).toContain('[REDACTED]');
    expect(result.content).not.toContain('kiro-secret');
  });

  it('Given KIRO_API_KEY resolved at config boundary, When non-auth failure includes it, Then redacts it as the configured provider key', async () => {
    mockSpawnWithScenario({
      code: 3,
      stderr: 'MCP startup failure: token inherited-kiro-secret was rejected',
    });

    const result = await callKiro('coder', 'implement feature', {
      cwd: '/repo',
      kiroApiKey: 'inherited-kiro-secret',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('[REDACTED]');
    expect(result.content).not.toContain('inherited-kiro-secret');
    expect(result.error).toBe(result.content);
  });

  it('Given parent KIRO_API_KEY, When non-auth failure includes it, Then redacts the parent key', async () => {
    process.env.KIRO_API_KEY = 'parent-kiro-secret';
    mockSpawnWithScenario({
      code: 3,
      stderr: 'MCP startup failure: token parent-kiro-secret was rejected',
    });

    const result = await callKiro('coder', 'implement feature', {
      cwd: '/repo',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('[REDACTED]');
    expect(result.content).not.toContain('parent-kiro-secret');
    expect(result.error).toBe(result.content);
  });

  it('Given API key crosses the detail trim boundary, When command fails, Then redacts before trimming', async () => {
    const prefix = 'x'.repeat(390);
    const kiroApiKey = 'kiro-secret-crosses-boundary';
    mockSpawnWithScenario({
      code: 3,
      stderr: `${prefix}${kiroApiKey} rejected`,
    });

    const result = await callKiro('coder', 'implement feature', {
      cwd: '/repo',
      kiroApiKey,
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('[REDACTED]');
    expect(result.content).not.toContain('kiro-secret');
  });

  it('Given empty stdout on success, When command closes, Then returns an error result event', async () => {
    mockSpawnWithScenario({
      stdout: '',
      code: 0,
    });

    const onStream = vi.fn();
    const result = await callKiro('coder', 'implement feature', {
      cwd: '/repo',
      onStream,
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('kiro-cli returned empty output');
    expect(result.error).toContain('kiro-cli returned empty output');
    expect(onStream).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        data: expect.objectContaining({ success: false }),
      }),
    );
  });

  it('Given an abort signal, When it aborts, Then terminates the child process and reports abort', async () => {
    const controller = new AbortController();
    let childProcess: MockChildProcess | undefined;

    mockSpawn.mockImplementation(() => {
      const child = createMockChildProcess();
      childProcess = child;

      queueMicrotask(() => {
        controller.abort();
        child.emit('close', null, 'SIGTERM');
      });

      return child;
    });

    const result = await callKiro('coder', 'implement', {
      cwd: '/repo',
      abortSignal: controller.signal,
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Kiro execution aborted');
    expect(childProcess?.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('Given stdout exceeds the buffer limit, When reading output, Then returns a buffer limit error', async () => {
    vi.useFakeTimers();
    let childProcess: MockChildProcess | undefined;
    mockSpawn.mockImplementation(() => {
      const child = createMockChildProcess();
      childProcess = child;
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1));
      });
      return child;
    });

    const result = await callKiro('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Kiro CLI output exceeded buffer limit');
    expect(childProcess?.kill).toHaveBeenCalledWith('SIGTERM');
    vi.advanceTimersByTime(1_000);
    expect(childProcess?.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('Given stdout exceeds the buffer limit and child closes, When force kill timer elapses, Then does not send SIGKILL', async () => {
    vi.useFakeTimers();
    let childProcess: MockChildProcess | undefined;
    mockSpawn.mockImplementation(() => {
      const child = createMockChildProcess();
      childProcess = child;
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1));
        child.emit('close', null, 'SIGTERM');
      });
      return child;
    });

    const result = await callKiro('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Kiro CLI output exceeded buffer limit');
    expect(childProcess?.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(childProcess?.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('Given close has no code or signal, When command closes, Then reports the malformed close state', async () => {
    mockSpawn.mockImplementation(() => {
      const child = createMockChildProcess();
      queueMicrotask(() => {
        child.emit('close', null, null);
      });
      return child;
    });

    const result = await callKiro('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('kiro-cli closed without exit code or signal');
    expect(result.content).not.toContain('unknown');
    expect(result.error).toBe(result.content);
  });

  it('Given stderr exceeds the buffer limit, When reading output, Then returns a buffer limit error', async () => {
    vi.useFakeTimers();
    let childProcess: MockChildProcess | undefined;
    mockSpawn.mockImplementation(() => {
      const child = createMockChildProcess();
      childProcess = child;
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1));
      });
      return child;
    });

    const result = await callKiro('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Kiro CLI output exceeded buffer limit');
    expect(childProcess?.kill).toHaveBeenCalledWith('SIGTERM');
    vi.advanceTimersByTime(1_000);
    expect(childProcess?.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('Given stderr exceeds the buffer limit and child closes, When force kill timer elapses, Then does not send SIGKILL', async () => {
    vi.useFakeTimers();
    let childProcess: MockChildProcess | undefined;
    mockSpawn.mockImplementation(() => {
      const child = createMockChildProcess();
      childProcess = child;
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1));
        child.emit('close', null, 'SIGTERM');
      });
      return child;
    });

    const result = await callKiro('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Kiro CLI output exceeded buffer limit');
    expect(childProcess?.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(childProcess?.kill).not.toHaveBeenCalledWith('SIGKILL');
  });
});

// Covers GitHub issue #781: real session ID resolution on the first turn and
// output cleanup (ANSI escapes + leading "> " prompt marker) so multi-turn
// context and response content survive a real kiro-cli 2.5.1 invocation.
describe('callKiro session ID resolution (issue #781)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KIRO_API_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreEnv();
  });

  const uuid = '123e4567-e89b-12d3-a456-426614174000';

  it('Given no session ID, When the main call succeeds, Then resolves the real session by invoking chat --list-sessions and returns its UUID', async () => {
    mockSpawnSequence([
      { stdout: 'Implementation complete.', code: 0 },
      { stderr: `${uuid}  updated just now`, code: 0 },
    ]);

    const result = await callKiro('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.content).toBe('Implementation complete.');
    expect(result.sessionId).toBe(uuid);

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const [, firstArgs] = mockSpawn.mock.calls[0] as [string, string[]];
    const [, secondArgs, secondOptions] = mockSpawn.mock.calls[1] as [
      string,
      string[],
      { cwd?: string },
    ];
    expect(firstArgs).toEqual(['chat', '--no-interactive', 'implement feature']);
    expect(secondArgs).toEqual(['chat', '--list-sessions']);
    expect(secondOptions.cwd).toBe('/repo');
  });

  it('Given an existing session ID (resume turn), When called, Then does not invoke --list-sessions and returns the same session ID', async () => {
    mockSpawnWithScenario({ stdout: 'done', code: 0 });

    const result = await callKiro('coder', 'continue', {
      cwd: '/repo',
      sessionId: 'sess-prev',
    });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('sess-prev');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('Given no session ID, When --list-sessions fails after the main call already succeeded, Then still returns success with an undefined session ID', async () => {
    mockSpawnSequence([
      { stdout: 'Implementation complete.', code: 0 },
      { code: 1 },
    ]);

    const result = await callKiro('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.content).toBe('Implementation complete.');
    expect(result.sessionId).toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('Given no session ID, When --list-sessions fails after the main call already succeeded, Then records the failure via log.debug instead of swallowing it silently', async () => {
    mockSpawnSequence([
      { stdout: 'Implementation complete.', code: 0 },
      { code: 1 },
    ]);

    await callKiro('coder', 'implement feature', { cwd: '/repo' });

    expect(debugSpy).toHaveBeenCalledWith(
      'kiro-cli --list-sessions failed; session ID unresolved for this turn',
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it('Given no session ID and an abort signal already aborted after the main call succeeds, When resolving the session ID, Then skips --list-sessions and returns an undefined session ID', async () => {
    const controller = new AbortController();

    mockSpawn.mockImplementation(() => {
      const child = createMockChildProcess();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('Implementation complete.', 'utf-8'));
        child.emit('close', 0, null);
        // Abort after the main call's close event resolves but before the
        // `await execKiro` continuation (which calls resolveLatestSessionId)
        // runs on the next microtask tick.
        controller.abort();
      });
      return child;
    });

    const result = await callKiro('coder', 'implement feature', {
      cwd: '/repo',
      abortSignal: controller.signal,
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('Implementation complete.');
    expect(result.sessionId).toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('Given no session ID, When --list-sessions output has no UUID in either stream, Then still returns success with an undefined session ID', async () => {
    mockSpawnSequence([
      { stdout: 'done', code: 0 },
      { stderr: 'no sessions found', code: 0 },
    ]);

    const result = await callKiro('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBeUndefined();
  });

  it('Given no session ID and a resolvable UUID, When onStream is provided, Then the result event carries the resolved session ID', async () => {
    mockSpawnSequence([
      { stdout: 'stream content', code: 0 },
      { stderr: uuid, code: 0 },
    ]);

    const onStream = vi.fn();
    await callKiro('coder', 'implement', { cwd: '/repo', onStream });

    expect(onStream).toHaveBeenCalledWith({
      type: 'result',
      data: expect.objectContaining({ sessionId: uuid, success: true }),
    });
  });

  it('Given no session ID and stdout that cleans to empty, When command succeeds, Then returns the empty-output error without attempting session resolution', async () => {
    mockSpawnWithScenario({
      stdout: '\x1b[32m> \x1b[0m',
      code: 0,
    });

    const result = await callKiro('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toBe('kiro-cli returned empty output');
    expect(result.sessionId).toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('Given no session ID, When the main call fails, Then does not attempt session resolution and reports the original error', async () => {
    mockSpawnWithScenario({
      error: { code: 'ENOENT', message: 'spawn kiro-cli ENOENT' },
    });

    const result = await callKiro('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.content).toContain('kiro-cli binary not found');
    expect(result.sessionId).toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  const otherUuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  it('Given ANSI escapes wrapping the UUID in --list-sessions stderr, When resolving the session ID, Then strips them before extracting', async () => {
    mockSpawnSequence([
      { stdout: 'Implementation complete.', code: 0 },
      { stderr: `\x1b[36m${uuid}\x1b[0m  updated just now`, code: 0 },
    ]);

    const result = await callKiro('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe(uuid);
  });

  it('Given no UUID in --list-sessions stderr but one in stdout, When resolving the session ID, Then falls back to stdout', async () => {
    mockSpawnSequence([
      { stdout: 'Implementation complete.', code: 0 },
      { stdout: `${uuid}  updated just now`, stderr: 'no sessions listed', code: 0 },
    ]);

    const result = await callKiro('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe(uuid);
  });

  it('Given UUIDs in both --list-sessions stdout and stderr, When resolving the session ID, Then prefers the stderr UUID', async () => {
    mockSpawnSequence([
      { stdout: 'Implementation complete.', code: 0 },
      { stdout: `${otherUuid}  updated 1m ago`, stderr: `${uuid}  updated 2m ago`, code: 0 },
    ]);

    const result = await callKiro('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe(uuid);
  });

  it('Given multiple UUIDs in --list-sessions stderr, When resolving the session ID, Then returns the first one (most recent session listed first)', async () => {
    mockSpawnSequence([
      { stdout: 'Implementation complete.', code: 0 },
      { stderr: `${uuid}  updated just now\n${otherUuid}  updated 1h ago`, code: 0 },
    ]);

    const result = await callKiro('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe(uuid);
  });

  it('Given --list-sessions stderr text that merely resembles a UUID (wrong segment lengths), When resolving the session ID, Then does not match it and returns undefined', async () => {
    mockSpawnSequence([
      { stdout: 'Implementation complete.', code: 0 },
      { stderr: '1234-5678-9012-3456', code: 0 },
    ]);

    const result = await callKiro('coder', 'implement feature', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBeUndefined();
  });
});

describe('callKiro output cleanup (issue #781)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KIRO_API_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreEnv();
  });

  it('Given stdout with ANSI escapes and a leading prompt marker, When resuming a session, Then returns cleaned content and skips session resolution', async () => {
    mockSpawnWithScenario({
      stdout: '\x1b[32m> \x1b[0mImplementation complete.\x1b[0m',
      code: 0,
    });

    const result = await callKiro('coder', 'continue', {
      cwd: '/repo',
      sessionId: 'sess-prev',
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('Implementation complete.');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('Given stdout with a Markdown blockquote in the body, When called, Then only strips the leading prompt marker and keeps body "> " intact', async () => {
    mockSpawnWithScenario({
      stdout: '> Summary\n> This quoted line should remain',
      code: 0,
    });

    const result = await callKiro('coder', 'continue', {
      cwd: '/repo',
      sessionId: 'sess-prev',
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('Summary\n> This quoted line should remain');
  });

  it('Given stdout with surrounding blank lines, a leading prompt marker, and trailing whitespace, When called, Then trims the result after marker removal', async () => {
    mockSpawnWithScenario({
      stdout: '\n\n  > Implementation complete.  \n\n',
      code: 0,
    });

    const result = await callKiro('coder', 'continue', {
      cwd: '/repo',
      sessionId: 'sess-prev',
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('Implementation complete.');
  });
});
