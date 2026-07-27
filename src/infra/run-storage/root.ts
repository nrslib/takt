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
  readonly slug: string;
  readonly findingContractEnabled: boolean;
}

export interface CreateRunStorageOptions {
  readonly databasePath: string;
  readonly run: RunInput;
  readonly workflowDefinition: WorkflowDefinitionInput;
  readonly busyRetry?: BusyRetryPolicy;
}

export interface OpenRunStorageOptions {
  readonly databasePath: string;
  readonly busyRetry?: BusyRetryPolicy;
}

export interface ResumeRunStorageOptions extends CreateRunStorageOptions {
  readonly source: RunStorageRoot;
}

export type { RunStorageRoot } from './run-storage-root-core.js';

export function createRunStorage(
  options: CreateRunStorageOptions,
): RunStorageRoot {
  assertExactPublicInput(
    options,
    ['databasePath', 'run', 'workflowDefinition', 'busyRetry'],
    'createRunStorage',
  );
  assertExactPublicInput(
    options.run,
    ['slug', 'findingContractEnabled'],
    'run',
  );
  assertExactPublicInput(
    options.workflowDefinition,
    ['name', 'codecName', 'definition'],
    'workflowDefinition',
  );
  rejectPublicEngineIdentityInput(options);
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
    ['databasePath', 'run', 'workflowDefinition', 'busyRetry', 'source'],
    'resumeRunStorage',
  );
  assertExactPublicInput(
    options.run,
    ['slug', 'findingContractEnabled'],
    'run',
  );
  assertExactPublicInput(
    options.workflowDefinition,
    ['name', 'codecName', 'definition'],
    'workflowDefinition',
  );
  rejectPublicEngineIdentityInput(options);
  const source = captureTrustedRunStorageResumeSnapshot(
    readTrustedRunStorageResumeSnapshot(options.source),
  );
  return createRunStorageRoot(
    createPublishedResumedRunDatabase(options, source),
    options.busyRetry ?? DEFAULT_BUSY_RETRY,
    SYSTEM_RUN_STORAGE_CLOCK,
  );
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
