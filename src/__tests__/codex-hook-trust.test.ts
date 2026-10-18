import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCodexHookTrust, selectCodexHookTrust } from '../infra/codex/hook-trust.js';

const doubles = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: doubles.spawn }));

const key = '/<session-flags>/config.toml:pre_tool_use:0:0';
const definition = { command: "'/fixture/node' '/fixture/handler.js'", matcher: '.*', timeout: 90 };
const current = { key, ...definition, currentHash: 'sha256:fixture-current' };

describe('Codex hook trust selection', () => {
  it('selects the current hash only for the complete session key and exact command, matcher and timeout', () => {
    const candidates = [
      { ...current, key: '/fixture/user/config.toml:pre_tool_use:0:0', currentHash: 'sha256:user' },
      { ...current, command: `${definition.command} `, currentHash: 'sha256:other-command' },
      { ...current, timeout: 91, currentHash: 'sha256:other-timeout' },
      { ...current, matcher: 'Bash', currentHash: 'sha256:other-matcher' },
      current,
    ];
    expect(selectCodexHookTrust(candidates, definition)).toEqual({ key, trustedHash: 'sha256:fixture-current' });
  });

  it('rejects a user configuration hash even when its command, matcher and timeout match', () => {
    expect(() => selectCodexHookTrust([
      { ...current, key: '/fixture/user/config.toml:pre_tool_use:0:0' },
    ], definition)).toThrow();
  });

  it.each([
    { command: `${definition.command} ` }, { matcher: 'Bash' }, { timeout: 91 }, { currentHash: '' },
  ])('rejects a stale or missing session hash: %j', (change) => {
    expect(() => selectCodexHookTrust([{ ...current, ...change }], definition)).toThrow();
  });
});


function pendingAppServer(hooksResult?: unknown) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((_signal?: NodeJS.Signals) => {
      child.signalCode = 'SIGTERM';
      queueMicrotask(() => { child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); });
      return true;
    }),
  });
  const messages: { id?: number; method: string; params?: unknown }[] = [];
  let buffer = '';
  child.stdin.on('data', (data: Buffer) => {
    buffer += data.toString();
    while (buffer.includes('\n')) {
      const boundary = buffer.indexOf('\n');
      const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
      const message = JSON.parse(line) as typeof messages[number];
      messages.push(message);
      if (message.method === 'initialize') queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`));
      if (message.method === 'hooks/list' && hooksResult !== undefined) {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result: hooksResult })}\n`));
      }
    }
  });
  return { child, messages };
}

const input = { executablePath: '/fixture/codex', cwd: '/fixture/work', env: { CODEX_HOME: '/fixture/empty-codex-home' }, definition };
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe('Codex hook trust app-server failure lifecycle', () => {
  // Shape taken from the specified 0.159.2 hooks/list recording (data-trust-initialization.md).
  const hook = {
    key, eventName: 'preToolUse', handlerType: 'command', command: definition.command,
    async: false, matcher: definition.matcher, timeoutSec: definition.timeout,
    sourcePath: '/<session-flags>/config.toml', source: 'sessionFlags', enabled: true,
    currentHash: 'sha256:fixture-current', trustStatus: 'untrusted',
  };
  const result = (hooks: unknown[], errors: unknown[] = []) => ({
    data: [{ cwd: input.cwd, hooks, warnings: [], errors }],
  });

  it('reads the recorded hooks/list shape and terminates the successful probe before returning its hash', async () => {
    const { child, messages } = pendingAppServer(result([
      { ...hook, source: 'user', sourcePath: '/fixture/user/config.toml', currentHash: 'sha256:user' }, hook,
    ]));
    doubles.spawn.mockReturnValue(child);
    await expect(resolveCodexHookTrust(input)).resolves.toEqual({ key, trustedHash: 'sha256:fixture-current' });
    expect(messages.map(({ method }) => method)).toEqual(['initialize', 'initialized', 'hooks/list']);
    expect(messages.at(-1)!.params).toEqual({ cwds: [input.cwd] });
    const args = doubles.spawn.mock.calls[0]![1] as string[];
    expect(args).toContain(`hooks.PreToolUse=[{matcher=${JSON.stringify(definition.matcher)},hooks=[{type="command",command=${JSON.stringify(definition.command)},timeout=${definition.timeout}}]}]`);
    expect(child.kill).toHaveBeenCalled();
    expect(child.signalCode).toBe('SIGTERM');
  });

  it.each([
    null, {}, { data: [] }, result([{ ...hook, source: 'user' }]),
    result([{ ...hook, sourcePath: '/fixture/user/config.toml' }]),
    result([{ ...hook, command: `${definition.command} ` }]),
    result([{ ...hook, currentHash: null }]), result([{ ...hook, enabled: false }]),
    result([hook], ['fixture config error']),
  ])('rejects invalid or non-session RPC metadata and cleans up: %j', async (response) => {
    const { child } = pendingAppServer(response);
    doubles.spawn.mockReturnValue(child);
    await expect(resolveCodexHookTrust(input)).rejects.toThrow();
    expect(child.kill).toHaveBeenCalled();
    expect(doubles.spawn).toHaveBeenCalledOnce();
  });

  it('initializes the app-server before listing hooks and terminates an unresponsive probe without retrying', async () => {
    vi.useFakeTimers();
    const { child, messages } = pendingAppServer();
    doubles.spawn.mockReturnValue(child);
    const pending = resolveCodexHookTrust(input);
    const rejected = expect(pending).rejects.toThrow();
    await vi.runAllTimersAsync();
    await rejected;
    expect(messages.map(({ method }) => method)).toEqual(['initialize', 'initialized', 'hooks/list']);
    expect(messages[0]!.params).toMatchObject({ capabilities: { experimentalApi: true } });
    expect(doubles.spawn).toHaveBeenCalledOnce();
    expect(doubles.spawn.mock.calls[0]![0]).toBe(input.executablePath);
    expect(doubles.spawn.mock.calls[0]![1]).toContain('app-server');
    expect(doubles.spawn.mock.calls[0]![2]).toMatchObject({ cwd: input.cwd, env: input.env });
    expect(child.kill).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates a cancelled probe and never returns a hash', async () => {
    const { child, messages } = pendingAppServer();
    doubles.spawn.mockReturnValue(child);
    const controller = new AbortController();
    const pending = resolveCodexHookTrust({ ...input, abortSignal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(messages.some(({ method }) => method === 'hooks/list')).toBe(true));
    controller.abort();
    await rejected;
    expect(child.kill).toHaveBeenCalled();
    expect(doubles.spawn).toHaveBeenCalledOnce();
  });

  it('rejects an app-server startup error without retrying or returning a fallback hash', async () => {
    doubles.spawn.mockImplementation(() => { throw new Error('fixture spawn failed'); });
    await expect(resolveCodexHookTrust(input)).rejects.toThrow();
    expect(doubles.spawn).toHaveBeenCalledOnce();
  });
});
