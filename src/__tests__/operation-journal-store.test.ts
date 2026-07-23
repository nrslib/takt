import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared/utils/private-file.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/private-file.js')>()),
  writePrivateFileWithMode: vi.fn(
    (await importOriginal<typeof import('../shared/utils/private-file.js')>())
      .writePrivateFileWithMode,
  ),
}));

import { OperationJournalConflictError } from '../core/workflow/operations/operation-recovery-error.js';
import { createOperationJournalStore } from '../core/workflow/operations/operation-journal-store.js';
import {
  OPERATION_ATTEMPT_STATUSES,
  OPERATION_JOURNAL_STAGE_ORDER,
  OPERATION_JOURNAL_STAGES,
  type OperationJournalStore,
  type OperationOwner,
} from '../core/workflow/operations/operation-journal-types.js';
import { writePrivateFileWithMode } from '../shared/utils/private-file.js';

interface ChildProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ManagedChildProcess {
  readonly result: Promise<ChildProcessResult>;
  waitForMessage(type: string): Promise<void>;
  send(type: string): void;
  terminate(): void;
}

const activeChildProcesses = new Set<ChildProcess>();

async function terminateActiveChildProcesses(): Promise<void> {
  const children = [...activeChildProcesses];
  for (const child of children) {
    child.kill('SIGTERM');
  }
  await Promise.all(children.map((child) =>
    new Promise<void>((resolveClose) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveClose();
        return;
      }
      child.once('close', () => resolveClose());
    })
  ));
}

function runTypeScriptProcess(script: string): ManagedChildProcess {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '--eval', script],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  activeChildProcesses.add(child);
  let stdout = '';
  let stderr = '';
  let closed = false;
  const receivedMessages = new Set<string>();
  const messageWaiters = new Map<string, {
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }>();
  child.stdout?.setEncoding('utf-8');
  child.stderr?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('message', (message: unknown) => {
    if (
      message === null
      || typeof message !== 'object'
      || typeof (message as { type?: unknown }).type !== 'string'
    ) {
      return;
    }
    const type = (message as { type: string }).type;
    const waiter = messageWaiters.get(type);
    if (waiter === undefined) {
      receivedMessages.add(type);
      return;
    }
    messageWaiters.delete(type);
    waiter.resolve();
  });
  const result = new Promise<ChildProcessResult>((resolveResult, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode) => {
      closed = true;
      activeChildProcesses.delete(child);
      const earlyExit = new Error(
        `Child process exited before barrier: exit=${exitCode}, stderr=${stderr}`,
      );
      for (const waiter of messageWaiters.values()) {
        waiter.reject(earlyExit);
      }
      messageWaiters.clear();
      resolveResult({ exitCode, stdout, stderr });
    });
  });
  return {
    result,
    waitForMessage(type: string): Promise<void> {
      if (receivedMessages.delete(type)) {
        return Promise.resolve();
      }
      if (closed) {
        return Promise.reject(new Error(
          `Child process already exited before message "${type}": ${stderr}`,
        ));
      }
      return new Promise<void>((resolveMessage, rejectMessage) => {
        messageWaiters.set(type, { resolve: resolveMessage, reject: rejectMessage });
      });
    },
    send(type: string): void {
      if (!child.connected) {
        throw new Error(`Child process is not connected for message "${type}": ${stderr}`);
      }
      child.send({ type });
    },
    terminate(): void {
      if (!closed) {
        child.kill('SIGTERM');
      }
    },
  };
}

function runStoreProcess(
  journalPath: string,
  operation: string,
): ManagedChildProcess {
  const storeModule = resolve(
    'src/core/workflow/operations/operation-journal-store.ts',
  );
  const script = `
    import { createOperationJournalStore } from ${JSON.stringify(storeModule)};
    const waitForParentMessage = (expected) =>
      new Promise((resolveMessage, rejectMessage) => {
        const onMessage = (message) => {
          if (
            message !== null
            && typeof message === 'object'
            && message.type === expected
          ) {
            process.off('message', onMessage);
            process.off('disconnect', onDisconnect);
            resolveMessage();
          }
        };
        const onDisconnect = () => {
          process.off('message', onMessage);
          rejectMessage(new Error('Parent disconnected before message: ' + expected));
        };
        process.on('message', onMessage);
        process.once('disconnect', onDisconnect);
      });
    const sendToParent = (type) => {
      if (process.send === undefined) throw new Error('IPC channel is unavailable');
      process.send({ type });
    };
    const store = createOperationJournalStore(${JSON.stringify(journalPath)});
    const main = async () => {
      try {
        sendToParent('ready');
        await waitForParentMessage('start');
        const result = ${operation};
        process.stdout.write(JSON.stringify(result));
      } catch (error) {
        process.stderr.write(JSON.stringify({
          name: error instanceof Error ? error.name : 'UnknownError',
          message: error instanceof Error ? error.message : String(error),
        }));
        process.exitCode = 2;
      } finally {
        if (process.connected) process.disconnect();
      }
    };
    void main();
  `;
  return runTypeScriptProcess(script);
}

function runInternalStoreProcess(journalPath: string, body: string): ManagedChildProcess {
  const storeModule = resolve(
    'src/core/workflow/operations/operation-journal-store.ts',
  );
  const script = `
    import { existsSync } from 'node:fs';
    import { createOperationJournalStore } from ${JSON.stringify(storeModule)};
    const waitForFile = (path) => {
      while (!existsSync(path)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    };
    const waitForParentMessage = (expected) =>
      new Promise((resolveMessage, rejectMessage) => {
        const onMessage = (message) => {
          if (
            message !== null
            && typeof message === 'object'
            && message.type === expected
          ) {
            process.off('message', onMessage);
            process.off('disconnect', onDisconnect);
            resolveMessage();
          }
        };
        const onDisconnect = () => {
          process.off('message', onMessage);
          rejectMessage(new Error('Parent disconnected before message: ' + expected));
        };
        process.on('message', onMessage);
        process.once('disconnect', onDisconnect);
      });
    const sendToParent = (type) => {
      if (process.send === undefined) throw new Error('IPC channel is unavailable');
      process.send({ type });
    };
    const store = createOperationJournalStore(${JSON.stringify(journalPath)});
    const main = async () => {
      try {
        ${body}
      } catch (error) {
        process.stderr.write(JSON.stringify({
          name: error instanceof Error ? error.name : 'UnknownError',
          message: error instanceof Error ? error.message : String(error),
        }));
        process.exitCode = 2;
      } finally {
        if (process.connected) process.disconnect();
      }
    };
    void main();
  `;
  return runTypeScriptProcess(script);
}

function parseChildError(result: ChildProcessResult): {
  readonly name: string;
  readonly message: string;
} {
  return JSON.parse(result.stderr) as { readonly name: string; readonly message: string };
}

describe('operation journal store', () => {
  let tempDir: string;
  let journalPath: string;
  let store: OperationJournalStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-operation-journal-'));
    journalPath = join(tempDir, 'state', 'operation-journal.json');
    store = createOperationJournalStore(journalPath);
  });

  afterEach(async () => {
    await terminateActiveChildProcesses();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createParent(claimToken = 'claim-a'): OperationOwner {
    const parent = store.createParent({
      id: 'parent-1',
      kind: 'team-leader-run',
      claimToken,
      stage: 'reserved',
      payload: { task: 'implement' },
    });
    return parent.owner;
  }

  it('persists one parent with multiple independently addressable children', () => {
    const owner = createParent();
    store.createChild({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: 0,
      expectedParentStage: 'reserved',
      id: 'child-1',
      kind: 'part',
      stage: 'reserved',
      payload: { index: 0 },
    });
    store.createChild({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: 1,
      expectedParentStage: 'reserved',
      id: 'child-2',
      kind: 'part',
      stage: 'reserved',
      payload: { index: 1 },
    });

    expect(store.listChildren('parent-1').map((child) => child.id)).toEqual([
      'child-1',
      'child-2',
    ]);
    expect(store.getChild('parent-1', 'child-2').payload).toEqual({ index: 1 });

    const reopened = createOperationJournalStore(journalPath);
    expect(reopened.getParent('parent-1').children).toHaveLength(2);
    expect(reopened.listParents().map((parent) => parent.id)).toEqual(['parent-1']);
    expect(statSync(journalPath).mode & 0o777).toBe(0o600);
    expect(existsSync(`${journalPath}.lock`)).toBe(false);
  });

  it('exposes immutable stage and attempt metadata at runtime', () => {
    expect(Object.isFrozen(OPERATION_JOURNAL_STAGES)).toBe(true);
    expect(Object.isFrozen(OPERATION_JOURNAL_STAGE_ORDER)).toBe(true);
    expect(Object.isFrozen(OPERATION_ATTEMPT_STATUSES)).toBe(true);

    expect(() => {
      (OPERATION_JOURNAL_STAGES as unknown as string[]).push('corrupted');
    }).toThrow(TypeError);
    expect(() => {
      (OPERATION_JOURNAL_STAGE_ORDER as unknown as Record<string, number>).reserved = 99;
    }).toThrow(TypeError);
  });

  it('rejects journal revisions that cannot account for persisted mutations', () => {
    createParent();
    const invalidChildRevision = {
      version: 1,
      parents: [{
        id: 'parent-1',
        kind: 'team-leader-run',
        revision: 2,
        stage: 'reserved',
        payload: {},
        owner: { generation: 0, claimToken: 'claim-a' },
        children: [{
          id: 'child-1',
          kind: 'part',
          revision: 0,
          stage: 'request_started',
          payload: {},
          attempts: [{
            id: 'attempt-1',
            attemptToken: 'attempt-1',
            sequence: 1,
            status: 'started',
            payload: {},
          }],
        }],
      }],
    };
    writeFileSync(journalPath, JSON.stringify(invalidChildRevision), { mode: 0o600 });
    expect(() => store.getParent('parent-1')).toThrow(
      /child revision cannot be lower than its attempt count/,
    );

    const invalidParentRevision = {
      version: 1,
      parents: [{
        id: 'parent-1',
        kind: 'team-leader-run',
        revision: 1,
        stage: 'reserved',
        payload: {},
        owner: { generation: 1, claimToken: 'claim-b' },
        children: [{
          id: 'child-1',
          kind: 'part',
          revision: 1,
          stage: 'request_started',
          payload: {},
          attempts: [],
        }],
      }],
    };
    writeFileSync(journalPath, JSON.stringify(invalidParentRevision), { mode: 0o600 });
    expect(() => store.getParent('parent-1')).toThrow(
      /parent revision cannot be lower than 3/,
    );
  });

  it('uses revision and stage as a fenced compare-and-set boundary', () => {
    const owner = createParent();
    store.createChild({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: 0,
      expectedParentStage: 'reserved',
      id: 'child-1',
      kind: 'part',
      stage: 'reserved',
      payload: {},
    });

    const started = store.compareAndSetChild({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: 1,
      expectedParentStage: 'reserved',
      childId: 'child-1',
      expectedRevision: 0,
      expectedStage: 'reserved',
      nextStage: 'request_started',
      payload: { requestId: 'request-1' },
    });

    expect(started.revision).toBe(1);
    expect(started.stage).toBe('request_started');
    expect(() => store.compareAndSetChild({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: 2,
      expectedParentStage: 'reserved',
      childId: 'child-1',
      expectedRevision: 0,
      expectedStage: 'reserved',
      nextStage: 'accepted',
      payload: {},
    })).toThrow(OperationJournalConflictError);
    const workerStarted = store.compareAndSetChild({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: 2,
      expectedParentStage: 'reserved',
      childId: 'child-1',
      expectedRevision: 1,
      expectedStage: 'request_started',
      nextStage: 'worker_started',
      payload: {},
    });

    const applied = store.compareAndSetChild({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: 3,
      expectedParentStage: 'reserved',
      childId: 'child-1',
      expectedRevision: workerStarted.revision,
      expectedStage: workerStarted.stage,
      nextStage: 'applied',
      payload: { output: 'done' },
    });
    expect(() => store.compareAndSetChild({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: 4,
      expectedParentStage: 'reserved',
      childId: 'child-1',
      expectedRevision: applied.revision,
      expectedStage: 'applied',
      nextStage: 'accepted',
      payload: {},
    })).toThrow(/cannot move/);
  });

  it('keeps attempt history append-only across reopen', () => {
    const owner = createParent();
    store.createChild({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: 0,
      expectedParentStage: 'reserved',
      id: 'child-1',
      kind: 'part',
      stage: 'request_started',
      payload: {},
    });

    const first = store.appendAttempt({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: 1,
      expectedParentStage: 'reserved',
      childId: 'child-1',
      expectedRevision: 0,
      expectedStage: 'request_started',
      nextStage: 'request_started',
      payload: { activeAttempt: 'attempt-1' },
      attempt: {
        id: 'attempt-event-1',
        attemptToken: 'attempt-1',
        status: 'started',
        payload: { provider: 'codex' },
      },
    });
    const second = store.appendAttempt({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: 2,
      expectedParentStage: 'reserved',
      childId: 'child-1',
      expectedRevision: first.revision,
      expectedStage: first.stage,
      nextStage: 'request_started',
      payload: { activeAttempt: null },
      attempt: {
        id: 'attempt-event-2',
        attemptToken: 'attempt-1',
        status: 'rejected',
        payload: { reason: 'invalid-output' },
      },
    });

    expect(second.attempts).toMatchObject([
      { id: 'attempt-event-1', sequence: 1, status: 'started' },
      { id: 'attempt-event-2', sequence: 2, status: 'rejected' },
    ]);
    expect(() => store.appendAttempt({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: 3,
      expectedParentStage: 'reserved',
      childId: 'child-1',
      expectedRevision: second.revision,
      expectedStage: second.stage,
      nextStage: 'request_started',
      payload: {},
      attempt: {
        id: 'attempt-event-1',
        attemptToken: 'attempt-2',
        status: 'started',
        payload: {},
      },
    })).toThrow(/already exists/);

    const reopened = createOperationJournalStore(journalPath);
    expect(reopened.getChild('parent-1', 'child-1').attempts).toEqual(second.attempts);
  });

  it('fences stale owners through A to B to C claims', () => {
    const ownerA = createParent('claim-a');
    const parentB = store.claimParent({
      parentId: 'parent-1',
      expectedOwner: ownerA,
      expectedRevision: 0,
      expectedStage: 'reserved',
      nextClaimToken: 'claim-b',
    });
    const ownerB = parentB.owner;

    expect(ownerB).toEqual({ generation: 1, claimToken: 'claim-b' });
    expect(() => store.claimParent({
      parentId: 'parent-1',
      expectedOwner: ownerA,
      expectedRevision: 0,
      expectedStage: 'reserved',
      nextClaimToken: 'stale-claim',
    })).toThrow(OperationJournalConflictError);

    const ownerC = store.claimParent({
      parentId: 'parent-1',
      expectedOwner: ownerB,
      expectedRevision: 1,
      expectedStage: 'reserved',
      nextClaimToken: 'claim-c',
    }).owner;
    expect(ownerC).toEqual({ generation: 2, claimToken: 'claim-c' });
    expect(() => store.createChild({
      parentId: 'parent-1',
      owner: ownerB,
      expectedParentRevision: 2,
      expectedParentStage: 'reserved',
      id: 'stale-child',
      kind: 'part',
      stage: 'reserved',
      payload: {},
    })).toThrow(OperationJournalConflictError);

    expect(store.createChild({
      parentId: 'parent-1',
      owner: ownerC,
      expectedParentRevision: 2,
      expectedParentStage: 'reserved',
      id: 'current-child',
      kind: 'part',
      stage: 'reserved',
      payload: {},
    }).id).toBe('current-child');
  });

  it('seals every child mutation and ownership claim after the parent becomes terminal', () => {
    const owner = createParent();
    store.createChild({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: 0,
      expectedParentStage: 'reserved',
      id: 'child-1',
      kind: 'part',
      stage: 'reserved',
      payload: {},
    });
    const terminated = store.compareAndSetParent({
      parentId: 'parent-1',
      owner,
      expectedRevision: 1,
      expectedStage: 'reserved',
      nextStage: 'terminated',
      payload: { reason: 'cancelled' },
    });

    expect(() => store.claimParent({
      parentId: 'parent-1',
      expectedOwner: owner,
      expectedRevision: terminated.revision,
      expectedStage: terminated.stage,
      nextClaimToken: 'late-owner',
    })).toThrow(/sealed/);
    expect(() => store.createChild({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: terminated.revision,
      expectedParentStage: terminated.stage,
      id: 'late-child',
      kind: 'part',
      stage: 'reserved',
      payload: {},
    })).toThrow(/sealed/);
    expect(() => store.compareAndSetChild({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: terminated.revision,
      expectedParentStage: terminated.stage,
      childId: 'child-1',
      expectedRevision: 0,
      expectedStage: 'reserved',
      nextStage: 'accepted',
      payload: {},
    })).toThrow(/sealed/);
    expect(() => store.appendAttempt({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: terminated.revision,
      expectedParentStage: terminated.stage,
      childId: 'child-1',
      expectedRevision: 0,
      expectedStage: 'reserved',
      nextStage: 'reserved',
      payload: {},
      attempt: {
        id: 'late-attempt',
        attemptToken: 'late-attempt',
        status: 'late',
        payload: {},
      },
    })).toThrow(/sealed/);
    expect(store.getParent('parent-1')).toEqual(terminated);
  });

  it('allows exactly one concurrent process to claim the same parent revision', async () => {
    const owner = createParent();
    const baseInput = {
      parentId: 'parent-1',
      expectedOwner: owner,
      expectedRevision: 0,
      expectedStage: 'reserved',
    };
    const processes = [
      runStoreProcess(
        journalPath,
        `store.claimParent(${JSON.stringify({ ...baseInput, nextClaimToken: 'claim-b' })})`,
      ),
      runStoreProcess(
        journalPath,
        `store.claimParent(${JSON.stringify({ ...baseInput, nextClaimToken: 'claim-c' })})`,
      ),
    ];
    await Promise.all(processes.map((process) => process.waitForMessage('ready')));
    for (const process of processes) {
      process.send('start');
    }
    const [claimB, claimC] = await Promise.all(processes.map((process) => process.result));

    expect([claimB.exitCode, claimC.exitCode].sort()).toEqual([0, 2]);
    const loser = [claimB, claimC].find((result) => result.exitCode === 2);
    if (loser === undefined) {
      throw new Error('Concurrent claim did not produce a losing process');
    }
    expect(parseChildError(loser)).toMatchObject({
      name: 'OperationJournalConflictError',
      message: expect.stringContaining('owner changed'),
    });
    const finalParent = store.getParent('parent-1');
    expect(finalParent.revision).toBe(1);
    expect(finalParent.owner.generation).toBe(1);
    expect(['claim-b', 'claim-c']).toContain(finalParent.owner.claimToken);
  });

  it('allows exactly one concurrent process to update the same parent and child revisions', async () => {
    const owner = createParent();
    store.createChild({
      parentId: 'parent-1',
      owner,
      expectedParentRevision: 0,
      expectedParentStage: 'reserved',
      id: 'child-1',
      kind: 'part',
      stage: 'reserved',
      payload: {},
    });
    const baseInput = {
      parentId: 'parent-1',
      owner,
      expectedParentRevision: 1,
      expectedParentStage: 'reserved',
      childId: 'child-1',
      expectedRevision: 0,
      expectedStage: 'reserved',
      nextStage: 'request_started',
    };
    const processes = [
      runStoreProcess(
        journalPath,
        `store.compareAndSetChild(${JSON.stringify({
          ...baseInput,
          payload: { requestId: 'request-a' },
        })})`,
      ),
      runStoreProcess(
        journalPath,
        `store.compareAndSetChild(${JSON.stringify({
          ...baseInput,
          payload: { requestId: 'request-b' },
        })})`,
      ),
    ];
    await Promise.all(processes.map((process) => process.waitForMessage('ready')));
    for (const process of processes) {
      process.send('start');
    }
    const [requestA, requestB] = await Promise.all(processes.map((process) => process.result));

    expect([requestA.exitCode, requestB.exitCode].sort()).toEqual([0, 2]);
    const loser = [requestA, requestB].find((result) => result.exitCode === 2);
    if (loser === undefined) {
      throw new Error('Concurrent child CAS did not produce a losing process');
    }
    expect(parseChildError(loser)).toMatchObject({
      name: 'OperationJournalConflictError',
      message: expect.stringContaining('Operation "parent-1" changed'),
    });
    expect(store.getParent('parent-1').revision).toBe(2);
    expect(store.getChild('parent-1', 'child-1').revision).toBe(1);
  });

  it('leaves the previous journal intact when atomic publication fails', () => {
    const owner = createParent();
    const before = readFileSync(journalPath, 'utf-8');
    vi.mocked(writePrivateFileWithMode).mockImplementationOnce(() => {
      throw new Error('injected publication failure');
    });

    expect(() => store.compareAndSetParent({
      parentId: 'parent-1',
      owner,
      expectedRevision: 0,
      expectedStage: 'reserved',
      nextStage: 'accepted',
      payload: { shouldNotPersist: true },
    })).toThrow('injected publication failure');

    expect(readFileSync(journalPath, 'utf-8')).toBe(before);
    expect(createOperationJournalStore(journalPath).getParent('parent-1').revision).toBe(0);
    expect(existsSync(`${journalPath}.lock`)).toBe(false);
  });

  it('recovers a lock whose holder process no longer exists', () => {
    const stateDir = join(tempDir, 'state');
    store.createParent({
      id: 'initial-parent',
      kind: 'team-leader-run',
      claimToken: 'initial-owner',
      stage: 'reserved',
      payload: {},
    });
    writeFileSync(
      `${journalPath}.lock`,
      `${JSON.stringify({ version: 1, pid: 2147483647, token: 'orphan' })}\n`,
      { mode: 0o600 },
    );

    const recovered = createOperationJournalStore(journalPath);
    recovered.createParent({
      id: 'recovered-parent',
      kind: 'team-leader-run',
      claimToken: 'recovered-owner',
      stage: 'reserved',
      payload: {},
    });

    expect(existsSync(`${journalPath}.lock`)).toBe(false);
    expect(readFileSync(journalPath, 'utf-8')).toContain('"recovered-parent"');
    expect(statSync(stateDir).isDirectory()).toBe(true);
  });

  it('serializes two stale-lock recoverers without removing a newly acquired owner lock', async () => {
    createParent();
    const lockPath = `${journalPath}.lock`;
    writeFileSync(
      lockPath,
      `${JSON.stringify({ version: 1, pid: 2147483647, token: 'stale-owner' })}\n`,
      { mode: 0o600 },
    );
    const ownerReleasePath = join(tempDir, 'new-owner-release');
    const recoveryA = runInternalStoreProcess(journalPath, `
      const internal = store;
      const snapshot = internal.readLockSnapshot(${JSON.stringify(lockPath)});
      if (snapshot === undefined) throw new Error('stale lock snapshot A is missing');
      sendToParent('ready');
      await waitForParentMessage('start');
      internal.recoverFileLock(snapshot, Date.now() + 10_000);
      sendToParent('done');
    `);
    const recoveryB = runInternalStoreProcess(journalPath, `
      const internal = store;
      const snapshot = internal.readLockSnapshot(${JSON.stringify(lockPath)});
      if (snapshot === undefined) throw new Error('stale lock snapshot B is missing');
      sendToParent('ready');
      await waitForParentMessage('start');
      internal.recoverFileLock(snapshot, Date.now() + 10_000);
      sendToParent('done');
    `);

    await Promise.all([
      recoveryA.waitForMessage('ready'),
      recoveryB.waitForMessage('ready'),
    ]);
    recoveryA.send('start');
    await recoveryA.waitForMessage('done');

    const newOwner = runInternalStoreProcess(journalPath, `
      const internal = store;
      internal.withLock(() => {
        sendToParent('held');
        waitForFile(${JSON.stringify(ownerReleasePath)});
      });
    `);
    await newOwner.waitForMessage('held');
    const newOwnerLock = readFileSync(lockPath, 'utf-8');

    recoveryB.send('start');
    await recoveryB.waitForMessage('done');
    expect(readFileSync(lockPath, 'utf-8')).toBe(newOwnerLock);

    writeFileSync(ownerReleasePath, '');
    const [resultA, resultB, ownerResult] = await Promise.all([
      recoveryA.result,
      recoveryB.result,
      newOwner.result,
    ]);
    expect([resultA.exitCode, resultB.exitCode, ownerResult.exitCode]).toEqual([0, 0, 0]);
    expect(existsSync(lockPath)).toBe(false);
  }, 30_000);

  it('continues recovery after the elected recovery process stops', async () => {
    createParent();
    const lockPath = `${journalPath}.lock`;
    writeFileSync(
      lockPath,
      `${JSON.stringify({ version: 1, pid: 2147483647, token: 'stale-owner' })}\n`,
      { mode: 0o600 },
    );
    const leader = runInternalStoreProcess(journalPath, `
      const internal = store;
      const snapshot = internal.readLockSnapshot(${JSON.stringify(lockPath)});
      if (snapshot === undefined) throw new Error('stale lock snapshot is missing');
      internal.appendRecoveryElectionRecord({
        version: 1,
        kind: 'claim',
        lockKey: internal.createRecoveryLockKey(snapshot),
        pid: process.pid,
        token: 'crashed-recovery-leader',
      });
      sendToParent('claimed');
      await waitForParentMessage('stop');
    `);
    await leader.waitForMessage('claimed');
    leader.terminate();
    const stopped = await leader.result;
    expect(stopped.exitCode).toBeNull();

    expect(store.getParent('parent-1').id).toBe('parent-1');
    expect(existsSync(lockPath)).toBe(false);
    expect(readFileSync(`${lockPath}.recovery`, 'utf-8')).toContain(
      '"token":"crashed-recovery-leader"',
    );
  }, 30_000);

  it('ignores partial and malformed recovery election records', () => {
    createParent();
    const lockPath = `${journalPath}.lock`;
    writeFileSync(
      lockPath,
      `${JSON.stringify({ version: 1, pid: 2147483647, token: 'stale-owner' })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      `${lockPath}.recovery`,
      '{"version":1,"kind":"claim"\nnot-json\n',
      { mode: 0o600 },
    );

    expect(store.getParent('parent-1').id).toBe('parent-1');
    expect(existsSync(lockPath)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symbolic-link recovery election log without touching its target',
    () => {
      createParent();
      const lockPath = `${journalPath}.lock`;
      const recoveryTarget = join(tempDir, 'outside-recovery-target');
      writeFileSync(
        lockPath,
        `${JSON.stringify({ version: 1, pid: 2147483647, token: 'stale-owner' })}\n`,
        { mode: 0o600 },
      );
      writeFileSync(recoveryTarget, 'outside\n', { mode: 0o600 });
      symlinkSync(recoveryTarget, `${lockPath}.recovery`);

      expect(() => store.getParent('parent-1')).toThrow(/symlink/);
      expect(readFileSync(recoveryTarget, 'utf-8')).toBe('outside\n');
      expect(existsSync(lockPath)).toBe(true);
    },
  );

  it('recovers partial and malformed locks after the bounded publication grace period', () => {
    createParent();
    const lockPath = `${journalPath}.lock`;

    writeFileSync(lockPath, '', { mode: 0o600 });
    expect(store.getParent('parent-1').id).toBe('parent-1');

    writeFileSync(lockPath, '{not-json}\n', { mode: 0o600 });
    expect(store.getParent('parent-1').id).toBe('parent-1');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('never removes an old lock held by a living process', () => {
    createParent();
    const lockPath = `${journalPath}.lock`;
    const content = `${JSON.stringify({
      version: 1,
      pid: process.pid,
      token: 'live-owner',
    })}\n`;
    writeFileSync(lockPath, content, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    expect(() => store.getParent('parent-1')).toThrow(/timed out waiting for lock/);
    expect(readFileSync(lockPath, 'utf-8')).toBe(content);
  }, 10_000);

  it.skipIf(process.platform === 'win32')('rejects a symbolic-link lock without touching its target', () => {
    createParent();
    const lockTarget = join(tempDir, 'outside-lock-target');
    const lockPath = `${journalPath}.lock`;
    writeFileSync(lockTarget, 'outside\n', { mode: 0o600 });
    symlinkSync(lockTarget, lockPath);

    expect(() => store.getParent('parent-1')).toThrow(/symlink/);
    expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(lockTarget, 'utf-8')).toBe('outside\n');
  });
});
