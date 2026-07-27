import { constants, type DatabaseSync } from 'node:sqlite';
import { throwAfterCleanup } from './cleanup-error.js';

export type AuthorityMode =
  | 'read'
  | 'normal-write'
  | 'lease-check'
  | 'lease-claim'
  | 'lease-maintenance'
  | 'operation';

const READ_ACTIONS = new Set([
  constants.SQLITE_FUNCTION,
  constants.SQLITE_READ,
  constants.SQLITE_RECURSIVE,
  constants.SQLITE_SELECT,
]);

const DML_ACTIONS = new Set([
  constants.SQLITE_DELETE,
  constants.SQLITE_INSERT,
  constants.SQLITE_UPDATE,
]);

const BOOTSTRAP_AUTHORITY_TABLES = new Set([
  'storage_contract',
  'storage_codecs',
  'engine_builds',
  'workflow_definitions',
  'runs',
  'run_ancestry',
  'run_resume_sources',
  'run_leases',
]);

const OPERATION_AUTHORITY_TABLES = new Set([
  'operations',
  'operation_attempts',
  'operation_transitions',
]);

function permitsDml(
  mode: AuthorityMode,
  actionCode: number,
  tableName: string,
  triggerName: string | null,
): boolean {
  if (!DML_ACTIONS.has(actionCode)) {
    return false;
  }
  switch (mode) {
    case 'read':
      return false;
    case 'normal-write':
      if (tableName === 'workflow_definitions') {
        return actionCode === constants.SQLITE_INSERT;
      }
      return !BOOTSTRAP_AUTHORITY_TABLES.has(tableName)
        && !OPERATION_AUTHORITY_TABLES.has(tableName);
    case 'lease-check':
      return actionCode === constants.SQLITE_UPDATE && tableName === 'run_leases';
    case 'lease-claim':
      return tableName === 'run_leases'
        && (actionCode === constants.SQLITE_INSERT || actionCode === constants.SQLITE_UPDATE);
    case 'lease-maintenance':
      return actionCode === constants.SQLITE_UPDATE
        && (
          tableName === 'run_leases'
          || tableName === 'scopes'
          || tableName === 'scope_runtime'
          || (
            tableName === 'runs'
            && triggerName === 'run_leases_apply_terminal_state'
          )
        );
    case 'operation':
      return OPERATION_AUTHORITY_TABLES.has(tableName);
  }
}

export class DatabaseAuthority {
  #mode: AuthorityMode | undefined;
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  activate(mode: AuthorityMode): void {
    if (this.#mode !== undefined) {
      throw new Error('Database authority is already active');
    }
    this.#database.setAuthorizer((actionCode, tableName, _column, _database, triggerName) => {
      if (READ_ACTIONS.has(actionCode)) {
        return constants.SQLITE_OK;
      }
      return permitsDml(mode, actionCode, tableName ?? '', triggerName)
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    });
    this.#mode = mode;
  }

  switchTo(mode: AuthorityMode): void {
    this.clear();
    this.activate(mode);
  }

  clear(): void {
    if (this.#mode === undefined) {
      return;
    }
    try {
      this.#database.setAuthorizer(null);
    } finally {
      this.#mode = undefined;
    }
  }

  runWithoutAuthorizer<Result>(callback: () => Result): Result {
    const activeMode = this.#mode;
    if (activeMode === undefined) {
      return callback();
    }
    this.clear();
    let result: Result;
    try {
      result = callback();
    } catch (error) {
      throwAfterCleanup(error, [() => this.activate(activeMode)]);
    }
    this.activate(activeMode);
    return result;
  }
}
