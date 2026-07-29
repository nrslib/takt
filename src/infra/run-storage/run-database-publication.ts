import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readClock, SYSTEM_RUN_STORAGE_CLOCK } from './clock.js';
import {
  openDatabaseFileFromDescriptor,
  openExistingDatabaseFile,
  type RunDatabaseFile,
} from './database-file.js';
import {
  seedRunResumeImport,
} from './resume-import.js';
import type { CompleteResumeSnapshot } from './resume-snapshot-types.js';
import {
  configureConnectionSafety,
  createFixedSchema,
  setJournalMode,
  validateRunDatabase,
} from './schema-contract.js';
import { throwAfterCleanup } from './cleanup-error.js';
import {
  bootstrapRecoverySeedSha256,
  serializeBootstrapRecoverySeed,
  type BootstrapRecoverySeed,
} from '../../core/workflow/run/bootstrap-recovery-seed.js';

const CONNECTION_TIMEOUT_MS = 5;

interface RunDatabaseCreationInput {
  readonly databasePath: string;
  readonly run: {
    readonly runId: string;
    readonly workflowName: string;
    readonly findingContractEnabled: boolean;
  };
  readonly bootstrapSeed: BootstrapRecoverySeed;
}

export interface PublishedRunDatabase {
  readonly database: DatabaseSync;
  readonly file: RunDatabaseFile;
  readonly runId: string;
}

export function createPublishedRunDatabase(
  input: RunDatabaseCreationInput,
): PublishedRunDatabase {
  return publishRunDatabase(input, { kind: 'new' });
}

export function createPublishedResumedRunDatabase(
  input: RunDatabaseCreationInput,
  source: CompleteResumeSnapshot,
): PublishedRunDatabase {
  return publishRunDatabase(input, { kind: 'resume', source });
}

function publishRunDatabase(
  input: RunDatabaseCreationInput,
  seed: {
    readonly kind: 'new';
  } | {
    readonly kind: 'resume';
    readonly source: CompleteResumeSnapshot;
  },
): PublishedRunDatabase {
  if (existsSync(input.databasePath)) {
    throw new Error(`Run database already exists: ${input.databasePath}`);
  }
  const directory = dirname(input.databasePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const runId = input.run.runId;
  const databaseInstanceId = randomUUID();
  const temporaryPath = join(
    directory,
    `.${basename(input.databasePath)}.${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  let destinationCreated = false;
  let opened: {
    readonly database: DatabaseSync;
    readonly file: RunDatabaseFile;
  } | undefined;
  try {
    const descriptor = openSync(
      temporaryPath,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_RDWR
        | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryExists = true;
    opened = openDatabaseFileFromDescriptor(
      temporaryPath,
      descriptor,
      CONNECTION_TIMEOUT_MS,
    );
    configureConnectionSafety(opened.database);
    initializeRunDatabase(
      opened.database,
      input,
      databaseInstanceId,
      runId,
      seed,
    );
    validateWritablePublication(
      opened.database,
      databaseInstanceId,
      runId,
    );
    opened.file.sync();
    opened.file.close(opened.database);
    opened = undefined;

    linkSync(temporaryPath, input.databasePath);
    destinationCreated = true;
    unlinkSync(temporaryPath);
    temporaryExists = false;
    fsyncPath(directory);

    opened = openValidatedWritable(input.databasePath);
    assertPublicationIdentity(
      opened.database,
      databaseInstanceId,
      runId,
    );
    return { ...opened, runId };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    const closeError = disposeOpenedDatabase(opened);
    if (closeError !== undefined) {
      cleanupErrors.push(closeError);
    }
    if (temporaryExists) {
      try {
        unlinkSync(temporaryPath);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (destinationCreated) {
      try {
        unlinkSync(input.databasePath);
        fsyncPath(directory);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    throw publicationFailure(
      error,
      cleanupErrors,
    );
  }
}

export function openPublishedRunDatabase(
  databasePath: string,
): PublishedRunDatabase {
  if (!existsSync(databasePath)) {
    throw new Error(`Run database does not exist: ${databasePath}`);
  }
  const opened = openValidatedWritable(databasePath);
  const run = opened.database.prepare(
    'SELECT run_id AS runId FROM runs',
  ).get() as { readonly runId: string };
  return { ...opened, runId: run.runId };
}

export function openPublishedRunDatabaseForRecovery(
  databasePath: string,
): PublishedRunDatabase {
  if (!existsSync(databasePath)) {
    throw new Error(`Run database does not exist: ${databasePath}`);
  }
  const opened = openValidatedWritable(databasePath);
  const run = opened.database.prepare(
    'SELECT run_id AS runId FROM runs',
  ).get() as { readonly runId: string };
  return { ...opened, runId: run.runId };
}

function initializeRunDatabase(
  database: DatabaseSync,
  input: RunDatabaseCreationInput,
  databaseInstanceId: string,
  runId: string,
  seed: {
    readonly kind: 'new';
  } | {
    readonly kind: 'resume';
    readonly source: CompleteResumeSnapshot;
  },
): void {
  setJournalMode(database, 'delete');
  createFixedSchema(database, databaseInstanceId);
  seedRun(database, input, runId, seed);
  assertDatabaseIdentity(
    database,
    'delete',
    databaseInstanceId,
    runId,
  );
  setJournalMode(database, 'wal');
  assertDatabaseIdentity(
    database,
    'wal',
    databaseInstanceId,
    runId,
  );
  checkpointWal(database);
}

function validateWritablePublication(
  database: DatabaseSync,
  databaseInstanceId: string,
  runId: string,
): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    assertDatabaseIdentity(
      database,
      'wal',
      databaseInstanceId,
      runId,
    );
    database.exec('COMMIT');
  } catch (error) {
    throwAfterCleanup(error, [
      () => {
        if (database.isTransaction) {
          database.exec('ROLLBACK');
        }
      },
    ]);
  }
}

function assertPublicationIdentity(
  database: DatabaseSync,
  databaseInstanceId: string,
  runId: string,
): void {
  assertDatabaseIdentity(
    database,
    'wal',
    databaseInstanceId,
    runId,
  );
}

function assertDatabaseIdentity(
  database: DatabaseSync,
  journalMode: 'delete' | 'wal',
  databaseInstanceId: string,
  runId: string,
): void {
  const actualDatabaseInstanceId = validateRunDatabase(
    database,
    journalMode,
  );
  if (actualDatabaseInstanceId !== databaseInstanceId) {
    throw new Error(
      'Run storage database instance identity changed during publication',
    );
  }
  const run = database.prepare(
    'SELECT run_id AS runId FROM runs WHERE singleton_id = 1',
  ).get() as { readonly runId: string } | undefined;
  if (run?.runId !== runId) {
    throw new Error('Run storage run identity changed during publication');
  }
}

function seedRun(
  database: DatabaseSync,
  input: RunDatabaseCreationInput,
  runId: string,
  seed: {
    readonly kind: 'new';
  } | {
    readonly kind: 'resume';
    readonly source: CompleteResumeSnapshot;
  },
): void {
  const createdAt = readClock(SYSTEM_RUN_STORAGE_CLOCK);
  const rootFindingContractEnabled = resolveRootFindingContractEnabled(
    input.run.findingContractEnabled,
    seed,
  );
  const bootstrapSeed = serializeBootstrapRecoverySeed(input.bootstrapSeed);
  const bootstrapSeedSha256 = bootstrapRecoverySeedSha256(
    input.bootstrapSeed,
  );
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`
      INSERT INTO runs (
        singleton_id, run_id, finding_contract_enabled,
        bootstrap_seed_codec_name, bootstrap_seed, bootstrap_seed_sha256,
        status, created_at
      ) VALUES (1, ?, ?, 'json-v1', ?, ?, 'running', ?)
    `).run(
      runId,
      rootFindingContractEnabled ? 1 : 0,
      bootstrapSeed,
      bootstrapSeedSha256,
      createdAt,
    );
    database.prepare(`
      INSERT INTO scopes (
        run_id, scope_id, kind, finding_contract_enabled, created_at
      ) VALUES (?, 'root', 'root', ?, ?)
    `).run(
      runId,
      rootFindingContractEnabled ? 1 : 0,
      createdAt,
    );
    database.prepare(`
      INSERT INTO scope_runtime (run_id, scope_id, status, updated_at)
      VALUES (?, 'root', 'ready', ?)
    `).run(runId, createdAt);
    if (seed.kind === 'resume') {
      seedRunResumeImport(database, {
        childRunId: runId,
        childWorkflowName: input.run.workflowName,
        source: seed.source,
      });
    }
    database.exec('COMMIT');
  } catch (error) {
    throwAfterCleanup(error, [
      () => {
        if (database.isTransaction) {
          database.exec('ROLLBACK');
        }
      },
    ]);
  }
}

function resolveRootFindingContractEnabled(
  requested: boolean,
  seed: {
    readonly kind: 'new';
  } | {
    readonly kind: 'resume';
    readonly source: CompleteResumeSnapshot;
  },
): boolean {
  return seed.kind === 'new'
    ? requested
    : requested || readRootFindingContractEnabled(seed.source);
}

function readRootFindingContractEnabled(
  source: CompleteResumeSnapshot,
): boolean {
  const root = source.scopes.find((scope) => scope.scopeId === 'root');
  if (
    root?.findingContractEnabled !== 0
    && root?.findingContractEnabled !== 1
  ) {
    throw new Error('Run resume source root Finding Contract state is invalid');
  }
  return root.findingContractEnabled === 1;
}

function checkpointWal(database: DatabaseSync): void {
  const result = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
    readonly busy: number;
    readonly log: number;
    readonly checkpointed: number;
  };
  if (result.busy !== 0 || result.log !== result.checkpointed) {
    throw new Error('Run storage WAL checkpoint did not complete');
  }
}

function openValidatedWritable(databasePath: string): {
  readonly database: DatabaseSync;
  readonly file: RunDatabaseFile;
} {
  return openValidatedDatabase(databasePath, (database) => {
    validateRunDatabase(database, 'wal');
  });
}

function openValidatedDatabase(
  databasePath: string,
  validate: (database: DatabaseSync) => void,
): {
  readonly database: DatabaseSync;
  readonly file: RunDatabaseFile;
} {
  let opened: {
    readonly database: DatabaseSync;
    readonly file: RunDatabaseFile;
  } | undefined;
  try {
    opened = openExistingDatabaseFile(databasePath, CONNECTION_TIMEOUT_MS);
    const database = opened.database;
    configureConnectionSafety(database);
    database.exec('BEGIN IMMEDIATE');
    try {
      validate(database);
      database.exec('COMMIT');
    } catch (error) {
      throwAfterCleanup(error, [
        () => {
          if (database.isTransaction) {
            database.exec('ROLLBACK');
          }
        },
      ]);
    }
    return opened;
  } catch (error) {
    const cleanupError = disposeOpenedDatabase(opened);
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [error, cleanupError],
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    throw error;
  }
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function publicationFailure(
  error: unknown,
  cleanupErrors: readonly unknown[],
): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const cause = cleanupErrors.length === 0
    ? error
    : new AggregateError(
        [error, ...cleanupErrors],
        detail,
        { cause: error },
      );
  return new Error(
    `Run database publication failed: ${detail}`,
    { cause },
  );
}

function disposeOpenedDatabase(
  opened: {
    readonly database: DatabaseSync;
    readonly file: RunDatabaseFile;
  } | undefined,
): unknown {
  if (opened === undefined) {
    return undefined;
  }
  try {
    opened.file.close(opened.database);
    return undefined;
  } catch (error) {
    return error;
  }
}
