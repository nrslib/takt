import type { DatabaseSync } from 'node:sqlite';
import type { FindingLedger } from '../../core/workflow/findings/types.js';
import type {
  FindingLedgerMutation,
  FindingLedgerPublicationDecision,
} from '../../core/workflow/findings/store.js';
import {
  cloneFindingLedgerMutation,
  normalizeFindingLedger,
  normalizeFindingLedgerMutation,
} from '../../core/workflow/findings/ledger-mutation.js';
import { FindingDatabase } from './database.js';
import type { SourceAuthorityRaw } from './inherited-source-parser.js';

interface AuthorityRow {
  readonly authorityKey: string;
  readonly workflowName: string;
  readonly revision: number;
  readonly ledgerJson: string;
}

export interface FindingAuthoritySeed {
  readonly ledger: FindingLedger;
}

export interface FindingAuthorityRevision {
  readonly revision: number;
  readonly ledger: FindingLedger;
}

function readAuthorityRow(
  database: DatabaseSync,
  authorityKey: string,
): AuthorityRow | undefined {
  return database.prepare(`
    SELECT
      authority_key AS authorityKey,
      workflow_name AS workflowName,
      revision,
      ledger_json AS ledgerJson
    FROM finding_authorities
    WHERE authority_key = ?
  `).get(authorityKey) as AuthorityRow | undefined;
}

function parseStoredLedger(row: AuthorityRow, expectedWorkflowName: string): FindingLedger {
  if (row.authorityKey.length === 0 || row.workflowName !== expectedWorkflowName
    || !Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw new Error(`Finding authority "${row.authorityKey}" has invalid metadata`);
  }
  return normalizeFindingLedger(JSON.parse(row.ledgerJson), expectedWorkflowName);
}

export class FindingAuthorityRepository {
  readonly #database: FindingDatabase;
  readonly #now: () => string;

  constructor(database: FindingDatabase, now: () => string) {
    this.#database = database;
    this.#now = now;
  }

  ensureAuthority(input: {
    readonly authorityKey: string;
    readonly workflowName: string;
    readonly seed: () => FindingAuthoritySeed;
  }): FindingAuthorityRevision {
    return this.#database.transaction(() => {
      const existing = readAuthorityRow(this.#database.connection, input.authorityKey);
      if (existing !== undefined) {
        return {
          revision: existing.revision,
          ledger: parseStoredLedger(existing, input.workflowName),
        };
      }

      const ledger = normalizeFindingLedger(input.seed().ledger, input.workflowName);
      this.#database.connection.prepare(`
        INSERT INTO finding_authorities (
          authority_key,
          workflow_name,
          revision,
          ledger_json,
          updated_at
        ) VALUES (?, ?, 1, ?, ?)
      `).run(
        input.authorityKey,
        input.workflowName,
        JSON.stringify(ledger),
        this.#now(),
      );
      return { revision: 1, ledger };
    });
  }

  load(authorityKey: string, workflowName: string): FindingAuthorityRevision {
    const row = readAuthorityRow(this.#database.connection, authorityKey);
    if (row === undefined) {
      throw new Error(`Finding authority "${authorityKey}" is missing`);
    }
    return {
      revision: row.revision,
      ledger: parseStoredLedger(row, workflowName),
    };
  }

  update<Result>(input: {
    readonly authorityKey: string;
    readonly workflowName: string;
    readonly mutator: (current: FindingLedger) => FindingLedgerMutation<Result>;
    readonly revalidateBeforeSave?: (
      current: FindingLedger,
      mutation: FindingLedgerMutation<Result>,
    ) => FindingLedgerPublicationDecision<Result>;
  }): FindingLedgerMutation<Result> {
    return this.#updatePrepared({
      authorityKey: input.authorityKey,
      workflowName: input.workflowName,
      prepare: (current) => {
        const initial = normalizeFindingLedgerMutation(
          current,
          input.mutator(structuredClone(current)),
          input.workflowName,
        );
        return input.revalidateBeforeSave === undefined
          ? initial
          : normalizeFindingLedgerMutation(
              current,
              input.revalidateBeforeSave(
                structuredClone(current),
                cloneFindingLedgerMutation(initial),
              ).mutation,
              input.workflowName,
            );
      },
    });
  }

  updatePrepared<Result>(input: {
    readonly authorityKey: string;
    readonly workflowName: string;
    readonly prepare: (current: FindingLedger) => FindingLedgerMutation<Result>;
  }): FindingLedgerMutation<Result> {
    return this.#updatePrepared({
      ...input,
      prepare: (current) => {
        const mutation = input.prepare(structuredClone(current));
        return {
          ...mutation,
          ledger: normalizeFindingLedger(mutation.ledger, input.workflowName),
        };
      },
    });
  }

  #updatePrepared<Result>(input: {
    readonly authorityKey: string;
    readonly workflowName: string;
    readonly prepare: (current: FindingLedger) => FindingLedgerMutation<Result>;
  }): FindingLedgerMutation<Result> {
    return this.#database.transaction(() => {
      const row = readAuthorityRow(this.#database.connection, input.authorityKey);
      if (row === undefined) {
        throw new Error(`Finding authority "${input.authorityKey}" is missing`);
      }
      const current = parseStoredLedger(row, input.workflowName);
      const mutation = input.prepare(current);
      const result = this.#database.connection.prepare(`
        UPDATE finding_authorities
        SET revision = revision + 1, ledger_json = ?, updated_at = ?
        WHERE authority_key = ? AND revision = ?
      `).run(
        JSON.stringify(mutation.ledger),
        this.#now(),
        input.authorityKey,
        row.revision,
      );
      if (Number(result.changes) !== 1) {
        throw new Error(`Finding authority "${input.authorityKey}" revision CAS failed`);
      }
      return mutation;
    });
  }
}

export function readSourceAuthorityRaw(
  database: DatabaseSync,
  authorityKey: string,
): SourceAuthorityRaw | undefined {
  return readAuthorityRow(database, authorityKey);
}

export function countSourceAuthorities(database: DatabaseSync): number {
  const row = database.prepare(`
    SELECT count(*) AS count FROM finding_authorities
  `).get() as { count: number };
  if (!Number.isSafeInteger(row.count) || row.count < 0) {
    throw new Error('Finding authority count is invalid');
  }
  return row.count;
}
