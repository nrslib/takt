import type { ComponentProps,ReactElement } from 'react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { assertStrictStructuredOutputSchema,validateStructuredOutputAgainstSchema } from '../core/workflow/engine/structured-output-schema-validator.js';
import { ensureManagerRun } from '../features/manager/autoRun.js';
import { managerOutputSchema } from '../features/manager/conversationSession.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import type { ManagerView } from '../features/manager/ManagerView.js';
import { runManager } from '../features/manager/runManager.js';
import { resolveManagerStartup } from '../features/manager/startupResolution.js';
import { ClaudeProvider } from '../infra/providers/claude.js';
import { CodexProvider } from '../infra/providers/codex.js';
import { OpenCodeProvider } from '../infra/providers/opencode.js';
import { selectOption } from '../shared/prompt/index.js';
vi.mock('../features/manager/startupResolution.js', async (original) => ({ ...await original<typeof import('../features/manager/startupResolution.js')>(), resolveManagerStartup: vi.fn() }));
vi.mock('../shared/prompt/index.js', async (original) => ({ ...await original<typeof import('../shared/prompt/index.js')>(), selectOption: vi.fn() }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));
const doubles = vi.hoisted(() => ({ plan: vi.fn(), connect: vi.fn(), session: vi.fn(), mount: vi.fn(), realpath: vi.fn(), preflight: vi.fn(), list: vi.fn(), codex: vi.fn(), execFile: vi.fn(), openCode: vi.fn(), claude: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('node:child_process')>(), execFile: doubles.execFile }));
vi.mock('../infra/opencode/index.js', () => ({ callOpenCode: doubles.openCode, callOpenCodeCustom: doubles.openCode, compactOpenCodeSession: vi.fn() }));
vi.mock('../infra/claude/client.js', () => ({ callClaude: doubles.claude, callClaudeCustom: doubles.claude }));
vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>(), realpathSync: doubles.realpath }));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: doubles.plan }));
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

describe('manager startup and teardown', () => {
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const close = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ensureManagerRun).mockReset().mockResolvedValue(undefined);
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    doubles.realpath.mockReturnValue('/canonical/repository');
    vi.mocked(resolveManagerStartup).mockReset().mockResolvedValue({ kind: 'ready', context: { cwd: '/canonical/repository', assignment: { kind: 'repository', repositoryDirectory: '/canonical/repository', repositoryDirectories: ['/canonical/repository'] } } });
    vi.mocked(selectOption).mockReset().mockResolvedValue(null);
    doubles.preflight.mockReset().mockResolvedValue(undefined);
    doubles.list.mockReset().mockResolvedValue('[]');
    doubles.plan.mockReturnValue({ ctx: { lang: 'ja', providerType: 'mock', provider: { preflight: doubles.preflight } }, strategy: { allowedTools: ['Read'] } });
    doubles.connect.mockResolvedValue({ client: {}, servers: {}, dispose });
    doubles.session.mockReturnValue({ close });
    doubles.mount.mockImplementation(async (buildTree) => {
      const tree = buildTree({ settle: vi.fn(), fail: vi.fn() }) as ReactElement<ComponentProps<typeof ManagerView>>;
      await tree.props.startup!.run(new AbortController().signal);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  });

  it('guides an outside-repository startup with no workspaces without starting MCP or provider', async () => {
    vi.mocked(resolveManagerStartup).mockResolvedValueOnce({ kind: 'selection', workspaces: [] });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runManager({ cwd: '/outside' });
    expect(output).toHaveBeenCalled();
    expect(selectOption).not.toHaveBeenCalled();
    expect(doubles.plan).not.toHaveBeenCalled();
    expect(doubles.connect).not.toHaveBeenCalled();
  });

  it.each([true, false])('selects a workspace outside repositories, cancelled=%s', async (cancelled) => {
    const workspace = { id: '550e8400-e29b-41d4-a716-446655440000', name: '開発', repositoryDirectories: ['/canonical/repository'] };
    const other = { id: '650e8400-e29b-41d4-a716-446655440001', name: '別の担当', repositoryDirectories: ['/other/repository', '/third/repository'] };
    vi.mocked(resolveManagerStartup).mockResolvedValueOnce({ kind: 'selection', workspaces: [workspace, other] });
    vi.mocked(selectOption).mockImplementationOnce(async () => {
      expect(doubles.plan).not.toHaveBeenCalled();
      expect(doubles.connect).not.toHaveBeenCalled();
      expect(doubles.mount).not.toHaveBeenCalled();
      return cancelled ? null : other.id;
    });
    await runManager({ cwd: process.cwd() });
    expect(selectOption).toHaveBeenCalledWith(expect.any(String), [
      { value: workspace.id, label: '開発 (1)' },
      { value: other.id, label: '別の担当 (2)' },
    ]);
    if (cancelled) {
      expect(doubles.plan).not.toHaveBeenCalled();
      expect(doubles.connect).not.toHaveBeenCalled();
      expect(doubles.mount).not.toHaveBeenCalled();
    } else {
      expect(doubles.connect).toHaveBeenCalledWith('/other/repository', {
        kind: 'workspace', workspaceId: other.id, name: other.name, repositoryDirectories: other.repositoryDirectories,
      });
      expect(vi.mocked(selectOption).mock.invocationCallOrder[0]).toBeLessThan(doubles.mount.mock.invocationCallOrder[0]!);
    }
  });

  it('rejects a noninteractive terminal before preparing provider or MCP resources', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    await expect(runManager({ cwd: '/repository' })).rejects.toThrow('interactive terminal');
    expect(doubles.plan).not.toHaveBeenCalled();
    expect(doubles.connect).not.toHaveBeenCalled();
  });

  it('preflights Codex with a strict conversation schema before opening the TUI', async () => {
    doubles.plan.mockReturnValueOnce({
      ctx: { lang: 'ja', providerType: 'codex', provider: { preflight: doubles.preflight } },
      strategy: { allowedTools: ['Read'] },
    });
    doubles.preflight.mockImplementationOnce(async ({ outputSchema }) => {
      assertStrictStructuredOutputSchema(outputSchema);
      validateStructuredOutputAgainstSchema({ message: '確認', summary: {
        objective: 'CSV出力', outOfScope: [], acceptanceCriteria: ['CSV取得'],
        repositoryDirectory: null, startBranch: null, integrationBranch: null,
       constraints: [], } }, outputSchema);
    });
    await runManager({ cwd: '/repository' });
    expect(doubles.preflight).toHaveBeenCalledOnce();
    expect(doubles.session).toHaveBeenCalledOnce();
    expect(doubles.mount).toHaveBeenCalledOnce();
  });

  it.each(['claude', 'claude-sdk'] as const)('keeps the existing schema constraints in %s startup preflight', async (providerType) => {
    doubles.plan.mockReturnValueOnce({
      ctx: { lang: 'ja', providerType, provider: { preflight: doubles.preflight } },
      strategy: { allowedTools: ['Read'] },
    });
    await runManager({ cwd: '/repository' });
    expect(doubles.preflight.mock.calls[0]![0].outputSchema).toEqual(managerOutputSchema);
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
      ctx: { lang: 'ja', providerType: 'codex', provider: new CodexProvider(), model: 'chosen-model', providerOptions: { codex: { fastMode: true, networkAccess: false } } },
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
      ctx: { lang: 'ja', providerType: 'opencode', provider: new OpenCodeProvider(), model: 'probe/probe' },
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
      ctx: { lang: 'ja', providerType: 'claude', provider: new ClaudeProvider() }, strategy: { allowedTools: ['Read'] },
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

  it.each([CodexProvider, OpenCodeProvider, ClaudeProvider])('cancels a pending runtime probe through provider preflight: %s', async (ProviderClass) => {
    const controller = new AbortController();
    doubles.list.mockImplementationOnce(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      expect(abortSignal).toBe(controller.signal);
      return new Promise<string>((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      });
    });
    doubles.execFile.mockImplementationOnce((_command, _args, options, callback) => {
      expect(options.signal).toBe(controller.signal);
      options.signal.addEventListener('abort', () => callback(controller.signal.reason, '', ''), { once: true });
    });
    const preflight = new ProviderClass().preflight({
      cwd: '/repository', model: 'probe/probe', permissionMode: 'readonly',
      mcpOnlySideEffects: ['Read'], abortSignal: controller.signal,
    });
    const rejected = expect(preflight).rejects.toThrow();
    await vi.waitFor(() => expect(doubles.list.mock.calls.length + doubles.execFile.mock.calls.length).toBe(1));

    controller.abort();
    await rejected;

    expect(doubles.codex).not.toHaveBeenCalled();
    expect(doubles.openCode).not.toHaveBeenCalled();
    expect(doubles.claude).not.toHaveBeenCalled();
  });

  it.each([OpenCodeProvider, ClaudeProvider])('rejects unsupported manager tool restrictions before probing the runtime: %s', async (ProviderClass) => {
    doubles.plan.mockReturnValueOnce({
      ctx: { lang: 'ja', providerType: ProviderClass === OpenCodeProvider ? 'opencode' : 'claude', provider: new ProviderClass(), model: 'probe/probe' }, strategy: { allowedTools: ['Bash'] },
    });
    await expect(runManager({ cwd: '/repository' })).rejects.toThrow();
    expect(doubles.execFile).not.toHaveBeenCalled();
    expect(doubles.mount).not.toHaveBeenCalled();
    expect(doubles.session).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('opens the TUI when the provider requires no runtime preflight', async () => {
    doubles.plan.mockReturnValueOnce({ ctx: { lang: 'ja', providerType: 'mock', provider: {} }, strategy: {} });
    await runManager({ cwd: '/repository' });
    expect(doubles.mount).toHaveBeenCalledTimes(1);
  });

  it('propagates automatic startup failures and cleans up the conversation and MCP', async () => {
    const failure = new Error('automatic startup failed');
    vi.mocked(ensureManagerRun).mockRejectedValueOnce(failure);

    await expect(runManager({ cwd: '/repository' })).rejects.toBe(failure);

    expect(close).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0]!);
  });
});
