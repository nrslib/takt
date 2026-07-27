import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunStorageRoot } from '../../infra/run-storage/index.js';
import {
  createRunStorage,
  resumeRunStorage,
} from '../../infra/run-storage/root.js';
import { TEST_RUN_STORAGE_CLOCK } from './run-storage-clock.js';

const roots: string[] = [];
const TEST_WORKFLOW_DEFINITION = '{"name":"default"}';

export function createRealRunStorage(options?: {
  readonly findingContractEnabled?: boolean;
  readonly busyRetryDelaysMs?: readonly number[];
  readonly wait?: (delayMs: number) => void;
}): {
  readonly databasePath: string;
  readonly root: RunStorageRoot;
  readonly clock: typeof TEST_RUN_STORAGE_CLOCK;
} {
  const directory = mkdtempSync(join(tmpdir(), 'takt-run-storage-'));
  roots.push(directory);
  const databasePath = join(directory, 'run.sqlite');
  const clock = TEST_RUN_STORAGE_CLOCK;
  clock.set(1_000);
  return {
    databasePath,
    clock,
    root: createRunStorage({
      databasePath,
      run: {
        slug: 'run-1',
        findingContractEnabled: options?.findingContractEnabled === true,
      },
      workflowDefinition: {
        name: 'default',
        codecName: 'json-v1',
        definition: TEST_WORKFLOW_DEFINITION,
      },
      busyRetry: {
        delaysMs: options?.busyRetryDelaysMs ?? [1, 2, 4],
        wait: options?.wait ?? (() => {}),
      },
    }),
  };
}

export function resumeRealRunStorage(
  source: RunStorageRoot,
  options?: {
    readonly slug?: string;
    readonly findingContractEnabled?: boolean;
    readonly busyRetryDelaysMs?: readonly number[];
    readonly wait?: (delayMs: number) => void;
  },
): {
  readonly databasePath: string;
  readonly root: RunStorageRoot;
  readonly clock: typeof TEST_RUN_STORAGE_CLOCK;
} {
  const directory = mkdtempSync(join(tmpdir(), 'takt-run-storage-resume-'));
  roots.push(directory);
  const databasePath = join(directory, 'run.sqlite');
  return {
    databasePath,
    clock: TEST_RUN_STORAGE_CLOCK,
    root: resumeRunStorage({
      databasePath,
      source,
      run: {
        slug: options?.slug ?? 'run-resume',
        findingContractEnabled: options?.findingContractEnabled
          ?? source.readResumeSnapshot().run.findingContractEnabled === 1,
      },
      workflowDefinition: {
        name: 'default',
        codecName: 'json-v1',
        definition: TEST_WORKFLOW_DEFINITION,
      },
      busyRetry: {
        delaysMs: options?.busyRetryDelaysMs ?? [1, 2, 4],
        wait: options?.wait ?? (() => {}),
      },
    }),
  };
}

export function cleanupRealRunStorages(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}
