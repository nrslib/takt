/**
 * The worker token given through TAKT_WORKER_TOKEN reaches neither the environment nor the arguments
 * of the task process the worker starts. A guard: the current filter already holds this.
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startWorker } from '../features/workerPool/workerCommands.js';
import { createRemoteTaskExecutor } from '../features/workerPool/remoteTaskExecutor.js';
import type { RemoteExecutionPort, RemoteTaskExecutor } from '../features/workerPool/remoteWorker.js';
import { RemoteAssignmentSchema } from '../core/worker-pool/remoteProtocol.js';
import * as spawn from '../shared/utils/spawn.js';

const doubles = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../features/workerPool/remoteWorker.js', () => ({ runRemoteWorker: doubles.run }));
vi.mock('../features/workerPool/remoteTaskExecutor.js', async (original) => {
  const actual = await original<typeof import('../features/workerPool/remoteTaskExecutor.js')>();
  return { ...actual, createRemoteTaskExecutor: vi.fn(actual.createRemoteTaskExecutor) };
});

const savedEnvironment = { TAKT_WORKER_TOKEN: process.env.TAKT_WORKER_TOKEN, TAKT_TEST_TOKEN_COPY: process.env.TAKT_TEST_TOKEN_COPY };

function fakeToken(): string {
  const header = Buffer.from(JSON.stringify({ workerId: 'w1', registrationGeneration: randomUUID() })).toString('base64url');
  return [header, ['Zq', String(randomInt(10_000_000, 99_999_999)), 'Zq'].join('')].join('.');
}

function valuesHolding(environment: NodeJS.ProcessEnv, token: string): string[] {
  return Object.entries(environment).filter(([, value]) => value?.includes(token)).map(([name]) => name);
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

it('keeps the worker token out of task process arguments and environment', async () => {
  const token = fakeToken();
  process.env.TAKT_WORKER_TOKEN = token;
  process.env.TAKT_TEST_TOKEN_COPY = `copied ${token}`;
  let executor: RemoteTaskExecutor | undefined;
  doubles.run.mockImplementation(async (input: { executor?: RemoteTaskExecutor }) => { executor = input.executor; });
  await startWorker('http://127.0.0.1:1', token);
  expect(vi.mocked(createRemoteTaskExecutor)).toHaveBeenCalledOnce();
  const environment = vi.mocked(createRemoteTaskExecutor).mock.calls[0]![0];
  expect(valuesHolding(environment, token)).toEqual([]);
  expect(environment).not.toHaveProperty('TAKT_WORKER_TOKEN');

  const started: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  vi.spyOn(spawn, 'spawnManagedProcess').mockImplementation((command, args, options) => {
    started.push({ command, args: [...(args ?? [])], env: { ...options?.env } });
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
  const executionId = randomUUID();
  const assignment = RemoteAssignmentSchema.parse({ workerId: 'w1', workerName: 'w1', registrationGeneration: randomUUID(),
    projectId: '/project', taskName: 'T', executionId, assignmentGeneration: 1, requestId: 'claim',
    originalSha: 'a'.repeat(40), origin: '/unused-origin', branch: 'result', leaseExpiresAt: Date.now() + 60_000,
    lastAcknowledgedLogSequence: 0, controlSequence: 0, workLocation: null, retryReservation: false });
  const bytes = Buffer.from(JSON.stringify({ version: 1, runSlug: `remote-${executionId}`, task: 'Work',
    taskConfig: { workflow: 'root' }, hasTaskSpec: false, openCode: {}, project: {}, global: {}, projectTrace: {}, globalTrace: {},
    runtime: { profileOrigins: [], assignmentOrigins: {} } }));
  const port: RemoteExecutionPort = { async request(command) {
    if (command.kind === 'credentials') return { kind: 'credentials', environment: {} };
    if (command.kind === 'input-manifest') return { kind: 'input-manifest', manifest: { version: 1, runSlug: `remote-${executionId}`,
      directories: [], files: [{ path: 'execution.json', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] } };
    if (command.kind === 'input-chunk') return { kind: 'input-chunk', data: bytes.toString('base64') };
    if (command.kind === 'controls') return { kind: 'controls', controls: [] };
    throw new Error('Unexpected execution command');
  } };
  if (executor === undefined) throw new Error('Expected the worker to receive a task executor');
  try {
    expect(await executor.execute(assignment, new AbortController().signal, port)).toMatchObject({ success: false, reason: 'fixture result' });
  } finally { await executor.workspace?.(assignment, 'remove'); }
  expect(started).toHaveLength(1);
  expect([started[0]!.command, ...started[0]!.args].filter((value) => value.includes(token))).toEqual([]);
  expect(valuesHolding(started[0]!.env, token)).toEqual([]);
});
