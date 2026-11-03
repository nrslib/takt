import { makeProvider } from './test-helpers.js';
import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertStrictStructuredOutputSchema, validateStructuredOutputAgainstSchema } from '../core/workflow/engine/structured-output-schema-validator.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { managerOutputSchema } from '../features/manager/turnResponse.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import type { ManagerView } from '../features/manager/ManagerView.js';
import { runManager } from '../features/manager/runManager.js';
import { createConversationRuntime } from '../features/manager/conversationRuntime.js';
import { resolveManagerStartup } from '../features/manager/startupResolution.js';
import { ClaudeProvider } from '../infra/providers/claude.js';
import { CodexProvider } from '../infra/providers/codex.js';
import { OpenCodeProvider } from '../infra/providers/opencode.js';
import { selectOption } from '../shared/prompt/index.js';
vi.mock('../features/manager/startupResolution.js', async (original) => ({ ...await original<typeof import('../features/manager/startupResolution.js')>(), resolveManagerStartup: vi.fn() }));
vi.mock('../shared/prompt/index.js', async (original) => ({ ...await original<typeof import('../shared/prompt/index.js')>(), selectOption: vi.fn() }));
vi.mock('../infra/config/global/projectRegistry.js', () => ({ registerProject: vi.fn() }));
const doubles = vi.hoisted(() => ({ plan: vi.fn(), mcp: vi.fn(), mount: vi.fn(), preflight: vi.fn(),
  list: vi.fn(), codex: vi.fn(), execFile: vi.fn(), openCode: vi.fn(), claude: vi.fn(),
  construct: vi.fn(), connect: vi.fn(), close: vi.fn() }));
vi.mock('../features/manager/conversationIpcClient.js', () => ({ ConversationIpcClient: class {
  constructor(...args: unknown[]) { doubles.construct(...args); }
  connect = doubles.connect;
  close = doubles.close;
} }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execFile: doubles.execFile }));
vi.mock('../infra/opencode/index.js', () => ({ callOpenCode: doubles.openCode, callOpenCodeCustom: doubles.openCode, compactOpenCodeSession: vi.fn() }));
vi.mock('../infra/claude/client.js', () => ({ callClaude: doubles.claude, callClaudeCustom: doubles.claude }));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: doubles.plan }));
vi.mock('../features/manager/managerMcp.js', async (original) => ({
  ...await original<typeof import('../features/manager/managerMcp.js')>(), connectManagerMcp: doubles.mcp,
}));
vi.mock('../features/tui/inkMount.js', () => ({ mountInk: doubles.mount }));
vi.mock('../infra/codex/mcp-list.js', () => ({ runCodexMcpList: doubles.list, hasCodexMcpServer: vi.fn() }));
vi.mock('../infra/codex/skill-config.js', () => ({ buildCodexSkillConfig: vi.fn() }));
vi.mock('../infra/codex/cli-runtime.js', () => ({ resolveCodexSdkCli: () => ({ executablePath: '/test/codex', pathDirs: [] }) }));
vi.mock('@openai/codex-sdk', () => ({ Codex: doubles.codex }));
vi.mock('../infra/config/index.js', async (original) => ({
  ...await original<typeof import('../infra/config/index.js')>(), resolveOpenaiApiKey: () => undefined,
  resolveCodexCliPath: () => '/test/codex', resolveClaudeCliPath: () => '/test/claude',
}));

const assignment = { kind: 'repository' as const, repositoryDirectory: '/canonical/repository', repositoryDirectories: ['/canonical/repository'] };
const dispose = vi.fn(async () => {});
const runtimes: ReturnType<typeof createConversationRuntime>[] = [];
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  vi.mocked(resolveManagerStartup).mockReset().mockResolvedValue({ kind: 'ready', context: { cwd: assignment.repositoryDirectory, assignment } });
  vi.mocked(selectOption).mockReset().mockResolvedValue(null);
  doubles.preflight.mockReset().mockResolvedValue(undefined);
  doubles.list.mockReset().mockResolvedValue('[]');
  doubles.plan.mockReturnValue({ ctx: { lang: 'ja', providerType: 'mock', provider: makeProvider({ preflight: doubles.preflight }) }, strategy: { systemPrompt: 'manager fixture' } });
  doubles.mcp.mockResolvedValue({ client: {}, servers: {}, dispose });
  doubles.connect.mockReset().mockResolvedValue(undefined);
  doubles.mount.mockReset().mockImplementation(async (buildTree) => {
    const tree = buildTree({ settle: vi.fn(), fail: vi.fn() }) as ReactElement<ComponentProps<typeof ManagerView>>;
    expect(tree.props.client).toBeDefined();
    expect(tree.props.assignment).toBeDefined();
  });
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const [stream, descriptor] of [[process.stdin, stdinTTY], [process.stdout, stdoutTTY]] as const) {
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  }
});
function prepare() {
  const runtime = createConversationRuntime(process.env.TAKT_CONFIG_DIR!);
  runtimes.push(runtime);
  return runtime.resolve(assignment, new AbortController().signal);
}

describe('manager IPC startup and teardown', () => {
  it('guides an outside-repository startup with no workspaces', async () => {
    vi.mocked(resolveManagerStartup).mockResolvedValueOnce({ kind: 'selection', workspaces: [] });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runManager({ cwd: '/outside' });
    expect(output).toHaveBeenCalled();
    expect(selectOption).not.toHaveBeenCalled();
    expect(doubles.construct).not.toHaveBeenCalled();
  });
  it.each([true, false])('selects a workspace before connecting, cancelled=%s', async (cancelled) => {
    const workspace = { id: '550e8400-e29b-41d4-a716-446655440000', name: '開発', repositoryDirectories: ['/canonical/repository'] };
    const other = { id: '650e8400-e29b-41d4-a716-446655440001', name: '別の担当', repositoryDirectories: ['/other/repository', '/third/repository'] };
    vi.mocked(resolveManagerStartup).mockResolvedValueOnce({ kind: 'selection', workspaces: [workspace, other] });
    vi.mocked(selectOption).mockImplementationOnce(async () => {
      expect(doubles.construct).not.toHaveBeenCalled();
      return cancelled ? null : other.id;
    });
    await runManager({ cwd: process.cwd() });
    expect(selectOption).toHaveBeenCalledWith(expect.any(String), [
      { value: workspace.id, label: '開発 (1)' }, { value: other.id, label: '別の担当 (2)' },
    ]);
    if (cancelled) expect(doubles.construct).not.toHaveBeenCalled();
    else expect(doubles.construct).toHaveBeenCalledExactlyOnceWith({ kind: 'workspace', workspaceId: other.id }, undefined);
  });
  it('rejects a noninteractive terminal before connecting', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    await expect(runManager({ cwd: '/repository' })).rejects.toThrow('interactive terminal');
    expect(doubles.construct).not.toHaveBeenCalled();
  });
  it('passes CLI overrides and waits for the conversation connection before mounting', async () => {
    let finish!: () => void;
    doubles.connect.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const overrides = { provider: 'mock' as const, model: 'chosen-model' };
    const run = runManager({ cwd: '/repository', agentOverrides: overrides });
    await vi.waitFor(() => expect(doubles.connect).toHaveBeenCalledOnce());
    expect(doubles.construct).toHaveBeenCalledExactlyOnceWith({ kind: 'repository', repositoryDirectory: assignment.repositoryDirectory }, overrides);
    expect(doubles.mount).not.toHaveBeenCalled();
    finish(); await run;
    expect(doubles.mount).toHaveBeenCalledOnce();
    expect(doubles.close).toHaveBeenCalledOnce();
    expect(registerProject).toHaveBeenCalledWith({ globalConfigDirectory: process.env.TAKT_CONFIG_DIR,
      projectDirectory: assignment.repositoryDirectory, command: 'manager', managerUsed: true });
  });
  it.each(['connect', 'mount'] as const)('closes the attachment after a %s failure', async (phase) => {
    const failure = new Error('startup failed');
    doubles[phase].mockRejectedValueOnce(failure);
    await expect(runManager({ cwd: '/repository' })).rejects.toBe(failure);
    expect(doubles.close).toHaveBeenCalledOnce();
  });
});

describe('daemon manager runtime preparation', () => {
  it.each(['claude', 'claude-sdk', 'codex', 'opencode', 'mock', 'claude-headless', 'claude-terminal', 'cursor', 'copilot', 'kiro', 'pi', 'deepseek-harness'] as const)('exposes goal execution only with a %s permission judge', async (providerType) => {
    const usesJudge = providerType === 'claude' || providerType === 'claude-sdk' || providerType === 'codex';
    doubles.plan.mockReturnValueOnce({
      ctx: { lang: 'ja', providerType, provider: makeProvider({ preflight: doubles.preflight }) },
      strategy: { systemPrompt: 'manager fixture' },
      ...(usesJudge ? { permissionJudge: { language: 'ja', systemPrompt: 'judge fixture', managerPersona: 'manager fixture',
        managerPolicy: 'policy fixture', resolution: { provider: providerType, model: undefined, providerOptions: {} } } } : {}),
    });
    await prepare();
    expect(doubles.mcp.mock.calls[0]?.[3]?.enableGoalExecutionTools === true).toBe(usesJudge);
  });
  it('preflights Codex with a strict conversation schema', async () => {
    doubles.plan.mockReturnValueOnce({ ctx: { lang: 'ja', providerType: 'codex', provider: makeProvider({ preflight: doubles.preflight }) }, strategy: { systemPrompt: 'fixture' } });
    doubles.preflight.mockImplementationOnce(async ({ outputSchema }) => {
      assertStrictStructuredOutputSchema(outputSchema);
      validateStructuredOutputAgainstSchema({ message: '確認', summary: {
        objective: 'CSV出力', outOfScope: [], acceptanceCriteria: ['CSV取得'], repositoryDirectory: null,
        startBranch: null, integrationBranch: null, constraints: [],
      } }, outputSchema);
    });
    await prepare();
    expect(doubles.preflight).toHaveBeenCalledOnce();
  });
  it.each(['claude', 'claude-sdk'] as const)('preserves the conversation schema for %s preflight', async (providerType) => {
    doubles.plan.mockReturnValueOnce({ ctx: { lang: 'ja', providerType, provider: makeProvider({ preflight: doubles.preflight }) }, strategy: { systemPrompt: 'fixture' } });
    await prepare();
    expect(doubles.preflight.mock.calls[0]![0].outputSchema).toEqual(managerOutputSchema);
  });
  it('waits for preflight with the prepared MCP servers and disposes them on completion', async () => {
    let finish!: () => void;
    doubles.preflight.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const servers = { browser: { command: '/browser-mcp' } };
    doubles.mcp.mockResolvedValueOnce({ servers, dispose });
    let prepared = false;
    const pending = prepare().then(() => { prepared = true; });
    await vi.waitFor(() => expect(doubles.preflight).toHaveBeenCalledOnce());
    expect(prepared).toBe(false);
    expect(doubles.preflight.mock.calls[0]![0]).toMatchObject({ cwd: assignment.repositoryDirectory,
      permissionMode: 'full', mcpServers: servers, outputSchema: managerOutputSchema });
    finish(); await pending;
    await runtimes[0]!.close();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('prepares Codex without an MCP isolation probe', async () => {
    const userServers = { browser: { command: '/browser-mcp' } };
    const servers = { ...userServers, [TAKT_MANAGER_MCP_SERVER_NAME]: { command: 'node', args: ['manager.js'] } };
    const providerOptions = { codex: { fastMode: true, networkAccess: true } };
    doubles.plan.mockReturnValueOnce({ ctx: { lang: 'ja', providerType: 'codex', provider: new CodexProvider(),
      model: 'chosen-model', providerOptions, mcpServers: userServers }, strategy: { systemPrompt: 'fixture' } });
    doubles.mcp.mockResolvedValueOnce({ servers, dispose });
    await prepare();
    expect(doubles.mcp.mock.calls[0]?.slice(0, 3)).toEqual([assignment.repositoryDirectory, expect.objectContaining({ kind: 'repository' }), userServers]);
    expect(doubles.list).not.toHaveBeenCalled();
    expect(doubles.codex).not.toHaveBeenCalled();
  });
  it.each(['missing CLI', 'wrong version', 'success'] as const)('prepares the selected OpenCode CLI: %s', async (outcome) => {
    vi.stubEnv('TAKT_OPENCODE_VERSION', 'v2'); vi.stubEnv('TAKT_OPENCODE_PATH', '/test/opencode');
    doubles.execFile.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(outcome === 'missing CLI' ? new Error('ENOENT') : null, outcome === 'wrong version' ? '1.18.2' : 'opencode v2.0.18', '');
    });
    doubles.plan.mockReturnValueOnce({ ctx: { lang: 'ja', providerType: 'opencode', provider: new OpenCodeProvider(), model: 'probe/probe' }, strategy: { systemPrompt: 'fixture' } });
    if (outcome === 'success') await prepare();
    else await expect(prepare()).rejects.toThrow();
    expect(doubles.execFile).toHaveBeenCalledWith('/test/opencode', ['--version'], expect.objectContaining({ timeout: 10_000 }), expect.any(Function));
    expect(doubles.openCode).not.toHaveBeenCalled();
  });
  it.each(['missing CLI', 'unsupported constraints', 'success'] as const)('checks the Claude runtime: %s', async (outcome) => {
    doubles.execFile.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(outcome === 'missing CLI' ? new Error('ENOENT') : null, outcome === 'unsupported constraints' ? '--tools' : '--tools --strict-mcp-config --json-schema', '');
    });
    doubles.plan.mockReturnValueOnce({ ctx: { lang: 'ja', providerType: 'claude', provider: new ClaudeProvider() }, strategy: { systemPrompt: 'fixture' } });
    if (outcome === 'success') await prepare();
    else await expect(prepare()).rejects.toThrow();
    expect(doubles.execFile).toHaveBeenCalledWith('/test/claude', ['--help'], expect.objectContaining({ cwd: assignment.repositoryDirectory, timeout: 5_000 }), expect.any(Function));
    expect(doubles.claude).not.toHaveBeenCalled();
  });
  it.each([CodexProvider, OpenCodeProvider, ClaudeProvider])('cancels a pending runtime probe through %s', async (ProviderClass) => {
    const controller = new AbortController();
    doubles.list.mockImplementationOnce(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      expect(abortSignal).toBe(controller.signal);
      return new Promise<string>((_resolve, reject) => { abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true }); });
    });
    doubles.execFile.mockImplementationOnce((_command, _args, options, callback) => {
      expect(options.signal).toBe(controller.signal);
      options.signal.addEventListener('abort', () => callback(controller.signal.reason, '', ''), { once: true });
    });
    const pending = new ProviderClass().preflight({ cwd: '/repository', model: 'probe/probe', permissionMode: 'readonly',
      mcpOnlySideEffects: ['Read'], abortSignal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(doubles.list.mock.calls.length + doubles.execFile.mock.calls.length).toBe(1));
    controller.abort(); await rejected;
    expect(doubles.codex).not.toHaveBeenCalled(); expect(doubles.openCode).not.toHaveBeenCalled(); expect(doubles.claude).not.toHaveBeenCalled();
  });
});
