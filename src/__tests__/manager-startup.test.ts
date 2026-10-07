import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps, ReactElement } from 'react';
import type { ManagerView } from '../features/manager/ManagerView.js';
vi.mock('../features/manager/completionTurn.js', () => ({ recoverManagerEvents: vi.fn(async () => {}) }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));
const doubles = vi.hoisted(() => ({ plan: vi.fn(), confirmation: vi.fn(), connect: vi.fn(), session: vi.fn(), mount: vi.fn(), realpath: vi.fn(), preflight: vi.fn(), list: vi.fn(), codex: vi.fn(), execFile: vi.fn(), openCode: vi.fn(), claude: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('node:child_process')>(), execFile: doubles.execFile }));
vi.mock('../infra/opencode/index.js', () => ({ callOpenCode: doubles.openCode, callOpenCodeCustom: doubles.openCode, compactOpenCodeSession: vi.fn() }));
vi.mock('../infra/claude/client.js', () => ({ callClaude: doubles.claude, callClaudeCustom: doubles.claude }));
vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>(), realpathSync: doubles.realpath }));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: doubles.plan }));
vi.mock('../features/manager/goalConfirmation.js', () => ({ createGoalConfirmation: doubles.confirmation }));
vi.mock('../features/manager/managerMcp.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../features/manager/managerMcp.js')>(),
  connectManagerMcp: doubles.connect,
}));
vi.mock('../features/manager/conversationSession.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../features/manager/conversationSession.js')>(),
  createManagerConversationSession: doubles.session,
}));
vi.mock('../features/tui/inkMount.js', () => ({ mountInk: doubles.mount }));
vi.mock('../infra/codex/mcp-list.js', () => ({ runCodexMcpList: doubles.list }));
vi.mock('../infra/codex/skill-config.js', () => ({ buildCodexSkillConfig: vi.fn() }));
vi.mock('../infra/codex/cli-runtime.js', () => ({ resolveCodexSdkCli: () => ({ executablePath: '/test/codex', pathDirs: [] }) }));
vi.mock('@openai/codex-sdk', () => ({ Codex: doubles.codex }));
vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infra/config/index.js')>(),
  resolveOpenaiApiKey: () => undefined,
  resolveCodexCliPath: () => '/test/codex',
  resolveClaudeCliPath: () => '/test/claude',
}));
import { runManager } from '../features/manager/runManager.js';
import { CodexProvider } from '../infra/providers/codex.js';
import { OpenCodeProvider } from '../infra/providers/opencode.js';
import { ClaudeProvider } from '../infra/providers/claude.js';
import { managerOutputSchema } from '../features/manager/conversationSession.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { recoverManagerEvents } from '../features/manager/completionTurn.js';
import { ensureManagerRun } from '../features/manager/autoRun.js';

describe('manager startup and teardown', () => {
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const close = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recoverManagerEvents).mockReset().mockResolvedValue(undefined);
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    doubles.realpath.mockReturnValue('/canonical/repository');
    doubles.preflight.mockReset().mockResolvedValue(undefined);
    doubles.list.mockReset().mockResolvedValue('[]');
    doubles.plan.mockReturnValue({ ctx: { lang: 'ja', provider: { preflight: doubles.preflight } }, strategy: { allowedTools: ['Read'] } });
    doubles.confirmation.mockReturnValue({ publicKey: 'public key', sign: vi.fn() });
    doubles.connect.mockResolvedValue({ client: {}, servers: {}, dispose });
    doubles.session.mockReturnValue({ close });
    doubles.mount.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  });

  it('rejects a noninteractive terminal before preparing provider or MCP resources', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    await expect(runManager({ cwd: '/repository' })).rejects.toThrow('interactive terminal');
    expect(doubles.plan).not.toHaveBeenCalled();
    expect(doubles.connect).not.toHaveBeenCalled();
  });

  it('waits for provider preflight before setting up the conversation or opening the TUI', async () => {
    let complete!: () => void;
    doubles.preflight.mockReturnValueOnce(new Promise<void>((resolve) => { complete = resolve; }));
    const servers = { manager: { command: 'node' } };
    doubles.connect.mockResolvedValueOnce({ client: {}, servers, dispose });
    const run = runManager({ cwd: '/repository' });
    await vi.waitFor(() => expect(doubles.preflight).toHaveBeenCalledTimes(1));
    expect(doubles.preflight).toHaveBeenCalledWith({
      cwd: '/canonical/repository', model: undefined, providerOptions: undefined,
      allowedTools: ['Read'], mcpOnlySideEffects: ['Read'],
      permissionMode: 'readonly', mcpServers: servers,
      outputSchema: managerOutputSchema,
    });
    expect(doubles.session).not.toHaveBeenCalled();
    expect(doubles.mount).not.toHaveBeenCalled();
    complete();
    await run;
    expect(doubles.mount).toHaveBeenCalledTimes(1);
  });

  it.each(['list failure', 'name collision', 'success'] as const)('checks effective Codex MCP configuration before the TUI: %s', async (outcome) => {
    doubles.plan.mockReturnValue({
      ctx: { lang: 'ja', provider: new CodexProvider(), model: 'chosen-model', providerOptions: { codex: { fastMode: true, networkAccess: false } } },
      strategy: { allowedTools: ['Read', `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__takt_list_goals`] },
    });
    doubles.connect.mockResolvedValueOnce({
      client: {}, servers: { [TAKT_MANAGER_MCP_SERVER_NAME]: { command: 'node', args: ['manager.js'] } }, dispose,
    });
    if (outcome === 'list failure') doubles.list.mockRejectedValueOnce(new Error('list unavailable'));
    else doubles.list.mockResolvedValueOnce(JSON.stringify([
      { name: outcome === 'name collision' ? TAKT_MANAGER_MCP_SERVER_NAME : 'unrelated', enabled: false },
    ]));

    const run = runManager({ cwd: '/repository' });
    if (outcome === 'success') {
      await run;
      expect(doubles.mount).toHaveBeenCalledTimes(1);
      expect(doubles.list.mock.invocationCallOrder[0]).toBeLessThan(doubles.session.mock.invocationCallOrder[0]!);
    } else {
      await expect(run).rejects.toThrow();
      expect(doubles.session).not.toHaveBeenCalled();
      expect(doubles.mount).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    }
    expect(doubles.list).toHaveBeenCalledTimes(1);
    expect(doubles.list).toHaveBeenCalledWith(expect.objectContaining({
      executablePath: '/test/codex', cwd: '/canonical/repository',
      configOverrides: expect.arrayContaining(['model="chosen-model"', 'sandbox_mode="read-only"', 'features.fast_mode=true']),
    }));
    expect(doubles.codex).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each(['missing CLI', 'wrong version', 'success'] as const)('resolves the selected OpenCode CLI before the TUI: %s', async (outcome) => {
    vi.stubEnv('TAKT_OPENCODE_VERSION', 'v2');
    vi.stubEnv('TAKT_OPENCODE_PATH', '/test/opencode');
    doubles.execFile.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(outcome === 'missing CLI' ? new Error('ENOENT') : null, outcome === 'wrong version' ? '1.18.2' : 'opencode v2.0.18', '');
    });
    doubles.plan.mockReturnValueOnce({
      ctx: { lang: 'ja', provider: new OpenCodeProvider(), model: 'probe/probe' },
      strategy: { allowedTools: ['Read', `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__takt_list_goals`] },
    });
    const run = runManager({ cwd: '/repository' });
    if (outcome === 'success') {
      await run;
      expect(doubles.mount).toHaveBeenCalledTimes(1);
      expect(doubles.execFile.mock.invocationCallOrder[0]).toBeLessThan(doubles.session.mock.invocationCallOrder[0]!);
    } else {
      await expect(run).rejects.toThrow();
      expect(doubles.session).not.toHaveBeenCalled();
      expect(doubles.mount).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    }
    expect(doubles.execFile).toHaveBeenCalledWith('/test/opencode', ['--version'], expect.objectContaining({ timeout: 10_000 }), expect.any(Function));
    expect(doubles.openCode).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each(['missing CLI', 'unsupported constraints', 'success'] as const)('checks Claude runtime before the TUI: %s', async (outcome) => {
    doubles.execFile.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(outcome === 'missing CLI' ? new Error('ENOENT') : null, outcome === 'unsupported constraints' ? '--tools' : '--tools --strict-mcp-config --json-schema', '');
    });
    doubles.plan.mockReturnValueOnce({
      ctx: { lang: 'ja', provider: new ClaudeProvider() }, strategy: { allowedTools: ['Read'] },
    });
    const run = runManager({ cwd: '/repository' });
    if (outcome === 'success') {
      await run;
      expect(doubles.mount).toHaveBeenCalledTimes(1);
    } else {
      await expect(run).rejects.toThrow();
      expect(doubles.session).not.toHaveBeenCalled();
      expect(doubles.mount).not.toHaveBeenCalled();
    }
    expect(doubles.execFile).toHaveBeenCalledWith('/test/claude', ['--help'], expect.objectContaining({ cwd: '/canonical/repository', timeout: 5_000 }), expect.any(Function));
    expect(doubles.claude).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each([OpenCodeProvider, ClaudeProvider])('rejects unsupported manager tool restrictions before probing the runtime: %s', async (ProviderClass) => {
    doubles.plan.mockReturnValueOnce({
      ctx: { lang: 'ja', provider: new ProviderClass(), model: 'probe/probe' }, strategy: { allowedTools: ['Bash'] },
    });
    await expect(runManager({ cwd: '/repository' })).rejects.toThrow();
    expect(doubles.execFile).not.toHaveBeenCalled();
    expect(doubles.mount).not.toHaveBeenCalled();
    expect(doubles.session).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('opens the TUI when the provider requires no runtime preflight', async () => {
    doubles.plan.mockReturnValueOnce({ ctx: { lang: 'ja', provider: {} }, strategy: {} });
    await runManager({ cwd: '/repository' });
    expect(doubles.mount).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('passes recovery diagnostics to the TUI and checks automatic startup when recovery fails=%s', async (fails) => {
    if (fails) vi.mocked(recoverManagerEvents).mockRejectedValueOnce(new Error('list unavailable api_key=fixture-secret'));
    doubles.mount.mockImplementationOnce(async (buildTree) => {
      const tree = buildTree({ settle: vi.fn(), fail: vi.fn() }) as ReactElement<ComponentProps<typeof ManagerView>>;
      expect(tree.props.initialDiagnostics).toEqual(fails ? ['list unavailable api_key=[REDACTED]'] : []);
    });

    await runManager({ cwd: '/repository' });

    expect(recoverManagerEvents).toHaveBeenCalledExactlyOnceWith('/canonical/repository');
    expect(ensureManagerRun).toHaveBeenCalledExactlyOnceWith('/canonical/repository');
    expect(vi.mocked(recoverManagerEvents).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ensureManagerRun).mock.invocationCallOrder[0]!);
    expect(vi.mocked(ensureManagerRun).mock.invocationCallOrder[0]).toBeLessThan(doubles.mount.mock.invocationCallOrder[0]!);
    expect(close).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0]!);
  });

  it('does not recover events or open the screen when preflight fails', async () => {
    const failure = new Error('preflight failed');
    doubles.preflight.mockRejectedValueOnce(failure);

    await expect(runManager({ cwd: '/repository' })).rejects.toBe(failure);

    expect(recoverManagerEvents).not.toHaveBeenCalled();
    expect(ensureManagerRun).not.toHaveBeenCalled();
    expect(doubles.mount).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('closes the conversation before MCP cleanup when the screen fails=%s', async (fails) => {
    if (fails) doubles.mount.mockRejectedValueOnce(new Error('screen failed'));
    const run = runManager({ cwd: '/repository', agentOverrides: { model: 'chosen-model' } });
    if (fails) await expect(run).rejects.toThrow('screen failed');
    else await run;
    expect(doubles.plan).toHaveBeenCalledWith('/canonical/repository', { model: 'chosen-model' });
    expect(doubles.connect).toHaveBeenCalledWith('/canonical/repository', 'public key');
    expect(close).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0]!);
  });
});
