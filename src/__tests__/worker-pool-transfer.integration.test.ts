import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RemoteExecutionStore, remoteExecutionDirectory, remoteFilePath } from '../infra/task/remoteExecutionStore.js';
import { RemoteExecutionControls } from '../infra/task/remoteExecutionControls.js';
import { RemoteControlReceiver } from '../infra/task/remoteControlReceiver.js';
import { RemoteRunSender } from '../features/workerPool/remoteRunSender.js';
import type { RemoteControl, RemoteRecord } from '../core/worker-pool/remoteExecutionProtocol.js';
import type { RemoteExecutionPort } from '../features/workerPool/remoteWorker.js';
import { prepareRemoteExecutionInput, remoteRuntimeConfiguration } from '../features/workerPool/remoteExecutionInput.js';
import { RemoteExecutionInputSchema } from '../features/workerPool/remoteExecutionInput.js';
import { portableRemoteConfiguration } from '../features/workerPool/remoteMcpConfiguration.js';
import { interpolateMcpEnv } from '../infra/config/runtime-provider/mcp-schema.js';
import { getMcpHeaderEnvRefs } from '../infra/config/runtime-provider/mcp-header-env.js';
import type { McpServerConfig } from '../core/models/workflow-provider-options.js';
import { resolveMcpAssignment } from '../infra/config/runtime-provider/mcp-assignment.js';
import { createCodexMcpAdapter } from '../infra/providers/mcp/codex.js';
import { createOpenCodeMcpAdapter } from '../infra/providers/mcp/opencode.js';
import { createRemoteTaskExecutor } from '../features/workerPool/remoteTaskExecutor.js';
import { getGlobalConfigDir, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { TaskRecordSchema } from '../infra/task/schema.js';
import { RemoteAssignmentSchema, executionIdentity } from '../core/worker-pool/remoteProtocol.js';
import { RemoteTaskLifecycle } from '../infra/task/remoteTaskLifecycle.js';
import { TaskStore } from '../infra/task/store.js';
import { LiveInterventionFileStore } from '../infra/workflow/live-intervention-store.js';
import * as spawn from '../shared/utils/spawn.js';
import { setExecutionSecrets } from '../shared/utils/execution-secrets.js';
import { StepExecutor, type StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { writeReportFile } from '../core/workflow/report-writer.js';

const directories: string[] = [];
afterEach(() => {
  setExecutionSecrets([]);
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  invalidateGlobalConfigCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('redacts distributed credentials before saving both previous-response snapshots', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'remote-snapshots-')); directories.push(cwd);
  const paths = buildRunPaths(cwd, 'remote-snapshot');
  mkdirSync(paths.contextPreviousResponsesAbs, { recursive: true });
  setExecutionSecrets(['fake-snapshot-credential']);
  const executor = new StepExecutor({ getCwd: () => cwd, getReportDir: () => paths.reportsAbs,
    getRunPaths: () => paths } as unknown as StepExecutorDeps);
  const state = createInitialState({ name: 'test', initialStep: 'work', maxSteps: 1, steps: [] }, { projectCwd: cwd });
  executor.persistPreviousResponseSnapshot(state, 'work', 1, 'output fake-snapshot-credential');
  expect(readFileSync(state.previousResponseSourcePath!, 'utf8')).toBe('output [REDACTED]');
  expect(readFileSync(join(paths.contextPreviousResponsesAbs, 'latest.md'), 'utf8')).toBe('output [REDACTED]');
});

it('redacts distributed values in reports and their archived history before transfer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'remote-reports-')); directories.push(directory);
  setExecutionSecrets(['fake-report-distributed-value']);
  writeReportFile(directory, 'auth.md', 'first fake-report-distributed-value');
  writeReportFile(directory, 'auth.md', 'second fake-report-distributed-value');
  expect(readFileSync(join(directory, 'auth.md'), 'utf8')).toBe('second [REDACTED]');
  const files = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]);
  const history = files(directory).filter((path) => path !== join(directory, 'auth.md'));
  expect(history.map((path) => readFileSync(path, 'utf8'))).toContain('first [REDACTED]');
  expect(files(directory).some((path) => readFileSync(path, 'utf8').includes('fake-report-distributed-value'))).toBe(false);
});

it.each([
  { command: 'mcp', args: ['--token', 'literal-token', '--mode', 'safe'] },
  { command: 'mcp', args: ['--token=literal-token'] },
  { command: 'mcp', args: ['--pass-phrase', 'literal-token'] },
  { type: 'http', url: 'https://user:literal-token@example.test/mcp' },
  { type: 'sse', url: 'https://example.test/mcp?access_token=literal-token' },
  { type: 'http', url: 'https://example.test/mcp?token=literal-token${MCP_TOKEN}' },
  { type: 'http', url: 'https://example.test/mcp#token=literal-token' },
  { type: 'http', url: 'https://example.test/mcp#section?token=literal-secret' },
  { type: 'http', url: 'https://example.test/mcp#section?token=safe' },
  { type: 'http', url: 'https://example.test/mcp#section?token=literal-token${MCP_TOKEN}' },
  { command: 'mcp', env: { API_TOKEN: 'literal-token' } },
  { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer literal-token' } },
  { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Token literal-token' } },
  { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: '${MCP_SCHEME} literal-token' } },
  { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Token ${env:MCP_ACCESS}literal-token' } },
  { type: 'http', url: 'https://example.test/mcp', headers: { 'X-Api-Key': 'hidden-key ${env:MCP_ACCESS}' } },
  { type: 'http', url: 'https://example.test/mcp', headers: { 'x-aPi-kEy': 'Token ${env:MCP_ACCESS}' } },
  { type: 'http', url: 'https://example.test/mcp', headers: { 'X-Key': 'literal-token ${env:MCP_ACCESS}' } },
  { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'literal-token:${env:MCP_ACCESS}' } },
  { type: 'http', url: 'https://example.test/mcp', headers: { 'X-Key': '${env:MCP_ACCESS}:literal-token' } },
])('rejects fixed MCP credentials before creating input files: %j', async (server) => {
  const f = fixture();
  rmSync(join(f.directory, 'input-manifest.json'));
  mkdirSync(join(f.cwd, '.takt/workflows'), { recursive: true });
  writeFileSync(join(getGlobalConfigDir(), 'config.yaml'), 'provider: mock\n');
  writeFileSync(join(f.cwd, '.takt/workflows/root.yaml'), 'name: root\nsteps:\n  - name: work\n    instruction: Work\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
  writeFileSync(join(f.cwd, '.takt/runtime.yaml'), JSON.stringify({ version: 1, mcp: { servers: { test: server } } }));
  invalidateGlobalConfigCache();
  let diagnostic = '';
  try {
    prepareRemoteExecutionInput(f.cwd, TaskRecordSchema.parse({ name: 'T', status: 'pending', content: 'work',
      workflow: 'root', created_at: new Date().toISOString(), started_at: null, completed_at: null }), f.executionId);
  } catch (error) { diagnostic = String(error); }
  expect(diagnostic).toMatch(/MCP/);
  expect(diagnostic).not.toContain('literal-token');
  expect(diagnostic).not.toContain('literal-secret');
  expect(diagnostic).not.toContain('hidden-key');
  expect(diagnostic).not.toContain('Token');
  expect(existsSync(join(f.directory, 'input'))).toBe(false);
  expect(existsSync(join(f.directory, 'input-manifest.json'))).toBe(false);
  await expect(f.store.inputManifest()).rejects.toThrow();
  await expect(f.store.inputChunk('execution.json', 0)).rejects.toThrow();
});

it('transfers unexpanded MCP references and resolves only worker credentials, including header reference metadata', async () => {
  const f = fixture();
  mkdirSync(join(f.cwd, '.takt/workflows'), { recursive: true });
  writeFileSync(join(getGlobalConfigDir(), 'config.yaml'), 'provider: mock\n');
  writeFileSync(join(f.cwd, '.takt/workflows/root.yaml'), 'name: root\nsteps:\n  - name: work\n    instruction: Work\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
  const servers = {
    stdio: { command: 'mcp', args: ['--token', '${MCP_TOKEN}', '--token=${MCP_TOKEN}', '--pass-phrase=${MCP_TOKEN}', '--mode', 'safe'], env: { API_TOKEN: '${MCP_TOKEN}', MODE: 'safe' } },
    http: { type: 'http', url: 'https://example.test/${MCP_TOKEN}', headers: { Authorization: 'Bearer ${env:DD_ACCESS_TOKEN}', 'X-Api-Key': '${MCP_TOKEN}' } },
    sse: { type: 'sse', url: 'https://example.test/mcp', headers: { Authorization: '${env:DD_ACCESS_TOKEN}' } },
    authenticatedUrl: { type: 'http', url: 'https://${MCP_USER}:${MCP_TOKEN}@example.test/mcp?api_key=${MCP_TOKEN}&mode=safe' },
    endpoint: { type: 'http', url: '${MCP_ENDPOINT}/mcp' },
    port: { type: 'http', url: 'https://example.test:${MCP_PORT}/mcp' },
    fragmentReference: { type: 'http', url: 'https://example.test/mcp#section?token=${MCP_TOKEN}' },
    fragmentSection: { type: 'http', url: 'https://example.test/mcp#section' },
    fragmentMode: { type: 'http', url: 'https://example.test/mcp#section?mode=safe' },
  };
  vi.stubEnv('MCP_TOKEN', 'daemon-secret'); vi.stubEnv('DD_ACCESS_TOKEN', 'daemon-header-secret');
  writeFileSync(join(f.cwd, '.takt/runtime.yaml'), JSON.stringify({ version: 1, mcp: { servers } }));
  invalidateGlobalConfigCache();
  prepareRemoteExecutionInput(f.cwd, TaskRecordSchema.parse({ name: 'T', status: 'pending', content: 'work', workflow: 'root',
    created_at: new Date().toISOString(), started_at: null, completed_at: null }), f.executionId);
  const chunk = Buffer.from(await f.store.inputChunk('execution.json', 0), 'base64').toString();
  expect(chunk).not.toContain('daemon-secret'); expect(chunk).not.toContain('daemon-header-secret');
  const input = RemoteExecutionInputSchema.parse(JSON.parse(chunk));
  const transferred = remoteRuntimeConfiguration(input).runtimeFile!.mcp!.servers!;
  expect(transferred).toEqual(servers);
  const workerEnv = { MCP_TOKEN: 'worker-token', DD_ACCESS_TOKEN: 'worker-header-token', MCP_USER: 'worker-user',
    MCP_ENDPOINT: 'https://worker.example.test', MCP_PORT: '8443' };
  expect(interpolateMcpEnv(transferred.stdio!, workerEnv)).toMatchObject({ args: ['--token', 'worker-token', '--token=worker-token', '--pass-phrase=worker-token', '--mode', 'safe'], env: { API_TOKEN: 'worker-token', MODE: 'safe' } });
  const http = interpolateMcpEnv(transferred.http!, workerEnv);
  expect(http).toMatchObject({ url: 'https://example.test/worker-token', headers: { 'X-Api-Key': 'worker-token' } });
  expect(getMcpHeaderEnvRefs(http).Authorization).toEqual(['Bearer ', { env: 'DD_ACCESS_TOKEN' }, '']);
  expect(getMcpHeaderEnvRefs(interpolateMcpEnv(transferred.sse!, workerEnv)).Authorization).toEqual(['', { env: 'DD_ACCESS_TOKEN' }, '']);
  expect(interpolateMcpEnv(transferred.authenticatedUrl!, workerEnv)).toMatchObject({ url: 'https://worker-user:worker-token@example.test/mcp?api_key=worker-token&mode=safe' });
  expect(interpolateMcpEnv(transferred.endpoint!, workerEnv)).toMatchObject({ url: 'https://worker.example.test/mcp' });
  expect(interpolateMcpEnv(transferred.port!, workerEnv)).toMatchObject({ url: 'https://example.test:8443/mcp' });
  expect(interpolateMcpEnv(transferred.fragmentReference!, workerEnv)).toMatchObject({ url: 'https://example.test/mcp#section?token=worker-token' });
  expect(() => interpolateMcpEnv(transferred.fragmentReference!, {})).toThrow(/undefined environment variable "MCP_TOKEN"/);
  expect(() => interpolateMcpEnv(transferred.http!, { MCP_TOKEN: 'worker-token' })).toThrow(/undefined environment variable "DD_ACCESS_TOKEN"/);
  expect(() => interpolateMcpEnv(transferred.stdio!, {})).toThrow(/undefined environment variable "MCP_TOKEN"/);
  vi.stubEnv('MCP_TOKEN', workerEnv.MCP_TOKEN); vi.stubEnv('DD_ACCESS_TOKEN', workerEnv.DD_ACCESS_TOKEN);
  const context = { persona: undefined, tags: [], stepQualifiedName: 'root/work', isWorkflowCallNode: false, isInternalAgent: false };
  const assignment = { servers: transferred, defaults: { servers: ['stdio', 'http'] } };
  const resolved = resolveMcpAssignment(assignment, context);
  const prepared = await createCodexMcpAdapter().prepare(resolved, { cwd: f.cwd, childProcessEnv: workerEnv });
  expect(prepared.config).toMatchObject({ mcp_servers: { http: { bearer_token_env_var: 'DD_ACCESS_TOKEN',
    url: 'https://example.test/worker-token', http_headers: { 'X-Api-Key': 'worker-token' } } } });
  await prepared.dispose();
  vi.stubEnv('DD_ACCESS_TOKEN', undefined);
  expect(() => resolveMcpAssignment(assignment, context)).toThrow(/undefined environment variable "DD_ACCESS_TOKEN"/);
});

it.each([{}, { path: '/daemon/opencode', version: 'v2' }])('transfers daemon OpenCode selection without probing the CLI: %j', async (openCode) => {
  const f = fixture();
  mkdirSync(join(f.cwd, '.takt/workflows'), { recursive: true });
  writeFileSync(join(getGlobalConfigDir(), 'config.yaml'), 'provider: mock\n');
  writeFileSync(join(f.cwd, '.takt/workflows/root.yaml'), 'name: root\nsteps:\n  - name: work\n    instruction: Work\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
  vi.stubEnv('TAKT_OPENCODE_PATH', 'path' in openCode ? openCode.path : undefined);
  vi.stubEnv('TAKT_OPENCODE_VERSION', 'version' in openCode ? openCode.version : undefined);
  invalidateGlobalConfigCache();
  prepareRemoteExecutionInput(f.cwd, TaskRecordSchema.parse({ name: 'T', status: 'pending', content: 'work', workflow: 'root',
    created_at: new Date().toISOString(), started_at: null, completed_at: null }), f.executionId);
  const input = RemoteExecutionInputSchema.parse(JSON.parse(Buffer.from(await f.store.inputChunk('execution.json', 0), 'base64').toString()));
  expect(input).toMatchObject({ openCode });
});

const executionLimitCases = [
  ['callTimeoutMs', 'TAKT_OPENCODE_CALL_TIMEOUT_MS', '60000'],
  ['messageCycleBudget', 'TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET', '7'],
  ['eventLimit', 'TAKT_OPENCODE_STREAM_EVENT_LIMIT', '3'],
  ['textByteLimit', 'TAKT_OPENCODE_STREAM_TEXT_BYTE_LIMIT', '64'],
  ['reasoningByteLimit', 'TAKT_OPENCODE_STREAM_REASONING_BYTE_LIMIT', '128'],
  ['idLimit', 'TAKT_OPENCODE_STREAM_ID_LIMIT', '9'],
  ['toolErrorWindow', 'TAKT_OPENCODE_TOOL_ERROR_WINDOW', '4'],
  ['toolErrorWindowRate', 'TAKT_OPENCODE_TOOL_ERROR_WINDOW_RATE', '50'],
  ['toolErrorConsecutive', 'TAKT_OPENCODE_TOOL_ERROR_CONSECUTIVE', '2'],
  ['editConflictRepeats', 'TAKT_OPENCODE_EDIT_CONFLICT_REPEATS', '3'],
  ['editCorrectionLimit', 'TAKT_OPENCODE_EDIT_CORRECTION_LIMIT', '1'],
] as const;

it.each(executionLimitCases.flatMap(([field, variable, value]) => [
  { field, variable, value }, { field, variable, value: undefined },
]))('transfers daemon OpenCode execution setting $field=$value', async ({ field, variable, value }) => {
  const f = fixture();
  mkdirSync(join(f.cwd, '.takt/workflows'), { recursive: true });
  writeFileSync(join(getGlobalConfigDir(), 'config.yaml'), 'provider: mock\n');
  writeFileSync(join(f.cwd, '.takt/workflows/root.yaml'), 'name: root\nsteps:\n  - name: work\n    instruction: Work\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
  vi.stubEnv(variable, value);
  invalidateGlobalConfigCache();
  prepareRemoteExecutionInput(f.cwd, TaskRecordSchema.parse({ name: 'T', status: 'pending', content: 'work', workflow: 'root',
    created_at: new Date().toISOString(), started_at: null, completed_at: null }), f.executionId);
  const input = RemoteExecutionInputSchema.parse(JSON.parse(Buffer.from(await f.store.inputChunk('execution.json', 0), 'base64').toString()));
  expect(Reflect.get(input.openCode, field)).toBe(value);
});

it.each([
  { name: 'Authorization', header: 'Token ${env:MCP_ACCESS}', scheme: 'Token' },
  { name: 'aUtHoRiZaTiOn', header: 'Token ${env:MCP_ACCESS}', scheme: 'Token' },
  { name: 'Authorization', header: '${MCP_SCHEME} ${env:MCP_ACCESS}', scheme: 'Token' },
  { name: 'Authorization', header: '${MCP_SCHEME} ${env:MCP_ACCESS}', scheme: 'Bearer' },
])('transfers authentication scheme references and preserves provider-specific results: %j', async ({ name, header, scheme }) => {
  const f = fixture();
  mkdirSync(join(f.cwd, '.takt/workflows'), { recursive: true });
  writeFileSync(join(getGlobalConfigDir(), 'config.yaml'), 'provider: mock\n');
  writeFileSync(join(f.cwd, '.takt/workflows/root.yaml'), 'name: root\nsteps:\n  - name: work\n    instruction: Work\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
  const servers = {
    authenticated: { type: 'http', url: 'https://example.test/mcp', headers: { [name]: header, 'X-Tenant': 'tenant' } },
    public: { type: 'http', url: 'https://public.example.test/mcp' },
  };
  vi.stubEnv('MCP_SCHEME', 'daemon-scheme');
  vi.stubEnv('MCP_ACCESS', 'daemon-secret');
  writeFileSync(join(f.cwd, '.takt/runtime.yaml'), JSON.stringify({ version: 1, mcp: { servers } }));
  invalidateGlobalConfigCache();
  prepareRemoteExecutionInput(f.cwd, TaskRecordSchema.parse({ name: 'T', status: 'pending', content: 'work', workflow: 'root',
    created_at: new Date().toISOString(), started_at: null, completed_at: null }), f.executionId);
  const chunk = Buffer.from(await f.store.inputChunk('execution.json', 0), 'base64').toString();
  const input = RemoteExecutionInputSchema.parse(JSON.parse(chunk));
  const transferred = remoteRuntimeConfiguration(input).runtimeFile!.mcp!.servers!;
  expect(transferred).toEqual(servers);
  expect(chunk).not.toContain('daemon-secret');
  expect(chunk).not.toContain('daemon-scheme');
  vi.stubEnv('MCP_SCHEME', scheme);
  vi.stubEnv('MCP_ACCESS', 'worker-secret');
  const context = { persona: undefined, tags: [], stepQualifiedName: 'root/work', isWorkflowCallNode: false, isInternalAgent: false };
  const assignment = { servers: transferred, defaults: { servers: ['authenticated', 'public'] } };
  const resolved = resolveMcpAssignment(assignment, context);
  const parts = getMcpHeaderEnvRefs(resolved.servers.authenticated!)[name]!;
  expect(parts.filter((part) => typeof part !== 'string')).toEqual([{ env: 'MCP_ACCESS' }]);
  expect(parts.filter((part) => typeof part === 'string').join('')).toBe(`${scheme} `);
  const providerContext = { cwd: f.cwd, childProcessEnv: { MCP_SCHEME: scheme, MCP_ACCESS: 'worker-secret' } };
  const openCode = await createOpenCodeMcpAdapter().prepare(resolved, providerContext);
  expect(openCode.serverConfig).toMatchObject({
    authenticated: { headers: { [name]: `${scheme} {env:MCP_ACCESS}`, 'X-Tenant': 'tenant' } },
    public: { url: 'https://public.example.test/mcp' },
  });
  expect(JSON.stringify(openCode.serverConfig)).not.toContain('worker-secret');
  await openCode.dispose();
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const codex = await createCodexMcpAdapter().prepare(resolved, providerContext);
  if (scheme === 'Bearer') {
    expect(codex.config).toMatchObject({ mcp_servers: {
      authenticated: { bearer_token_env_var: 'MCP_ACCESS' }, public: { url: 'https://public.example.test/mcp' },
    } });
    expect(warnings).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  } else {
    expect(codex.excludedServerNames).toEqual(['authenticated']);
    expect(codex.config?.mcp_servers).toEqual({ public: { url: 'https://public.example.test/mcp' } });
    const messages = [...output.mock.calls, ...warnings.mock.calls];
    expect(messages).toHaveLength(1);
    const warning = messages[0]!.join(' ');
    expect(warning).toContain('codex');
    expect(warning).toContain('authenticated');
    expect(warning).not.toContain('worker-secret');
    expect(warning).not.toContain('daemon-secret');
  }
  expect(JSON.stringify(codex.config)).not.toContain('worker-secret');
  await codex.dispose();
  warnings.mockClear();
  output.mockClear();
  vi.stubEnv('MCP_ACCESS', undefined);
  expect(() => resolveMcpAssignment(assignment, context)).toThrow(/undefined environment variable "MCP_ACCESS"/);
  expect(warnings).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
  if (header.includes('${MCP_SCHEME}')) {
    vi.stubEnv('MCP_ACCESS', 'worker-secret');
    vi.stubEnv('MCP_SCHEME', undefined);
    expect(() => resolveMcpAssignment(assignment, context)).toThrow(/undefined environment variable "MCP_SCHEME"/);
    expect(warnings).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  }
});

it.each([
  { name: 'X-Api-Key', value: '${env:MCP_HEADER_ACCESS}', variables: ['MCP_HEADER_ACCESS'], delimiter: '' },
  { name: 'x-aPi-kEy', value: '${env:MCP_HEADER_ACCESS}', variables: ['MCP_HEADER_ACCESS'], delimiter: '' },
  { name: 'Authorization', value: '${env:MCP_HEADER_ACCESS}:${env:MCP_HEADER_KEY}', variables: ['MCP_HEADER_ACCESS', 'MCP_HEADER_KEY'], delimiter: ':' },
  { name: 'X-Key', value: '${env:MCP_HEADER_ACCESS}:${env:MCP_HEADER_KEY}', variables: ['MCP_HEADER_ACCESS', 'MCP_HEADER_KEY'], delimiter: ':' },
])('transfers credential header references without changing their positions: %j', async ({ name, value, variables, delimiter }) => {
  const f = fixture();
  mkdirSync(join(f.cwd, '.takt/workflows'), { recursive: true });
  writeFileSync(join(getGlobalConfigDir(), 'config.yaml'), 'provider: mock\n');
  writeFileSync(join(f.cwd, '.takt/workflows/root.yaml'), 'name: root\nsteps:\n  - name: work\n    instruction: Work\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
  const servers = {
    authenticated: { type: 'http', url: 'https://example.test/mcp', headers: { [name]: value, 'X-Tenant': 'tenant' } },
    public: { type: 'http', url: 'https://public.example.test/mcp' },
  };
  for (const variable of variables) vi.stubEnv(variable, `daemon-secret-${variable}`);
  writeFileSync(join(f.cwd, '.takt/runtime.yaml'), JSON.stringify({ version: 1, mcp: { servers } }));
  invalidateGlobalConfigCache();
  prepareRemoteExecutionInput(f.cwd, TaskRecordSchema.parse({ name: 'T', status: 'pending', content: 'work', workflow: 'root',
    created_at: new Date().toISOString(), started_at: null, completed_at: null }), f.executionId);
  const chunk = Buffer.from(await f.store.inputChunk('execution.json', 0), 'base64').toString();
  expect(chunk).not.toContain('daemon-secret');
  const transferred = remoteRuntimeConfiguration(RemoteExecutionInputSchema.parse(JSON.parse(chunk))).runtimeFile!.mcp!.servers!;
  expect(transferred).toEqual(servers);
  const workerEnv = Object.fromEntries(variables.map((variable) => [variable, `worker-secret-${variable}`]));
  for (const [variable, secret] of Object.entries(workerEnv)) vi.stubEnv(variable, secret);
  const context = { persona: undefined, tags: [], stepQualifiedName: 'root/work', isWorkflowCallNode: false, isInternalAgent: false };
  const assignment = { servers: transferred, defaults: { servers: ['authenticated', 'public'] } };
  const resolved = resolveMcpAssignment(assignment, context);
  const parts = getMcpHeaderEnvRefs(resolved.servers.authenticated!)[name]!;
  expect(parts.filter((part) => typeof part !== 'string')).toEqual(variables.map((env) => ({ env })));
  expect(parts.filter((part) => typeof part === 'string').join('')).toBe(delimiter);
  const providerContext = { cwd: f.cwd, childProcessEnv: workerEnv };
  const openCode = await createOpenCodeMcpAdapter().prepare(resolved, providerContext);
  expect(openCode.serverConfig).toMatchObject({
    authenticated: { headers: { [name]: variables.map((env) => `{env:${env}}`).join(delimiter), 'X-Tenant': 'tenant' } },
    public: { url: 'https://public.example.test/mcp' },
  });
  expect(JSON.stringify(openCode.serverConfig)).not.toContain('worker-secret');
  await openCode.dispose();
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const codex = await createCodexMcpAdapter().prepare(resolved, providerContext);
  if (variables.length === 1) {
    expect(codex.config).toMatchObject({ mcp_servers: {
      authenticated: { env_http_headers: { [name]: variables[0] } }, public: { url: 'https://public.example.test/mcp' },
    } });
    expect(warnings).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  } else {
    expect(codex.excludedServerNames).toEqual(['authenticated']);
    expect(codex.config?.mcp_servers).toEqual({ public: { url: 'https://public.example.test/mcp' } });
    const messages = [...warnings.mock.calls, ...output.mock.calls].map((args) => args.join(' '));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('codex');
    expect(messages[0]).toContain('authenticated');
  }
  expect(JSON.stringify([codex.config, warnings.mock.calls, output.mock.calls])).not.toMatch(/(?:worker|daemon)-secret/);
  await codex.dispose();
  warnings.mockClear(); output.mockClear();
  for (const variable of variables) {
    vi.stubEnv(variable, undefined);
    expect(() => resolveMcpAssignment(assignment, context)).toThrow(`undefined environment variable "${variable}"`);
    vi.stubEnv(variable, workerEnv[variable]);
  }
  expect(warnings).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
});

it.each(['${MCP_TOKEN', '${outer${MCP_TOKEN}}', 'Bearer ${env:TOKEN', '${env:TOKEN}literal-token', 'Token ${outer${env:MCP_ACCESS}}'])(
  'rejects malformed authentication references in configuration and trace serialization: %s', (value) => {
    const server: McpServerConfig = { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: value } };
    expect(() => portableRemoteConfiguration({ mcp: { servers: { test: server } } })).toThrow(/authentication/);
    expect(() => portableRemoteConfiguration({ test: server }, 'mcpServers')).toThrow(/authentication/);
  });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'worker-transfer-')); directories.push(cwd);
  const executionId = randomUUID();
  const directory = remoteExecutionDirectory(cwd, executionId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'input-manifest.json'), JSON.stringify({ version: 1, runSlug: 'test-run', directories: [], files: [] }));
  const source = join(cwd, 'worker-run'); mkdirSync(source);
  const destination = join(cwd, '.takt/runs/test-run');
  return { cwd, executionId, directory, source, destination, store: new RemoteExecutionStore(cwd, executionId) };
}
function record(sequence: number, data: string, extra: Partial<RemoteRecord> = {}): RemoteRecord {
  return { sequence, runSlug: 'test-run', path: 'logs/session.jsonl', offset: 0, mode: 'append', final: true,
    data: Buffer.from(data).toString('base64'), sha256: createHash('sha256').update(data).digest('hex'), ...extra };
}

it('continues the same sender after a lost acknowledgement without duplicating the second log record', async () => {
  const f = fixture(); mkdirSync(join(f.source, 'logs')); writeFileSync(join(f.source, 'logs/session.jsonl'), 'first\n');
  let resume!: () => void;
  let persisted!: () => void;
  const disconnected = new Promise<void>((resolve) => { persisted = resolve; });
  const reconnect = new Promise<void>((resolve) => { resume = resolve; });
  const received: number[] = [];
  const port: RemoteExecutionPort = { async request(command) {
    if (command.kind !== 'record') throw new Error('Unexpected operation');
    received.push(command.record.sequence);
    let acknowledgedSequence = await f.store.receiveRecord(command.record);
    if (command.record.sequence === 2) {
      persisted(); await reconnect;
      received.push(command.record.sequence);
      acknowledgedSequence = await new RemoteExecutionStore(f.cwd, f.executionId).receiveRecord(command.record);
    }
    return { kind: 'record', acknowledgedSequence };
  } };
  const sender = new RemoteRunSender(f.source, 'test-run', port);
  expect(await sender.flush()).toBe(1);
  appendFileSync(join(f.source, 'logs/session.jsonl'), 'second\n');
  const continuing = sender.flush(); await disconnected;
  expect(await f.store.acknowledgedSequence()).toBe(2);
  resume(); expect(await continuing).toBe(2);
  expect(received).toEqual([1, 2, 2]);
  expect(readFileSync(join(f.destination, 'logs/session.jsonl'), 'utf8')).toBe('first\nsecond\n');
});

it('rejects different bytes at the same sequence and preserves the saved content and acknowledgement', async () => {
  const f = fixture(); await f.store.receiveRecord(record(1, 'first\n'));
  await expect(f.store.receiveRecord(record(1, 'changed\n'))).rejects.toThrow(/different content/);
  expect(await f.store.acknowledgedSequence()).toBe(1);
  expect(readFileSync(join(f.destination, 'logs/session.jsonl'), 'utf8')).toBe('first\n');
});

it('publishes a replacement only after its last chunk while preserving binary bytes', async () => {
  const f = fixture();
  await f.store.receiveRecord(record(1, 'old', { path: 'meta.json', mode: 'replace' }));
  await f.store.receiveRecord(record(2, 'new', { path: 'meta.json', mode: 'replace', final: false }));
  await expect(f.store.assertFinalSequence(2)).rejects.toThrow(/unfinished/);
  expect(readFileSync(join(f.destination, 'meta.json'), 'utf8')).toBe('old');
  const data = Buffer.from([0, 255, 128]);
  await new RemoteExecutionStore(f.cwd, f.executionId).receiveRecord(record(3, '', { path: 'meta.json', mode: 'replace', offset: 3, data: data.toString('base64'),
    sha256: createHash('sha256').update(data).digest('hex') }));
  expect(readFileSync(join(f.destination, 'meta.json'))).toEqual(Buffer.concat([Buffer.from('new'), data]));
  await expect(f.store.assertFinalSequence(3)).resolves.toBeUndefined();
});

it('resumes an append interrupted after journaling and writing only part of its bytes', async () => {
  const f = fixture();
  await f.store.receiveRecord(record(1, 'first\n'));
  const pending = record(2, 'second\n', { offset: 6 });
  writeFileSync(join(f.directory, 'records/2.json'), JSON.stringify(pending));
  appendFileSync(join(f.destination, 'logs/session.jsonl'), 'sec');
  const restored = new RemoteExecutionStore(f.cwd, f.executionId);
  expect(await restored.acknowledgedSequence()).toBe(1);
  expect(await restored.receiveRecord(pending)).toBe(2);
  expect(readFileSync(join(f.destination, 'logs/session.jsonl'), 'utf8')).toBe('first\nsecond\n');
  expect(await restored.receiveRecord(pending)).toBe(2);
  expect(readFileSync(join(f.destination, 'logs/session.jsonl'), 'utf8')).toBe('first\nsecond\n');
});

it('acknowledges a replacement restored after rename without requiring the removed staging file', async () => {
  const f = fixture();
  const completed = record(1, 'saved', { path: 'meta.json', mode: 'replace' });
  await f.store.receiveRecord(completed);
  writeFileSync(join(f.directory, 'record-sequence.json'), '0');
  const restored = new RemoteExecutionStore(f.cwd, f.executionId);
  expect(await restored.receiveRecord(completed)).toBe(1);
  await expect(restored.assertFinalSequence(1)).resolves.toBeUndefined();
  expect(readFileSync(join(f.destination, 'meta.json'), 'utf8')).toBe('saved');
});

it('finishes a pending replacement even when the old destination has the same size and final bytes', async () => {
  const f = fixture();
  await f.store.receiveRecord(record(1, 'old!!', { path: 'meta.json', mode: 'replace' }));
  await f.store.receiveRecord(record(2, 'new', { path: 'meta.json', mode: 'replace', final: false }));
  const pending = record(3, '!!', { path: 'meta.json', mode: 'replace', offset: 3 });
  writeFileSync(join(f.directory, 'records/3.json'), JSON.stringify(pending));
  const restored = new RemoteExecutionStore(f.cwd, f.executionId);
  expect(await restored.acknowledgedSequence()).toBe(2);
  expect(await restored.receiveRecord(pending)).toBe(3);
  expect(readFileSync(join(f.destination, 'meta.json'), 'utf8')).toBe('new!!');
  await expect(restored.assertFinalSequence(3)).resolves.toBeUndefined();
});

it('rejects gaps, incorrect hashes, foreign run identities and daemon-owned intervention files before acknowledging', async () => {
  const f = fixture();
  for (const invalid of [record(2, 'gap'), record(1, 'bad', { sha256: '0'.repeat(64) }),
    record(1, 'foreign', { runSlug: 'other' }), record(1, 'overwrite', { path: 'interventions.jsonl' })]) {
    await expect(f.store.receiveRecord(invalid)).rejects.toThrow();
    expect(await f.store.acknowledgedSequence()).toBe(0);
  }
});

it('rejects traversal and symlink ancestors when creating a remote artifact path', async () => {
  const f = fixture(); const outside = join(f.cwd, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(f.source, 'linked'));
  for (const path of ['../outside/result', '/absolute', 'linked/result', 'a\\b']) {
    await expect(remoteFilePath(f.source, path)).rejects.toThrow();
  }
});

it('transfers durable report versions and hidden attachments while excluding active locks and temporary writes', async () => {
  const f = fixture();
  const entries = {
    'reports/.takt-report-internal/executions/versions/result.md': 'saved version',
    'context/task/attachments/.example': 'attachment',
    'context/subworkflows/child/task/attachments/data.lock': 'child attachment',
    'reports/.takt-report-internal/locks/report.lock': 'transient',
    '.meta.json.example.tmp': 'partial',
  };
  for (const [path, data] of Object.entries(entries)) {
    mkdirSync(join(f.source, path, '..'), { recursive: true }); writeFileSync(join(f.source, path), data);
  }
  const paths: string[] = [];
  const sender = new RemoteRunSender(f.source, 'test-run', { async request(command) {
    if (command.kind !== 'record') throw new Error('Unexpected request');
    paths.push(command.record.path);
    return { kind: 'record', acknowledgedSequence: await f.store.receiveRecord(command.record) };
  } });
  await sender.flush();
  expect(paths).toEqual(expect.arrayContaining(['reports/.takt-report-internal/executions/versions/result.md',
    'context/task/attachments/.example', 'context/subworkflows/child/task/attachments/data.lock']));
  expect(paths).toHaveLength(3);
  expect(readFileSync(join(f.destination, 'context/subworkflows/child/task/attachments/data.lock'), 'utf8')).toBe('child attachment');
});

it('transfers report versions through three nested workflow namespaces', async () => {
  const f = fixture();
  const segments = [
    'iteration-1--step-develop--workflow-development-core--site-' + 'a'.repeat(64),
    'iteration-1--step-peer-review--workflow-peer-review--site-' + 'b'.repeat(64),
    'iteration-1--step-initial-reviewers--workflow-takt-development-review--site-' + 'c'.repeat(64),
  ];
  const path = 'reports/' + segments.map((segment) => 'subworkflows/' + segment).join('/')
    + '/.takt-report-internal/executions/versions/00000000-0000-4000-8000-000000000000/result.md';
  expect(path.length).toBeGreaterThan(512);
  mkdirSync(join(f.source, path, '..'), { recursive: true });
  writeFileSync(join(f.source, path), 'nested report');
  const sender = new RemoteRunSender(f.source, 'test-run', { async request(command) {
    if (command.kind !== 'record') throw new Error('Unexpected request');
    return { kind: 'record', acknowledgedSequence: await f.store.receiveRecord(command.record) };
  } });
  expect(await sender.flush()).toBe(1);
  expect(readFileSync(join(f.destination, path), 'utf8')).toBe('nested report');
});

it('prepares daemon settings, a child workflow and binary attachments without forwarding credentials or dropping empty directories', async () => {
  const f = fixture();
  mkdirSync(join(f.cwd, '.takt/workflows'), { recursive: true });
  mkdirSync(join(f.cwd, '.takt/tasks/input/attachments/empty'), { recursive: true });
  writeFileSync(join(getGlobalConfigDir(), 'config.yaml'), 'provider: mock\nopenai_api_key: daemon-secret\n');
  writeFileSync(join(f.cwd, '.takt/config.yaml'), 'provider: mock\nmodel: daemon-model\n');
  writeFileSync(join(f.cwd, '.takt/workflows/root.yaml'), 'name: root\nsteps:\n  - name: child\n    kind: workflow_call\n    call: ./child.yaml\n    rules:\n      - condition: COMPLETE\n        next: COMPLETE\n');
  writeFileSync(join(f.cwd, '.takt/workflows/child.yaml'), 'name: child\nsubworkflow:\n  callable: true\nsteps:\n  - name: work\n    instruction: Complete the task\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
  writeFileSync(join(f.cwd, '.takt/tasks/input/order.md'), '# Daemon order\nRead `attachments/input.bin`.\n');
  const data = Buffer.from([0, 255, 128, 10]); writeFileSync(join(f.cwd, '.takt/tasks/input/attachments/input.bin'), data);
  invalidateGlobalConfigCache();
  prepareRemoteExecutionInput(f.cwd, TaskRecordSchema.parse({ name: 'T', status: 'pending', task_dir: '.takt/tasks/input',
    workflow: 'root', created_at: new Date().toISOString(), started_at: null, completed_at: null }), f.executionId);
  const manifest = await f.store.inputManifest();
  expect(manifest.directories.some((path) => path.endsWith('/attachments/empty'))).toBe(true);
  const attachment = manifest.files.find((file) => file.path.endsWith('/attachments/input.bin'))!;
  expect(Buffer.from(await f.store.inputChunk(attachment.path, 0), 'base64')).toEqual(data);
  await expect(f.store.inputChunk(attachment.path, data.length + 1)).rejects.toThrow(/outside/);
  await expect(f.store.inputChunk('../outside', 0)).rejects.toThrow(/outside/);
  const metadata = readFileSync(join(f.directory, 'input/execution.json'), 'utf8');
  expect(metadata).toContain('daemon-model'); expect(metadata).not.toContain('daemon-secret');
  const objects = manifest.files.filter((file) => file.path.includes('/workflow-bundle/objects/'));
  expect(objects).toHaveLength(2);
});

it('does not retain the previous assignment environment in the same executor', async () => {
  const environments: NodeJS.ProcessEnv[] = [];
  vi.spyOn(spawn, 'spawnManagedProcess').mockImplementation((_command, _args, options) => {
    environments.push({ ...options?.env });
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      send(message: { kind: string }) {
        queueMicrotask(() => {
          if (message.kind === 'start') child.emit('message', { kind: 'result', success: false, reason: 'fixture result' });
          else if (message.kind === 'stop') { child.connected = false; child.emit('close', 0); }
        });
      },
      kill: vi.fn(),
    });
    return { child, terminate: vi.fn().mockResolvedValue(undefined) } as unknown as ReturnType<typeof spawn.spawnManagedProcess>;
  });
  const worker = { TAKT_OPENCODE_STREAM_EVENT_LIMIT: '100', MCP_WORKER_AUTH: 'worker-auth' };
  const executor = createRemoteTaskExecutor(worker);
  for (const eventLimit of ['3', undefined]) {
    const f = fixture();
    const assignment = RemoteAssignmentSchema.parse({ workerId: 'w1', workerName: 'w1', registrationGeneration: randomUUID(),
      projectId: f.cwd, taskName: 'T', executionId: f.executionId, assignmentGeneration: 1, requestId: 'claim',
      originalSha: 'a'.repeat(40), origin: '/unused-origin', branch: 'result', leaseExpiresAt: Date.now() + 60_000,
      lastAcknowledgedLogSequence: 0, controlSequence: 0, workLocation: null, retryReservation: false });
    const bytes = Buffer.from(JSON.stringify({ version: 1, runSlug: `remote-${f.executionId}`, task: 'Work',
      taskConfig: { workflow: 'root' }, hasTaskSpec: false, openCode: { eventLimit },
      project: {}, global: {}, projectTrace: {}, globalTrace: {},
      runtime: { profileOrigins: [], assignmentOrigins: {} } }));
    const port: RemoteExecutionPort = { async request(command) {
      if (command.kind === 'credentials') return { kind: 'credentials', environment: {} };
      if (command.kind === 'input-manifest') return { kind: 'input-manifest', manifest: { version: 1,
        runSlug: `remote-${f.executionId}`, directories: [], files: [{ path: 'execution.json', size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex') }] } };
      if (command.kind === 'input-chunk') return { kind: 'input-chunk', data: bytes.toString('base64') };
      if (command.kind === 'controls') return { kind: 'controls', controls: [] };
      throw new Error('Unexpected execution command');
    } };
    expect(await executor.execute(assignment, new AbortController().signal, port)).toMatchObject({ success: false, reason: 'fixture result' });
  }
  expect(environments).toHaveLength(2);
  expect(environments[0]).toMatchObject({ TAKT_OPENCODE_STREAM_EVENT_LIMIT: '3', MCP_WORKER_AUTH: 'worker-auth' });
  expect(environments[1]).not.toHaveProperty('TAKT_OPENCODE_STREAM_EVENT_LIMIT');
  expect(environments[1]).toMatchObject({ MCP_WORKER_AUTH: 'worker-auth' });
  expect(worker.TAKT_OPENCODE_STREAM_EVENT_LIMIT).toBe('100');
});

it('classifies raw child authentication errors before redacting the network result', async () => {
  vi.spyOn(spawn, 'spawnManagedProcess').mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      send(message: { kind: string }) {
        queueMicrotask(() => {
          if (message.kind === 'start') child.emit('message', { kind: 'result', success: false,
            reason: 'OpenAI authentication failed: supplied value a9', prError: 'GitHub authentication failed: supplied value a9' });
          else if (message.kind === 'stop') { child.connected = false; child.emit('close', 0); }
        });
      },
      kill: vi.fn(),
    });
    return { child, terminate: vi.fn().mockResolvedValue(undefined) } as unknown as ReturnType<typeof spawn.spawnManagedProcess>;
  });
  const f = fixture();
  directories.push(join(getGlobalConfigDir(), 'worker-executions', f.executionId));
  const assignment = RemoteAssignmentSchema.parse({ workerId: 'w1', workerName: 'w1', registrationGeneration: randomUUID(),
    projectId: f.cwd, taskName: 'T', executionId: f.executionId, assignmentGeneration: 1, requestId: 'claim',
    originalSha: 'a'.repeat(40), origin: '/unused-origin', branch: 'result', leaseExpiresAt: Date.now() + 60_000,
    lastAcknowledgedLogSequence: 0, controlSequence: 0, workLocation: null, retryReservation: false });
  const bytes = Buffer.from(JSON.stringify({ version: 1, runSlug: `remote-${f.executionId}`, task: 'Work',
    taskConfig: { workflow: 'root' }, hasTaskSpec: false, openCode: {}, project: {}, global: {}, projectTrace: {}, globalTrace: {},
    runtime: { profileOrigins: [], assignmentOrigins: {} } }));
  const port: RemoteExecutionPort = { async request(command) {
    if (command.kind === 'credentials') return { kind: 'credentials', environment: { OPENAI_API_KEY: 'a' } };
    if (command.kind === 'input-manifest') return { kind: 'input-manifest', manifest: { version: 1,
      runSlug: `remote-${f.executionId}`, directories: [], files: [{ path: 'execution.json', size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') }] } };
    if (command.kind === 'input-chunk') return { kind: 'input-chunk', data: bytes.toString('base64') };
    if (command.kind === 'controls') return { kind: 'controls', controls: [] };
    throw new Error('Unexpected execution command');
  } };
  const result = await createRemoteTaskExecutor({}).execute(assignment, new AbortController().signal, port);
  expect(result.success).toBe(false);
  for (const reason of [result.reason, result.prError]) {
    expect(reason).toMatch(/^Worker w1:/);
    expect(reason).toContain('[REDACTED]9');
    expect(reason?.includes('a')).toBe(false);
  }
});

it('inspects and removes only the assignment workspace, including its nested retry attempts', async () => {
  const f = fixture();
  const assignment = RemoteAssignmentSchema.parse({ workerId: 'w1', workerName: 'w1', registrationGeneration: randomUUID(),
    projectId: f.cwd, taskName: 'T', executionId: f.executionId, assignmentGeneration: 1, requestId: 'claim',
    originalSha: 'a'.repeat(40), origin: '/unused-origin', branch: 'result', leaseExpiresAt: 1,
    lastAcknowledgedLogSequence: 0, controlSequence: 0, workLocation: null, retryReservation: false });
  const root = join(getGlobalConfigDir(), 'worker-executions', f.executionId); directories.push(root);
  mkdirSync(join(root, 'clone', '.git'), { recursive: true });
  mkdirSync(join(root, 'attempts', randomUUID(), 'input'), { recursive: true });
  const executor = createRemoteTaskExecutor({});
  expect(await executor.workspace!(assignment, 'inspect')).toBe(true);
  expect(await executor.workspace!({ ...assignment, executionId: randomUUID(), workLocation: assignment.executionId }, 'remove')).toBe(false);
  expect(existsSync(root)).toBe(false);
  expect(await executor.workspace!(assignment, 'inspect')).toBe(false);
  await expect(executor.workspace!({ ...assignment, workLocation: '../outside' }, 'remove')).rejects.toThrow();
});

it('rejects a corrupt transferred file before starting the task process', async () => {
  const f = fixture();
  const assignment = RemoteAssignmentSchema.parse({ workerId: 'w1', workerName: 'w1', registrationGeneration: randomUUID(),
    projectId: f.cwd, taskName: 'T', executionId: f.executionId, assignmentGeneration: 1, requestId: 'claim',
    originalSha: 'a'.repeat(40), origin: '/unused-origin', branch: 'result', leaseExpiresAt: Date.now() + 60_000,
    lastAcknowledgedLogSequence: 0, controlSequence: 0, workLocation: null, retryReservation: false });
  const request = vi.fn<RemoteExecutionPort['request']>(async (command) => command.kind === 'input-manifest'
    ? { kind: 'input-manifest', manifest: { version: 1, runSlug: `remote-${f.executionId}`, directories: [],
      files: [{ path: 'execution.json', size: 4, sha256: createHash('sha256').update('good').digest('hex') }] } }
    : { kind: 'input-chunk', data: Buffer.from('evil').toString('base64') });
  await expect(createRemoteTaskExecutor({}).execute(assignment, new AbortController().signal, { request })).rejects.toThrow(/file hash/);
  expect(request).toHaveBeenCalledTimes(2);
});

const tell = (instructionId: number, content: string): Omit<RemoteControl, 'sequence'> => ({ kind: 'tell', instructionId,
  content, issuedAt: '2026-11-13T00:00:00.000Z' });

it('records a remote delivery without overwriting a later pending daemon instruction', async () => {
  const f = fixture(); mkdirSync(f.destination, { recursive: true });
  const assignment = RemoteAssignmentSchema.parse({ workerId: 'w1', workerName: 'w1', registrationGeneration: randomUUID(),
    projectId: f.cwd, taskName: 'T', executionId: f.executionId, assignmentGeneration: 1, requestId: 'claim',
    originalSha: 'a'.repeat(40), origin: '/unused-origin', branch: 'result', leaseExpiresAt: Date.now() + 60_000,
    lastAcknowledgedLogSequence: 0, controlSequence: 0, workLocation: null, retryReservation: false });
  const store = new TaskStore(f.cwd);
  store.update(() => ({ tasks: [TaskRecordSchema.parse({ name: 'T', content: 'work', status: 'running',
    created_at: new Date().toISOString(), started_at: new Date().toISOString(), completed_at: null,
    remote_assignment: assignment, execution_id: f.executionId, run_slug: 'test-run' })] }));
  const instructions = new LiveInterventionFileStore(f.cwd, 'test-run');
  await instructions.issue('first'); await instructions.issue('later pending instruction');
  const lifecycle = new RemoteTaskLifecycle(f.cwd, store, vi.fn());
  const delivery = { kind: 'execution' as const, assignment: executionIdentity(assignment), now: Date.now(),
    command: { kind: 'intervention-delivery' as const, instructionIds: [1], context: { mode: 'next_step' as const, step: 'work', phase: 1 as const } } };
  expect(await lifecycle.request(delivery, 1)).toEqual({ kind: 'execution', response: { kind: 'intervention-delivery' } });
  expect(instructions.read()).toMatchObject({ pending: 1, issuedTotal: 2, deliveredNextStep: 1,
    instructions: [{ instructionId: 1, state: 'deliveredNextStep' }, { instructionId: 2, content: 'later pending instruction', state: 'pending' }] });
  await lifecycle.request(delivery, 1);
  expect(instructions.read()).toMatchObject({ pending: 1, deliveredNextStep: 1 });
});

it('applies the next instruction after the acknowledged control sequence and retains a receipt', async () => {
  const f = fixture(); const sender = new RemoteExecutionControls(f.directory);
  const receiver = new RemoteControlReceiver(join(f.cwd, 'worker-controls'));
  const apply = vi.fn(async (_control: RemoteControl) => {});
  const first = (await sender.poll(0, [tell(1, '最初の指示')]))[0]!;
  expect(await receiver.apply(first, apply)).toBe(1);
  const next = await sender.poll(1, [tell(1, '最初の指示'), tell(2, '境界条件を確認する')]);
  expect(next).toEqual([expect.objectContaining({ sequence: 2, content: '境界条件を確認する' })]);
  expect(await receiver.apply(next[0]!, apply)).toBe(2);
  expect(apply).toHaveBeenCalledTimes(2);
  expect(apply).toHaveBeenLastCalledWith(next[0]);
  expect(await new RemoteExecutionControls(f.directory).poll(2, [])).toEqual([]);
  expect(JSON.parse(readFileSync(join(f.cwd, 'worker-controls/applied-controls/2.json'), 'utf8'))).toEqual(next[0]);
});

it('acknowledges a resent control without applying the instruction twice', async () => {
  const f = fixture(); const sender = new RemoteExecutionControls(f.directory);
  const receiver = new RemoteControlReceiver(join(f.cwd, 'worker-controls'));
  const apply = vi.fn(async (_control: RemoteControl) => {});
  const first = (await sender.poll(0, [tell(1, '最初の指示')]))[0]!;
  await receiver.apply(first, apply);
  const [second] = await sender.poll(1, [tell(2, '境界条件を確認する')]);
  await receiver.apply(second!, apply);
  const resent = await new RemoteExecutionControls(f.directory).poll(1, []);
  expect(resent).toEqual([second]);
  expect(await receiver.apply(resent[0]!, apply)).toBe(2);
  expect(apply).toHaveBeenCalledTimes(2);
  await expect(receiver.apply({ ...second!, content: 'changed' }, apply)).rejects.toThrow(/different content/);
  expect(apply).toHaveBeenCalledTimes(2);
});

it('restores a control acknowledgement after its applied journal was saved without applying it again', async () => {
  const f = fixture(); const directory = join(f.cwd, 'worker-controls');
  const receiver = new RemoteControlReceiver(directory);
  const apply = vi.fn(async (_control: RemoteControl) => {});
  const control = { ...tell(1, '保存済みの指示'), sequence: 1 };
  expect(await receiver.apply(control, apply)).toBe(1);
  writeFileSync(join(directory, 'control-sequence.json'), '0');
  expect(await new RemoteControlReceiver(directory).apply(control, apply)).toBe(1);
  expect(apply).toHaveBeenCalledOnce();
});
