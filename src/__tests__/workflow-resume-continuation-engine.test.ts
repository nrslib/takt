import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockWorkflowEngineWarn } = vi.hoisted(() => ({
  mockWorkflowEngineWarn: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...original,
    createLogger: (name: string) => {
      const logger = original.createLogger(name);
      return name === 'workflow-engine'
        ? { ...logger, warn: mockWorkflowEngineWarn }
        : logger;
    },
  };
});

import type { WorkflowConfig } from '../core/models/index.js';
import type { WorkflowSharedRuntimeState } from '../core/workflow/types.js';
import { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';
import { RESUME_ARTIFACTS_FILE_NAME } from '../core/workflow/run/resume-report-snapshot.js';
import { ResumeArtifactOccurrenceIndex } from '../core/workflow/run/resume-artifact-occurrence-index.js';
import { makeRule, makeStep } from './test-helpers.js';

const testDirectories: string[] = [];

function engineWorkflow(): WorkflowConfig {
  return {
    name: 'resume-index-engine-test',
    initialStep: 'work',
    maxSteps: 2,
    steps: [makeStep({
      name: 'work',
      rules: [makeRule('done', 'COMPLETE')],
    })],
  };
}

function createEngineCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-resume-index-engine-'));
  testDirectories.push(cwd);
  return cwd;
}

function constructEngine(
  cwd: string,
  resumeMode: 'retry' | 'requeue',
  sharedRuntime: WorkflowSharedRuntimeState,
): void {
  new WorkflowEngine(engineWorkflow(), cwd, 'test task', {
    projectCwd: cwd,
    reportDirName: 'target-run',
    resumeSource: { sourceRunSlug: 'source-run', resumeMode },
    sharedRuntime,
  });
}

afterEach(() => {
  mockWorkflowEngineWarn.mockClear();
  for (const directory of testDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('WorkflowEngine resume occurrence index gate', () => {
  it('通常 resume では artifact occurrence index を作らない', () => {
    const sharedRuntime: WorkflowSharedRuntimeState = { startedAtMs: Date.now() };

    constructEngine(createEngineCwd(), 'retry', sharedRuntime);

    expect(sharedRuntime.resumeArtifactOccurrenceIndex).toBeUndefined();
  });

  it('requeue では artifact occurrence index を作る', () => {
    const sharedRuntime: WorkflowSharedRuntimeState = { startedAtMs: Date.now() };

    constructEngine(createEngineCwd(), 'requeue', sharedRuntime);

    expect(sharedRuntime.resumeArtifactOccurrenceIndex).toBeInstanceOf(
      ResumeArtifactOccurrenceIndex,
    );
  });

  it('manifest があるのに source resume point を取得できなければ警告する', () => {
    const cwd = createEngineCwd();
    const reportsDir = join(cwd, '.takt', 'runs', 'target-run', 'reports');
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(
      join(reportsDir, RESUME_ARTIFACTS_FILE_NAME),
      JSON.stringify({
        version: 1,
        sourceRunSlug: 'source-run',
        targetRunSlug: 'target-run',
        createdAt: new Date(0).toISOString(),
        files: [],
      }),
      'utf-8',
    );

    constructEngine(cwd, 'requeue', { startedAtMs: Date.now() });

    expect(mockWorkflowEngineWarn).toHaveBeenCalledWith(
      'Requeue artifact occurrence restoration is unavailable because source run metadata or resume point is missing',
      { sourceRunSlug: 'source-run' },
    );
  });
});
