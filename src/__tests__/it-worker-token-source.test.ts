/**
 * `takt worker` takes its registration token from exactly one of TAKT_WORKER_TOKEN, --token-file
 * (mode 600) or the deprecated --token, so the token does not have to sit in the process arguments
 * where `ps` shows it. Starts the real CLI (`bin/takt`, which loads `dist/`; run `npm run build`
 * first) against an HTTP server this test holds open, and reads the started process arguments.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { UPDATE_NOTIFIER_DISABLED_ARG } from '../shared/utils/updateNotifierProcess.js';
import { captureOwnedChild, terminateOwnedProcess, type OwnedProcess } from './helpers/owned-process.js';

const START_WAIT_MS = 30_000;
const TAKT_BIN = join(process.cwd(), 'bin', 'takt');

/**
 * A token the registry never issued, built at run time so no token text sits in this file. The worker
 * reads its identity from the header before connecting, so the header is a real identity.
 */
function fakeToken(): string {
  const header = Buffer.from(JSON.stringify({ workerId: 'w1', registrationGeneration: randomUUID() })).toString('base64url');
  return [header, ['Zq', String(randomInt(10_000_000, 99_999_999)), 'Zq'].join('')].join('.');
}

interface StartedWorker {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
}

let home: string;
let server: Server;
let url: string;
let authorizations: (string | undefined)[];
const started: { child: ChildProcess; owned: OwnedProcess | undefined }[] = [];

function tokenFile(token: string, mode: number): string {
  const path = join(home, `worker-token-${randomInt(1_000_000)}`);
  writeFileSync(path, `${token}\n`);
  chmodSync(path, mode);
  return path;
}

async function startWorker(args: readonly string[], environmentToken?: string): Promise<StartedWorker> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TAKT_CONFIG_DIR: join(home, '.takt'), NODE_OPTIONS: '' };
  delete env.TAKT_WORKER_TOKEN;
  if (environmentToken !== undefined) env.TAKT_WORKER_TOKEN = environmentToken;
  const child = spawn(process.execPath, [TAKT_BIN, UPDATE_NOTIFIER_DISABLED_ARG, 'worker', '--url', url, ...args], {
    cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  const entry: { child: ChildProcess; owned: OwnedProcess | undefined } = { child, owned: undefined };
  started.push(entry);
  entry.owned = await captureOwnedChild(child);
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

/** Resolves when the server holds a connection, or when the worker exits first (then the reason is in its output). */
async function connectionOrExit(worker: StartedWorker): Promise<'connected' | 'exited'> {
  const connected = new Promise<'connected'>((resolve) => {
    const poll = setInterval(() => { if (authorizations.length > 0) { clearInterval(poll); resolve('connected'); } }, 20);
    void worker.exited.finally(() => clearInterval(poll));
  });
  const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Worker neither connected nor exited')), START_WAIT_MS));
  return Promise.race([connected, worker.exited.then(() => 'exited' as const), timeout]);
}

function processArguments(pid: number): string {
  if (process.platform === 'linux') return readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').join(' ');
  const result = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function exitedBeforeConnecting(worker: StartedWorker, code: number | null): void {
  expect(code, worker.stderr()).not.toBe(0);
  expect(code, worker.stderr()).not.toBeNull();
  expect(authorizations).toEqual([]);
}

beforeEach(async () => {
  home = mkdtempSync(join(getGlobalConfigDir(), 'worker-token-'));
  mkdirSync(join(home, '.takt'), { recursive: true });
  authorizations = [];
  // Holds every request open: the worker stays at "connecting" while the test reads its arguments.
  server = createServer((request) => { authorizations.push(request.headers.authorization); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const { child, owned } of started.splice(0)) {
    if (owned !== undefined) await terminateOwnedProcess(owned, () => child.exitCode !== null || child.signalCode !== null);
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

it.each(['TAKT_WORKER_TOKEN', '--token-file'] as const)('keeps the worker token out of the started process arguments: %s', async (way) => {
  const token = fakeToken();
  const worker = way === 'TAKT_WORKER_TOKEN' ? await startWorker([], token)
    : await startWorker(['--token-file', tokenFile(token, 0o600)]);
  expect(await connectionOrExit(worker), worker.stderr()).toBe('connected');
  expect(authorizations).toEqual([`Bearer ${token}`]);
  const args = processArguments(worker.child.pid!);
  expect(args).toContain('worker');
  expect(args).not.toContain(token);
  expect(worker.stdout()).not.toContain(token);
  expect(worker.stderr()).not.toContain(token);
});

it('warns that --token is visible to ps and still connects', async () => {
  const token = fakeToken();
  const worker = await startWorker(['--token', token]);
  expect(await connectionOrExit(worker), worker.stderr()).toBe('connected');
  expect(authorizations).toEqual([`Bearer ${token}`]);
  await vi.waitFor(() => expect(worker.stderr().split('\n').filter((line) => line.includes('--token') && /\bps\b/u.test(line))).toHaveLength(1));
  expect(worker.stderr()).not.toContain(token);
  expect(worker.stdout()).not.toContain(token);
});

it.skipIf(process.platform === 'win32')('refuses a token file that group or others can read', async () => {
  const token = fakeToken();
  const path = tokenFile(token, 0o644);
  const worker = await startWorker(['--token-file', path]);
  expect(await connectionOrExit(worker), worker.stderr()).toBe('exited');
  exitedBeforeConnecting(worker, await worker.exited);
  expect(worker.stderr()).toContain(path);
  expect(worker.stderr()).toContain('644');
  expect(worker.stderr()).not.toContain(token);
  expect(worker.stdout()).not.toContain(token);
});

it.each([
  { ways: ['TAKT_WORKER_TOKEN', '--token-file'], named: '(TAKT_WORKER_TOKEN, --token-file)' },
  { ways: ['--token-file', '--token'], named: '(--token-file, --token)' },
  { ways: ['TAKT_WORKER_TOKEN', '--token-file', '--token'], named: '(TAKT_WORKER_TOKEN, --token-file, --token)' },
])('stops when the worker token is given in more than one way and names only the ways: $named', async ({ ways, named }) => {
  const tokens = { environment: fakeToken(), file: fakeToken(), argument: fakeToken() };
  const path = tokenFile(tokens.file, 0o600);
  const args = [...(ways.includes('--token-file') ? ['--token-file', path] : []),
    ...(ways.includes('--token') ? ['--token', tokens.argument] : [])];
  const worker = await startWorker(args, ways.includes('TAKT_WORKER_TOKEN') ? tokens.environment : undefined);
  expect(await connectionOrExit(worker), worker.stderr()).toBe('exited');
  exitedBeforeConnecting(worker, await worker.exited);
  expect(worker.stderr().split('\n').filter((line) => line.includes(named))).toHaveLength(1);
  for (const output of [worker.stderr(), worker.stdout()]) {
    for (const token of Object.values(tokens)) expect(output).not.toContain(token);
    expect(output).not.toContain(path);
  }
});
