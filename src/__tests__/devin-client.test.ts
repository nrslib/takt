import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
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

type SpawnScenario = {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Partial<NodeJS.ErrnoException> & { message: string };
};

type MockChildProcess = EventEmitter & {
  stdin: EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

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

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  child.stdin.write = vi.fn();
  child.stdin.end = vi.fn();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

/** Capture of spawn-time file contents (tmp files are deleted after the call). */
const spawnFiles = new Map<string, string>();

function readArgFile(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const path = args[index + 1];
  if (path === undefined) {
    return undefined;
  }
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

function recordInvocation(call: unknown[]): void {
  const args = call[1] as string[];
  const promptFile = readArgFile(args, '--prompt-file');
  if (promptFile !== undefined) {
    spawnFiles.set('prompt', promptFile);
  }
  const configFile = readArgFile(args, '--config');
  if (configFile !== undefined) {
    spawnFiles.set('config', configFile);
  }
}

function isListInvocation(args: string[]): boolean {
  return args[0] === 'list';
}

// `devin list` calls (session snapshotting) get `listStdout`; the main `-p`
// call gets `scenario`.
function mockSpawnWithScenario(scenario: SpawnScenario, listStdout = '[]'): void {
  mockSpawn.mockImplementation((...call: unknown[]) => {
    recordInvocation(call);
    const effective = isListInvocation(call[1] as string[])
      ? { stdout: listStdout, code: 0 }
      : scenario;
    const child = createMockChildProcess();
    queueMicrotask(() => {
      if (effective.stdout) {
        child.stdout.emit('data', Buffer.from(effective.stdout, 'utf-8'));
      }
      if (effective.stderr) {
        child.stderr.emit('data', Buffer.from(effective.stderr, 'utf-8'));
      }
      if (effective.error) {
        child.emit('error', Object.assign(new Error(effective.error.message), effective.error));
        return;
      }
      child.emit(
        'close',
        effective.code === undefined ? 0 : effective.code,
        effective.signal === undefined ? null : effective.signal,
      );
    });
    return child;
  });
}

function mockSpawnSequence(scenarios: SpawnScenario[]): void {
  let callIndex = 0;
  mockSpawn.mockImplementation((...call: unknown[]) => {
    recordInvocation(call);
    const scenario = scenarios[callIndex];
    callIndex += 1;
    const child = createMockChildProcess();
    queueMicrotask(() => {
      if (!scenario) {
        child.emit('error', Object.assign(new Error(`Unexpected spawn call #${callIndex}`), {
          code: 'ERR_TEST_UNEXPECTED_SPAWN',
        }));
        return;
      }
      if (scenario.stdout) {
        child.stdout.emit('data', Buffer.from(scenario.stdout, 'utf-8'));
      }
      if (scenario.stderr) {
        child.stderr.emit('data', Buffer.from(scenario.stderr, 'utf-8'));
      }
      if (scenario.error) {
        child.emit('error', Object.assign(new Error(scenario.error.message), scenario.error));
        return;
      }
      child.emit(
        'close',
        scenario.code === undefined ? 0 : scenario.code,
        scenario.signal === undefined ? null : scenario.signal,
      );
    });
    return child;
  });
}

function spawnCall(index: number): [string, string[], { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown; shell?: boolean }] {
  return mockSpawn.mock.calls[index] as [string, string[], { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown; shell?: boolean }];
}

// First-turn calls run `devin list` before and after the main `-p` call for
// session resolution, so the main invocation is identified by its `-p` flag.
function mainSpawnCall(): [string, string[], { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown; shell?: boolean }] {
  const call = mockSpawn.mock.calls.find((c) => (c[1] as string[]).includes('-p'));
  if (call === undefined) {
    throw new Error('no spawn call with -p found');
  }
  return call as [string, string[], { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown; shell?: boolean }];
}

describe('callDevin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnFiles.clear();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('Given full permission and a session, When called, Then invokes devin print mode with dangerous mode and resume', async () => {
    const onActivity = vi.fn();
    mockSpawnWithScenario({ stdout: 'Implementation complete.', code: 0 });

    const result = await callDevin('coder', 'implement feature', {
      cwd: '/repo',
      sessionId: 'rare-boater',
      permissionMode: 'full',
      onActivity,
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('Implementation complete.');
    expect(result.sessionId).toBe('rare-boater');
    expect(onActivity).toHaveBeenCalledOnce();

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnCall(0);
    expect(command).toBe('devin');
    expect(args).toContain('-p');
    expect(args).toContain('--prompt-file');
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'dangerous']));
    expect(args).toEqual(expect.arrayContaining(['--respect-workspace-trust', 'false']));
    expect(args).toEqual(expect.arrayContaining(['-r', 'rare-boater']));
    expect(args).not.toContain('--model');
    expect(options.cwd).toBe('/repo');
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(options.shell).toBeUndefined();
    expect(spawnFiles.get('prompt')).toBe('implement feature');
  });

  it('Given edit permission, When called, Then maps to accept-edits mode and injects allow rules for exec through --config', async () => {
    mockSpawnWithScenario({ stdout: 'done', code: 0 });

    await callDevin('coder', 'implement', { cwd: '/repo', permissionMode: 'edit' });

    const [, args] = mainSpawnCall();
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'accept-edits']));
    expect(args).toContain('--config');
    const config = JSON.parse(spawnFiles.get('config') ?? '{}') as { permissions?: { allow?: string[] } };
    expect(config.permissions?.allow).toEqual(expect.arrayContaining(['exec', 'edit', 'Write(**)']));
  });

  it('Given readonly permission, When called, Then maps to auto mode and injects deny rules through --config', async () => {
    mockSpawnWithScenario({ stdout: 'done', code: 0 });

    await callDevin('coder', 'inspect', { cwd: '/repo', permissionMode: 'readonly' });

    const [, args] = mainSpawnCall();
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'auto']));
    expect(args).toContain('--config');
    const config = JSON.parse(spawnFiles.get('config') ?? '{}') as { permissions?: { deny?: string[] }; shell?: { setup_complete?: boolean } };
    expect(config.permissions?.deny).toEqual(expect.arrayContaining(['exec', 'edit', 'Write(**)', 'mcp__*']));
    expect(config.permissions?.deny).not.toContain('Fetch(**)');
    expect(config.shell?.setup_complete).toBe(true);
  });

  it('Given strict-readonly isolation, When called, Then deny rules also block fetch access', async () => {
    mockSpawnWithScenario({ stdout: 'done', code: 0 });

    await callDevin('verifier', 'inspect', {
      cwd: '/repo',
      permissionMode: 'readonly',
      internalAgentIsolation: 'strict-readonly',
    });

    const config = JSON.parse(spawnFiles.get('config') ?? '{}') as { permissions?: { deny?: string[] } };
    expect(config.permissions?.deny).toContain('Fetch(**)');
  });

  it('Given no permission mode, When called, Then defaults to auto mode without a config override', async () => {
    mockSpawnWithScenario({ stdout: 'done', code: 0 });

    await callDevin('coder', 'inspect', { cwd: '/repo' });

    const [, args] = mainSpawnCall();
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'auto']));
    expect(args).not.toContain('--config');
  });

  it('Given system prompt, When called, Then prepends it to the prompt file', async () => {
    mockSpawnWithScenario({ stdout: 'reviewed', code: 0 });

    await callDevin('reviewer', 'custom user prompt', {
      cwd: '/repo',
      systemPrompt: 'custom system prompt',
    });

    expect(spawnFiles.get('prompt')).toBe('custom system prompt\n\ncustom user prompt');
  });

  it('Given a model option, When called, Then adds --model with the given value', async () => {
    mockSpawnWithScenario({ stdout: 'done', code: 0 });

    await callDevin('coder', 'implement', { cwd: '/repo', model: 'swe-2-max' });

    const [, args] = mainSpawnCall();
    const modelFlagIndex = args.indexOf('--model');
    expect(modelFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[modelFlagIndex + 1]).toBe('swe-2-max');
  });

  it('Given custom CLI path, When called, Then uses it as the executable', async () => {
    mockSpawnWithScenario({ stdout: 'done', code: 0 });

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
    mockSpawnWithScenario({ stdout: 'done', code: 0 });

    await callDevin('coder', 'implement', { cwd: '/repo' });

    const [, , options] = mainSpawnCall();
    expect(options.env).not.toBe(process.env);
    expect(options.env?.GITHUB_TOKEN).toBeUndefined();
    expect(options.env?.SERVICE_SECRET).toBeUndefined();
    expect(options.env?.DEVIN_MODEL).toBe('swe-2-high');
    expect(options.env?.WINDSURF_API_KEY).toBe('windsurf-key');
    expect(options.env?.XDG_DATA_HOME).toBe('/xdg/data');
  });

  it('Given a prompt with shell metacharacters, When called, Then delivers it through the prompt file without shell execution', async () => {
    mockSpawnWithScenario({ stdout: 'done', code: 0 });

    await callDevin('coder', 'inspect & whoami | cat', { cwd: '/repo' });

    const [, args, options] = mainSpawnCall();
    expect(args).not.toContain('inspect & whoami | cat');
    expect(options.shell).toBeUndefined();
    expect(spawnFiles.get('prompt')).toBe('inspect & whoami | cat');
  });

  it('Given a prompt larger than the single-argument limit, When called, Then it is written to the prompt file instead of argv', async () => {
    mockSpawnWithScenario({ stdout: 'done', code: 0 });

    const largePrompt = 'x'.repeat(150 * 1024);
    await callDevin('coder', largePrompt, { cwd: '/repo' });

    const [, args] = mainSpawnCall();
    expect(args).not.toContain(largePrompt);
    expect(spawnFiles.get('prompt')).toBe(largePrompt);
  });

  it('Given no session, When called, Then resolves the new session ID via devin list', async () => {
    // Snapshot before, main call, then session list after — the new session
    // is identified as the one absent from the pre-call snapshot.
    mockSpawnSequence([
      { stdout: '[]', code: 0 },
      { stdout: 'first turn done', code: 0 },
      { stdout: JSON.stringify([{ id: 'keen-otter', title: 'implement' }]), code: 0 },
    ]);

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('keen-otter');
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    const [, beforeListArgs] = spawnCall(0);
    const [, afterListArgs] = spawnCall(2);
    expect(beforeListArgs).toEqual(['list', '--format', 'json']);
    expect(afterListArgs).toEqual(['list', '--format', 'json']);
  });

  it('Given a session, When called, Then does not spawn a devin list call', async () => {
    mockSpawnWithScenario({ stdout: 'done', code: 0 });

    const result = await callDevin('coder', 'implement', { cwd: '/repo', sessionId: 'rare-boater' });

    expect(result.sessionId).toBe('rare-boater');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('Given a parallel sibling session in the same directory, When called, Then resolves the session matching this prompt title', async () => {
    // Parallel steps share the cwd and its `devin list` output: the sibling's
    // session also appears as new, so the prompt-derived title decides.
    const prompt = 'implement the devin provider for takt';
    mockSpawnSequence([
      { stdout: '[]', code: 0 },
      { stdout: 'first turn done', code: 0 },
      {
        stdout: JSON.stringify([
          { id: 'sibling-session', title: 'unrelated sibling step prompt...' },
          { id: 'keen-otter', title: prompt },
        ]),
        code: 0,
      },
    ]);

    const result = await callDevin('coder', prompt, { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('keen-otter');
  });

  it('Given multiple new sessions and no title match, When called, Then leaves the session unresolved rather than picking a sibling', async () => {
    mockSpawnSequence([
      { stdout: '[]', code: 0 },
      { stdout: 'first turn done', code: 0 },
      {
        stdout: JSON.stringify([
          { id: 'sibling-a', title: 'totally different task...' },
          { id: 'sibling-b', title: 'another unrelated task...' },
        ]),
        code: 0,
      },
    ]);

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBeUndefined();
  });

  it('Given a pre-existing session in the snapshot, When called, Then only new sessions are considered for resolution', async () => {
    mockSpawnSequence([
      { stdout: JSON.stringify([{ id: 'old-session', title: 'implement' }]), code: 0 },
      { stdout: 'first turn done', code: 0 },
      {
        stdout: JSON.stringify([
          { id: 'keen-otter', title: 'other title' },
          { id: 'old-session', title: 'implement' },
        ]),
        code: 0,
      },
    ]);

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBe('keen-otter');
  });

  it('Given devin list fails, When called, Then still succeeds without a session ID', async () => {
    mockSpawnSequence([
      { stdout: '[]', code: 0 },
      { stdout: 'first turn done', code: 0 },
      { stderr: 'boom', code: 1 },
    ]);

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBeUndefined();
  });

  it('Given devin list returns malformed JSON, When called, Then still succeeds without a session ID', async () => {
    mockSpawnSequence([
      { stdout: '[]', code: 0 },
      { stdout: 'first turn done', code: 0 },
      { stdout: 'not json', code: 0 },
    ]);

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('done');
    expect(result.sessionId).toBeUndefined();
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

  it('Given empty stdout, When called, Then returns an error response', async () => {
    mockSpawnWithScenario({ stdout: '', code: 0 });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toBe('devin returned empty output');
  });

  it('Given non-zero exit, When called, Then returns an error with stderr detail', async () => {
    mockSpawnWithScenario({ stdout: '', stderr: 'something exploded', code: 2 });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Devin CLI exited with code 2');
    expect(result.error).toContain('something exploded');
  });

  it('Given ENOENT, When called, Then reports the missing devin binary', async () => {
    mockSpawnWithScenario({
      error: { message: 'spawn devin ENOENT', code: 'ENOENT' },
    });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('devin binary not found');
  });

  it('Given an authentication failure, When called, Then reports the login requirement', async () => {
    mockSpawnWithScenario({ stderr: 'Error: not logged in', code: 1 });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('devin auth login');
  });

  it('Given an abort signal, When called, Then returns the aborted error', async () => {
    const abortController = new AbortController();
    mockSpawn.mockImplementation(() => {
      const child = createMockChildProcess();
      queueMicrotask(() => {
        abortController.abort();
        child.emit('close', null, 'SIGTERM');
      });
      return child;
    });

    const result = await callDevin('coder', 'implement', {
      cwd: '/repo',
      abortSignal: abortController.signal,
    });

    expect(result.status).toBe('error');
    expect(result.error).toBe('Devin execution aborted');
  });

  it('Given a rate limit response in stdout, When called, Then returns a rate_limited response', async () => {
    mockSpawnWithScenario({ stdout: 'too many requests', code: 0 });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('rate_limited');
  });

  it('Given a rate limit failure in stderr, When called, Then returns a rate_limited response', async () => {
    mockSpawnWithScenario({ stderr: 'HTTP status 429: rate limit exceeded', code: 1 });

    const result = await callDevin('coder', 'implement', { cwd: '/repo' });

    expect(result.status).toBe('rate_limited');
  });

  it('Given stream callback, When called, Then emits text and result events', async () => {
    const onStream = vi.fn();
    mockSpawnWithScenario({ stdout: 'streamed answer', code: 0 });

    await callDevin('coder', 'implement', { cwd: '/repo', sessionId: 's-1', onStream });

    const eventTypes = onStream.mock.calls.map((call) => (call[0] as { type: string }).type);
    expect(eventTypes).toEqual(['text', 'result']);
    expect(onStream).toHaveBeenCalledWith({ type: 'text', data: { text: 'streamed answer' } });
  });
});
