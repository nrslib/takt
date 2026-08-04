import type { DatabaseSync } from 'node:sqlite';

export const FINDING_STORAGE_TABLES = [
  'database_identity',
  'finding_authorities',
] as const;

export const FINDING_STORAGE_DDL = `
  CREATE TABLE database_identity (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    database_instance_id TEXT NOT NULL,
    run_id TEXT NOT NULL
  ) STRICT;

  CREATE TABLE finding_authorities (
    authority_key TEXT PRIMARY KEY CHECK (length(authority_key) > 0),
    workflow_name TEXT NOT NULL CHECK (length(workflow_name) > 0),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    ledger_json TEXT NOT NULL CHECK (json_valid(ledger_json)),
    updated_at TEXT NOT NULL
  ) STRICT;
`;

interface TableColumn {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly pk: number;
}

const EXPECTED_COLUMNS: Readonly<Record<string, readonly TableColumn[]>> = {
  database_identity: [
    { name: 'singleton_id', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'database_instance_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'run_id', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  finding_authorities: [
    { name: 'authority_key', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'workflow_name', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'revision', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'ledger_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'TEXT', notnull: 1, pk: 0 },
  ],
};

function assertExpectedTables(database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ readonly name: string }>;
  const actual = rows.map((row) => row.name);
  const expected = [...FINDING_STORAGE_TABLES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Finding storage schema tables mismatch: ${actual.join(', ')}`);
  }
}

function assertExpectedColumns(database: DatabaseSync, table: string): void {
  const actual = (
    database.prepare(`PRAGMA table_info(${table})`).all() as unknown
  ) as TableColumn[];
  const expected = EXPECTED_COLUMNS[table];
  if (expected === undefined || actual.length !== expected.length) {
    throw new Error(`Finding storage table "${table}" has an unexpected column count`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actualColumn = actual[index];
    const expectedColumn = expected[index];
    if (actualColumn === undefined || expectedColumn === undefined
      || actualColumn.name !== expectedColumn.name
      || actualColumn.type.toUpperCase() !== expectedColumn.type
      || actualColumn.notnull !== expectedColumn.notnull
      || actualColumn.pk !== expectedColumn.pk) {
      throw new Error(`Finding storage table "${table}" has an unexpected column contract`);
    }
  }
}

function assertExpectedDefinition(table: string, sql: string): void {
  const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  const required = table === 'database_identity'
    ? [
        /singleton_id integer primary key check \(singleton_id = 1\)/,
        /database_instance_id text not null/,
        /run_id text not null/,
      ]
    : [
        /authority_key text primary key check \(length\(authority_key\) > 0\)/,
        /workflow_name text not null check \(length\(workflow_name\) > 0\)/,
        /revision integer not null check \(revision >= 1\)/,
        /ledger_json text not null check \(json_valid\(ledger_json\)\)/,
        /updated_at text not null/,
      ];
  if (!normalized.endsWith('strict') || required.some((pattern) => !pattern.test(normalized))) {
    throw new Error(`Finding storage table "${table}" has an unexpected definition`);
  }
}

export function createFindingStorageSchema(database: DatabaseSync): void {
  database.exec(FINDING_STORAGE_DDL);
}

export function validateFindingStorageSchema(database: DatabaseSync): void {
  assertExpectedTables(database);
  for (const table of FINDING_STORAGE_TABLES) {
    assertExpectedColumns(database, table);
    const definition = database.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?
    `).get(table) as { readonly sql?: unknown } | undefined;
    if (typeof definition?.sql !== 'string') {
      throw new Error(`Finding storage table "${table}" has no SQL definition`);
    }
    assertExpectedDefinition(table, definition.sql);
  }
}
