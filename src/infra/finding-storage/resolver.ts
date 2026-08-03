import { resolve } from 'node:path';
import type { FindingLedger } from '../../core/workflow/findings/types.js';
import { createEmptyFindingContractRegistries } from '../../core/models/finding-contract-seed.js';
import type { FindingLedgerStore } from '../../core/workflow/findings/store.js';
import { FindingArtifactStore } from './artifacts.js';
import { FindingDatabase } from './database.js';
import {
  FindingAuthorityRepository,
  readSourceAuthorityRaw,
} from './repository.js';
import { SqliteFindingLedgerStore } from './store.js';
import { parseInheritedSourceAuthority } from './inherited-source-parser.js';
import { normalizeInheritedProvisionalTargetConflicts } from '../../core/workflow/findings/provisional-conflict-normalization.js';
import { normalizeFindingLedger } from '../../core/workflow/findings/ledger-mutation.js';

export const ROOT_FINDING_AUTHORITY_KEY = 'root';

export interface FindingStorageSource {
  readonly databasePath: string;
  readonly runId: string;
}

export interface FindingAuthorityInput {
  readonly authorityKey: string;
  readonly workflowName: string;
  readonly reportDir: string;
}

export interface FindingStorageWarning {
  readonly message: string;
  readonly error?: unknown;
}

function emptyLedger(workflowName: string, now: string): FindingLedger {
  return {
    workflowName,
    nextId: 1,
    findings: [],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawFindings: [],
    conflicts: [],
    ...createEmptyFindingContractRegistries(),
    updatedAt: now,
  };
}

function importLedger(
  source: FindingLedger,
  workflowName: string,
  destinationRunId: string,
): FindingLedger {
  return {
    ...structuredClone(source),
    workflowName,
    ...(source.pendingManagerCommit === undefined
      ? {}
      : {
          pendingManagerCommit: {
            ...structuredClone(source.pendingManagerCommit),
            publication: {
              ...structuredClone(source.pendingManagerCommit.publication),
              destinationRunId,
            },
          },
        }),
  };
}

export class FindingStorageResolver {
  readonly databasePath: string;
  readonly runId: string;
  readonly #source: FindingStorageSource | undefined;
  readonly #now: () => string;
  readonly #timeoutMs: number | undefined;
  readonly #sourceMatchesTarget: boolean;
  #database: FindingDatabase | undefined;
  #repository: FindingAuthorityRepository | undefined;
  #closed = false;

  constructor(input: {
    readonly databasePath: string;
    readonly runId: string;
    readonly source?: FindingStorageSource;
    readonly now?: () => string;
    readonly onWarning?: (warning: FindingStorageWarning) => void;
    readonly timeoutMs?: number;
  }) {
    this.databasePath = resolve(input.databasePath);
    this.runId = input.runId;
    this.#source = input.source === undefined
      ? undefined
      : { ...input.source, databasePath: resolve(input.source.databasePath) };
    this.#now = input.now ?? (() => new Date().toISOString());
    this.#timeoutMs = input.timeoutMs;
    this.#sourceMatchesTarget = this.#source?.databasePath === this.databasePath;
  }

  resolveAuthority(input: FindingAuthorityInput): FindingLedgerStore {
    if (input.authorityKey.length === 0) {
      throw new Error('Finding authority key must not be empty');
    }
    if (input.workflowName.length === 0) {
      throw new Error('Finding authority workflow name must not be empty');
    }
    const { database, repository } = this.#ensureOpen();
    repository.ensureAuthority({
      authorityKey: input.authorityKey,
      workflowName: input.workflowName,
      seed: () => ({
        ledger: this.#seedAuthority(input.authorityKey, input.workflowName),
      }),
    });
    const artifacts = new FindingArtifactStore({
      reportDir: input.reportDir,
      runId: this.runId,
      databaseInstanceId: database.identity.databaseInstanceId,
      authorityKey: input.authorityKey,
    });
    return new SqliteFindingLedgerStore({
      runId: this.runId,
      databaseInstanceId: database.identity.databaseInstanceId,
      authorityKey: input.authorityKey,
      workflowName: input.workflowName,
      repository,
      artifacts,
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#database?.close();
  }

  #ensureOpen(): {
    readonly database: FindingDatabase;
    readonly repository: FindingAuthorityRepository;
  } {
    if (this.#closed) {
      throw new Error('Finding storage resolver is closed');
    }
    if (this.#database === undefined || this.#repository === undefined) {
      this.#database = FindingDatabase.openTarget({
        databasePath: this.databasePath,
        runId: this.runId,
        ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
      });
      this.#repository = new FindingAuthorityRepository(this.#database, this.#now);
    }
    return { database: this.#database, repository: this.#repository };
  }

  #seedAuthority(authorityKey: string, workflowName: string): FindingLedger {
    if (this.#source === undefined) {
      return emptyLedger(workflowName, this.#now());
    }
    if (this.#sourceMatchesTarget) {
      throw new Error(`Finding authority "${authorityKey}" is missing from the source target`);
    }
    const source = FindingDatabase.readSource({
      databasePath: this.#source.databasePath,
      runId: this.#source.runId,
      ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
      read: (database) => readSourceAuthorityRaw(database, authorityKey),
    });
    if (source === undefined) {
      throw new Error(`Finding authority "${authorityKey}" is missing from the source`);
    }
    const parsed = parseInheritedSourceAuthority(source);
    const sourceLedger = parsed.kind === 'current'
      ? normalizeFindingLedger(parsed.ledger, source.workflowName)
      : normalizeFindingLedger(
          normalizeInheritedProvisionalTargetConflicts({
            source,
            legacyLedger: parsed.ledger,
            destinationRunId: this.runId,
            recordedAt: {
              runId: this.runId,
              stepName: 'finding-requeue-normalization',
              timestamp: this.#now(),
            },
          }).ledger,
          source.workflowName,
        );
    return importLedger(sourceLedger, workflowName, this.runId);
  }
}
