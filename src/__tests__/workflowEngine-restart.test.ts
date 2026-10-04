import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import type {
  WorkflowConfig,
  WorkflowRestartPoint,
  WorkflowRestartPointEntry,
  WorkflowResumePoint,
} from '../core/models/index.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';

import { WorkflowEngine } from '../core/workflow/index.js';
import {
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeRule,
} from './engine-test-helpers.js';

function agentStep(name: string, next: string): WorkflowConfig['steps'][number] {
  return {
    name,
    persona: `${name}-persona`,
    instruction: `Run ${name}`,
    rules: [makeRule('done', next)],
  };
}

function callStep(name: string, call: string, next: string): WorkflowConfig['steps'][number] {
  return {
    name,
    kind: 'workflow_call',
    call,
    rules: [makeRule('COMPLETE', next)],
  };
}

function systemStep(
  name: string,
  effects?: Extract<WorkflowConfig['steps'][number], { kind: 'system' }>['effects'],
): WorkflowConfig['steps'][number] {
  return {
    name,
    kind: 'system',
    personaDisplayName: name,
    instruction: `Run ${name}`,
    ...(effects === undefined ? {} : { effects }),
  };
}

function makeRoot(): WorkflowConfig {
  return {
    name: 'root',
    initialStep: 'before',
    maxSteps: 5,
    steps: [
      agentStep('before', 'selected'),
      agentStep('selected', 'delegate'),
      callStep('delegate', 'child', 'COMPLETE'),
    ],
  };
}

function makeRestartPoint(
  entry: Omit<WorkflowRestartPointEntry, 'workflow_ref'> & { workflow_ref?: string },
  continuation: Array<Omit<WorkflowRestartPointEntry, 'workflow_ref'> & { workflow_ref?: string }> = [],
): WorkflowRestartPoint {
  return {
    stack: [entry, ...continuation].map((candidate) => ({
      ...candidate,
      workflow_ref: candidate.workflow_ref ?? candidate.workflow,
    })),
  };
}

function makeResumePoint(): WorkflowResumePoint {
  return {
    version: 2,
    stack: [{
      workflow: 'root',
      workflow_ref: 'root',
      step: 'selected',
      kind: 'agent',
      occurrence: 1,
    }],
    iteration: 3,
    elapsed_ms: 1_000,
    workflow_call_invocations: {},
    workflow_step_participations: {},
  };
}

function listDirectoryTree(directory: string): string[] {
  return readdirSync(directory, { recursive: true }).map(String).sort();
}

describe('WorkflowEngine root restart contract', () => {
  let tmpDir: string;
  let engine: WorkflowEngine | null;

  beforeEach(() => {
    tmpDir = createTestTmpDir();
    engine = null;
  });

  afterEach(() => {
    if (engine !== null) {
      cleanupWorkflowEngine(engine);
    }
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should derive the root start step from a terminal agent restart', () => {
    const root = makeRoot();
    const restartPoint = makeRestartPoint({
      workflow: 'root',
      step: 'selected',
      kind: 'agent',
    });

    engine = new WorkflowEngine(root, tmpDir, 'restart root agent', {
      projectCwd: tmpDir,
      restartPoint,
      workflowCallResolver: () => null,
    });

    expect(engine.getState().currentStep).toBe('selected');
  });

  it('should derive the root start step from a terminal workflow_call restart', () => {
    const restartPoint = makeRestartPoint({
      workflow: 'root',
      step: 'delegate',
      kind: 'workflow_call',
      call_instance: 1,
    });

    engine = new WorkflowEngine(makeRoot(), tmpDir, 'restart root call', {
      projectCwd: tmpDir,
      restartPoint,
      workflowCallResolver: () => null,
    });

    expect(engine.getState().currentStep).toBe('delegate');
  });

  it('should allow a root restart at a system step with an empty effect list', () => {
    const root = makeRoot();
    root.steps = [...root.steps, systemStep('checkpoint', [])];
    const restartPoint = makeRestartPoint({
      workflow: 'root',
      step: 'checkpoint',
      kind: 'system',
    });

    engine = new WorkflowEngine(root, tmpDir, 'restart root checkpoint', {
      projectCwd: tmpDir,
      restartPoint,
      workflowCallResolver: () => null,
    });

    expect(engine.getState().currentStep).toBe('checkpoint');
  });

  it('should reject a root restart at an effect-backed system step before initialization', () => {
    const root = makeRoot();
    root.steps = [...root.steps, systemStep('publish', [{ type: 'merge_pr', pr: 42 }])];
    const restartPoint = makeRestartPoint({
      workflow: 'root',
      step: 'publish',
      kind: 'system',
    });
    const directoryTreeBeforeConstruction = listDirectoryTree(tmpDir);

    expect(() => new WorkflowEngine(root, tmpDir, 'restart root effect', {
      projectCwd: tmpDir,
      restartPoint,
      workflowCallResolver: () => null,
    })).toThrow();
    expect(listDirectoryTree(tmpDir)).toEqual(directoryTreeBeforeConstruction);
  });

  it('should reject a synthesized agent restart before initialization', () => {
    const root = makeRoot();
    root.steps = [
      ...root.steps,
      { ...agentStep('synthetic', 'COMPLETE'), engineSynthesized: true },
    ];
    const restartPoint = makeRestartPoint({
      workflow: 'root',
      step: 'synthetic',
      kind: 'agent',
    });
    const directoryTreeBeforeConstruction = listDirectoryTree(tmpDir);

    expect(() => new WorkflowEngine(root, tmpDir, 'reject synthesized restart', {
      projectCwd: tmpDir,
      restartPoint,
      workflowCallResolver: () => null,
    })).toThrow();
    expect(listDirectoryTree(tmpDir)).toEqual(directoryTreeBeforeConstruction);
  });

  it('should restart from the selected authored step after the workflow initial changes', () => {
    const root = makeRoot();
    root.initialStep = 'selected';
    const restartPoint = makeRestartPoint({
      workflow: 'root',
      step: 'before',
      kind: 'agent',
    });

    engine = new WorkflowEngine(root, tmpDir, 'restart after initial change', {
      projectCwd: tmpDir,
      restartPoint,
      workflowCallResolver: () => null,
    });

    expect(engine.getState().currentStep).toBe('before');
  });

  it('should preserve checkpoint resume ownership without a restart point', () => {
    engine = new WorkflowEngine(makeRoot(), tmpDir, 'resume checkpoint', {
      projectCwd: tmpDir,
      resumePoint: makeResumePoint(),
      startStep: 'selected',
      workflowCallResolver: () => null,
    });

    expect(engine.getState().currentStep).toBe('selected');
    expect(engine.getResumePoint()?.iteration).toBe(3);
  });

  it('should reject simultaneous checkpoint resume and stateless restart ownership before initialization', () => {
    const restartPoint = makeRestartPoint({
      workflow: 'root',
      step: 'selected',
      kind: 'agent',
    });
    const directoryTreeBeforeConstruction = listDirectoryTree(tmpDir);

    expect(() => new WorkflowEngine(makeRoot(), tmpDir, 'conflicting restart ownership', {
      projectCwd: tmpDir,
      resumePoint: makeResumePoint(),
      restartPoint,
    })).toThrow('Workflow engine cannot own both resumePoint and restartPoint');
    expect(listDirectoryTree(tmpDir)).toEqual(directoryTreeBeforeConstruction);
  });

  it.each([0, 7])(
    'should reject stateless restart with initial iteration %s before initialization',
    (initialIteration) => {
      const restartPoint = makeRestartPoint({
        workflow: 'root',
        step: 'selected',
        kind: 'agent',
      });
      const directoryTreeBeforeConstruction = listDirectoryTree(tmpDir);

      expect(() => new WorkflowEngine(makeRoot(), tmpDir, 'restart with old iteration', {
        projectCwd: tmpDir,
        initialIteration,
        restartPoint,
      })).toThrow('Workflow engine cannot own both restartPoint and initialIteration');
      expect(listDirectoryTree(tmpDir)).toEqual(directoryTreeBeforeConstruction);
    },
  );

  it('should reject a root workflow identity mismatch during construction', () => {
    const root = attachWorkflowOpaqueRef(makeRoot(), 'project:root');
    const restartPoint = makeRestartPoint({
      workflow: 'root',
      workflow_ref: 'project:other',
      step: 'selected',
      kind: 'agent',
    });

    expect(() => new WorkflowEngine(root, tmpDir, 'mismatched root', {
      projectCwd: tmpDir,
      restartPoint,
    })).toThrow(
      'Restart path workflow "root" (ref "project:other") does not match root workflow "root" (ref "project:root")',
    );
  });

  it('should reject a missing root step during construction', () => {
    const restartPoint = makeRestartPoint({
      workflow: 'root',
      step: 'missing',
      kind: 'agent',
    });

    expect(() => new WorkflowEngine(makeRoot(), tmpDir, 'missing root step', {
      projectCwd: tmpDir,
      restartPoint,
    })).toThrow('Restart path step "missing" does not match workflow "root"');
  });

  it('should reject a root step kind mismatch during construction', () => {
    const restartPoint = makeRestartPoint({
      workflow: 'root',
      step: 'selected',
      kind: 'system',
    });

    expect(() => new WorkflowEngine(makeRoot(), tmpDir, 'mismatched root kind', {
      projectCwd: tmpDir,
      restartPoint,
    })).toThrow('Restart path step "selected" does not match workflow "root"');
  });

  it('should reject an explicit start step that differs from the restart root', () => {
    const restartPoint = makeRestartPoint({
      workflow: 'root',
      step: 'selected',
      kind: 'agent',
    });

    expect(() => new WorkflowEngine(makeRoot(), tmpDir, 'mismatched start step', {
      projectCwd: tmpDir,
      startStep: 'before',
      restartPoint,
    })).toThrow('Workflow start step "before" does not match restart path step "selected"');
  });

  it('should reject a restart path that continues after a root non-call step', () => {
    const restartPoint = makeRestartPoint(
      { workflow: 'root', step: 'selected', kind: 'agent' },
      [{ workflow: 'child', step: 'child-first', kind: 'agent' }],
    );

    expect(() => new WorkflowEngine(makeRoot(), tmpDir, 'invalid continuation', {
      projectCwd: tmpDir,
      restartPoint,
    })).toThrow('Restart path cannot continue after non-call step "selected"');
  });
});
