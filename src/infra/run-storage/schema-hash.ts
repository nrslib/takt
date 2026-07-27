import { DatabaseSync, type DatabaseSync as Database } from 'node:sqlite';
import { canonicalJson, sha256 } from './canonical-json.js';
import { RUN_STORAGE_DDL } from './schema/index.js';

interface SchemaRow {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string | null;
}

export function actualSchemaHash(database: Database): string {
  const rows = database.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name, tbl_name
  `).all() as unknown as SchemaRow[];
  return sha256(canonicalJson(rows));
}

export function expectedSchemaHashFromDdl(): string {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(`${RUN_STORAGE_DDL.join(';\n')};`);
    return actualSchemaHash(database);
  } finally {
    database.close();
  }
}
