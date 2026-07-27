import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256 } from './canonical-json.js';
import { readClock, SYSTEM_RUN_STORAGE_CLOCK } from './clock.js';
import { assertCodecContent } from './codec-contract.js';
import {
  openDatabaseFileFromDescriptor,
  openExistingDatabaseFile,
  type RunDatabaseFile,
} from './database-file.js';
import {
  currentEngineArtifactIdentity,
  type EngineArtifactIdentity,
} from './engine-artifact.js';
import { bootstrapFindingAuthority } from './finding-ledger.js';
import {
  seedRunResumeImport,
  type TrustedRunStorageResumeSnapshot,
} from './resume-import.js';
import {
  configureConnectionSafety,
  createFixedSchema,
  setJournalMode,
  validateRunDatabase,
} from './schema-contract.js';
import { throwAfterCleanup } from './cleanup-error.js';

const CONNECTION_TIMEOUT_MS = 5;

interface RunDatabaseCreationInput {
  readonly databasePath: string;
  readonly run: {
    readonly slug: string;
    readonly findingContractEnabled: boolean;
  };
  readonly workflowDefinition: {
    readonly name: string;
    readonly codecName: string;
    readonly definition: string;
  };
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
  source: TrustedRunStorageResumeSnapshot,
): PublishedRunDatabase {
  return publishRunDatabase(input, { kind: 'resume', source });
}

function publishRunDatabase(
  input: RunDatabaseCreationInput,
  seed: {
    readonly kind: 'new';
  } | {
    readonly kind: 'resume';
    readonly source: TrustedRunStorageResumeSnapshot;
  },
): PublishedRunDatabase {
  if (existsSync(input.databasePath)) {
    throw new Error(`Run database already exists: ${input.databasePath}`);
  }
  const directory = dirname(input.databasePath);
  const engineArtifact = currentEngineArtifactIdentity();
  const runId = randomUUID();
  const databaseInstanceId = randomUUID();
  let destinationCreated = false;
  let opened: {
    readonly database: DatabaseSync;
    readonly file: RunDatabaseFile;
  } | undefined;
  try {
    const descriptor = openSync(
      input.databasePath,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_RDWR
        | constants.O_NOFOLLOW,
      0o600,
    );
    destinationCreated = true;
    opened = openDatabaseFileFromDescriptor(
      input.databasePath,
      descriptor,
      CONNECTION_TIMEOUT_MS,
    );
    configureConnectionSafety(opened.database);
    initializeRunDatabase(
      opened.database,
      input,
      engineArtifact,
      databaseInstanceId,
      runId,
      seed,
    );
    validateWritablePublication(
      opened.database,
      engineArtifact,
      databaseInstanceId,
      runId,
    );
    opened.file.sync();
    fsyncPath(directory);
    assertPublicationIdentity(
      opened.database,
      engineArtifact,
      databaseInstanceId,
      runId,
    );
    return { ...opened, runId };
  } catch (error) {
    const cleanupError = disposeOpenedDatabase(opened);
    throw publicationFailure(
      error,
      input.databasePath,
      destinationCreated,
      cleanupError,
    );
  }
}

export function openPublishedRunDatabase(
  databasePath: string,
): PublishedRunDatabase {
  if (!existsSync(databasePath)) {
    throw new Error(`Run database does not exist: ${databasePath}`);
  }
  const opened = openValidatedWritable(
    databasePath,
    currentEngineArtifactIdentity(),
  );
  const run = opened.database.prepare(
    'SELECT run_id AS runId FROM runs',
  ).get() as { readonly runId: string };
  return { ...opened, runId: run.runId };
}

function initializeRunDatabase(
  database: DatabaseSync,
  input: RunDatabaseCreationInput,
  engineArtifact: EngineArtifactIdentity,
  databaseInstanceId: string,
  runId: string,
  seed: {
    readonly kind: 'new';
  } | {
    readonly kind: 'resume';
    readonly source: TrustedRunStorageResumeSnapshot;
  },
): void {
  setJournalMode(database, 'delete');
  createFixedSchema(database, databaseInstanceId);
  seedRun(database, input, engineArtifact, runId, seed);
  assertDatabaseIdentity(
    database,
    'delete',
    engineArtifact,
    databaseInstanceId,
    runId,
  );
  setJournalMode(database, 'wal');
  assertDatabaseIdentity(
    database,
    'wal',
    engineArtifact,
    databaseInstanceId,
    runId,
  );
  checkpointWal(database);
}

function validateWritablePublication(
  database: DatabaseSync,
  engineArtifact: EngineArtifactIdentity,
  databaseInstanceId: string,
  runId: string,
): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    assertDatabaseIdentity(
      database,
      'wal',
      engineArtifact,
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
  engineArtifact: EngineArtifactIdentity,
  databaseInstanceId: string,
  runId: string,
): void {
  assertDatabaseIdentity(
    database,
    'wal',
    engineArtifact,
    databaseInstanceId,
    runId,
  );
}

function assertDatabaseIdentity(
  database: DatabaseSync,
  journalMode: 'delete' | 'wal',
  engineArtifact: EngineArtifactIdentity,
  databaseInstanceId: string,
  runId: string,
): void {
  const actualDatabaseInstanceId = validateRunDatabase(
    database,
    journalMode,
    engineArtifact,
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
  engineArtifact: EngineArtifactIdentity,
  runId: string,
  seed: {
    readonly kind: 'new';
  } | {
    readonly kind: 'resume';
    readonly source: TrustedRunStorageResumeSnapshot;
  },
): void {
  const workflow = input.workflowDefinition;
  assertCodecContent(workflow.codecName, workflow.definition);
  const createdAt = readClock(SYSTEM_RUN_STORAGE_CLOCK);
  const definitionDigest = sha256(workflow.definition);
  const definitionId = sha256([
    workflow.name,
    workflow.codecName,
    definitionDigest,
  ].join('\0'));
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`
      INSERT INTO engine_builds (build_id, version, digest)
      VALUES (?, ?, ?)
    `).run(
      engineArtifact.buildId,
      engineArtifact.version,
      engineArtifact.digest,
    );
    database.prepare(`
      INSERT INTO workflow_definitions (
        definition_id, name, codec_name, definition, digest
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      definitionId,
      workflow.name,
      workflow.codecName,
      workflow.definition,
      definitionDigest,
    );
    database.prepare(`
      INSERT INTO runs (
        singleton_id, run_id, slug, engine_build_id,
        workflow_definition_id, finding_contract_enabled, status, created_at
      ) VALUES (1, ?, ?, ?, ?, ?, 'running', ?)
    `).run(
      runId,
      input.run.slug,
      engineArtifact.buildId,
      definitionId,
      input.run.findingContractEnabled ? 1 : 0,
      createdAt,
    );
    database.prepare(`
      INSERT INTO scopes (
        run_id, scope_id, kind, workflow_definition_id, created_at
      ) VALUES (?, 'root', 'root', ?, ?)
    `).run(runId, definitionId, createdAt);
    database.prepare(`
      INSERT INTO scope_runtime (run_id, scope_id, status, updated_at)
      VALUES (?, 'root', 'ready', ?)
    `).run(runId, createdAt);
    if (seed.kind === 'resume') {
      seedRunResumeImport(database, {
        childRunId: runId,
        childWorkflowName: workflow.name,
        findingContractEnabled: input.run.findingContractEnabled,
        source: seed.source,
      });
    } else if (input.run.findingContractEnabled) {
      bootstrapFindingAuthority({
        run: (sql, ...parameters) => database.prepare(sql).run(...parameters),
      }, {
        runId,
        scopeId: 'root',
        workflowName: workflow.name,
        createdAt,
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

function openValidatedWritable(
  databasePath: string,
  expectedEngineBuild: EngineArtifactIdentity,
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
      validateRunDatabase(
        database,
        'wal',
        expectedEngineBuild,
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
  databasePath: string,
  destinationCreated: boolean,
  cleanupError: unknown,
): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const cause = cleanupError === undefined
    ? error
    : new AggregateError(
        [error, cleanupError],
        detail,
        { cause: error },
      );
  if (destinationCreated) {
    return new Error(
      `Run database publication failed after destination creation; `
      + `the destination was left untouched as an orphan and retrying the same path will fail: `
      + `${databasePath}; ${detail}`,
      { cause },
    );
  }
  return new Error(
    `Run database publication failed before destination creation: ${detail}`,
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
