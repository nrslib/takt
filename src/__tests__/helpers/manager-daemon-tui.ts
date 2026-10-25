import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect, vi } from 'vitest';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { readDaemonOwner } from '../../infra/daemon/owner.js';
import { ConversationStore } from '../../infra/conversations/store.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { captureOwnedChild, terminateOwnedProcess } from './owned-process.js';

const built = (path: string): string => pathToFileURL(join(process.cwd(), 'dist', path)).href;
const require = createRequire(import.meta.url);

interface Observation {
  event: 'write' | 'provider_start' | 'provider_complete' | 'request';
  pid: number;
  conversationId?: string;
  revision?: number;
  running?: boolean;
  approvalState?: 'reserved' | 'registered' | null;
  model?: string;
  summaryRequest?: boolean;
  method?: string;
  command?: string;
  operationId?: string;
}

export interface ManagerTuiProcess {
  child: ChildProcess;
  key(input: string): void;
  frame(): Promise<string>;
  ready(runningOperationId?: string | null): Promise<void>;
  exit(): Promise<void>;
}

export function managerDaemonFixture(language: 'ja' | 'en') {
  const directory = getGlobalConfigDir();
  const repository = join(directory, 'team-a', 'takt3');
  const home = join(directory, 'home');
  mkdirSync(home);
  const createRepository = (path: string): string => {
    mkdirSync(path, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: path, stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial'],
      { cwd: path, stdio: 'pipe' });
    return realpathSync(path);
  };
  createRepository(repository);
  writeFileSync(join(directory, 'config.yaml'), `provider: mock\nlanguage: ${language}\nmanager:\n  auto_run: false\n`);
  const observations = join(directory, 'observations.jsonl');
  writeFileSync(observations, '');
  const gate = join(directory, 'provider-release');
  const release = (): void => { writeFileSync(gate, 'release'); };
  const scenario = join(directory, 'scenario.json');
  const summary = { objective: 'Export CSV from the daemon', outOfScope: ['Remote upload'],
    acceptanceCriteria: ['CSV is available'], constraints: ['Keep the existing format'] };
  writeFileSync(scenario, JSON.stringify(Array.from({ length: 8 }, () => ({ persona: 'manager', content: '',
    structured_output: { message: 'The daemon completed this request.', summary: { ...summary, repositoryDirectory: repository } } }))));
  const harness = join(directory, 'ink-harness.mjs');
  writeFileSync(harness, `
import { render } from ${JSON.stringify(pathToFileURL(require.resolve('ink-testing-library')).href)};
export async function mountInk(buildTree) {
  let settle, fail;
  const completed = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
  const tree = buildTree({ settle, fail });
  const client = tree.props.client;
  const app = render(tree);
  const receive = (message) => {
    if (message.kind === 'key') app.stdin.write(message.input);
    if (message.kind === 'frame') process.send({ kind: 'frame', id: message.id, frame: app.lastFrame() ?? '' });
    if (message.kind === 'ready') {
      const state = client.getSnapshot();
      process.send({ kind: 'ready', id: message.id, ready: state.connection === 'connected' && state.readStatus === 'complete'
        && (!Object.hasOwn(message, 'runningOperationId') || (state.state?.running?.operationId ?? null) === message.runningOperationId) });
    }
  };
  process.on('message', receive);
  process.send({ kind: 'mounted' });
  try { return await completed; }
  finally { process.off('message', receive); app.unmount(); }
}
`);
  const preload = join(directory, 'observe.mjs');
  // 本文と capability は記録せず、実処理の所有 PID と公開操作だけを観測する。
  writeFileSync(preload, `
import { registerHooks } from 'node:module';
import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Socket } from 'node:net';
import { ConversationStore } from ${JSON.stringify(built('infra/conversations/store.js'))};
import { MockProvider } from ${JSON.stringify(built('infra/providers/mock.js'))};
import { getLabel } from ${JSON.stringify(built('shared/i18n/index.js'))};
const record = (value) => appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ ...value, pid: process.pid }) + '\\n');
const save = ConversationStore.prototype.write;
ConversationStore.prototype.write = function(value) {
  const result = save.call(this, value);
  record({ event: 'write', conversationId: value.id, revision: value.revision, running: value.running !== null,
    approvalState: value.approval?.state ?? null });
  return result;
};
const setup = MockProvider.prototype.setup;
MockProvider.prototype.setup = function(config) {
  const agent = setup.call(this, config);
  return { ...agent, call: async (prompt, options) => {
    record({ event: 'provider_start', model: options.model,
      summaryRequest: prompt.includes(getLabel('manager.goSummaryRequest', ${JSON.stringify(language)})) });
    const deadline = Date.now() + 15000;
    while (!existsSync(${JSON.stringify(gate)})) {
      if (options.abortSignal?.aborted) throw options.abortSignal.reason;
      if (Date.now() >= deadline) throw new Error('Test provider was not released');
      await delay(20);
    }
    const result = await agent.call(prompt, options);
    record({ event: 'provider_complete' });
    return result;
  } };
};
const write = Socket.prototype.write;
Socket.prototype.write = function(chunk, ...args) {
  let value;
  try { value = JSON.parse(String(chunk)); } catch { /* 通信以外の標準出力も Socket を使う。 */ }
  if (value?.type === 'request' && value.protocolVersion === 1) record({ event: 'request', method: value.method,
    conversationId: value.params?.conversationId, command: value.params?.command?.kind, revision: value.params?.command?.revision,
    operationId: value.params?.command?.operationId });
  return write.call(this, chunk, ...args);
};
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  return resolved.url === ${JSON.stringify(built('features/tui/inkMount.js'))}
    ? { url: ${JSON.stringify(pathToFileURL(harness).href)}, shortCircuit: true } : resolved;
} });
`);
  const clients: Array<{ child: ChildProcess; owned: Awaited<ReturnType<typeof captureOwnedChild>> }> = [];
  const readObservations = (): Observation[] => readFileSync(observations, 'utf8').trim().split('\n')
    .filter(Boolean).map((line) => JSON.parse(line) as Observation);
  const state = (path = repository) => {
    const assignment = { kind: 'repository' as const, repositoryDirectory: path };
    return new ConversationStore(directory).read(conversationId(assignment), assignment);
  };
  const start = async (path: string, model: string | undefined): Promise<ManagerTuiProcess> => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', `
Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
const { runManager } = await import(${JSON.stringify(built('features/manager/runManager.js'))});
try { await runManager(${JSON.stringify({ cwd: path, agentOverrides: { provider: 'mock', model } })}); }
catch (error) { process.send({ kind: 'failure', message: String(error) }); process.exitCode = 1; }
finally { process.disconnect(); }
`], { cwd: path, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env,
      HOME: home, TAKT_CONFIG_DIR: directory, TAKT_MOCK_SCENARIO: scenario,
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, TAKT_NO_TTY: '',
    } });
    const messages: Array<{ kind: string; id?: number; frame?: string; message?: string; ready?: boolean }> = [];
    let errors = '';
    child.stdout!.resume();
    child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    child.on('message', (message) => { messages.push(message as typeof messages[number]); });
    const owned = await captureOwnedChild(child);
    clients.push({ child, owned });
    let id = 0;
    await vi.waitFor(() => {
      expect(messages.find((message) => message.kind === 'failure')?.message, errors).toBeUndefined();
      expect(messages.some((message) => message.kind === 'mounted'), errors).toBe(true);
    }, { timeout: 10000 });
    const key = (input: string): void => { child.send({ kind: 'key', input }); };
    const frame = async (): Promise<string> => {
      const request = ++id;
      child.send({ kind: 'frame', id: request });
      await vi.waitFor(() => expect(messages.some((message) => message.id === request), errors).toBe(true));
      const index = messages.findIndex((message) => message.id === request);
      return messages.splice(index, 1)[0]!.frame!;
    };
    const exit = async (): Promise<void> => {
      key('\x03');
      await vi.waitFor(() => expect(child.exitCode, errors).toBe(0), { timeout: 10000 });
    };
    const ready = async (runningOperationId?: string | null): Promise<void> => {
      await vi.waitFor(async () => {
        const request = ++id;
        child.send({ kind: 'ready', id: request, ...(runningOperationId === undefined ? {} : { runningOperationId }) });
        await vi.waitFor(() => expect(messages.some((message) => message.id === request), errors).toBe(true));
        const index = messages.findIndex((message) => message.id === request);
        expect(messages.splice(index, 1)[0]!.ready).toBe(true);
      }, { timeout: 10000 });
    };
    return { child, key, frame, ready, exit };
  };
  const cleanup = async (): Promise<void> => {
    release();
    for (const { child, owned } of clients) {
      if (owned !== undefined) await terminateOwnedProcess(owned, () => child.exitCode !== null || child.signalCode !== null);
    }
    const owner = readDaemonOwner(directory);
    if (owner !== undefined) await terminateOwnedProcess({ pid: owner.pid, identity: owner.identity }, () => false);
  };
  return { directory, repository, summary, start, release, state, readObservations, cleanup, createRepository };
}

export async function waitForManager(tui: ManagerTuiProcess, text: string): Promise<void> {
  await vi.waitFor(async () => {
    const frame = await tui.frame();
    expect(frame).toContain(text);
    if (text === 'Discuss your goal' || text === 'ゴールを相談してください') expect(frame).not.toMatch(/Working|処理中/u);
  }, { timeout: 5000 });
}

export async function submitManagerText(tui: ManagerTuiProcess, text: string): Promise<void> {
  await tui.ready();
  tui.key(text);
  await waitForManager(tui, text);
  tui.key('\r');
}
