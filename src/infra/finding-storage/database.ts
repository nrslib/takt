import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createFindingStorageSchema,
  validateFindingStorageSchema,
} from './schema.js';

const DATABASE_MODE = 0o600;
const DEFAULT_DATABASE_TIMEOUT_MS = 5_000;

export interface FindingDatabaseIdentity {
  readonly databaseInstanceId: string;
  readonly runId: string;
}

interface StoredIdentityRow {
  readonly singletonId: number;
  readonly databaseInstanceId: string;
  readonly runId: string;
}

function configureConnection(database: DatabaseSync): void {
  database.exec('PRAGMA trusted_schema = OFF');
  database.exec('PRAGMA synchronous = FULL');
  database.enableDefensive(true);
}

function readIdentity(database: DatabaseSync): FindingDatabaseIdentity {
  const rows = database.prepare(`
    SELECT
      singleton_id AS singletonId,
      database_instance_id AS databaseInstanceId,
      run_id AS runId
    FROM database_identity
  `).all() as unknown as StoredIdentityRow[];
  const identity = rows[0];
  if (rows.length !== 1 || identity === undefined || identity.singletonId !== 1
    || identity.databaseInstanceId.length === 0 || identity.runId.length === 0) {
    throw new Error('Finding storage database identity is invalid');
  }
  return identity;
}

function initializeOrValidateTarget(
  database: DatabaseSync,
  runId: string,
): { readonly identity: FindingDatabaseIdentity; readonly initialized: boolean } {
  try {
    database.exec('BEGIN IMMEDIATE');
    const tables = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all();
    let initialized = false;
    if (tables.length === 0) {
      const identity = {
        databaseInstanceId: randomUUID(),
        runId,
      };
      createFindingStorageSchema(database);
      database.prepare(`
        INSERT INTO database_identity (singleton_id, database_instance_id, run_id)
        VALUES (1, ?, ?)
      `).run(identity.databaseInstanceId, identity.runId);
      initialized = true;
    }
    validateFindingStorageSchema(database);
    const identity = readIdentity(database);
    if (identity.runId !== runId) {
      throw new Error(
        `Finding storage run id mismatch: expected "${runId}", got "${identity.runId}"`,
      );
    }
    database.exec('COMMIT');
    return { identity, initialized };
  } catch (error) {
    if (database.isTransaction) {
      database.exec('ROLLBACK');
    }
    throw error;
  }
}

export class FindingDatabase {
  readonly databasePath: string;
  readonly identity: FindingDatabaseIdentity;
  readonly persistent: boolean;
  readonly #database: DatabaseSync;
  #closed = false;

  private constructor(
    databasePath: string,
    database: DatabaseSync,
    identity: FindingDatabaseIdentity,
    persistent: boolean,
  ) {
    this.databasePath = databasePath;
    this.#database = database;
    this.identity = identity;
    this.persistent = persistent;
  }

  static openTarget(input: {
    readonly databasePath: string;
    readonly runId: string;
    readonly timeoutMs?: number;
  }): FindingDatabase {
    const databasePath = resolve(input.databasePath);
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    let target: DatabaseSync | undefined;
    try {
      target = new DatabaseSync(databasePath, {
        timeout: input.timeoutMs ?? DEFAULT_DATABASE_TIMEOUT_MS,
      });
      configureConnection(target);
      const opened = initializeOrValidateTarget(target, input.runId);
      if (opened.initialized) {
        chmodSync(databasePath, DATABASE_MODE);
      }
      return new FindingDatabase(databasePath, target, opened.identity, true);
    } catch (error) {
      if (target?.isOpen === true) {
        target.close();
      }
      throw error;
    }
  }

  static readSource<Result>(input: {
    readonly databasePath: string;
    readonly runId: string;
    readonly read: (database: DatabaseSync) => Result;
    readonly timeoutMs?: number;
  }): Result {
    const database = new DatabaseSync(resolve(input.databasePath), {
      readOnly: true,
      timeout: input.timeoutMs ?? DEFAULT_DATABASE_TIMEOUT_MS,
    });
    try {
      configureConnection(database);
      validateFindingStorageSchema(database);
      const identity = readIdentity(database);
      if (identity.runId !== input.runId) {
        throw new Error(
          `Finding storage source run id mismatch: expected "${input.runId}", got "${identity.runId}"`,
        );
      }
      return input.read(database);
    } finally {
      database.close();
    }
  }

  get connection(): DatabaseSync {
    if (this.#closed) {
      throw new Error('Finding storage database is closed');
    }
    return this.#database;
  }

  transaction<Result>(action: () => Result): Result {
    const database = this.connection;
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      if (database.isTransaction) {
        database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#database.close();
  }
}
