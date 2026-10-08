import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { decompressSessionFrames } from './helpers/deepseek-session-frames.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
vi.mock('../infra/deepseek-harness/managed-package.js', async (importOriginal) => {
  const managed = await importOriginal<typeof import('../infra/deepseek-harness/managed-package.js')>();
  const [sdk, llm] = await Promise.all([
    import('@deepseek-ai/dsh-sdk-client'),
    import('@deepseek-ai/dsh-llm'),
  ]);
  return {
    ...managed,
    loadManagedDeepSeekHarnessModules: async () => ({ directory: process.cwd(), sdk, llm }),
  };
});
import { createAssistantConversationPlan } from '../features/interactive/conversationPlan.js';
import { createConversationSession } from '../features/interactive/conversationSession.js';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { runAgent } from '../agents/runner.js';
import { loadPersonaSessions, resolvePersonaSessionId, updatePersonaSession } from '../infra/config/project/sessionStore.js';
import { hasDeepSeekSessionMarker } from '../infra/deepseek-harness/runtime-state.js';
import type { WorkflowStep } from '../core/models/types.js';
import {
  callDeepSeekHarness,
  closeDeepSeekHarnessProcesses,
} from '../infra/deepseek-harness/index.js';
import { createProviderEventLogger } from '../core/logging/providerEventLogger.js';
import { renderTraceReportFromRecords } from '../features/tasks/execute/traceReport.js';
import type { StreamCallback, StreamEvent } from '../shared/types/provider.js';

const supportedRuntime = (
  (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64'))
  || (process.platform === 'darwin' && process.arch === 'arm64')
);

const STORE_KEY = 'dummy-store-credential-1487';
const UPDATED_STORE_KEY = 'dummy-updated-credential-1487';
const ENV_KEY = 'dummy-env-credential-1487';
const REQUEST_TIMEOUT_MS = 120_000;
const WATCHER_TIMEOUT_MS = 20_000;
const WATCHER_POLL_INTERVAL_MS = 500;

interface RecordedRequest {
  apiKey: string | undefined;
  toolNames: string[];
  toolResultContainsStoreKey: boolean;
  messages: unknown;
}

type MockMode = 'ok' | 'auth-echo' | 'workspace-tools' | 'held-tool' | 'assistant-message-reasoning' | 'assistant-message-text-only';

interface MockEndpoint {
  baseUrl: string;
  requests: RecordedRequest[];
  setMode: (mode: MockMode) => void;
  holdNextResponse: () => { received: Promise<void>; release: () => void };
  close: () => Promise<void>;
}

/** Emit Anthropic-compatible streaming events, optionally requesting a read tool or simulating a provider failure. */
function writeEventStream(
  response: import('node:http').ServerResponse,
  options: { mode: MockMode; readSourcePath?: string; sequence: number; exposeReadTool: boolean },
): void {
  const write = (event: string, data: unknown): void => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  write('message_start', {
    type: 'message_start',
    message: {
      id: 'credential-store-mock', type: 'message', role: 'assistant', model: 'deepseek-v4-flash',
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 0 },
    },
  });
  const toolActions = [
    { name: 'read', input: { file_path: options.readSourcePath } },
    { name: 'write', input: { file_path: 'generated.ts', content: 'export const value = 1;\n' } },
    { name: 'edit', input: { file_path: 'generated.ts', old_string: 'value = 1', new_string: 'value = 2' } },
    { name: 'bash', input: { command: "printf 'shell-ok' > shell.txt", description: 'Write the bounded shell fixture' } },
  ];
  const action = options.mode === 'held-tool'
    ? { name: 'bash', input: { command: 'node -e "require(\'node:fs\').writeFileSync(\'child.pid\',String(process.pid));setInterval(()=>{},1000)"', description: 'Start the bounded child cleanup fixture' } }
    : toolActions[options.sequence - 1];
  if (action !== undefined && options.readSourcePath !== undefined && options.exposeReadTool
    && (options.mode === 'workspace-tools' || (options.mode === 'held-tool' && options.sequence === 1))) {
    write('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: `toolu_workspace_${options.sequence}`, name: action.name, input: {} },
    });
    write('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(action.input),
      },
    });
    write('content_block_stop', { type: 'content_block_stop', index: 0 });
    write('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 2 },
    });
    write('message_stop', { type: 'message_stop' });
    response.end();
    return;
  }
  if (options.mode === 'assistant-message-reasoning') {
    write('content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' },
    });
    write('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'local mock reasoning' },
    });
    write('content_block_stop', { type: 'content_block_stop', index: 0 });
    write('content_block_start', {
      type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' },
    });
    write('content_block_delta', {
      type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'confirmed' },
    });
    write('content_block_stop', { type: 'content_block_stop', index: 1 });
  } else {
    write('content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    });
    write('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'confirmed' },
    });
    write('content_block_stop', { type: 'content_block_stop', index: 0 });
  }
  write('message_delta', {
    type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 2 },
  });
  write('message_stop', { type: 'message_stop' });
  response.end();
}

/** Start a credential-store mock that records authorization and supports holding/releasing requests for binding tests. */
async function startMockEndpoint(readSourcePath: string): Promise<MockEndpoint> {
  const requests: RecordedRequest[] = [];
  let mode: MockMode = 'ok';
  let hold: { received: () => void; ready: Promise<void> } | undefined;
  let releaseHeld: (() => void) | undefined;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const toolNames = tools.flatMap((tool) => (
        tool !== null && typeof tool === 'object' && 'name' in tool && typeof tool.name === 'string'
          ? [tool.name]
          : []
      ));
      const bodyText = JSON.stringify(body);
      const apiKeyHeader = request.headers['x-api-key'];
      requests.push({
        apiKey: Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader,
        toolNames,
        toolResultContainsStoreKey: bodyText.includes(STORE_KEY),
        messages: body.messages,
      });
      const sequence = requests.length;
      const currentHold = hold;
      hold = undefined;
      if (currentHold) {
        currentHold.received();
        await currentHold.ready;
      }
      if (mode === 'auth-echo') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: `rejected ${STORE_KEY}` },
        }));
        return;
      }
      writeEventStream(response, {
        mode,
        ...((mode === 'workspace-tools' || mode === 'held-tool') ? { readSourcePath } : {}),
        sequence,
        exposeReadTool: toolNames.includes('read'),
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('mock endpoint did not bind a TCP port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    setMode: (next) => {
      mode = next;
    },
    holdNextResponse: () => {
      let received!: () => void;
      let release!: () => void;
      const receipt = new Promise<void>((resolve) => { received = resolve; });
      const ready = new Promise<void>((resolve) => { release = resolve; });
      hold = { received, ready };
      releaseHeld = release;
      return { received: receipt, release };
    },
    close: () => new Promise<void>((resolve) => {
      releaseHeld?.();
      server.close(() => resolve());
    }),
  };
}

describe('DeepSeek Harness persisted session inspection', () => {
  it('scans later concatenated Zstd frames instead of just the session header', () => {
    const data = Buffer.concat([
      zstdCompressSync(Buffer.from('{"type":"session/header"}\n')),
      zstdCompressSync(Buffer.from(JSON.stringify({ message: STORE_KEY }) + '\n')),
    ]);
    expect(decompressSessionFrames(data).includes(STORE_KEY)).toBe(true);
  });

  it('rejects an unreadable frame instead of treating it as secret-free', () => {
    expect(() => decompressSessionFrames(Buffer.from('invalid compressed session'))).toThrow();
  });
});

function collectSecretHits(directory: string, secret: string): string[] {
  const hits: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      let data: Buffer = readFileSync(entryPath);
      if (entryPath.endsWith('.zstd')) {
        data = decompressSessionFrames(data);
      }
      if (data.includes(secret)) {
        hits.push(entryPath);
      }
    }
  };
  visit(directory);
  return hits;
}

describe.skipIf(!supportedRuntime)('DeepSeek Harness credential store integration', () => {
  let root: string;
  let workspace: string;
  let sourceHome: string;
  let dshHome: string;
  let storePath: string;
  let settingsPath: string;
  let endpoint: MockEndpoint;

  async function writeStore(content: string): Promise<void> {
    await writeFile(storePath, content, 'utf8');
    await chmod(storePath, 0o600);
  }

  async function writeSettings(baseUrl: string, reference = 'DEEPSEEK_API_KEY'): Promise<void> {
    await writeFile(settingsPath, [
      'llm-deepseek:',
      `  apiKeyEnv: ${reference}`,
      `  baseURL: ${baseUrl}`,
      '',
    ].join('\n'), 'utf8');
  }

  /** Call the provider with fixture defaults and optional session/environment overrides without contacting a real service. */
  async function runTurn(options: {
    prompt?: string;
    sessionId?: string;
    model?: string;
    childProcessEnv?: Readonly<Record<string, string>>;
    onStream?: StreamCallback;
    abortSignal?: AbortSignal;
  } = {}): Promise<Awaited<ReturnType<typeof callDeepSeekHarness>>> {
    return callDeepSeekHarness('live-smoke', options.prompt ?? 'Return ok.', {
      cwd: workspace,
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      ...(options.onStream === undefined ? {} : { onStream: options.onStream }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.childProcessEnv === undefined ? {} : { childProcessEnv: options.childProcessEnv }),
      ...(options.model === undefined ? {} : { model: options.model }),
      providerOptions: { baseUrl: endpoint.baseUrl, requestTimeoutMs: REQUEST_TIMEOUT_MS },
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-credential-store-'));
    workspace = path.join(root, 'workspace');
    sourceHome = path.join(root, 'source-home');
    const managedRoot = path.join(root, 'config', 'deepseek-harness');
    dshHome = path.join(managedRoot, 'dsh-home');
    storePath = path.join(sourceHome, '.credentials.yaml');
    settingsPath = path.join(sourceHome, 'settings.yaml');
    await mkdir(workspace, { recursive: true });
    await mkdir(sourceHome, { recursive: true });
    await mkdir(dshHome, { recursive: true });
    endpoint = await startMockEndpoint(path.join(workspace, 'source.ts'));
    await writeFile(path.join(workspace, 'source.ts'), 'export const source = true;\n');
    await writeStore(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${STORE_KEY}\n`);
    await writeSettings(endpoint.baseUrl);
    vi.stubEnv('TAKT_CONFIG_DIR', path.join(root, 'config'));
    vi.stubEnv('DSH_HOME', sourceHome);
    vi.stubEnv('DEEPSEEK_API_KEY', undefined);
    vi.stubEnv('DEEPSEEK_BASE_URL', undefined);
  });

  afterEach(async () => {
    await closeDeepSeekHarnessProcesses();
    await endpoint?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('resolves the credential from the source store without reading or changing it', async () => {
    const storeBefore = await readFile(storePath);
    const modeBefore = (await stat(storePath)).mode & 0o777;

    const response = await runTurn();

    expect(response.status).toBe('done');
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]?.apiKey).toContain(STORE_KEY);
    expect(response.content).not.toContain(STORE_KEY);
    expect(await readFile(storePath)).toEqual(storeBefore);
    expect((await stat(storePath)).mode & 0o777).toBe(modeBefore);
    expect(existsSync(path.join(dshHome, 'sessions'))).toBe(false);
    expect(existsSync(path.join(dshHome, '.credentials.yaml'))).toBe(false);
  });

  it('executes standard coding tools through the public interactive plan, session and real SDK without copying credentials', async () => {
    endpoint.setMode('workspace-tools');
    const events: StreamEvent[] = [];
    const storeBefore = await readFile(storePath);

    vi.stubEnv('DEEPSEEK_BASE_URL', endpoint.baseUrl);
    const plan = createAssistantConversationPlan(workspace, {
      assistantMode: 'assistant', formalSpec: false, formalSpecComments: false, modelCheckTimeoutSeconds: 30,
      provider: 'deepseek-harness', model: 'deepseek-v4-flash',
    });
    const session = createConversationSession({
      cwd: workspace, ctx: plan.ctx, strategy: plan.strategy, formalSpec: false,
      modelCheckTimeoutSeconds: 30, outputMode: 'silent', persistSession: false,
      onStream: (event) => events.push(event),
    });
    const response = await session.handleUserMessage({ text: 'Read, write, edit and run the workspace fixture.' });

    expect(response.kind).toBe('assistant_response');
    const toolNames = endpoint.requests[0]?.toolNames ?? [];
    expect(toolNames).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'bash', 'glob', 'grep', 'subagent', 'workflow']));
    expect(endpoint.requests).toHaveLength(5);
    expect(await readFile(path.join(workspace, 'generated.ts'), 'utf8')).toBe('export const value = 2;\n');
    expect(await readFile(path.join(workspace, 'shell.txt'), 'utf8')).toBe('shell-ok');
    expect(events.filter((event) => event.type === 'tool_use')).toHaveLength(4);
    expect(events.filter((event) => event.type === 'tool_result')).toHaveLength(4);
    expect(endpoint.requests.some((request) => request.toolResultContainsStoreKey)).toBe(false);
    expect(JSON.stringify(response)).not.toContain(STORE_KEY);
    expect(await readFile(storePath)).toEqual(storeBefore);
    expect(existsSync(path.join(dshHome, '.credentials.yaml'))).toBe(false);

    const liveId = session.getSessionId();
    plan.strategy.permissionMode = 'readonly';
    const refusal = await session.handleUserMessage({ text: 'Reject this unsupported permission request.' });
    expect(refusal.kind).toBe('error');
    expect(endpoint.requests).toHaveLength(5);
    expect(session.getSessionId()).toBe(liveId);
    plan.strategy.permissionMode = undefined;
    const normalTurn = await session.handleUserMessage({ text: 'Continue with native tools.' });
    expect(normalTurn.kind).toBe('assistant_response');
    expect(session.getSessionId()).toBe(liveId);
    expect(endpoint.requests).toHaveLength(6);
  });

  it('refuses all report routes through the real agent dispatcher without starting the SDK or contacting the endpoint', async () => {
    const step: WorkflowStep = {
      name: 'report', personaDisplayName: 'Reporter', instruction: 'report', passPreviousResponse: false,
      engineSynthesized: true, provider: 'deepseek-harness', model: 'deepseek-v4-flash',
    };
    const builder = new OptionsBuilder(
      { projectCwd: workspace, provider: 'deepseek-harness', reportFallbackProvider: { provider: 'deepseek-harness', model: 'deepseek-v4-flash' } },
      () => workspace, () => workspace, () => undefined, () => path.join(root, 'reports'),
      () => 'en', () => [{ name: 'report' }], () => 'default', () => 'test workflow',
    );
    const fallback = builder.buildFallbackReportOptions(step, { cwd: workspace, resolvedProvider: 'opencode' }, { allowedTools: [] });
    expect(fallback).toBeDefined();
    const start = vi.spyOn(DeepSeekHarness.prototype, 'start');
    for (const options of [
      builder.buildResumeOptions(step, 'old-session', {}),
      builder.buildNewSessionReportOptions(step, { allowedTools: [] }),
      builder.buildNewSessionReportOptions(step, {}),
      builder.buildNewSessionReportOptions(step, { allowedTools: ['Read'] }),
      fallback!,
    ]) {
      const response = await runAgent(undefined, 'Write a tool-free report.', options);
      expect(response.status).toBe('error');
      expect(response.content).toContain('cannot honor allowedTools');
    }
    expect(start).not.toHaveBeenCalled();
    expect(endpoint.requests).toHaveLength(0);
    expect(existsSync(path.join(workspace, 'generated.ts'))).toBe(false);
  });

  it('starts a new interactive SDK session after teardown refusal without restoring or replaying history', async () => {
    vi.stubEnv('DEEPSEEK_BASE_URL', endpoint.baseUrl);
    const plan = createAssistantConversationPlan(workspace, {
      assistantMode: 'assistant', formalSpec: false, formalSpecComments: false,
      modelCheckTimeoutSeconds: 30, provider: 'deepseek-harness', model: 'deepseek-v4-flash',
    });
    const session = createConversationSession({
      cwd: workspace, ctx: plan.ctx, strategy: plan.strategy, formalSpec: false,
      modelCheckTimeoutSeconds: 30, outputMode: 'silent',
    });
    const first = await session.handleUserMessage({ text: 'UNIQUE_OLD_SESSION_HISTORY_SENTINEL' });
    expect(first.kind).toBe('assistant_response');
    const oldId = session.getSessionId();
    expect(oldId).toEqual(expect.any(String));
    expect(resolvePersonaSessionId(loadPersonaSessions(workspace, 'deepseek-harness'), 'interactive', 'deepseek-harness')).toBe(oldId);
    await closeDeepSeekHarnessProcesses();

    const refused = await session.handleUserMessage({ text: 'Do not restore a dead SDK session.' });
    expect(refused).toMatchObject({ kind: 'error', message: expect.stringContaining('next turn will start a new SDK session') });
    expect(session.getSessionId()).toBeUndefined();
    expect(resolvePersonaSessionId(loadPersonaSessions(workspace, 'deepseek-harness'), 'interactive', 'deepseek-harness')).toBeUndefined();
    expect(endpoint.requests).toHaveLength(1);

    const next = await session.handleUserMessage({ text: 'EXPLICIT_NEXT_TURN_FRESH_SESSION' });
    expect(next.kind).toBe('assistant_response');
    expect(session.getSessionId()).toEqual(expect.any(String));
    expect(session.getSessionId()).not.toBe(oldId);
    expect(endpoint.requests).toHaveLength(2);
    expect(JSON.stringify(endpoint.requests[1]?.messages)).toContain('EXPLICIT_NEXT_TURN_FRESH_SESSION');
    expect(JSON.stringify(endpoint.requests[1]?.messages)).not.toContain('UNIQUE_OLD_SESSION_HISTORY_SENTINEL');
  });

  it('refuses an unregistered saved ID before SDK startup and creates a fresh ID only on the next user turn', async () => {
    vi.stubEnv('DEEPSEEK_BASE_URL', endpoint.baseUrl);
    const oldId = 'saved-unregistered-sdk-session';
    updatePersonaSession(workspace, 'interactive', oldId, 'deepseek-harness');
    expect(await hasDeepSeekSessionMarker(oldId)).toBe(false);
    const plan = createAssistantConversationPlan(workspace, {
      assistantMode: 'assistant', formalSpec: false, formalSpecComments: false,
      modelCheckTimeoutSeconds: 30, provider: 'deepseek-harness', model: 'deepseek-v4-flash',
    });
    const session = createConversationSession({
      cwd: workspace, ctx: { ...plan.ctx, sessionId: oldId }, strategy: plan.strategy,
      formalSpec: false, modelCheckTimeoutSeconds: 30, outputMode: 'silent',
    });
    const start = vi.spyOn(DeepSeekHarness.prototype, 'start');
    const refused = await session.handleUserMessage({ text: 'UNREGISTERED_CONTINUATION_MUST_NOT_RUN' });
    expect(refused).toMatchObject({ kind: 'error', message: expect.stringContaining('next turn will start a new SDK session') });
    expect(start).not.toHaveBeenCalled();
    expect(endpoint.requests).toHaveLength(0);
    expect(session.getSessionId()).toBeUndefined();
    expect(resolvePersonaSessionId(loadPersonaSessions(workspace, 'deepseek-harness'), 'interactive', 'deepseek-harness')).toBeUndefined();
    expect(await hasDeepSeekSessionMarker(oldId)).toBe(false);
    const next = await session.handleUserMessage({ text: 'NEXT_USER_TURN_STARTS_WITH_NO_ID' });
    expect(next.kind).toBe('assistant_response');
    expect(new Set(start.mock.contexts).size).toBe(1);
    expect(session.getSessionId()).toEqual(expect.any(String));
    expect(session.getSessionId()).not.toBe(oldId);
    expect(endpoint.requests).toHaveLength(1);
    expect(JSON.stringify(endpoint.requests[0]?.messages)).not.toContain('UNREGISTERED_CONTINUATION_MUST_NOT_RUN');
  });

  it('keeps credential-binding refusal out of interactive fresh-session recovery on repeated turns', async () => {
    vi.stubEnv('DEEPSEEK_BASE_URL', endpoint.baseUrl);
    const plan = createAssistantConversationPlan(workspace, {
      assistantMode: 'assistant', formalSpec: false, formalSpecComments: false,
      modelCheckTimeoutSeconds: 30, provider: 'deepseek-harness', model: 'deepseek-v4-flash',
    });
    const session = createConversationSession({
      cwd: workspace, ctx: plan.ctx, strategy: plan.strategy, formalSpec: false,
      modelCheckTimeoutSeconds: 30, outputMode: 'silent',
    });
    const start = vi.spyOn(DeepSeekHarness.prototype, 'start');
    expect((await session.handleUserMessage({ text: 'Start with the original binding.' })).kind).toBe('assistant_response');
    const startCalls = start.mock.calls.length;
    expect(startCalls).toBeGreaterThan(0);
    const originalId = session.getSessionId();
    const changedKey = 'dummy-changed-binding-credential';
    await writeStore(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${STORE_KEY}\n  CUSTOM_DSH_KEY: ${changedKey}\n`);
    await writeSettings(endpoint.baseUrl, 'CUSTOM_DSH_KEY');
    for (const text of ['Reject the new binding.', 'Still refuse; do not start a fresh session.']) {
      const refused = await session.handleUserMessage({ text });
      expect(refused).toMatchObject({ kind: 'error', message: expect.stringContaining('start a new run or session') });
      expect(JSON.stringify(refused)).not.toContain('next turn will start a new SDK session');
      expect(JSON.stringify(refused)).not.toContain(changedKey);
      expect(session.getSessionId()).toBe(originalId);
      expect(resolvePersonaSessionId(loadPersonaSessions(workspace, 'deepseek-harness'), 'interactive', 'deepseek-harness')).toBe(originalId);
      expect(endpoint.requests).toHaveLength(1);
      expect(start).toHaveBeenCalledTimes(startCalls);
    }
    await writeSettings(endpoint.baseUrl);
    expect((await session.handleUserMessage({ text: 'Use the original binding again.' })).kind).toBe('assistant_response');
    expect(session.getSessionId()).toBe(originalId);
    expect(endpoint.requests).toHaveLength(2);
    expect(new Set(start.mock.contexts).size).toBe(1);
  });

  it('terminates a real coding-tool child on abort before allowing another runtime', async () => {
    endpoint.setMode('held-tool');
    const controller = new AbortController();
    const turn = runTurn({ abortSignal: controller.signal });
    let childPid: number | undefined;
    try {
      await vi.waitFor(async () => {
        childPid = Number(await readFile(path.join(workspace, 'child.pid'), 'utf8'));
        expect(childPid).toBeGreaterThan(0);
      }, { timeout: 10_000, interval: 50 });
      controller.abort();
      expect((await turn).status).not.toBe('done');
      await vi.waitFor(() => {
        expect(() => process.kill(childPid!, 0)).toThrow();
      }, { timeout: 5_000, interval: 50 });
      endpoint.setMode('ok');
      expect((await runTurn()).status).toBe('done');
    } finally {
      controller.abort();
      await turn;
      if (childPid !== undefined) {
        try { process.kill(childPid, 'SIGKILL'); } catch { /* Child already exited. */ }
      }
    }
  });

  it('maps real SDK assistant/message reasoning to thinking and text-only content to text', async () => {
    endpoint.setMode('assistant-message-reasoning');
    const reasoningEvents: StreamEvent[] = [];
    const reasoning = await runTurn({ onStream: (event) => reasoningEvents.push(event) });

    expect(reasoning.status).toBe('done');
    expect(reasoningEvents.some((event) => event.type === 'thinking' && event.data.thinking === 'local mock reasoning'))
      .toBe(true);
    expect(reasoningEvents.some((event) => event.type === 'text' && event.data.text === 'confirmed')).toBe(true);

    endpoint.setMode('assistant-message-text-only');
    const textEvents: StreamEvent[] = [];
    const textOnly = await runTurn({ sessionId: reasoning.sessionId!, onStream: (event) => textEvents.push(event) });

    expect(textOnly.status).toBe('done');
    expect(textEvents.some((event) => event.type === 'text' && event.data.text === 'confirmed')).toBe(true);
    expect(textEvents.some((event) => event.type === 'thinking')).toBe(false);
  });

  it('prefers a same-reference launch environment value over the store', async () => {
    const response = await runTurn({ childProcessEnv: { DEEPSEEK_API_KEY: ENV_KEY } });

    expect(response.status).toBe('done');
    expect(endpoint.requests.at(-1)?.apiKey).toContain(ENV_KEY);
    expect(endpoint.requests.at(-1)?.apiKey).not.toContain(STORE_KEY);
  });

  it('does not substitute a different reference for the selected reference', async () => {
    await writeSettings(endpoint.baseUrl, 'CUSTOM_DSH_KEY');
    const response = await runTurn({ childProcessEnv: { DEEPSEEK_API_KEY: ENV_KEY } });

    expect(response.status).toBe('error');
    expect(endpoint.requests).toHaveLength(0);
    expect(response.content).not.toContain(STORE_KEY);
    expect(response.content).not.toContain(ENV_KEY);
    await expect(readFile(storePath, 'utf8')).resolves.toContain(STORE_KEY);
  });

  it('reflects a store update on a later turn of the same session', async () => {
    const first = await runTurn({ prompt: 'First turn.' });
    expect(first.status).toBe('done');
    expect(endpoint.requests.at(-1)?.apiKey).toContain(STORE_KEY);

    await writeStore(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${UPDATED_STORE_KEY}\n`);

    let attempts = 0;
    await vi.waitFor(async () => {
      attempts += 1;
      const turn = await runTurn({ sessionId: first.sessionId!, prompt: `Reload check ${attempts}.` });
      expect(turn.status).toBe('done');
      expect(endpoint.requests.at(-1)?.apiKey).toContain(UPDATED_STORE_KEY);
    }, { timeout: WATCHER_TIMEOUT_MS, interval: WATCHER_POLL_INTERVAL_MS });
  });

  it('refuses a changed credential binding for an active session without another request', async () => {
    const first = await runTurn({ prompt: 'Start with the original binding.' });
    expect(first.status).toBe('done');
    const sessionId = first.sessionId!;
    expect(endpoint.requests).toHaveLength(1);

    await writeSettings(endpoint.baseUrl, 'CUSTOM_DSH_KEY');
    const changed = await runTurn({
      sessionId,
      prompt: 'Do not run with the new binding in the old session.',
      childProcessEnv: { CUSTOM_DSH_KEY: 'dummy-changed-binding-credential' },
    });

    expect(changed).toMatchObject({
      status: 'error',
      sessionId,
      failureCategory: 'credential_binding_changed',
    });
    expect(changed.content).toContain('changed during this session');
    expect(endpoint.requests).toHaveLength(1);
  });

  it('fails a later turn after the store entry is deleted without sending another request', async () => {
    const first = await runTurn({ prompt: 'First turn.' });
    expect(first.status).toBe('done');

    await rm(storePath);

    let turnsAfterDeletion = 0;
    let requestsBeforeFailure: number | undefined;
    let failed: Awaited<ReturnType<typeof callDeepSeekHarness>> | undefined;
    await vi.waitFor(async () => {
      turnsAfterDeletion += 1;
      const requestsBeforeTurn = endpoint.requests.length;
      const turn = await runTurn({ sessionId: first.sessionId!, prompt: `After deletion ${turnsAfterDeletion}.` });
      if (turn.status !== 'done') {
        failed = turn;
        requestsBeforeFailure = requestsBeforeTurn;
      }
      expect(failed).toBeDefined();
    }, { timeout: WATCHER_TIMEOUT_MS, interval: WATCHER_POLL_INTERVAL_MS });

    expect(failed?.content).not.toContain(STORE_KEY);
    // The official runtime may complete one more turn from its last-good credential while its
    // watcher observes the deletion; the turn that fails must not send another request.
    expect(endpoint.requests.length).toBe(requestsBeforeFailure);
  });

  it('reports a malformed store without echoing the document or its path', async () => {
    await writeStore('version: 1\nrefs: [broken\n');
    const response = await runTurn();

    expect(response.status).toBe('error');
    expect(endpoint.requests).toHaveLength(0);
    expect(response.content).not.toContain('broken');
    expect(response.content).not.toContain(storePath);
    expect(response.content).toContain('DSH_HOME');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails closed for an unreadable store without changing permissions or sending a request', async () => {
      const before = await readFile(storePath);
      await chmod(storePath, 0o000);
      try {
        const response = await runTurn();
        expect(response.status).toBe('error');
        expect(endpoint.requests).toHaveLength(0);
        expect(response.content).not.toContain(STORE_KEY);
        expect(response.content).not.toContain(storePath);
        expect((await stat(storePath)).mode & 0o777).toBe(0);
      } finally {
        await chmod(storePath, 0o600);
      }
      expect(await readFile(storePath)).toEqual(before);
    },
  );

  it('keeps an in-flight request on its initial credential and reloads for later turns', async () => {
    const held = endpoint.holdNextResponse();
    const pending = runTurn();
    try {
      await Promise.race([
        held.received,
        pending.then(() => { throw new Error('Turn ended before reaching mock endpoint'); }),
      ]);
      await writeStore(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${UPDATED_STORE_KEY}\n`);
      expect(endpoint.requests).toHaveLength(1);
      expect(endpoint.requests[0]?.apiKey).toContain(STORE_KEY);
    } finally {
      held.release();
    }
    const first = await pending;
    expect(first.status).toBe('done');
    expect(endpoint.requests).toHaveLength(1);
    await vi.waitFor(async () => {
      expect((await runTurn({ sessionId: first.sessionId! })).status).toBe('done');
      expect(endpoint.requests.at(-1)?.apiKey).toContain(UPDATED_STORE_KEY);
    }, { timeout: WATCHER_TIMEOUT_MS, interval: WATCHER_POLL_INTERVAL_MS });
  });

  it('observes malformed live reload independently from deletion and recovers after repair', async () => {
    const first = await runTurn();
    expect(first.status).toBe('done');
    await writeStore('version: 1\nrefs: [broken\n');
    // Wait past the official watcher's debounce, then observe its last-good policy.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const afterCorruption = await runTurn({ sessionId: first.sessionId! });
    expect(afterCorruption.status).toBe('done');
    expect(endpoint.requests.at(-1)?.apiKey).toContain(STORE_KEY);
    await writeStore(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${UPDATED_STORE_KEY}\n`);
    await vi.waitFor(async () => {
      expect((await runTurn({ sessionId: first.sessionId! })).status).toBe('done');
      expect(endpoint.requests.at(-1)?.apiKey).toContain(UPDATED_STORE_KEY);
    }, { timeout: WATCHER_TIMEOUT_MS, interval: WATCHER_POLL_INTERVAL_MS });
  });

  it('keeps an echoed dummy credential out of TAKT output and the runtime session store', async () => {
    endpoint.setMode('auth-echo');
    await mkdir(path.join(root, 'reports'));
    const logger = createProviderEventLogger({
      logsDir: path.join(root, 'reports'), sessionId: 'credential-echo', runId: 'credential-echo', enabled: true,
    });
    const events: unknown[] = [];
    const response = await runTurn({ prompt: 'Trigger the mocked auth rejection.', onStream: (event) => {
      events.push(event);
      logger.logEvent({ provider: 'deepseek-harness', providerModel: 'deepseek-v4-flash', step: 'smoke' }, event);
    } });

    await closeDeepSeekHarnessProcesses();

    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]?.apiKey).toContain(STORE_KEY);
    expect(response.status).toBe('error');
    expect(response.content).not.toContain(STORE_KEY);
    expect(response.content).toMatch(/credential|auth/iu);
    expect(JSON.stringify(events)).not.toContain(STORE_KEY);
    expect(await readFile(logger.filepath, 'utf8')).not.toContain(STORE_KEY);

    const timestamp = '2026-09-24T12:00:00.000Z';
    const report = renderTraceReportFromRecords({
      tracePath: path.join(root, 'reports', 'trace.md'), workflowName: 'smoke', task: 'Credential echo probe',
      runSlug: 'credential-echo', status: 'failed', iterations: 1, endTime: timestamp,
    }, [{
      type: 'step_complete', step: 'smoke', persona: 'worker', iteration: 1,
      status: response.status, content: response.content, instruction: 'Trigger the mocked auth rejection.', timestamp,
    }], [], 'full');
    expect(report).toContain(response.content);
    expect(report).not.toContain(STORE_KEY);

    const leakedIntoRuntimeStore = collectSecretHits(dshHome, STORE_KEY);
    expect(
      leakedIntoRuntimeStore,
      'the pinned DeepSeek Harness runtime persisted the echoed dummy credential into its session store',
    ).toEqual([]);
  });
});
