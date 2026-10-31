import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, vi } from 'vitest';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { readDaemonOwner } from '../../infra/daemon/owner.js';
import type { ConversationClientSnapshot } from '../../features/manager/conversationIpcClient.js';
import { captureOwnedChild, terminateOwnedProcess, type OwnedProcess } from './owned-process.js';

const built = (path: string): string => pathToFileURL(join(process.cwd(), 'dist', path)).href;
const require = createRequire(import.meta.url);

export interface IpcObservation {
  event: 'request' | 'response' | 'transfer' | 'connection' | 'refresh' | 'provider_start' | 'provider_complete' | 'service_start' | 'service_end' | 'event_loop'
    | 'repository_start' | 'repository_end';
  pid: number;
  at: number;
  method?: string;
  requestId?: string;
  transferId?: string;
  frameKind?: string;
  purpose?: string;
  conversationId?: string;
  agent?: string;
  connection?: ConversationClientSnapshot['connection'];
  error?: string | null;
  intervalMs?: number;
  callId?: number;
  parentCallId?: number;
  attachmentId?: string;
  delayMs?: number;
}

interface Screen {
  frame: string;
  frames: string[];
  snapshot: Pick<ConversationClientSnapshot, 'connection' | 'readStatus' | 'state' | 'error'>;
}

export interface ConcurrentTui {
  child: ChildProcess;
  inspect(): Promise<Screen>;
  submit(text: string): Promise<void>;
  ready(): Promise<void>;
}

export function concurrentTuiFixture(kind: 'manager' | 'director') {
  const directory = getGlobalConfigDir();
  const repository = join(directory, 'repository');
  const home = join(directory, 'home');
  mkdirSync(repository); mkdirSync(home);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'pipe' });
  const canonical = realpathSync(repository);
  writeFileSync(join(directory, 'config.yaml'), 'provider: mock\nlanguage: en\nmanager:\n  auto_run: false\n');
  const reply = 'The shared conversation reply is complete.';
  const scenario = join(directory, 'scenario.json');
  writeFileSync(scenario, JSON.stringify(Array.from({ length: 8 }, () => ({
    persona: kind, content: reply, structured_output: { message: reply, summary: null },
  }))));
  const observations = join(directory, 'concurrent-observations.jsonl');
  writeFileSync(observations, '');
  const gate = join(directory, 'release-provider');
  const harness = join(directory, 'concurrent-ink.mjs');
  writeFileSync(harness, `
import { render } from ${JSON.stringify(pathToFileURL(require.resolve('ink-testing-library')).href)};
import { appendFileSync } from 'node:fs';
const record = (value) => appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ ...value, pid: process.pid, at: Date.now() }) + '\\n');
export async function mountInk(buildTree) {
  let settle, fail;
  const completed = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
  const tree = buildTree({ settle, fail });
  const client = tree.props.client;
  // 実際に登録された周期と、そのコールバックが起こす refresh を対応付ける。
  const schedule = globalThis.setInterval;
  let intervalMs;
  globalThis.setInterval = (callback, milliseconds, ...args) => schedule((...values) => {
    intervalMs = milliseconds;
    try { callback(...values); } finally { intervalMs = undefined; }
  }, milliseconds, ...args);
  const refresh = client.refresh;
  client.refresh = function(...args) {
    record({ event: 'refresh', intervalMs });
    return refresh.apply(this, args);
  };
  const app = render(tree);
  Object.defineProperties(app.stdout, {
    columns: { configurable: true, value: 120 }, rows: { configurable: true, value: 60 },
  });
  app.stdout.emit('resize');
  const receive = (message) => {
    if (message.kind === 'key') app.stdin.write(message.input);
    if (message.kind === 'inspect') {
      const { connection, readStatus, state, error } = client.getSnapshot();
      process.send({ kind: 'screen', id: message.id, frame: app.lastFrame() ?? '', frames: app.frames,
        snapshot: { connection, readStatus, state, error } });
    }
  };
  process.on('message', receive);
  process.send({ kind: 'mounted' });
  try { return await completed; }
  finally { process.off('message', receive); app.unmount(); globalThis.setInterval = schedule; }
}
`);
  const preload = join(directory, 'concurrent-observe.mjs');
  writeFileSync(preload, `
import { registerHooks } from 'node:module';
import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Socket } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
const record = (value) => appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ ...value, pid: process.pid, at: Date.now() }) + '\\n');
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
setInterval(() => { record({ event: 'event_loop', delayMs: lag.max / 1000000 }); lag.reset(); }, 1000).unref();
globalThis.recordConcurrentIpc = record;
globalThis.concurrentServiceContext = new AsyncLocalStorage();
globalThis.concurrentRepositoryCall = 0;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url === ${JSON.stringify(built('features/tui/inkMount.js'))}
      ? { url: ${JSON.stringify(pathToFileURL(harness).href)}, shortCircuit: true } : resolved;
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url === ${JSON.stringify(built('infra/task/repositoryDirectory.js'))}) {
      const source = String(loaded.source).replace('export async function resolveGitRepositoryDirectory(', 'async function observedRepositoryDirectory(');
      if (source === String(loaded.source)) throw new Error('Repository observation hook did not match');
      return { ...loaded, source: source + \`
export async function resolveGitRepositoryDirectory(...args) {
  const parent = globalThis.concurrentServiceContext.getStore();
  const metadata = { callId: ++globalThis.concurrentRepositoryCall, parentCallId: parent?.callId, attachmentId: parent?.attachmentId };
  globalThis.recordConcurrentIpc({ event: 'repository_start', ...metadata });
  try { return await observedRepositoryDirectory(...args); }
  finally { globalThis.recordConcurrentIpc({ event: 'repository_end', ...metadata }); }
}
\` };
    }
    if (url !== ${JSON.stringify(built('features/manager/conversationService.js'))}) return loaded;
    // 呼び出しと返却の間に待機を追加せず、公開 service 操作の所要時間だけを観測する。
    const source = String(loaded.source).replace('export function createConversationService(', 'function observedConversationService(');
    if (source === String(loaded.source)) throw new Error('Conversation service observation hook did not match');
    return { ...loaded, source: source + \`
export function createConversationService(input) {
  const service = observedConversationService(input);
  let nextCall = 0;
  for (const method of ['open', 'snapshot', 'submit']) {
    const original = service[method];
    service[method] = async function(...args) {
      const callId = ++nextCall;
      const metadata = { method, callId, requestId: method === 'submit' ? args[0].requestId : undefined,
        attachmentId: method === 'snapshot' ? args[0] : method === 'submit' ? args[0].attachmentId : undefined };
      globalThis.recordConcurrentIpc({ event: 'service_start', ...metadata });
      try { return await globalThis.concurrentServiceContext.run(metadata, () => original.apply(this, args)); }
      finally { globalThis.recordConcurrentIpc({ event: 'service_end', ...metadata }); }
    };
  }
  return service;
}
\` };
  },
});
const { ConversationFrameDecoder } = await import(${JSON.stringify(built('features/daemon/conversationFrames.js'))});
const { ConversationIpcClient } = await import(${JSON.stringify(built('features/manager/conversationIpcClient.js'))});
const { MockProvider } = await import(${JSON.stringify(built('infra/providers/mock.js'))});
const connect = ConversationIpcClient.prototype.connect;
const clients = new WeakSet();
ConversationIpcClient.prototype.connect = function(...args) {
  if (!clients.has(this)) {
    clients.add(this);
    let previous;
    const observe = () => {
      const { connection, error, state } = this.getSnapshot();
      const next = JSON.stringify({ connection, error, conversationId: state?.conversationId });
      if (next !== previous) { previous = next; record({ event: 'connection', connection, error, conversationId: state?.conversationId }); }
    };
    this.subscribe(observe); observe();
  }
  return connect.apply(this, args);
};
const setup = MockProvider.prototype.setup;
MockProvider.prototype.setup = function(config) {
  const agent = setup.call(this, config);
  return { ...agent, call: async (prompt, options) => {
    record({ event: 'provider_start', agent: config.name });
    const deadline = Date.now() + 20000;
    while (!existsSync(${JSON.stringify(gate)})) {
      options.abortSignal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error('Test provider was not released');
      await delay(20);
    }
    const result = await agent.call(prompt, options);
    record({ event: 'provider_complete', agent: config.name });
    return result;
  } };
};
const observed = new WeakSet();
const write = Socket.prototype.write;
Socket.prototype.write = function(chunk, ...args) {
  let value;
  try { value = JSON.parse(String(chunk)); } catch { /* 標準出力の Socket は IPC フレームではない。 */ }
  if (value?.type === 'request' && value.protocolVersion === 1) {
    record({ event: 'request', method: value.method, requestId: value.requestId, conversationId: value.params?.conversationId,
      attachmentId: value.params?.attachmentId });
    if (!observed.has(this)) {
      observed.add(this);
      const decoder = new ConversationFrameDecoder();
      this.on('data', (bytes) => {
        for (const frame of decoder.decode(bytes)) {
          if (frame.type === 'response') record({ event: 'response', requestId: frame.requestId });
          if (frame.type === 'event' && ['transfer_start', 'transfer_end', 'transfer_error'].includes(frame.output?.kind)) {
            record({ event: 'transfer', conversationId: frame.conversationId, transferId: frame.output.transferId,
              frameKind: frame.output.kind, purpose: frame.output.purpose });
          }
        }
      });
    }
  }
  return write.call(this, chunk, ...args);
};
`);
  const children: Array<{ child: ChildProcess; owned: OwnedProcess | undefined }> = [];
  const readObservations = (): IpcObservation[] => readFileSync(observations, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as IpcObservation);
  const start = async (): Promise<ConcurrentTui> => {
    const module = kind === 'manager' ? 'features/manager/runManager.js' : 'features/director/runDirector.js';
    const entry = kind === 'manager' ? 'runManager' : 'runDirector';
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', `
Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
const { ${entry} } = await import(${JSON.stringify(built(module))});
try { await ${entry}(${JSON.stringify({ cwd: canonical, agentOverrides: { provider: 'mock' } })}); }
catch (error) { process.send({ kind: 'failure', message: String(error) }); process.exitCode = 1; }
finally { process.disconnect(); }
`], { cwd: canonical, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env,
      HOME: home, TAKT_CONFIG_DIR: directory, TAKT_MOCK_SCENARIO: scenario, TAKT_NO_TTY: '',
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    } });
    const messages: Array<{ kind: string; id?: number; message?: string } & Partial<Screen>> = [];
    let errors = '';
    child.stdout!.resume();
    child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    child.on('message', (message) => { messages.push(message as typeof messages[number]); });
    const tracked = { child, owned: undefined as OwnedProcess | undefined };
    children.push(tracked);
    tracked.owned = await captureOwnedChild(child);
    const healthy = (): void => {
      expect(messages.find(({ kind }) => kind === 'failure')?.message, errors).toBeUndefined();
      expect(child.exitCode, errors).toBeNull();
      expect(child.signalCode, errors).toBeNull();
    };
    await vi.waitFor(() => { healthy(); expect(messages.some(({ kind }) => kind === 'mounted'), errors).toBe(true); }, { timeout: 30000 });
    let nextId = 0;
    const inspect = async (): Promise<Screen> => {
      healthy();
      const id = ++nextId;
      child.send({ kind: 'inspect', id });
      await vi.waitFor(() => { healthy(); expect(messages.some((message) => message.id === id), errors).toBe(true); }, { timeout: 3000 });
      return messages.splice(messages.findIndex((message) => message.id === id), 1)[0] as Screen;
    };
    const ready = async (): Promise<void> => {
      await vi.waitFor(async () => expect((await inspect()).snapshot).toMatchObject({ connection: 'connected', readStatus: 'complete' }), { timeout: 10000 });
    };
    const submit = async (text: string): Promise<void> => {
      await ready();
      child.send({ kind: 'key', input: text });
      await vi.waitFor(async () => expect((await inspect()).frame).toContain(text), { timeout: 3000 });
      child.send({ kind: 'key', input: '\r' });
    };
    return { child, inspect, ready, submit };
  };
  const release = (): void => { writeFileSync(gate, 'release'); };
  const cleanup = async (): Promise<void> => {
    release();
    for (const { child, owned } of children) {
      if (owned !== undefined) await terminateOwnedProcess(owned, () => child.exitCode !== null || child.signalCode !== null);
    }
    const owner = readDaemonOwner(directory);
    if (owner !== undefined) await terminateOwnedProcess({ pid: owner.pid, identity: owner.identity }, () => false);
  };
  return { directory, reply, start, release, readObservations, cleanup };
}
