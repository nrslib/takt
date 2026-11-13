import { afterEach, expect, it, vi } from 'vitest';
import { RemoteExecutionInputSchema, remoteRuntimeConfiguration, withRemoteExecutionConfig } from '../features/workerPool/remoteExecutionInput.js';
import { resolveConfigValue } from '../infra/config/resolveConfigValue.js';
import { loadGlobalConfig } from '../infra/config/global/globalConfigCore.js';
import { getProjectConfigSnapshot, withConfigSnapshot } from '../infra/config/configSnapshot.js';
import type { Provider } from '../infra/providers/types.js';
import { applyRemoteOpenCodeEnvironment } from '../features/workerPool/remoteExecutionEnvironment.js';
import { openCodeRuntimeSelection } from '../infra/opencode/runtime.js';
import { resolveOpenCodeGuardPolicy } from '../infra/opencode/guards/policy.js';
import { resolveOpenCodeStreamLimits } from '../infra/opencode/OpenCodeStreamHandler.js';

const launches = vi.hoisted(() => ({ codex: vi.fn(), claude: vi.fn(), headless: vi.fn(), terminal: vi.fn(),
  cursor: vi.fn(), copilot: vi.fn(), kiro: vi.fn(), devin: vi.fn(), session: vi.fn() }));
vi.mock('../infra/codex/index.js', async (original) => ({ ...await original<typeof import('../infra/codex/index.js')>(), callCodex: launches.codex }));
vi.mock('../infra/claude/client.js', async (original) => ({ ...await original<typeof import('../infra/claude/client.js')>(), callClaude: launches.claude }));
vi.mock('../infra/claude-headless/client.js', async (original) => ({ ...await original<typeof import('../infra/claude-headless/client.js')>(), callClaudeHeadless: launches.headless }));
vi.mock('../infra/claude-terminal/client.js', async (original) => ({ ...await original<typeof import('../infra/claude-terminal/client.js')>(), callClaudeTerminal: launches.terminal }));
vi.mock('../infra/cursor/index.js', async (original) => ({ ...await original<typeof import('../infra/cursor/index.js')>(), callCursor: launches.cursor }));
vi.mock('../infra/copilot/index.js', async (original) => ({ ...await original<typeof import('../infra/copilot/index.js')>(), callCopilot: launches.copilot }));
vi.mock('../infra/kiro/index.js', async (original) => ({ ...await original<typeof import('../infra/kiro/index.js')>(), callKiro: launches.kiro }));
vi.mock('../infra/devin/index.js', async (original) => ({ ...await original<typeof import('../infra/devin/index.js')>(), callDevin: launches.devin }));
vi.mock('../infra/kiro/process.js', async (original) => ({ ...await original<typeof import('../infra/kiro/process.js')>(), execKiro: launches.session }));
vi.mock('../infra/config/global/cliPathValidator.js', () => ({ validateCliPath: (path: string) => path }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

vi.mock('../infra/config/index.js', async (original) => ({ ...await original<typeof import('../infra/config/index.js')>(),
  loadGlobalConfig: () => ({ language: 'ja', provider: 'mock', model: 'worker-model', openaiApiKey: 'worker-authentication' }),
}));

function input() {
  return RemoteExecutionInputSchema.parse({ version: 1, runSlug: 'remote-run', task: 'Execute the transferred task',
    taskConfig: { workflow: 'transferred' }, hasTaskSpec: false, openCode: {},
    project: { provider: 'mock', model: 'daemon-project-model', language: 'en' },
    global: { provider: 'mock', model: 'daemon-global-model', language: 'en' },
    projectTrace: { provider: { origin: 'local', fileValue: 'mock', fileOrigin: 'local' },
      model: { origin: 'local', fileValue: 'daemon-project-model', fileOrigin: 'local' } },
    globalTrace: { provider: { origin: 'global', fileValue: 'mock', fileOrigin: 'global' } },
    runtime: { runtimeFile: { version: 1 }, profileOrigins: [['agent', 'project']], assignmentOrigins: { defaults: '/daemon/runtime.yaml' } },
  });
}

it('uses the daemon configuration and preserves worker authentication inside the execution scope', () => {
  withRemoteExecutionConfig(input(), '/worker/control', '/worker/clone', () => {
    expect(resolveConfigValue('/worker/control', 'model')).toBe('daemon-project-model');
    expect(resolveConfigValue('/worker/control', 'language')).toBe('en');
    expect(resolveConfigValue('/worker/clone', 'model')).toBe('daemon-project-model');
    expect(getProjectConfigSnapshot('/worker/unrelated')).toBeUndefined();
    expect(loadGlobalConfig().model).toBe('daemon-global-model');
    expect(loadGlobalConfig().openaiApiKey).toBe('worker-authentication');
  });
});

it('keeps an ordinary snapshot restricted to its original project directory', () => {
  withRemoteExecutionConfig(input(), '/worker/control', '/worker/clone', () => {
    const snapshot = getProjectConfigSnapshot('/worker/control')!;
    withConfigSnapshot({ ...snapshot, additionalProjectDirs: undefined }, () => {
      expect(getProjectConfigSnapshot('/worker/control')).toBeDefined();
      expect(getProjectConfigSnapshot('/worker/clone')).toBeUndefined();
    });
  });
});

it('keeps runtime profile origins and fixes all runtime lookups to the supplied configuration', async () => {
  const invocation = await import('../infra/config/runtime-provider/invocation.js');
  const configuration = remoteRuntimeConfiguration(input());
  expect(configuration.profileOrigins.get('agent')).toBe('project');
  expect(configuration.assignmentOrigins).toEqual({ defaults: '/daemon/runtime.yaml' });
  invocation.setExecutionRuntimeProviderConfiguration(configuration);
  const resolved = invocation.resolveInvocationRuntimeProviderFileWithOrigins({ globalConfigDir: '/unreadable-worker-global', projectConfigDir: '/unreadable-worker-project' });
  expect(resolved).toEqual(configuration);
  expect(resolved).not.toBe(configuration);
});

it('rejects input with an unsupported version or a malformed execution configuration', () => {
  expect(RemoteExecutionInputSchema.safeParse({ ...input(), version: 2 }).success).toBe(false);
  expect(RemoteExecutionInputSchema.safeParse({ ...input(), taskConfig: { workflow: 'transferred', unexpected: true } }).success).toBe(false);
  expect(RemoteExecutionInputSchema.safeParse({ ...input(), project: [] }).success).toBe(false);
  const { openCode: _openCode, ...missingOpenCode } = input();
  expect(RemoteExecutionInputSchema.safeParse(missingOpenCode).success).toBe(false);
});

const guardPolicy = () => resolveOpenCodeGuardPolicy({ eventLimit: 2, textByteLimit: 16, reasoningByteLimit: 32 }, 'minimal');
const openCodeEnvironmentCases = [
  { field: 'path', variable: 'TAKT_OPENCODE_PATH', value: '/daemon/opencode', worker: '/worker/opencode', expected: '/daemon/opencode', read: () => openCodeRuntimeSelection().command },
  { field: 'version', variable: 'TAKT_OPENCODE_VERSION', value: 'v2', worker: 'v1', expected: 'v2', read: () => openCodeRuntimeSelection().generation },
  { field: 'callTimeoutMs', variable: 'TAKT_OPENCODE_CALL_TIMEOUT_MS', value: '60000', worker: '120000', expected: 60000, read: () => guardPolicy().callTimeoutMs },
  { field: 'messageCycleBudget', variable: 'TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET', value: '7', worker: '8', expected: 7, read: () => guardPolicy().messageCycleBudget },
  { field: 'eventLimit', variable: 'TAKT_OPENCODE_STREAM_EVENT_LIMIT', value: '3', worker: '100', expected: 3, read: () => guardPolicy().streamEventLimit },
  { field: 'textByteLimit', variable: 'TAKT_OPENCODE_STREAM_TEXT_BYTE_LIMIT', value: '64', worker: '128', expected: 64, read: () => guardPolicy().streamLimits.textByteLimit },
  { field: 'reasoningByteLimit', variable: 'TAKT_OPENCODE_STREAM_REASONING_BYTE_LIMIT', value: '128', worker: '256', expected: 128, read: () => guardPolicy().streamLimits.reasoningByteLimit },
  { field: 'idLimit', variable: 'TAKT_OPENCODE_STREAM_ID_LIMIT', value: '9', worker: '10', expected: 9, read: () => guardPolicy().streamLimits.idLimit },
  { field: 'toolErrorWindow', variable: 'TAKT_OPENCODE_TOOL_ERROR_WINDOW', value: '4', worker: '5', expected: 4, read: () => guardPolicy().toolGuard.recentWindow },
  { field: 'toolErrorWindowRate', variable: 'TAKT_OPENCODE_TOOL_ERROR_WINDOW_RATE', value: '50', worker: '90', expected: 50, read: () => guardPolicy().toolGuard.recentWindowErrorRatePercent },
  { field: 'toolErrorConsecutive', variable: 'TAKT_OPENCODE_TOOL_ERROR_CONSECUTIVE', value: '2', worker: '3', expected: 2, read: () => guardPolicy().toolGuard.consecutiveErrors },
  { field: 'editConflictRepeats', variable: 'TAKT_OPENCODE_EDIT_CONFLICT_REPEATS', value: '3', worker: '4', expected: 3, read: () => guardPolicy().toolGuard.editConflictRepeats },
  { field: 'editCorrectionLimit', variable: 'TAKT_OPENCODE_EDIT_CORRECTION_LIMIT', value: '1', worker: '2', expected: 1, read: () => guardPolicy().toolGuard.editCorrectionLimit },
] as const;

function useOpenCodeEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const { variable } of openCodeEnvironmentCases) vi.stubEnv(variable, environment[variable]);
}

it.each(openCodeEnvironmentCases)('uses the daemon $field and removes the worker override when unspecified', (entry) => {
  useOpenCodeEnvironment({});
  const fallback = entry.read();
  const worker = { [entry.variable]: entry.worker, HOME: '/worker', PATH: '/worker/bin',
    TAKT_OPENCODE_API_KEY: 'worker-opencode-auth', OPENAI_API_KEY: 'worker-provider-auth', GIT_ASKPASS: '/worker-git-auth', MCP_WORKER_AUTH: 'worker-mcp-auth' };
  const configuration = input();
  const specified = RemoteExecutionInputSchema.parse({ ...configuration, openCode: { [entry.field]: entry.value } });
  const first = applyRemoteOpenCodeEnvironment(worker, specified.openCode);
  useOpenCodeEnvironment(first);
  expect(entry.read()).toBe(entry.expected);
  expect(first).toMatchObject({ HOME: worker.HOME, PATH: worker.PATH, TAKT_OPENCODE_API_KEY: worker.TAKT_OPENCODE_API_KEY,
    OPENAI_API_KEY: worker.OPENAI_API_KEY, GIT_ASKPASS: worker.GIT_ASKPASS, MCP_WORKER_AUTH: worker.MCP_WORKER_AUTH });
  const next = applyRemoteOpenCodeEnvironment(worker, configuration.openCode);
  useOpenCodeEnvironment(next);
  expect(next).not.toHaveProperty(entry.variable);
  expect(entry.read()).toBe(fallback);
  expect(first[entry.variable]).toBe(entry.value);
  expect(worker[entry.variable]).toBe(entry.worker);
});

it.each(['0', '1.5', '-5', 'abc'])('preserves event limit fallback for daemon value %s without using the worker value', (eventLimit) => {
  useOpenCodeEnvironment(applyRemoteOpenCodeEnvironment({ TAKT_OPENCODE_STREAM_EVENT_LIMIT: '100' }, { eventLimit }));
  expect(guardPolicy().streamEventLimit).toBe(2);
});

it('preserves stream limit rounding and call timeout rejection in the existing consumers', () => {
  useOpenCodeEnvironment(applyRemoteOpenCodeEnvironment({}, { textByteLimit: '1.5', callTimeoutMs: 'abc' }));
  expect(resolveOpenCodeStreamLimits().textByteLimit).toBe(1);
  expect(() => guardPolicy()).toThrow();
});

it.each(['/daemon-cli-A', '/daemon-cli-C'])('passes the daemon CLI paths to every provider launch and Kiro session check: %s', async (path) => {
  const configuration = input();
  Object.assign(configuration.global, { codexCliPath: path, claudeCliPath: path, cursorCliPath: path,
    copilotCliPath: path, kiroCliPath: path, devinCliPath: path });
  const providers: [Provider, keyof typeof launches, string][] = [
    [new (await import('../infra/providers/codex.js')).CodexProvider(), 'codex', 'codexPathOverride'],
    [new (await import('../infra/providers/claude.js')).ClaudeProvider(), 'claude', 'pathToClaudeCodeExecutable'],
    [new (await import('../infra/providers/claude-headless.js')).ClaudeHeadlessProvider(), 'headless', 'claudeCliPath'],
    [new (await import('../infra/providers/claude-terminal.js')).ClaudeTerminalProvider(), 'terminal', 'pathToClaudeCodeExecutable'],
    [new (await import('../infra/providers/cursor.js')).CursorProvider(), 'cursor', 'cursorCliPath'],
    [new (await import('../infra/providers/copilot.js')).CopilotProvider(), 'copilot', 'copilotCliPath'],
    [new (await import('../infra/providers/kiro.js')).KiroProvider(), 'kiro', 'kiroCliPath'],
    [new (await import('../infra/providers/devin.js')).DevinProvider(), 'devin', 'devinCliPath'],
  ];
  await withRemoteExecutionConfig(configuration, '/worker/control', '/worker/clone', async () => {
    for (const [provider, launch, option] of providers) {
      launches[launch].mockResolvedValue({ persona: 'agent', status: 'done', content: 'done', timestamp: new Date() });
      await provider.setup({ name: 'agent' }).call('work', { cwd: '/worker/clone' });
      expect(launches[launch]).toHaveBeenCalledWith('agent', 'work', expect.objectContaining({ [option]: path }));
    }
    launches.session.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    await (await import('../infra/kiro/sessionExistence.js')).kiroSessionExists('/worker/clone', '12345678-1234-1234-1234-123456789abc');
    expect(launches.session).toHaveBeenCalledWith(['chat', '--list-sessions'], expect.objectContaining({ kiroCliPath: path }));
  });
});
