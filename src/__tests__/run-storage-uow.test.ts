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
import { openRunStorage } from '../infra/run-storage/index.js';

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
      // Removed fields fail loudly instead of being treated as stored workflow state.
      workflowDefinition: {
        name: 'invalid',
        codecName: 'json-v1',
        definition: 'not-json',
      },
    } as never)).toThrow(/Unknown/);
    const after = root.readResumeSnapshot();
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

    for (const sql of [
      'BEGIN',
      'CREATE TABLE bypass (value TEXT)',
      "UPDATE runs SET status = 'forged'",
      "INSERT INTO operations (operation_id) VALUES ('forged')",
    ]) {
      const independent = createIndependentUnitOfWork();
      expect(() => independent.uow.write(
        independent.owner,
        (context) => context.run(sql),
      )).toThrow(/authorized|not authorized|transaction|stale/i);
      independent.close();
    }
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
    const receipt = root.finishRun(owner, {
      status: 'completed',
      publication: {
        status: 'completed',
        iteration: 1,
        payload: '{}',
      },
    });
    expect(receipt).toMatchObject({
      runId: 'run-1',
      eventId: expect.stringMatching(/^[a-f0-9]{64}$/),
      runStatus: 'completed',
      iteration: 1,
      payloadDigest:
        '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      terminalAt: 3_000,
    });

    expect(root.readResumeSnapshot().run).toMatchObject({
      status: 'completed',
      terminalAt: 3_000,
    });
    expect(root.readTerminalPublication()).toMatchObject({
      status: 'completed',
      iteration: 1,
      terminalAt: 3_000,
      payload: '{}',
      stages: ['meta', 'session', 'trace'],
    });
    clock.set(4_000);
    for (const stage of ['meta', 'session', 'trace'] as const) {
      const claim = root.claimTerminalPublicationStage({
        claimDurationMs: 9_000,
      });
      expect(claim).toMatchObject({ stage });
      root.acknowledgeTerminalPublicationStage(claim!);
    }
    expect(root.readTerminalPublication()).toMatchObject({
      status: 'completed',
      iteration: 1,
      terminalAt: 3_000,
      payload: '{}',
      stages: [],
      publishedAt: 4_000,
    });
    expect(() => root.heartbeatLease(owner, 9_000)).toThrow(/stale|terminal/i);
  });

  it('terminal stageをtransactional claimし、同時ownerを排除して期限後に回収する', () => {
    const { databasePath, root, clock } = createRealRunStorage();
    const owner = claim(root);
    clock.set(2_000);
    root.finishRun(owner, {
      status: 'completed',
      publication: {
        status: 'completed',
        iteration: 1,
        payload: '{}',
      },
    });

    clock.set(3_000);
    const first = root.claimTerminalPublicationStage({
      claimDurationMs: 1_000,
    });
    expect(first).toMatchObject({ stage: 'meta', generation: 1 });
    const competingRecovery = openRunStorage({ databasePath });
    try {
      expect(competingRecovery.claimTerminalPublicationStage({
        claimDurationMs: 1_000,
      })).toBeUndefined();
    } finally {
      competingRecovery.close();
    }

    clock.set(4_001);
    const recovered = root.claimTerminalPublicationStage({
      claimDurationMs: 1_000,
    });
    expect(recovered).toMatchObject({ stage: 'meta', generation: 2 });
    expect(() => root.acknowledgeTerminalPublicationStage(first!))
      .toThrow(/stale/i);
    root.acknowledgeTerminalPublicationStage(recovered!);
    expect(root.readTerminalPublication()).toMatchObject({
      stages: ['session', 'trace'],
    });
  });

  it('rolls back every execution, scope, run, lease, and publication on terminal failure', () => {
    const { databasePath, root } = createRealRunStorage();
    const owner = claim(root);
    const rootRuntime = root.runtime({ lease: owner });
    rootRuntime.execution.startStep({
      stepKey: 'root-step',
      expectedScopeRevision: 0,
    });
    const childScope = rootRuntime.scopes.createParallelChild({
      scopeKey: 'parallel-child',
    });
    root.runtime({ lease: owner, scope: childScope }).execution.startStep({
      stepKey: 'child-step',
      expectedScopeRevision: 0,
    });

    const injector = new DatabaseSync(databasePath);
    injector.exec(`
      CREATE TRIGGER injected_root_terminal_failure
      BEFORE UPDATE OF status ON scope_runtime
      WHEN OLD.scope_id = 'root' AND NEW.status = 'failed'
      BEGIN
        SELECT RAISE(ABORT, 'injected root terminal failure');
      END
    `);
    injector.close();

    expect(() => root.finishRun(owner, {
      status: 'failed',
      failureReason: 'workflow failed',
      publication: {
        status: 'failed',
        iteration: 2,
        reason: 'workflow failed',
        payload: '{}',
      },
    })).toThrow(/injected root terminal failure/i);

    const snapshot = root.readResumeSnapshot();
    expect(snapshot.run).toMatchObject({
      status: 'running',
      terminalAt: null,
    });
    expect(snapshot.leases[0]).toMatchObject({
      terminalized_at: null,
      terminal_status: null,
    });
    expect(snapshot.scopes).toHaveLength(2);
    expect(snapshot.scopes.every(
      (scope) => scope.runtime.status === 'running',
    )).toBe(true);
    expect(snapshot.scopes.flatMap(
      (scope) => scope.stepExecutions,
    ).every((execution) => execution.status === 'running')).toBe(true);
    expect(root.readTerminalPublication()).toBeUndefined();
  });
});
