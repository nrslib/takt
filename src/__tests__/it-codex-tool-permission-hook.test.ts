import type { CodexOptions } from '@openai/codex-sdk';
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { createConnection } from 'node:net';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexClient } from '../infra/codex/client.js';
import { CODEX_CONFIG_PROFILE_ENV, type CodexCallOptions } from '../infra/codex/types.js';
import type { ToolPermissionDecisionHandler } from '../core/workflow/types.js';
import { buildCodexToolPermissionHookCommand } from '../infra/codex/tool-permission-hook.js';
import {
  CODEX_TOOL_PERMISSION_ENDPOINT_ENV,
  CODEX_TOOL_PERMISSION_TOKEN_ENV,
  CODEX_TOOL_PERMISSION_HANDLER_TIMEOUT_MS,
} from '../infra/codex/tool-permission-hook-protocol.js';
import { MAX_AGENT_FAILURE_MESSAGE_BYTES } from '../shared/types/agent-failure.js';

const sdk = vi.hoisted(() => ({ construct: vi.fn(), run: vi.fn(), events: vi.fn(), start: vi.fn(), trust: vi.fn(), runtime: vi.fn(), log: vi.fn() }));
vi.mock('../shared/utils/debug.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/debug.js')>()),
  createLogger: () => ({ debug: sdk.log, info: sdk.log, warn: sdk.log, error: sdk.log, trace: sdk.log, enter: sdk.log, exit: sdk.log }),
}));
vi.mock('../infra/managed-providers/loader.js', () => import('./helpers/managed-sdk.js'));
vi.mock('../infra/codex/hook-trust.js', () => ({ resolveCodexHookTrust: sdk.trust }));
vi.mock('../infra/codex/cli-runtime.js', () => ({ resolveCodexSdkCli: sdk.runtime }));
vi.mock('@openai/codex-sdk', () => ({ Codex: class {
  private readonly options: CodexOptions;
  constructor(options: CodexOptions) { this.options = options; sdk.construct(options); }
  startThread() {
    sdk.start();
    return { runStreamed: async (_input: unknown, turn?: { signal?: AbortSignal }) => {
      let cancel!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new Error('fixture turn aborted'));
        turn?.signal?.addEventListener('abort', cancel, { once: true });
        if (turn?.signal?.aborted) cancel();
      });
      try { await Promise.race([cancelled, sdk.run(this.options)]); }
      finally { turn?.signal?.removeEventListener('abort', cancel); }
      return { events: sdk.events(this.options) };
    } };
  }
} }));

interface HookDefinition { command: string; timeout: number }
interface HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason: string;
  };
}
let root: string;
const servers = new Set<Server>();
const children = new Set<ChildProcess>();
const controllers = new Set<AbortController>();
const activeCalls = new Set<ReturnType<CodexClient['call']>>();
const actualCall = CodexClient.prototype.call;
const payload = {
  session_id: 'fixture-session', turn_id: 'fixture-turn', tool_use_id: 'fixture-tool-use',
  cwd: '/fixture/actual-tool', tool_name: 'Bash', tool_input: { command: "printf '日本語'" },
  transcript_path: '/fixture/transcript.jsonl', model: 'fixture-model',
  permission_mode: 'danger-full-access', hook_event_name: 'PreToolUse',
};

interface ShellPolicy {
  filters?: Record<string, 'include' | 'exclude'>;
  exclude?: string[];
  include_only?: string[];
  set?: Record<string, string>;
}

// Codex 0.159.2 config/src/merge.rs: a representation switch removes the lower filter fields.
function mergeShellPolicy(base: ShellPolicy, overlay: ShellPolicy): ShellPolicy {
  const result = { ...base };
  if (overlay.filters !== undefined) {
    delete result.exclude;
    delete result.include_only;
  } else if (overlay.exclude !== undefined || overlay.include_only !== undefined) {
    delete result.filters;
  }
  const normalizeFilters = (filters: ShellPolicy['filters']) => Object.fromEntries(
    Object.entries(filters ?? {}).map(([name, action]) => [name.toLowerCase(), action]),
  );
  const filters = { ...normalizeFilters(result.filters), ...normalizeFilters(overlay.filters) };
  return {
    ...result, ...overlay,
    ...(result.filters === undefined && overlay.filters === undefined ? {} : { filters }),
    ...(result.set === undefined && overlay.set === undefined ? {} : { set: { ...result.set, ...overlay.set } }),
  };
}

function shellEnvironment(config: CodexOptions, user: ShellPolicy, profiles: Record<string, ShellPolicy>): Record<string, string> {
  const profile = config.env?.[CODEX_CONFIG_PROFILE_ENV];
  if (profile !== undefined && !Object.hasOwn(profiles, profile)) throw new Error('Unknown fixture profile');
  const policy = mergeShellPolicy(mergeShellPolicy(user, profile === undefined ? {} : profiles[profile]!),
    config.config?.shell_environment_policy as ShellPolicy ?? {});
  const matches = (name: string, patterns: string[]) => patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
    return new RegExp(`^${escaped}$`, 'iu').test(name);
  });
  const filters = Object.entries(policy.filters ?? {});
  const exclude = policy.filters === undefined ? policy.exclude ?? [] : filters.filter(([, action]) => action === 'exclude').map(([name]) => name);
  const include = policy.filters === undefined ? policy.include_only ?? [] : filters.filter(([, action]) => action === 'include').map(([name]) => name);
  // These fixtures use Codex's defaults: inherit=all, ignore_default_excludes=true.
  // protocol/src/shell_environment.rs applies custom excludes, then set, then include_only.
  const inherited = Object.entries(config.env!).filter(([name]) => !matches(name, exclude));
  return Object.fromEntries(Object.entries({ ...Object.fromEntries(inherited), ...policy.set })
    .filter(([name]) => include.length === 0 || matches(name, include)));
}

function definition(options: CodexOptions): HookDefinition {
  expect(options.config?.features).toMatchObject({ hooks: true });
  const hooks = options.config?.hooks as { PreToolUse?: { matcher: string; hooks: HookDefinition[] }[] } | undefined;
  const hook = hooks?.PreToolUse?.[0]?.hooks[0];
  expect(hook).toBeDefined();
  const trustIndex = sdk.trust.mock.calls.findIndex(([input]) => input.definition.command === hook!.command);
  expect(trustIndex).toBeGreaterThanOrEqual(0);
  const trusted = sdk.trust.mock.calls[trustIndex]![0].definition;
  expect(trusted.matcher).toBe(hooks!.PreToolUse![0]!.matcher);
  expect(trusted.timeout).toBe(hook!.timeout);
  expect(options.configOverrides).toContain(`hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="sha256:fixture-${trustIndex + 1}"}}`);
  return hook!;
}

async function invoke(command: string, env: Record<string, string>, input: unknown, timeoutMs = 8_000): Promise<HookOutput> {
  const child = spawn(command, { shell: true, cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const parsed = await readOutput(child, input, timeoutMs);
  expect(parsed).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse' } });
  return parsed as HookOutput;
}

async function readOutput(child: ChildProcessWithoutNullStreams, input: unknown, timeoutMs: number): Promise<unknown> {
  children.add(child);
  child.once('close', () => children.delete(child));
  const result = new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.resume();
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout }));
  });
  // 実行体の読込失敗も close と stdout で検出する。EPIPE による未処理例外で隠さない。
  child.stdin.on('error', () => {});
  const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    child.stdin.end(JSON.stringify(input));
    const output = await result;
    expect(output.code).toBe(0);
    return JSON.parse(output.stdout) as unknown;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await result;
  }
}

async function observeBashEnvironment(config: CodexOptions, user: ShellPolicy, profiles: Record<string, ShellPolicy>): Promise<Record<string, string>> {
  const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', 'exec "$@"', 'fixture', process.execPath,
    '-e', 'process.stdout.write(JSON.stringify(process.env))'], {
    cwd: root, env: shellEnvironment(config, user, profiles), stdio: ['pipe', 'pipe', 'pipe'],
  });
  return await readOutput(child, payload, 8_000) as Record<string, string>;
}

function expectDeny(output: HookOutput): void {
  expect(output.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/\S/u) });
}

function options(handler: ToolPermissionDecisionHandler): CodexCallOptions & { onToolPermissionDecision: ToolPermissionDecisionHandler } {
  const controller = new AbortController();
  controllers.add(controller);
  return { cwd: root, abortSignal: controller.signal, codexPathOverride: '/fixture/codex', onToolPermissionDecision: handler, fastMode: true };
}

function credentials(command: string): { endpoint: string; token: string } {
  const value = (name: string) => {
    const match = new RegExp(`${name}='([^']+)'`, 'u').exec(command);
    if (match === null) throw new Error('Missing fixture hook credential');
    return match[1]!;
  };
  return { endpoint: value(CODEX_TOOL_PERMISSION_ENDPOINT_ENV), token: value(CODEX_TOOL_PERMISSION_TOKEN_ENV) };
}

function handlerCommand(config: CodexOptions, overrides: Partial<{ endpoint: string; token: string }>): string {
  return buildCodexToolPermissionHookCommand(fileURLToPath(new URL('../infra/codex/tool-permission-hook-handler.ts', import.meta.url)),
    { ...credentials(definition(config).command), ...overrides });
}

async function expectClosed(command: string): Promise<void> {
  const url = new URL(credentials(command).endpoint);
  await expect(new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    socket.setTimeout(1_000, () => socket.destroy(new Error('connection did not settle')));
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
  })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(CodexClient.prototype, 'call').mockImplementation(function (this: CodexClient, ...args) {
    const result = actualCall.apply(this, args);
    activeCalls.add(result);
    void result.then(() => activeCalls.delete(result), () => activeCalls.delete(result));
    return result;
  });
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
  root = mkdtempSync(join(process.cwd(), '.tmp', 'codex-hook-'));
  vi.stubEnv('HOME', root); vi.stubEnv('CODEX_HOME', root);
  sdk.trust.mockImplementation(async () => ({ key: '/<session-flags>/config.toml:pre_tool_use:0:0', trustedHash: `sha256:fixture-${sdk.trust.mock.calls.length}` }));
  sdk.run.mockResolvedValue(undefined);
  sdk.events.mockImplementation(() => (async function* () { yield { type: 'turn.completed' }; })());
  sdk.runtime.mockImplementation((override: string | undefined) => ({ executablePath: override ?? '/fixture/managed-codex', pathDirs: [] }));
});
afterEach(async () => {
  for (const controller of controllers) controller.abort();
  controllers.clear();
  const exits = [...children].map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('close', () => resolve()); child.kill('SIGKILL');
  }));
  await Promise.all(exits);
  await Promise.allSettled([...activeCalls]);
  children.clear(); activeCalls.clear();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('Codex tool permission command and turn resources', () => {
  it('uses the managed CLI for both trust lookup and SDK execution when no override is provided', async () => {
    const handler = vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue({ decision: 'allow' });
    expect((await new CodexClient().call('manager', 'inspect', { ...options(handler), codexPathOverride: undefined })).status).toBe('done');
    expect(sdk.runtime).toHaveBeenCalledWith(undefined, '/test/managed/codex');
    expect(sdk.trust.mock.calls[0]![0].executablePath).toBe('/fixture/managed-codex');
    expect(sdk.construct.mock.calls[0]![0].codexPathOverride).toBe('/fixture/managed-codex');
  });

  it('keeps the turn endpoint through a provider retry and disposes it after the last attempt', async () => {
    const handler = vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue({ decision: 'allow' });
    sdk.run.mockImplementationOnce(async (config: CodexOptions) => { throw new Error(`transport error: ${definition(config).command}`); });
    sdk.run.mockImplementationOnce(async (config: CodexOptions) => {
      const first = sdk.construct.mock.calls[0]![0] as CodexOptions;
      expect(definition(config).command === definition(first).command).toBe(true);
      expect((await invoke(definition(config).command, config.env!, payload)).hookSpecificOutput.permissionDecision).toBe('allow');
    });
    const response = await new CodexClient().call('manager', 'inspect', options(handler));
    expect(response.status).toBe('done');
    expect(response.retryCount).toBe(1);
    expect(sdk.trust).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
    const secrets = Object.values(credentials(definition(sdk.construct.mock.calls[0]![0] as CodexOptions).command));
    for (const secret of secrets) expect(JSON.stringify(sdk.log.mock.calls).includes(secret)).toBe(false);
    await expectClosed(definition(sdk.construct.mock.calls[0]![0] as CodexOptions).command);
  });

  it.each(['allow', 'deny'] as const)('runs the real handler with stdin and returns %s stdout with the original cwd and arguments', async (decision) => {
    const listen = vi.spyOn(Server.prototype, 'listen');
    const handler = vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue(decision === 'allow'
      ? { decision: 'allow' } : { decision: 'deny', reason: 'operation refused' });
    let command!: string;
    sdk.run.mockImplementationOnce(async (config: CodexOptions) => {
      const hook = definition(config);
      expect(hook.timeout * 1_000).toBeGreaterThan(CODEX_TOOL_PERMISSION_HANDLER_TIMEOUT_MS);
      command = hook.command;
      const endpoint = new URL(credentials(command).endpoint);
      expect(endpoint.hostname).toBe('127.0.0.1');
      const owner = (listen.mock.contexts as Server[]).find((server) => {
        const address = server.address();
        return address !== null && typeof address === 'object' && address.port === Number(endpoint.port);
      });
      expect(owner?.address()).toMatchObject({ address: '127.0.0.1' });
      const output = await invoke(command, config.env!, payload);
      expect(config.config?.features).toMatchObject({ hooks: true, fast_mode: true });
      expect(output).toEqual({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: decision,
        permissionDecisionReason: decision === 'deny' ? 'operation refused' : '',
      } });
    });
    expect((await new CodexClient().call('manager', 'inspect', options(handler))).status).toBe('done');
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0]).toMatchObject({ toolName: 'Bash', toolInput: payload.tool_input, cwd: payload.cwd });
    await expectClosed(command);
  });

  it.each([{ pathDirs: [] }, { pathDirs: ['/fixture/codex-path'] }])('excludes hook credentials from Bash while preserving authenticated hooks (pathDirs=$pathDirs)', async ({ pathDirs }) => {
    vi.stubEnv('PATH', '/fixture/original-path');
    vi.stubEnv('FIXTURE_NOTE', 'PRIVATE_VAR');
    vi.stubEnv('PRIVATE_VAR', 'private');
    vi.stubEnv('PUBLIC_VAR', 'public');
    vi.stubEnv(CODEX_TOOL_PERMISSION_ENDPOINT_ENV, 'http://127.0.0.1:1/parent-endpoint');
    vi.stubEnv(CODEX_TOOL_PERMISSION_TOKEN_ENV, 'parent-token');
    sdk.runtime.mockReturnValue({ executablePath: '/fixture/codex', pathDirs });
    const handler = vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue({ decision: 'allow' });
    sdk.run.mockImplementationOnce(async (config: CodexOptions) => {
      const environment = shellEnvironment(config, { filters: { PRIVATE_VAR: 'exclude' } }, {});
      const script = `
        import { readFileSync } from 'node:fs';
        const response = await fetch(process.argv[1], {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: readFileSync(0, 'utf8'), signal: AbortSignal.timeout(3000),
        });
        process.stdout.write(JSON.stringify({ environment: process.env, output: await response.json() }));
      `;
      // Supply only the endpoint as an argument to test authentication independently of environment secrecy.
      const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', 'exec "$@"', 'fixture',
        process.execPath, '--input-type=module', '-e', script, credentials(definition(config).command).endpoint],
      { cwd: root, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
      const observed = await readOutput(child, payload, 8_000) as { environment: Record<string, string>; output: HookOutput };
      expect(Object.hasOwn(observed.environment, 'PRIVATE_VAR')).toBe(false);
      expect(observed.environment.PUBLIC_VAR).toBe('public');
      for (const name of [CODEX_TOOL_PERMISSION_ENDPOINT_ENV, CODEX_TOOL_PERMISSION_TOKEN_ENV]) {
        expect(Object.hasOwn(observed.environment, name)).toBe(false);
        expect(Object.hasOwn(config.env!, name)).toBe(false);
      }
      const secrets = [...Object.values(credentials(definition(config).command)), 'parent-token', 'http://127.0.0.1:1/parent-endpoint'];
      for (const secret of secrets) expect(Object.values(observed.environment).some((value) => value.includes(secret))).toBe(false);
      expect(observed.environment.PATH).toBe([...pathDirs, '/fixture/original-path'].join(delimiter));
      expect(observed.environment.FIXTURE_NOTE).toBe('PRIVATE_VAR');
      expectDeny(observed.output);
      expect(handler).not.toHaveBeenCalled();
      expect((await invoke(definition(config).command, config.env!, payload)).hookSpecificOutput.permissionDecision).toBe('allow');
      expect(handler).toHaveBeenCalledOnce();
    });
    const response = await new CodexClient().call('manager', 'inspect', options(handler));
    expect(response.status, response.error).toBe('done');
    await expectClosed(definition(sdk.construct.mock.calls[0]![0] as CodexOptions).command);
  });

  it.each([
    { name: 'user filter removed', user: {}, profiles: {}, privatePresent: true, outsidePresent: true },
    ...(['exclude', 'include'] as const).map((action) => ({
      name: `selected profile ${action}`,
      user: { filters: { '*': 'include' as const, PRIVATE_VAR: 'exclude' as const }, set: { USER_SET: 'user-value' } },
      profiles: {
        selected: { filters: { private_var: action }, set: { PROFILE_SET: 'profile-value' } },
        unselected: { filters: { PRIVATE_VAR: action === 'include' ? 'exclude' as const : 'include' as const } },
      },
      privatePresent: action === 'include', outsidePresent: true,
    })),
    { name: 'legacy include_only', user: { exclude: ['PRIVATE_VAR'], include_only: ['PATH', 'PUBLIC_VAR', 'FIXTURE_NOTE', 'USER_SET'], set: { USER_SET: 'user-value' } }, profiles: {}, privatePresent: false, outsidePresent: false },
    { name: 'legacy include_only removed', user: { exclude: ['PRIVATE_VAR'], set: { USER_SET: 'user-value' } }, profiles: {}, privatePresent: false, outsidePresent: true },
  ])('preserves effective user/profile shell policy: $name', async ({ user, profiles, privatePresent, outsidePresent }) => {
    vi.stubEnv('PRIVATE_VAR', 'private'); vi.stubEnv('PUBLIC_VAR', 'public');
    vi.stubEnv('FIXTURE_NOTE', 'PRIVATE_VAR'); vi.stubEnv('OUTSIDE_VAR', 'outside');
    const handler = vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue({ decision: 'allow' });
    const configProfile = Object.hasOwn(profiles, 'selected') ? 'selected' : undefined;
    sdk.run.mockImplementationOnce(async (config: CodexOptions) => {
      expect(config.env?.[CODEX_CONFIG_PROFILE_ENV]).toBe(configProfile);
      const observed = await observeBashEnvironment(config, user as ShellPolicy, profiles as Record<string, ShellPolicy>);
      expect(Object.hasOwn(observed, 'PRIVATE_VAR')).toBe(privatePresent);
      expect(Object.hasOwn(observed, 'OUTSIDE_VAR')).toBe(outsidePresent);
      expect(observed.PUBLIC_VAR).toBe('public');
      expect(observed.FIXTURE_NOTE).toBe('PRIVATE_VAR');
      if (Object.hasOwn(user, 'set')) expect(observed.USER_SET).toBe('user-value');
      if (configProfile !== undefined) expect(observed.PROFILE_SET).toBe('profile-value');
      expect(observed.PATH).toBe(config.env!.PATH);
      expect((await invoke(definition(config).command, config.env!, payload)).hookSpecificOutput.permissionDecision).toBe('allow');
    });
    const response = await new CodexClient().call('manager', 'inspect', {
      ...options(handler), configProfile, permissionControl: configProfile === undefined ? undefined : 'codex',
    });
    expect(response.status, response.error).toBe('done');
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each(['exception', 'error', 'turn.failed', 'startup'] as const)('removes hook credentials from %s diagnostics, saved failure text and responses', async (source) => {
    const handler = vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue({ decision: 'allow' });
    const message = (config: CodexOptions) => `fixture SDK diagnostic: ${definition(config).command}\n${'x'.repeat(MAX_AGENT_FAILURE_MESSAGE_BYTES + 100)}\n${definition(config).command}`;
    if (source === 'startup') sdk.construct.mockImplementationOnce((config: CodexOptions) => { throw new Error(message(config)); });
    else if (source === 'exception') sdk.run.mockImplementationOnce(async (config: CodexOptions) => { throw new Error(message(config)); });
    else sdk.events.mockImplementationOnce((config: CodexOptions) => (async function* () {
      if (source === 'error') yield { type: 'error', message: message(config) };
      else yield { type: 'turn.failed', error: { message: message(config) } };
    })());
    const onStream = vi.fn();
    const failureDir = join(root, 'failures');
    const response = await new CodexClient().call('manager', 'inspect', { ...options(handler), onStream, failureDir });
    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('provider_error');
    expect(response.error?.includes('fixture SDK diagnostic:')).toBe(true);
    const persisted = readdirSync(failureDir).map((name) => readFileSync(join(failureDir, name), 'utf8'));
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.every((text) => text.includes('fixture SDK diagnostic:'))).toBe(true);
    const outputs = [JSON.stringify(response), ...onStream.mock.calls.map(([event]) => JSON.stringify(event)),
      ...sdk.log.mock.calls.map((call) => JSON.stringify(call)), ...persisted];
    const secrets = Object.values(credentials(definition(sdk.construct.mock.calls[0]![0] as CodexOptions).command));
    for (const output of outputs) {
      for (const secret of secrets) expect(output.includes(secret)).toBe(false);
    }
    if (source !== 'startup') expect(sdk.log.mock.calls.some(([text]) => text === 'Stream completed')).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an incorrect token before invoking the manager handler', async () => {
    const handler = vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue({ decision: 'allow' });
    sdk.run.mockImplementationOnce(async (config: CodexOptions) => {
      const response = await fetch(credentials(definition(config).command).endpoint, {
        method: 'POST', headers: { authorization: 'Bearer invalid-fixture-token', 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(3_000),
      });
      expectDeny(await response.json() as HookOutput);
    });
    expect((await new CodexClient().call('manager', 'inspect', options(handler))).status).toBe('done');
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns a reasoned denial when the endpoint has closed', async () => {
    const handler = vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue({ decision: 'allow' });
    let config!: CodexOptions;
    sdk.run.mockImplementationOnce(async (input: CodexOptions) => { definition(input); config = input; });
    await new CodexClient().call('manager', 'inspect', options(handler));
    await expectClosed(definition(config).command);
    expectDeny(await invoke(definition(config).command, config.env!, payload));
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['not json', '{}', '{"decision":"allow"}', '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":""}}'])('denies an invalid endpoint response without reconnecting: %s', async (body) => {
    let attempts = 0;
    const server = createServer((request, response) => {
      attempts++; request.resume(); response.end(body);
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    expect(address).toBeTypeOf('object');
    const endpoint = `http://127.0.0.1:${(address as { port: number }).port}`;
    sdk.run.mockImplementationOnce(async (config: CodexOptions) => {
      expectDeny(await invoke(handlerCommand(config, { endpoint }), config.env!, payload));
    });
    const handler = vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue({ decision: 'allow' });
    await new CodexClient().call('manager', 'inspect', options(handler));
    expect(attempts).toBe(1); expect(handler).not.toHaveBeenCalled();
  });

  it('denies an unresponsive endpoint before the Codex hook deadline and makes only one request', async () => {
    let attempts = 0;
    const server = createServer((request) => { attempts++; request.resume(); });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    sdk.run.mockImplementationOnce(async (config: CodexOptions) => {
      const hook = definition(config);
      const started = Date.now();
      expectDeny(await invoke(handlerCommand(config, { endpoint }), config.env!, payload,
        CODEX_TOOL_PERMISSION_HANDLER_TIMEOUT_MS + 10_000));
      expect(Date.now() - started).toBeLessThan(hook.timeout * 1_000);
    });
    const handler = vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue({ decision: 'allow' });
    expect((await new CodexClient().call('manager', 'inspect', options(handler))).status).toBe('done');
    expect(attempts).toBe(1); expect(handler).not.toHaveBeenCalled();
  }, CODEX_TOOL_PERMISSION_HANDLER_TIMEOUT_MS + 15_000);

  it.each(['ts', 'js'])('starts the %s handler from a path containing spaces and shell metacharacters', async (extension) => {
    const directory = join(root, "handler space ' $literal");
    mkdirSync(directory);
    const sourceRoot = fileURLToPath(new URL(extension === 'ts' ? '../infra/codex/' : '../../dist/infra/codex/', import.meta.url));
    for (const name of ['tool-permission-hook-handler', 'tool-permission-hook-protocol']) {
      cpSync(join(sourceRoot, `${name}.${extension}`), join(directory, `${name}.${extension}`));
    }
    const handler = vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue({ decision: 'allow' });
    sdk.run.mockImplementationOnce(async (config: CodexOptions) => {
      definition(config);
      const command = buildCodexToolPermissionHookCommand(join(directory, `tool-permission-hook-handler.${extension}`), credentials(definition(config).command));
      expect((await invoke(command, config.env!, payload)).hookSpecificOutput.permissionDecision).toBe('allow');
    });
    expect((await new CodexClient().call('manager', 'inspect', options(handler))).status).toBe('done');
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each(['trust initialization', 'SDK failure', 'abort'] as const)('closes the endpoint after %s', async (failure) => {
    const controller = new AbortController();
    const handler = vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue({ decision: 'allow' });
    let command: string | undefined;
    if (failure === 'trust initialization') {
      sdk.trust.mockImplementationOnce(async (input: { definition: HookDefinition }) => {
        command = input.definition.command; throw new Error('fixture trust failed');
      });
    } else sdk.run.mockImplementationOnce(async (config: CodexOptions) => {
      command = definition(config).command;
      if (failure === 'abort') controller.abort();
      throw new Error('fixture SDK failure');
    });
    const result = await Promise.allSettled([new CodexClient().call('manager', 'inspect', { ...options(handler), abortSignal: controller.signal })]);
    if (result[0]!.status === 'fulfilled') expect(result[0]!.value.status).toBe('error');
    expect(command !== undefined).toBe(true);
    await expectClosed(command!);
    expect(handler).not.toHaveBeenCalled();
    if (failure === 'trust initialization') expect(sdk.start).not.toHaveBeenCalled();
  });

  it('separates concurrent turn credentials and obtains trust for each complete definition', async () => {
    const handlers = [
      vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue({ decision: 'allow' }),
      vi.fn<ToolPermissionDecisionHandler>().mockResolvedValue({ decision: 'deny', reason: 'second turn denied' }),
    ];
    const configs: CodexOptions[] = [];
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    let exercise: Promise<void> | undefined;
    sdk.run.mockImplementation(async (config: CodexOptions) => {
      definition(config); configs.push(config);
      if (configs.length === 2) release();
      await ready;
      exercise ??= (async () => {
        const [first, second] = configs as [CodexOptions, CodexOptions];
        expect(definition(first).command === definition(second).command).toBe(false);
        expect(credentials(definition(first).command).token === credentials(definition(second).command).token).toBe(false);
        expectDeny(await invoke(handlerCommand(first, { token: credentials(definition(second).command).token }), first.env!, payload));
        expect((await invoke(definition(first).command, first.env!, payload)).hookSpecificOutput.permissionDecision).toBe('allow');
        expectDeny(await invoke(definition(second).command, second.env!, payload));
      })();
      await exercise;
    });
    const client = new CodexClient();
    const first = client.call('manager', 'first', options(handlers[0]!));
    await vi.waitFor(() => expect(configs).toHaveLength(1));
    const calls = await Promise.all([first, client.call('manager', 'second', options(handlers[1]!))]);
    expect(calls.map((result) => result.status)).toEqual(['done', 'done']);
    for (const handler of handlers) expect(handler).toHaveBeenCalledOnce();
    expect(sdk.trust).toHaveBeenCalledTimes(2);
    for (const config of configs) {
      const command = definition(config).command;
      expect(sdk.trust.mock.calls.filter(([input]) => input.definition.command === command).length).toBe(1);
      await expectClosed(command);
    }
  });
});
