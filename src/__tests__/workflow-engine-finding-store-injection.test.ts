import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { createTestFindingLedgerStore } from './helpers/finding-storage.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-engine-store-injection-'));
  roots.push(root);
  return root;
}

function workflow(): WorkflowConfig {
  return {
    name: 'finding-store-injection',
    maxSteps: 1,
    initialStep: 'review',
    findingContract: {
      manager: {
        persona: 'findings-manager',
        instruction: 'manage',
        outputContract: 'findings-manager',
      },
    },
    steps: [{
      name: 'review',
      persona: 'reviewer',
      instruction: 'review',
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    }],
  };
}

describe('WorkflowEngine Finding ledger store dependency', () => {
  it('requires an injected authority resolver for a Finding Contract', () => {
    const cwd = createRoot();

    expect(() => new WorkflowEngine(workflow(), cwd, 'task', {
      projectCwd: cwd,
      reportDirName: 'run',
    })).toThrow(/requires an injected Finding authority resolver/);
  });

  it('accepts the run-bound resolver constructed by the composition root', () => {
    const cwd = createRoot();
    const config = workflow();
    const findingLedgerStore = createTestFindingLedgerStore({
      projectCwd: cwd,
      runId: 'run',
      reportDir: buildRunPaths(cwd, 'run').reportsAbs,
      workflowName: config.name,
    });

    expect(() => new WorkflowEngine(config, cwd, 'task', {
      projectCwd: cwd,
      reportDirName: 'run',
      findingAuthorityResolver: {
        resolve: () => findingLedgerStore,
      },
    })).not.toThrow();
  });

  it('keeps an authority resolver available for a child with its own contract', () => {
    const cwd = createRoot();
    const configWithContract = workflow();
    const findingLedgerStore = createTestFindingLedgerStore({
      projectCwd: cwd,
      runId: 'run',
      reportDir: buildRunPaths(cwd, 'run').reportsAbs,
      workflowName: configWithContract.name,
    });
    const configWithoutContract = { ...configWithContract };
    delete configWithoutContract.findingContract;

    const resolve = vi.fn(() => findingLedgerStore);

    expect(() => new WorkflowEngine(
      configWithoutContract,
      cwd,
      'task',
      {
        projectCwd: cwd,
        reportDirName: 'run',
        findingAuthorityResolver: { resolve },
      },
    )).not.toThrow();
    expect(resolve).not.toHaveBeenCalled();
  });
});
