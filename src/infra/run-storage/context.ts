import type { SQLInputValue, StatementResultingChanges } from 'node:sqlite';
import type { DatabaseSync } from 'node:sqlite';
import type { LeaseOwner } from './lease.js';

export class ContextCapability {
  #active = true;
  readonly #leaseOwner: LeaseOwner | undefined;

  constructor(leaseOwner?: LeaseOwner) {
    this.#leaseOwner = leaseOwner;
  }

  assertActive(): void {
    if (!this.#active) {
      throw new Error('Run storage context capability has expired');
    }
  }

  invalidate(): void {
    this.#active = false;
  }

  assertLeaseOwner(owner: LeaseOwner): void {
    this.assertActive();
    if (
      this.#leaseOwner === undefined
      || this.#leaseOwner.runId !== owner.runId
      || this.#leaseOwner.generation !== owner.generation
      || this.#leaseOwner.claimToken !== owner.claimToken
    ) {
      throw new Error('Run write context lease owner mismatch');
    }
  }

  child(): ContextCapability {
    this.assertActive();
    return new ContextCapability(this.#leaseOwner);
  }
}

export class RunReadContext {
  readonly #database: DatabaseSync;
  readonly #capability: ContextCapability;

  constructor(
    database: DatabaseSync,
    capability: ContextCapability,
  ) {
    this.#database = database;
    this.#capability = capability;
  }

  get<Row>(
    sql: string,
    ...parameters: SQLInputValue[]
  ): Row | undefined {
    this.#capability.assertActive();
    return this.#database.prepare(sql).get(...parameters) as Row | undefined;
  }

  all<Row>(
    sql: string,
    ...parameters: SQLInputValue[]
  ): Row[] {
    this.#capability.assertActive();
    return this.#database.prepare(sql).all(...parameters) as Row[];
  }

  protected runStatement(
    sql: string,
    parameters: readonly SQLInputValue[],
  ): StatementResultingChanges {
    this.#capability.assertActive();
    return this.#database.prepare(sql).run(...parameters);
  }

  protected assertCapabilityLeaseOwner(owner: LeaseOwner): void {
    this.#capability.assertLeaseOwner(owner);
  }

  protected assertCapabilityActive(): void {
    this.#capability.assertActive();
  }
}

export class RunWriteContext extends RunReadContext {
  readonly #runSavepoint: <Result>(
    callback: (context: RunWriteContext) => Result,
  ) => Result;

  constructor(
    database: DatabaseSync,
    capability: ContextCapability,
    runSavepoint: <Result>(
      callback: (context: RunWriteContext) => Result,
    ) => Result,
  ) {
    super(database, capability);
    this.#runSavepoint = runSavepoint;
  }

  run(sql: string, ...parameters: SQLInputValue[]): StatementResultingChanges {
    return this.runStatement(sql, parameters);
  }

  assertLeaseOwner(owner: LeaseOwner): void {
    this.assertCapabilityLeaseOwner(owner);
  }

  savepoint<Result>(callback: (context: RunWriteContext) => Result): Result {
    this.assertCapabilityActive();
    return this.#runSavepoint(callback);
  }
}
