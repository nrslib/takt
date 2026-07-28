import {
  SYSTEM_RUN_STORAGE_CLOCK,
} from './clock.js';
import {
  createPublishedRunDatabase,
  createPublishedResumedRunDatabase,
  openPublishedRunDatabase,
} from './run-database-publication.js';
import {
  createRunStorageRoot,
  readTrustedRunStorageResumeSnapshot,
  type RunStorageRoot,
} from './run-storage-root-core.js';
import type { BusyRetryPolicy } from './unit-of-work.js';
import { captureTrustedRunStorageResumeSnapshot } from './resume-import.js';
import type {
  BootstrapRecoverySeed,
} from '../../core/workflow/run/bootstrap-recovery-seed.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_BUSY_RETRY: BusyRetryPolicy = Object.freeze({
  delaysMs: Object.freeze([2, 4, 8]),
  wait(delayMs: number): void {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, delayMs);
  },
});

interface WorkflowDefinitionInput {
  readonly name: string;
  readonly codecName: string;
  readonly definition: string;
}

interface RunInput {
  readonly runId: string;
  readonly findingContractEnabled: boolean;
}

export interface CreateRunStorageOptions {
  readonly databasePath: string;
  readonly run: RunInput;
  readonly workflowDefinition: WorkflowDefinitionInput;
  readonly bootstrapSeed: BootstrapRecoverySeed;
  readonly busyRetry?: BusyRetryPolicy;
}

export interface OpenRunStorageOptions {
  readonly databasePath: string;
  readonly busyRetry?: BusyRetryPolicy;
}

export interface ResumeRunStorageOptions extends CreateRunStorageOptions {
  readonly source: RunStorageRoot;
}

export type {
  RunStorageRoot,
  TerminalPublication,
  TerminalPublicationStageClaim,
  TerminalPublicationStage,
  TerminalPublicationCommitReceipt,
} from './run-storage-root-core.js';

export function createRunStorage(
  options: CreateRunStorageOptions,
): RunStorageRoot {
  assertExactPublicInput(
    options,
    [
      'databasePath',
      'run',
      'workflowDefinition',
      'bootstrapSeed',
      'busyRetry',
    ],
    'createRunStorage',
  );
  assertExactPublicInput(
    options.run,
    ['runId', 'findingContractEnabled'],
    'run',
  );
  assertExactPublicInput(
    options.workflowDefinition,
    ['name', 'codecName', 'definition'],
    'workflowDefinition',
  );
  rejectPublicEngineIdentityInput(options);
  assertNoFileAuthority(options.databasePath);
  return createRunStorageRoot(
    createPublishedRunDatabase(options),
    options.busyRetry ?? DEFAULT_BUSY_RETRY,
    SYSTEM_RUN_STORAGE_CLOCK,
  );
}

export function openRunStorage(
  options: OpenRunStorageOptions,
): RunStorageRoot {
  assertExactPublicInput(
    options,
    ['databasePath', 'busyRetry'],
    'openRunStorage',
  );
  rejectPublicEngineIdentityInput(options);
  assertNoFileAuthority(options.databasePath);
  return createRunStorageRoot(
    openPublishedRunDatabase(options.databasePath),
    options.busyRetry ?? DEFAULT_BUSY_RETRY,
    SYSTEM_RUN_STORAGE_CLOCK,
  );
}

export function resumeRunStorage(
  options: ResumeRunStorageOptions,
): RunStorageRoot {
  assertExactPublicInput(
    options,
    [
      'databasePath',
      'run',
      'workflowDefinition',
      'bootstrapSeed',
      'busyRetry',
      'source',
    ],
    'resumeRunStorage',
  );
  assertExactPublicInput(
    options.run,
    ['runId', 'findingContractEnabled'],
    'run',
  );
  assertExactPublicInput(
    options.workflowDefinition,
    ['name', 'codecName', 'definition'],
    'workflowDefinition',
  );
  rejectPublicEngineIdentityInput(options);
  assertNoFileAuthority(options.databasePath);
  const source = captureTrustedRunStorageResumeSnapshot(
    readTrustedRunStorageResumeSnapshot(options.source),
  );
  return createRunStorageRoot(
    createPublishedResumedRunDatabase(options, source),
    options.busyRetry ?? DEFAULT_BUSY_RETRY,
    SYSTEM_RUN_STORAGE_CLOCK,
  );
}

function assertNoFileAuthority(databasePath: string): void {
  if (existsSync(join(dirname(databasePath), 'run-authority.json'))) {
    throw new Error(
      `Run directory corruption: SQLite and file authorities coexist at `
      + `"${dirname(databasePath)}"`,
    );
  }
}

function rejectPublicEngineIdentityInput(options: object): void {
  if (
    Reflect.has(options, 'engineBuild')
    || Reflect.has(options, 'expectedEngineBuild')
  ) {
    throw new Error(
      'Run storage engine artifact identity is internally derived',
    );
  }
}

function assertExactPublicInput(
  input: object,
  allowed: readonly string[],
  label: string,
): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!keys.has(key)) {
      throw new Error(`Unknown ${label} field "${key}"`);
    }
  }
}
