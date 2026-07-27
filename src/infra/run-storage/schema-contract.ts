import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { sha256 } from './canonical-json.js';
import { CODEC_CONTRACT } from './codec-contract.js';
import {
  APPLICATION_ID,
  EXPECTED_SCHEMA_HASH,
  SCHEMA_VERSION,
  STORAGE_CONTRACT_FINGERPRINT,
} from './contract.js';
import { actualSchemaHash } from './schema-hash.js';
import { FINDING_AUTHORITY_TABLES } from './schema/findings.js';
import { RUN_STORAGE_DDL } from './schema/index.js';
import {
  validateFindingAuthority,
} from './finding-ledger.js';
import { validateStoredReportHistory } from './reports.js';
import { throwAfterCleanup } from './cleanup-error.js';

interface StoredContractRow {
  readonly databaseInstanceId: string;
  readonly schemaVersion: number;
  readonly applicationId: number;
  readonly schemaHash: string;
  readonly fingerprint: string;
}

function pragmaNumber(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row?.[name];
  if (typeof value !== 'number') {
    throw new Error(`PRAGMA ${name} did not return a number`);
  }
  return value;
}

function pragmaText(database: DatabaseSync, name: string): string {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row?.[name];
  if (typeof value !== 'string') {
    throw new Error(`PRAGMA ${name} did not return text`);
  }
  return value.toLowerCase();
}

export function configureConnectionSafety(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA trusted_schema = OFF');
  database.enableDefensive(true);
  if (pragmaNumber(database, 'foreign_keys') !== 1) {
    throw new Error('Run storage requires PRAGMA foreign_keys = ON');
  }
  if (pragmaNumber(database, 'trusted_schema') !== 0) {
    throw new Error('Run storage requires PRAGMA trusted_schema = OFF');
  }
}

export function setJournalMode(
  database: DatabaseSync,
  journalMode: 'delete' | 'wal',
): void {
  const configured = database.prepare(
    `PRAGMA journal_mode = ${journalMode}`,
  ).get() as Record<string, unknown> | undefined;
  const result = configured?.journal_mode;
  if (typeof result !== 'string' || result.toLowerCase() !== journalMode) {
    throw new Error(
      `Run storage requires journal_mode=${journalMode}; received ${String(result)}`,
    );
  }
}

export function validateJournalMode(
  database: DatabaseSync,
  expected: 'delete' | 'wal',
): void {
  if (pragmaText(database, 'journal_mode') !== expected) {
    throw new Error(`Run storage journal_mode contract is ${expected}`);
  }
}

export function createFixedSchema(
  database: DatabaseSync,
  databaseInstanceId: string,
): void {
  database.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`${RUN_STORAGE_DDL.join(';\n')};`);
    const insertCodec = database.prepare(`
      INSERT INTO storage_codecs (codec_name, content_kind, digest_algorithm)
      VALUES (?, ?, ?)
    `);
    for (const codec of CODEC_CONTRACT) {
      insertCodec.run(codec.name, codec.contentKind, codec.digestAlgorithm);
    }
    database.prepare(`
      INSERT INTO storage_contract (
        singleton_id,
        database_instance_id,
        schema_version,
        application_id,
        schema_hash,
        fingerprint
      ) VALUES (1, ?, ?, ?, ?, ?)
    `).run(
      databaseInstanceId,
      SCHEMA_VERSION,
      APPLICATION_ID,
      EXPECTED_SCHEMA_HASH,
      STORAGE_CONTRACT_FINGERPRINT,
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

export function validateIntegrity(database: DatabaseSync): void {
  const integrityRows = database.prepare('PRAGMA integrity_check').all() as Array<
    Record<string, unknown>
  >;
  if (
    integrityRows.length !== 1
    || integrityRows[0]?.integrity_check !== 'ok'
  ) {
    throw new Error('Run storage integrity_check failed');
  }
  const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyViolations.length !== 0) {
    throw new Error('Run storage foreign_key_check reported a violation');
  }
}

export function validateAuthoritySeed(database: DatabaseSync): void {
  const authority = database.prepare(`
    SELECT
      (SELECT count(*) FROM runs) AS runCount,
      (SELECT count(*) FROM scopes WHERE kind = 'root') AS rootScopeCount,
      (
        SELECT count(*)
        FROM scope_runtime
        JOIN scopes USING (run_id, scope_id)
        WHERE scopes.kind = 'root'
      ) AS rootRuntimeCount,
      (
        SELECT count(*)
        FROM scopes
        LEFT JOIN scope_runtime USING (run_id, scope_id)
        WHERE scope_runtime.scope_id IS NULL
      ) AS scopeWithoutRuntimeCount,
      (
        SELECT count(*)
        FROM scope_runtime
        LEFT JOIN scopes USING (run_id, scope_id)
        WHERE scopes.scope_id IS NULL
      ) AS runtimeWithoutScopeCount,
      (
        SELECT count(*)
        FROM scopes
        JOIN scope_runtime USING (run_id, scope_id)
        WHERE
          (
            scope_runtime.status IN ('ready', 'running')
            AND scopes.terminal_at IS NOT NULL
          )
          OR (
            scope_runtime.status IN ('completed', 'failed', 'cancelled')
            AND (
              scopes.terminal_at IS NULL
              OR scopes.terminal_at <> scope_runtime.updated_at
            )
          )
      ) AS scopeTerminalPairViolationCount,
      (
        SELECT count(*)
        FROM runs
        LEFT JOIN run_leases USING (run_id)
        WHERE
          (
            runs.status = 'running'
            AND run_leases.terminalized_at IS NOT NULL
          )
          OR (
            runs.status <> 'running'
            AND (
              run_leases.terminalized_at IS NULL
              OR run_leases.terminalized_at <> runs.terminal_at
              OR run_leases.terminal_status <> runs.status
            )
          )
      ) AS terminalPairViolationCount
  `).get() as {
    readonly runCount: number;
    readonly rootScopeCount: number;
    readonly rootRuntimeCount: number;
    readonly scopeWithoutRuntimeCount: number;
    readonly runtimeWithoutScopeCount: number;
    readonly scopeTerminalPairViolationCount: number;
    readonly terminalPairViolationCount: number;
  };
  if (
    authority.runCount !== 1
    || authority.rootScopeCount !== 1
    || authority.rootRuntimeCount !== 1
    || authority.scopeWithoutRuntimeCount !== 0
    || authority.runtimeWithoutScopeCount !== 0
    || authority.scopeTerminalPairViolationCount !== 0
    || authority.terminalPairViolationCount !== 0
  ) {
    throw new Error('Run storage authority seed invariant mismatch');
  }
  const run = database.prepare(`
    SELECT
      run_id AS runId,
      finding_contract_enabled AS findingContractEnabled
    FROM runs
  `).get() as {
    readonly runId: string;
    readonly findingContractEnabled: number;
  };
  validateResumeProvenance(database, run);
  if (run.findingContractEnabled === 0) {
    for (const table of FINDING_AUTHORITY_TABLES) {
      const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
        readonly count: number;
      };
      if (row.count !== 0) {
        throw new Error(
          `Finding Contract disabled authority contains rows in "${table}"`,
        );
      }
    }
  } else {
    const findingSeed = database.prepare(`
      SELECT count(*) AS rootRevisionOneCount
      FROM finding_ledger_revisions
      WHERE run_id = ? AND scope_id = 'root' AND revision = 1
    `).get(run.runId) as {
      readonly rootRevisionOneCount: number;
    };
    if (findingSeed.rootRevisionOneCount !== 1) {
      throw new Error('Finding Contract authority bootstrap invariant mismatch');
    }
    const findingContext = {
      get: <Row>(sql: string, ...parameters: SQLInputValue[]) => (
        database.prepare(sql).get(...parameters) as Row | undefined
      ),
      all: <Row>(sql: string, ...parameters: SQLInputValue[]) => (
        database.prepare(sql).all(...parameters) as Row[]
      ),
    };
    validateFindingAuthority(findingContext, run.runId);
  }
}

function validateResumeProvenance(
  database: DatabaseSync,
  run: {
    readonly runId: string;
    readonly findingContractEnabled: number;
  },
): void {
  const ancestry = database.prepare(`
    SELECT
      ancestor_run_id AS ancestorRunId,
      depth,
      snapshot_digest AS snapshotDigest
    FROM run_ancestry
    WHERE run_id = ?
    ORDER BY depth
  `).all(run.runId) as Array<{
    readonly ancestorRunId: string;
    readonly depth: number;
    readonly snapshotDigest: string;
  }>;
  const source = database.prepare(`
    SELECT
      source_run_id AS sourceRunId,
      source_snapshot_digest AS sourceSnapshotDigest,
      source_finding_scope_id AS sourceFindingScopeId,
      source_finding_revision AS sourceFindingRevision,
      imported_finding_revision AS importedFindingRevision,
      source_finding_projection_digest AS sourceFindingProjectionDigest
    FROM run_resume_sources
    WHERE run_id = ?
  `).get(run.runId) as {
    readonly sourceRunId: string;
    readonly sourceSnapshotDigest: string;
    readonly sourceFindingScopeId: string | null;
    readonly sourceFindingRevision: number | null;
    readonly importedFindingRevision: number | null;
    readonly sourceFindingProjectionDigest: string | null;
  } | undefined;
  if (source === undefined) {
    if (ancestry.length !== 0) {
      throw new Error('Run resume ancestry has no direct source provenance');
    }
    return;
  }
  if (
    ancestry.length === 0
    || ancestry.some((entry, index) => entry.depth !== index + 1)
    || ancestry[0]?.ancestorRunId !== source.sourceRunId
    || ancestry[0]?.snapshotDigest !== source.sourceSnapshotDigest
  ) {
    throw new Error('Run resume direct source provenance mismatch');
  }
  if (run.findingContractEnabled === 0) {
    if (
      source.sourceFindingScopeId !== null
      || source.sourceFindingRevision !== null
      || source.importedFindingRevision !== null
      || source.sourceFindingProjectionDigest !== null
    ) {
      throw new Error('Run resume imported Finding authority while disabled');
    }
    return;
  }
  const imported = database.prepare(`
    SELECT projection_digest AS projectionDigest
    FROM finding_ledger_revisions
    WHERE run_id = ? AND scope_id = ? AND revision = ?
  `).get(
    run.runId,
    source.sourceFindingScopeId,
    source.importedFindingRevision,
  ) as { readonly projectionDigest: string } | undefined;
  if (
    source.sourceFindingScopeId !== 'root'
    || source.sourceFindingRevision === null
    || source.importedFindingRevision !== 1
    || source.sourceFindingProjectionDigest === null
    || imported?.projectionDigest !== source.sourceFindingProjectionDigest
  ) {
    throw new Error('Run resume imported Finding authority provenance mismatch');
  }
}

export function validateEngineProvenance(
  database: DatabaseSync,
  expected: {
    readonly buildId: string;
    readonly version: string;
    readonly digest: string;
  },
): void {
  const actual = database.prepare(`
    SELECT
      engine_builds.build_id AS buildId,
      engine_builds.version,
      engine_builds.digest
    FROM runs
    JOIN engine_builds ON engine_builds.build_id = runs.engine_build_id
  `).get() as typeof expected | undefined;
  if (
    actual === undefined
    || actual.buildId !== expected.buildId
    || actual.version !== expected.version
    || actual.digest !== expected.digest
  ) {
    throw new Error('Run storage engine build provenance mismatch');
  }
}

export function validateWorkflowDefinitionDigests(database: DatabaseSync): void {
  const definitions = database.prepare(`
    SELECT
      definition_id AS definitionId,
      name,
      codec_name AS codecName,
      definition,
      digest
    FROM workflow_definitions
  `).all() as Array<{
    readonly definitionId: string;
    readonly name: string;
    readonly codecName: string;
    readonly definition: string;
    readonly digest: string;
  }>;
  for (const definition of definitions) {
    const digest = sha256(definition.definition);
    const definitionId = sha256([
      definition.name,
      definition.codecName,
      digest,
    ].join('\0'));
    if (
      digest !== definition.digest
      || definitionId !== definition.definitionId
    ) {
      throw new Error(
        `Workflow definition identity mismatch for "${definition.definitionId}"`,
      );
    }
  }
}

export function validateFixedSchema(database: DatabaseSync): string {
  const applicationId = pragmaNumber(database, 'application_id');
  if (applicationId !== APPLICATION_ID) {
    throw new Error(
      `Run storage application_id mismatch: expected ${APPLICATION_ID}, received ${applicationId}`,
    );
  }
  const userVersion = pragmaNumber(database, 'user_version');
  if (userVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Run storage schema_version mismatch: expected ${SCHEMA_VERSION}, received ${userVersion}`,
    );
  }
  const schemaHash = actualSchemaHash(database);
  if (schemaHash !== EXPECTED_SCHEMA_HASH) {
    throw new Error(
      `Run storage schema hash mismatch: expected ${EXPECTED_SCHEMA_HASH}, received ${schemaHash}`,
    );
  }
  const stored = database.prepare(`
    SELECT
      database_instance_id AS databaseInstanceId,
      schema_version AS schemaVersion,
      application_id AS applicationId,
      schema_hash AS schemaHash,
      fingerprint
    FROM storage_contract
    WHERE singleton_id = 1
  `).get() as StoredContractRow | undefined;
  if (stored === undefined) {
    throw new Error('Run storage contract row is missing');
  }
  if (stored.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Run storage schema_version must be ${SCHEMA_VERSION}`);
  }
  if (stored.applicationId !== APPLICATION_ID) {
    throw new Error('Run storage stored application_id mismatch');
  }
  if (stored.schemaHash !== EXPECTED_SCHEMA_HASH) {
    throw new Error('Run storage stored schema hash mismatch');
  }
  if (stored.fingerprint !== STORAGE_CONTRACT_FINGERPRINT) {
    throw new Error('Run storage stored fingerprint mismatch');
  }
  if (
    stored.databaseInstanceId.length !== 36
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      stored.databaseInstanceId,
    )
  ) {
    throw new Error('Run storage database instance identity is invalid');
  }
  const codecs = database.prepare(`
    SELECT
      codec_name AS name,
      content_kind AS contentKind,
      digest_algorithm AS digestAlgorithm
    FROM storage_codecs
    ORDER BY codec_name
  `).all();
  const expectedCodecs = [...CODEC_CONTRACT].sort((left, right) => (
    left.name.localeCompare(right.name)
  ));
  if (JSON.stringify(codecs) !== JSON.stringify(expectedCodecs)) {
    throw new Error('Run storage codec registry mismatch');
  }
  validateWorkflowDefinitionDigests(database);
  return stored.databaseInstanceId;
}

export function validateRunDatabase(
  database: DatabaseSync,
  expectedJournalMode: 'delete' | 'wal',
  expectedEngineBuild?: {
    readonly buildId: string;
    readonly version: string;
    readonly digest: string;
  },
): string {
  const databaseInstanceId = validateFixedSchema(database);
  validateIntegrity(database);
  validateAuthoritySeed(database);
  const run = database.prepare(
    'SELECT run_id AS runId FROM runs',
  ).get() as { readonly runId: string };
  validateStoredReportHistory({
    all: <Row>(sql: string, ...parameters: SQLInputValue[]) => (
      database.prepare(sql).all(...parameters) as Row[]
    ),
  }, run.runId);
  if (expectedEngineBuild !== undefined) {
    validateEngineProvenance(database, expectedEngineBuild);
  }
  validateJournalMode(database, expectedJournalMode);
  return databaseInstanceId;
}
