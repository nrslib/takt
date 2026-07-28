import type { DatabaseSync } from 'node:sqlite';
import type { AuthorityMode } from './authority.js';
import { DatabaseAuthority } from './authority.js';
import { ContextCapability, RunReadContext, RunWriteContext } from './context.js';
import type { LeaseOwner, RunLeaseManager } from './lease.js';
import { isNativeAsyncFunction, isThenable } from './synchronous-callback.js';
import { readClock, type RunStorageClock } from './clock.js';
import { throwAfterCleanup } from './cleanup-error.js';

export interface BusyRetryPolicy {
  readonly delaysMs: readonly number[];
  readonly wait: (delayMs: number) => void;
}

function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = Reflect.get(error, 'code');
  return code === 'ERR_SQLITE_ERROR' && /(?:busy|locked)/i.test(error.message);
}

export class RunUnitOfWork {
  #writing = false;
  #reading = false;
  #savepointSequence = 0;
  readonly #authority: DatabaseAuthority;
  readonly #database: DatabaseSync;
  readonly #leases: RunLeaseManager;
  readonly #busyRetry: BusyRetryPolicy;
  readonly #clock: RunStorageClock;

  constructor(
    database: DatabaseSync,
    leases: RunLeaseManager,
    busyRetry: BusyRetryPolicy,
    clock: RunStorageClock,
  ) {
    this.#database = database;
    this.#leases = leases;
    this.#busyRetry = busyRetry;
    this.#clock = clock;
    this.#authority = new DatabaseAuthority(database);
  }

  read<Result>(callback: (context: RunReadContext) => Result): Result {
    this.assertIdle();
    if (isNativeAsyncFunction(callback)) {
      throw new Error('RunUnitOfWork rejects native async read callbacks');
    }
    this.#database.exec('BEGIN');
    const capability = new ContextCapability();
    this.#reading = true;
    try {
      this.#authority.activate('read');
      const result = callback(new RunReadContext(this.#database, capability));
      if (isThenable(result)) {
        throw new Error('RunUnitOfWork rejects thenable read callback results');
      }
      capability.invalidate();
      this.#authority.clear();
      this.commit();
      return result;
    } catch (error) {
      capability.invalidate();
      throwAfterCleanup(error, [
        () => this.#authority.clear(),
        () => {
          if (this.#database.isTransaction) {
            this.#database.exec('ROLLBACK');
          }
        },
      ]);
    } finally {
      capability.invalidate();
      this.#reading = false;
    }
  }

  write<Result>(
    owner: LeaseOwner,
    callback: (context: RunWriteContext, now: number) => Result,
  ): Result {
    return this.runOwnedWrite('normal-write', owner, true, callback);
  }

  operation<Result>(
    owner: LeaseOwner,
    callback: (context: RunWriteContext, now: number) => Result,
  ): Result {
    return this.runOwnedWrite('operation', owner, true, callback);
  }

  maintainLease<Result>(
    owner: LeaseOwner,
    revalidateBeforeCommit: boolean,
    callback: (context: RunWriteContext, now: number) => Result,
  ): Result {
    return this.runOwnedWrite(
      'lease-maintenance',
      owner,
      revalidateBeforeCommit,
      callback,
    );
  }

  terminalize<Result>(
    owner: LeaseOwner,
    callback: (context: RunWriteContext, now: number) => Result,
  ): Result {
    return this.runOwnedWrite(
      'run-terminalization',
      owner,
      false,
      callback,
    );
  }

  terminalPublication<Result>(
    callback: (context: RunWriteContext, now: number) => Result,
  ): Result {
    return this.runUnownedWrite('terminal-publication', callback);
  }

  forceFail<Result>(
    callback: (context: RunWriteContext, now: number) => Result,
  ): Result {
    return this.runUnownedWrite('forced-run-terminalization', callback);
  }

  claim<Result>(
    callback: (context: RunWriteContext, now: number) => Result,
  ): Result {
    this.assertIdle();
    if (isNativeAsyncFunction(callback)) {
      throw new Error('RunUnitOfWork rejects native async claim callbacks');
    }
    this.acquireWriteTransaction();
    this.#writing = true;
    const capability = new ContextCapability();
    try {
      this.#authority.activate('lease-claim');
      const result = callback(
        this.createWriteContext(capability),
        readClock(this.#clock),
      );
      if (isThenable(result)) {
        throw new Error('RunUnitOfWork rejects thenable claim callback results');
      }
      capability.assertActive();
      capability.invalidate();
      this.#authority.clear();
      this.commit();
      return result;
    } catch (error) {
      capability.invalidate();
      this.rollbackAfter(error);
    } finally {
      this.#writing = false;
    }
  }

  assertIdle(): void {
    if (this.#writing || this.#reading) {
      throw new Error('RunUnitOfWork does not permit reentrant root operations');
    }
  }

  private runOwnedWrite<Result>(
    callbackMode: Extract<
      AuthorityMode,
      | 'normal-write'
      | 'lease-maintenance'
      | 'run-terminalization'
      | 'operation'
    >,
    owner: LeaseOwner,
    revalidateBeforeCommit: boolean,
    callback: (context: RunWriteContext, now: number) => Result,
  ): Result {
    this.assertIdle();
    if (isNativeAsyncFunction(callback)) {
      throw new Error('RunUnitOfWork rejects native async callbacks');
    }
    this.acquireWriteTransaction();
    this.#writing = true;
    const capability = new ContextCapability(owner);
    const context = this.createWriteContext(capability);
    try {
      const startNow = readClock(this.#clock);
      this.#authority.activate('lease-check');
      this.#leases.assertForWrite(context, owner, startNow);
      this.#authority.switchTo(callbackMode);
      const result = callback(context, startNow);
      if (isThenable(result)) {
        throw new Error('RunUnitOfWork rejects thenable callback results');
      }
      capability.assertActive();
      if (revalidateBeforeCommit) {
        const commitNow = readClock(this.#clock);
        this.#authority.switchTo('lease-check');
        this.#leases.assertForWrite(context, owner, commitNow);
      }
      capability.assertActive();
      capability.invalidate();
      this.#authority.clear();
      this.commit();
      return result;
    } catch (error) {
      capability.invalidate();
      this.rollbackAfter(error);
    } finally {
      this.#writing = false;
    }
  }

  private runUnownedWrite<Result>(
    callbackMode: Extract<
      AuthorityMode,
      'terminal-publication' | 'forced-run-terminalization'
    >,
    callback: (context: RunWriteContext, now: number) => Result,
  ): Result {
    this.assertIdle();
    if (isNativeAsyncFunction(callback)) {
      throw new Error('RunUnitOfWork rejects native async callbacks');
    }
    this.acquireWriteTransaction();
    this.#writing = true;
    const capability = new ContextCapability();
    try {
      this.#authority.activate(callbackMode);
      const result = callback(
        this.createWriteContext(capability),
        readClock(this.#clock),
      );
      if (isThenable(result)) {
        throw new Error('RunUnitOfWork rejects thenable callback results');
      }
      capability.assertActive();
      capability.invalidate();
      this.#authority.clear();
      this.commit();
      return result;
    } catch (error) {
      capability.invalidate();
      this.rollbackAfter(error);
    } finally {
      this.#writing = false;
    }
  }

  private acquireWriteTransaction(): void {
    const attempts = this.#busyRetry.delaysMs.length + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        this.#database.exec('BEGIN IMMEDIATE');
        return;
      } catch (error) {
        if (!isBusyError(error) || attempt === attempts - 1) {
          throw error;
        }
        const delay = this.#busyRetry.delaysMs[attempt];
        if (delay === undefined) {
          throw new Error('Busy retry policy is inconsistent');
        }
        this.#busyRetry.wait(delay);
      }
    }
    throw new Error('Write transaction acquisition exhausted unexpectedly');
  }

  private commit(): void {
    if (!this.#database.isTransaction) {
      throw new Error('RunUnitOfWork transaction ended before commit');
    }
    this.#database.exec('COMMIT');
  }

  private rollbackAfter(primaryError: unknown): never {
    throwAfterCleanup(primaryError, [
      () => this.#authority.clear(),
      () => {
        if (this.#database.isTransaction) {
          this.#database.exec('ROLLBACK');
        }
      },
    ]);
  }

  private createWriteContext(capability: ContextCapability): RunWriteContext {
    return new RunWriteContext(
      this.#database,
      capability,
      <Result>(callback: (context: RunWriteContext) => Result): Result => (
        this.runSavepoint(capability, callback)
      ),
    );
  }

  private runSavepoint<Result>(
    parentCapability: ContextCapability,
    callback: (context: RunWriteContext) => Result,
  ): Result {
    if (isNativeAsyncFunction(callback)) {
      throw new Error('RunUnitOfWork rejects native async savepoint callbacks');
    }
    this.#savepointSequence += 1;
    const name = `run_storage_${this.#savepointSequence}`;
    this.#authority.runWithoutAuthorizer(() => {
      this.#database.exec(`SAVEPOINT ${name}`);
    });
    const capability = parentCapability.child();
    try {
      const result = callback(this.createWriteContext(capability));
      if (isThenable(result)) {
        throw new Error('RunUnitOfWork rejects thenable savepoint results');
      }
      capability.invalidate();
      this.#authority.runWithoutAuthorizer(() => {
        this.#database.exec(`RELEASE SAVEPOINT ${name}`);
      });
      return result;
    } catch (error) {
      capability.invalidate();
      throwAfterCleanup(error, [
        () => this.#authority.runWithoutAuthorizer(() => {
          this.#database.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        }),
        () => this.#authority.runWithoutAuthorizer(() => {
          this.#database.exec(`RELEASE SAVEPOINT ${name}`);
        }),
      ]);
    }
  }
}
