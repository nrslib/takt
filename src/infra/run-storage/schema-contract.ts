import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { CODEC_CONTRACT } from './codec-contract.js';
import {
  APPLICATION_ID,
  EXPECTED_SCHEMA_HASH,
  SCHEMA_VERSION,
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
  database.exec('PRAGMA synchronous = FULL');
  database.enableDefensive(true);
  if (pragmaNumber(database, 'foreign_keys') !== 1) {
    throw new Error('Run storage requires PRAGMA foreign_keys = ON');
  }
  if (pragmaNumber(database, 'trusted_schema') !== 0) {
    throw new Error('Run storage requires PRAGMA trusted_schema = OFF');
  }
  if (pragmaNumber(database, 'synchronous') !== 2) {
    throw new Error('Run storage requires PRAGMA synchronous = FULL');
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
        schema_hash
      ) VALUES (1, ?, ?, ?, ?)
    `).run(
      databaseInstanceId,
      SCHEMA_VERSION,
      APPLICATION_ID,
      EXPECTED_SCHEMA_HASH,
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
      ) AS terminalPairViolationCount,
      (
        SELECT count(*)
        FROM runs
        LEFT JOIN terminal_publications USING (run_id)
        WHERE
          (runs.status = 'running' AND terminal_publications.run_id IS NOT NULL)
          OR (
            runs.status <> 'running'
            AND (
              terminal_publications.run_id IS NULL
              OR terminal_publications.terminal_at <> runs.terminal_at
              OR terminal_publications.status <> CASE runs.status
                WHEN 'cancelled' THEN 'aborted'
                ELSE runs.status
              END
            )
          )
      ) AS terminalPublicationViolationCount,
      (
        SELECT count(*)
        FROM runs
        LEFT JOIN terminal_publications USING (run_id)
        WHERE
          (
            runs.status = 'running'
            AND EXISTS (
              SELECT 1
              FROM terminal_publication_stages
              WHERE terminal_publication_stages.run_id = runs.run_id
            )
          )
          OR (
            runs.status <> 'running'
            AND (
              (
                SELECT count(*)
                FROM terminal_publication_stages
                WHERE terminal_publication_stages.run_id = runs.run_id
              ) <> 3
              OR (
                terminal_publications.published_at IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM terminal_publication_stages
                  WHERE
                    terminal_publication_stages.run_id = runs.run_id
                    AND acknowledged_at IS NULL
                )
              )
              OR (
                terminal_publications.published_at IS NULL
                AND NOT EXISTS (
                  SELECT 1
                  FROM terminal_publication_stages
                  WHERE
                    terminal_publication_stages.run_id = runs.run_id
                    AND acknowledged_at IS NULL
                )
              )
            )
          )
      ) AS terminalPublicationStageViolationCount
  `).get() as {
    readonly runCount: number;
    readonly rootScopeCount: number;
    readonly rootRuntimeCount: number;
    readonly scopeWithoutRuntimeCount: number;
    readonly runtimeWithoutScopeCount: number;
    readonly scopeTerminalPairViolationCount: number;
    readonly terminalPairViolationCount: number;
    readonly terminalPublicationViolationCount: number;
    readonly terminalPublicationStageViolationCount: number;
  };
  if (
    authority.runCount !== 1
    || authority.rootScopeCount !== 1
    || authority.rootRuntimeCount !== 1
    || authority.scopeWithoutRuntimeCount !== 0
    || authority.runtimeWithoutScopeCount !== 0
    || authority.scopeTerminalPairViolationCount !== 0
    || authority.terminalPairViolationCount !== 0
    || authority.terminalPublicationViolationCount !== 0
    || authority.terminalPublicationStageViolationCount !== 0
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
      schema_hash AS schemaHash
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
  return stored.databaseInstanceId;
}

export function validateRunDatabase(
  database: DatabaseSync,
  expectedJournalMode: 'delete' | 'wal',
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
  validateJournalMode(database, expectedJournalMode);
  return databaseInstanceId;
}
