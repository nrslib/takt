import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunReadContext, RunWriteContext } from '../infra/run-storage/context.js';
import {
  type LeaseOwner,
  RunLeaseManager,
  StaleLeaseOwnerError,
} from '../infra/run-storage/lease.js';
import { RunUnitOfWork } from '../infra/run-storage/unit-of-work.js';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
} from './helpers/run-storage.js';

afterEach(cleanupRealRunStorages);

function claim(root: ReturnType<typeof createRealRunStorage>['root']) {
  return root.claimLease({
    ownerKey: 'owner-1',
    leaseDurationMs: 9_000,
  });
}

interface IndependentUnitOfWork {
  readonly database: DatabaseSync;
  readonly databasePath: string;
  readonly owner: LeaseOwner;
  readonly uow: RunUnitOfWork;
  close(): void;
}

function createIndependentUnitOfWork(options?: {
  readonly failRollbackOnce?: boolean;
  readonly failAuthorizerClearOnce?: boolean;
}): IndependentUnitOfWork {
  const directory = mkdtempSync(join(tmpdir(), 'takt-uow-contract-'));
  const databasePath = join(directory, 'uow.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE run_leases (
      run_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      claim_token TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      released_at INTEGER,
      terminalized_at INTEGER,
      terminal_status TEXT,
      validation_count INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE test_values (
      value TEXT PRIMARY KEY
    ) STRICT;
    CREATE TABLE deferred_parents (
      parent_id TEXT PRIMARY KEY
    ) STRICT;
    CREATE TABLE deferred_children (
      child_id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES deferred_parents (parent_id)
        DEFERRABLE INITIALLY DEFERRED
    ) STRICT;
    CREATE TABLE operations (
      operation_id TEXT PRIMARY KEY
    ) STRICT;
    INSERT INTO runs (run_id, status) VALUES ('uow-run', 'running');
    INSERT INTO run_leases (
      run_id, generation, owner_id, claim_token,
      claimed_at, expires_at, heartbeat_at
    ) VALUES ('uow-run', 1, 'uow-owner', 'uow-token', 0, 10000, 0);
  `);
  const owner = {
    runId: 'uow-run',
    generation: 1,
    claimToken: 'uow-token',
  } as const;
  let failRollback = options?.failRollbackOnce === true;
  let authorizerClearCount = 0;
  const uowDatabase = new Proxy(database, {
    get(target, property) {
      if (property === 'exec') {
        return (sql: string) => {
          const result = target.exec(sql);
          if (failRollback && sql === 'ROLLBACK') {
            failRollback = false;
            throw new Error('injected rollback cleanup failure');
          }
          return result;
        };
      }
      if (property === 'setAuthorizer') {
        return (
          authorizer: Parameters<DatabaseSync['setAuthorizer']>[0],
        ) => {
          const result = target.setAuthorizer(authorizer);
          if (authorizer === null) {
            authorizerClearCount += 1;
          }
          if (
            options?.failAuthorizerClearOnce === true
            && authorizer === null
            && authorizerClearCount === 2
          ) {
            throw new Error('injected authorizer cleanup failure');
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DatabaseSync;
  const uow = new RunUnitOfWork(
    uowDatabase,
    new RunLeaseManager(),
    { delaysMs: [], wait: () => undefined },
    { now: () => 1_000 },
  );
  return {
    database,
    databasePath,
    owner,
    uow,
    close: () => {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe('RunUnitOfWork and lease fencing', () => {
  it('does not expose generic read/write callbacks or raw SQL contexts', () => {
    const { root } = createRealRunStorage();

    expect(Reflect.get(root, 'read')).toBeUndefined();
    expect(Reflect.get(root, 'write')).toBeUndefined();
    expect(Reflect.get(root, 'database')).toBeUndefined();
    expect(Reflect.get(root, 'unitOfWork')).toBeUndefined();
  });

  it('rolls back every statement in a failed command', () => {
    const { root } = createRealRunStorage();
    const owner = claim(root);
    const runtime = root.runtime({ lease: owner });
    const before = root.readResumeSnapshot();

    expect(() => runtime.scopes.createWorkflowCallChild({
      scopeKey: 'invalid-child',
      workflowDefinition: {
        name: 'invalid',
        codecName: 'json-v1',
        definition: 'not-json',
      },
    })).toThrow(/JSON/);
    const after = root.readResumeSnapshot();
    expect(after.workflowDefinitions).toEqual(before.workflowDefinitions);
    expect(after.scopes).toEqual(before.scopes);
  });

  it('holds one SQLite read transaction across a complete snapshot read', () => {
    const independent = createIndependentUnitOfWork();
    const observed = independent.uow.read((context) => {
      const before = context.get<{ readonly count: number }>(`
        SELECT count(*) AS count FROM test_values
      `)?.count;
      const writer = new DatabaseSync(
        independent.databasePath,
      );
      writer.exec('PRAGMA foreign_keys = ON');
      writer.exec('BEGIN IMMEDIATE');
      writer.prepare('INSERT INTO test_values (value) VALUES (?)').run('late');
      writer.exec('COMMIT');
      writer.close();
      const after = context.get<{ readonly count: number }>(`
        SELECT count(*) AS count FROM test_values
      `)?.count;
      return { before, after };
    });

    expect(observed).toEqual({ before: 0, after: 0 });
    expect(independent.uow.read((context) => (
      context.get<{ readonly count: number }>(
        'SELECT count(*) AS count FROM test_values',
      )?.count
    ))).toBe(1);
    independent.close();
  });

  it('preserves synchronous callback, context lifetime, savepoint, and reentrancy guarantees', () => {
    const independent = createIndependentUnitOfWork();
    let expiredReadContext: RunReadContext | undefined;
    let expiredWriteContext: RunWriteContext | undefined;

    expect(() => independent.uow.read(async () => 1)).toThrow(/native async read/);
    expect(() => independent.uow.read(() => ({
      then: () => undefined,
    }))).toThrow(/thenable read/);
    independent.uow.read((context) => {
      expiredReadContext = context;
      expect(() => independent.uow.read(() => undefined)).toThrow(/reentrant/);
    });
    expect(() => expiredReadContext?.get('SELECT 1')).toThrow(/expired/);

    independent.uow.write(independent.owner, (context) => {
      expiredWriteContext = context;
      context.run('INSERT INTO test_values (value) VALUES (?)', 'outer');
      expect(() => context.savepoint((savepoint) => {
        savepoint.run('INSERT INTO test_values (value) VALUES (?)', 'rolled-back');
        throw new Error('rollback savepoint');
      })).toThrow(/rollback savepoint/);
      context.run('INSERT INTO test_values (value) VALUES (?)', 'after-savepoint');
    });
    expect(() => expiredWriteContext?.run(
      'INSERT INTO test_values (value) VALUES (?)',
      'expired',
    )).toThrow(/expired/);
    expect(independent.uow.read((context) => context.all(
      'SELECT value FROM test_values ORDER BY value',
    ))).toEqual([
      { value: 'after-savepoint' },
      { value: 'outer' },
    ]);
    independent.close();
  });

  it('rolls back COMMIT failures and restores the authorizer', () => {
    const independent = createIndependentUnitOfWork();

    expect(() => independent.uow.write(independent.owner, (context) => {
      context.run(`
        INSERT INTO deferred_children (child_id, parent_id)
        VALUES ('orphan', 'missing')
      `);
    })).toThrow(/constraint|foreign key/i);
    expect(independent.database.isTransaction).toBe(false);
    expect(independent.uow.read((context) => context.get(
      'SELECT count(*) AS count FROM deferred_children',
    ))).toEqual({ count: 0 });

    independent.uow.write(independent.owner, (context) => {
      context.run('INSERT INTO test_values (value) VALUES (?)', 'after-failure');
    });
    expect(independent.uow.read((context) => context.get(
      'SELECT count(*) AS count FROM test_values',
    ))).toEqual({ count: 1 });
    independent.close();
  });

  it.each([
    {
      label: 'rollback',
      options: { failRollbackOnce: true },
      cleanupMessage: 'injected rollback cleanup failure',
    },
    {
      label: 'authorizer',
      options: { failAuthorizerClearOnce: true },
      cleanupMessage: 'injected authorizer cleanup failure',
    },
  ])('preserves the primary error when $label cleanup also fails', ({
    options,
    cleanupMessage,
  }) => {
    const independent = createIndependentUnitOfWork(options);
    let caught: unknown;
    try {
      independent.uow.write(independent.owner, () => {
        throw new Error('primary callback failure');
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.cause).toEqual(
      expect.objectContaining({ message: 'primary callback failure' }),
    );
    expect(aggregate.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'primary callback failure' }),
      expect.objectContaining({ message: cleanupMessage }),
    ]));
    expect(independent.database.isTransaction).toBe(false);
    expect(() => independent.uow.read(() => 'recovered')).not.toThrow();
    independent.close();
  });

  it('rejects stale generation, token, expiry, and released owners', () => {
    const { root, clock } = createRealRunStorage();
    const owner = claim(root);
    const runtime = root.runtime({ lease: owner });

    expect(() => root.runtime({
      lease: { ...owner, claimToken: 'forged' } as never,
    })).toThrow(/Lease handle is forged/i);
    clock.set(10_000);
    expect(() => runtime.sequences.appendEvent({
      expectedSequence: 0,
      eventType: 'expired',
    })).toThrow(StaleLeaseOwnerError);

    clock.set(1_000);
    root.releaseLease(owner);
    expect(() => runtime.sequences.appendEvent({
      expectedSequence: 0,
      eventType: 'released',
    })).toThrow(StaleLeaseOwnerError);
  });

  it('revalidates the lease immediately before commit and rolls back', () => {
    const { root, clock } = createRealRunStorage();
    const owner = claim(root);
    const runtime = root.runtime({ lease: owner });
    clock.queue(2_000, 10_001);

    expect(() => runtime.sequences.appendEvent({
      expectedSequence: 0,
      eventType: 'must-roll-back',
    })).toThrow(StaleLeaseOwnerError);
    expect(root.readResumeSnapshot().scopes[0]?.events).toEqual([]);
  });

  it('retries only transaction acquisition with finite configured backoff', () => {
    let blocker: DatabaseSync | undefined;
    const waits: number[] = [];
    const storage = createRealRunStorage({
      busyRetryDelaysMs: [1, 2],
      wait: (delay) => {
        waits.push(delay);
        blocker?.exec('COMMIT');
      },
    });
    const owner = claim(storage.root);
    const runtime = storage.root.runtime({ lease: owner });
    blocker = new DatabaseSync(storage.databasePath, { timeout: 1 });
    blocker.exec('PRAGMA foreign_keys = ON');
    blocker.exec('BEGIN IMMEDIATE');

    expect(runtime.sequences.appendEvent({
      expectedSequence: 0,
      eventType: 'after-retry',
    })).toBe(1);
    expect(waits).toEqual([1]);
    blocker.close();
  });

  it('keeps transaction control, DDL, bootstrap, and operation tables inaccessible', () => {
    const { root } = createRealRunStorage();
    expect(Reflect.get(root, 'executor')).toBeUndefined();
    expect(Reflect.get(root.runtime, 'executor')).toBeUndefined();
    expect(() => root.runtime({
      lease: Object.freeze({}) as never,
    })).toThrow(/Lease handle is forged/i);

    const independent = createIndependentUnitOfWork();
    for (const sql of [
      'BEGIN',
      'CREATE TABLE bypass (value TEXT)',
      "UPDATE runs SET status = 'forged'",
      "INSERT INTO operations (operation_id) VALUES ('forged')",
    ]) {
      expect(() => independent.uow.write(
        independent.owner,
        (context) => context.run(sql),
      )).toThrow(/authorized|not authorized|transaction/i);
    }
    independent.close();
  });

  it('rejects caller-controlled authority timestamps and generated IDs', () => {
    const { root } = createRealRunStorage();
    const owner = claim(root);
    const runtime = root.runtime({ lease: owner });

    expect(() => runtime.execution.startStep({
      stepKey: 'forged',
      expectedScopeRevision: 0,
      startedAt: 999_999,
    } as never)).toThrow(/Unknown run storage command field/);
    expect(() => runtime.scopes.createParallelChild({
      scopeId: 'forged',
      createdAt: 999_999,
    } as never)).toThrow(/Unknown run storage command field/);
  });

  it('claims, heartbeats, releases, and terminalizes with owner CAS', () => {
    const { root, clock } = createRealRunStorage();
    const owner = claim(root);
    clock.set(2_000);
    root.heartbeatLease(owner, 9_000);
    clock.set(3_000);
    root.terminalizeRun(owner, 'completed');

    expect(root.readResumeSnapshot().run).toMatchObject({
      status: 'completed',
      terminalAt: 3_000,
    });
    expect(() => root.heartbeatLease(owner, 9_000)).toThrow(/stale|terminal/i);
  });
});

function setup() {
  const storage = createRealRunStorage();
  const owner = storage.root.claimLease({
      ownerKey: 'owner-1',
      leaseDurationMs: 9_000,
  });
  const runtime = storage.root.runtime({ lease: owner });
  return { ...storage, owner, runtime };
}

const request = {
  codecName: 'json-v1',
  content: '{"prompt":"hello"}',
} as const;

describe('operation state machine', () => {
  it('loads a matching scoped idempotency key and rejects collisions', () => {
    const { runtime } = setup();
    const first = runtime.operations.prepareOrLoad({
      idempotencyKey: 'provider-call',
      kind: 'provider',
      request,
    });
    const replay = runtime.operations.prepareOrLoad({
      idempotencyKey: 'provider-call',
      kind: 'provider',
      request,
    });

    expect(replay.state).toBe(first.state);
    expect(() => runtime.operations.prepareOrLoad({
      idempotencyKey: 'provider-call',
      kind: 'provider',
      request: { ...request, content: '{"prompt":"different"}' },
    })).toThrow(/authority collision/i);
  });

  it('separates the same idempotency key by scope', () => {
    const { root, owner, runtime } = setup();
    const childScope = runtime.scopes.createParallelChild({ scopeKey: 'child' });
    const child = root.runtime({ lease: owner, scope: childScope });

    const parentOperation = runtime.operations.prepareOrLoad({
      idempotencyKey: 'same',
      kind: 'provider',
      request,
    });
    const childOperation = child.operations.prepareOrLoad({
      idempotencyKey: 'same',
      kind: 'provider',
      request,
    });

    expect(root.readResumeSnapshot().operations).toHaveLength(2);
    expect(() => child.operations.get(parentOperation.handle))
      .toThrow(/cross-scope/i);
  });

  it('generates transition and attempt history from legal commands', () => {
    const { root, runtime } = setup();
    const operation = runtime.operations.prepareOrLoad({
      idempotencyKey: 'provider-call',
      kind: 'provider',
      request,
    });
    runtime.operations.claimPrepared(operation.handle);
    runtime.operations.recordResponse({
      operation: operation.handle,
      response: { codecName: 'json-v1', content: '{"answer":"ok"}' },
    });
    runtime.operations.markApplied(operation.handle);

    expect(runtime.operations.get(operation.handle).state).toBe('applied');
    expect(root.readResumeSnapshot().operationTransitions.map((row) => row.to_state))
      .toEqual(['prepared', 'dispatching', 'response_recorded', 'applied']);
    expect(root.readResumeSnapshot().operationAttempts).toEqual([
      expect.objectContaining({
        outcome: 'response_recorded',
      }),
    ]);
  });

  it('preserves a recorded response when application fails', () => {
    const { runtime } = setup();
    const operation = runtime.operations.prepareOrLoad({
      idempotencyKey: 'provider-call',
      kind: 'provider',
      request,
    });
    runtime.operations.claimPrepared(operation.handle);
    runtime.operations.recordResponse({
      operation: operation.handle,
      response: { codecName: 'json-v1', content: '{"answer":"ok"}' },
    });
    runtime.operations.markFailed({
      operation: operation.handle,
      error: { codecName: 'text-v1', content: 'apply failed' },
    });

    expect(runtime.operations.get(operation.handle)).toMatchObject({
      state: 'failed',
      response: { encoded: '{"answer":"ok"}' },
      error: { encoded: 'apply failed' },
    });
  });

  it.each([
    ['prepared', 'failed'],
    ['prepared', 'cancelled'],
    ['dispatching', 'failed'],
    ['dispatching', 'unknown_after_dispatch'],
    ['response_recorded', 'applied'],
  ] as const)('supports crash matrix %s -> %s', (from, target) => {
    const { runtime } = setup();
    const operation = runtime.operations.prepareOrLoad({
      idempotencyKey: `${from}-${target}`,
      kind: 'provider',
      request,
    });
    if (from === 'dispatching' || from === 'response_recorded') {
      runtime.operations.claimPrepared(operation.handle);
    }
    if (from === 'response_recorded') {
      runtime.operations.recordResponse({
        operation: operation.handle,
        response: { codecName: 'json-v1', content: '{"answer":"ok"}' },
      });
    }
    switch (target) {
      case 'failed':
        runtime.operations.markFailed({
          operation: operation.handle,
          error: { codecName: 'text-v1', content: 'failed' },
        });
        break;
      case 'cancelled':
        runtime.operations.cancelPrepared(operation.handle);
        break;
      case 'unknown_after_dispatch':
        runtime.operations.recoverAfterDispatchCrash(operation.handle);
        break;
      case 'applied':
        runtime.operations.markApplied(operation.handle);
        break;
    }
    expect(runtime.operations.get(operation.handle).state).toBe(target);
  });

  it('rejects terminal resurrection and stale lease commands', () => {
    const { root, owner, runtime, clock } = setup();
    const operation = runtime.operations.prepareOrLoad({
      idempotencyKey: 'cancel',
      kind: 'provider',
      request,
    });
    runtime.operations.cancelPrepared(operation.handle);
    expect(() => runtime.operations.claimPrepared(operation.handle)).toThrow(/prepared/);

    root.releaseLease(owner);
    clock.set(2_000);
    root.claimLease({
      ownerKey: 'owner-2',
      leaseDurationMs: 9_000,
    });
    expect(() => runtime.operations.prepareOrLoad({
      idempotencyKey: 'stale',
      kind: 'provider',
      request,
    })).toThrow(/stale/i);
  });
});
