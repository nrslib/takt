import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunPaths } from '../core/workflow/run/run-paths.js';

vi.mock('../infra/config/index.js', () => ({
  ensureDir: vi.fn(),
  writeFileAtomic: vi.fn(),
}));

import { ensureDir, writeFileAtomic } from '../infra/config/index.js';
import { RunMetaManager } from '../features/tasks/execute/runMeta.js';

function createRunPaths(): RunPaths {
  return {
    slug: '20260409-force-fail-test',
    runRootAbs: '/tmp/project/.takt/runs/20260409-force-fail-test',
    runRootRel: '.takt/runs/20260409-force-fail-test',
    reportsAbs: '/tmp/project/.takt/runs/20260409-force-fail-test/reports',
    reportsRel: '.takt/runs/20260409-force-fail-test/reports',
    contextAbs: '/tmp/project/.takt/runs/20260409-force-fail-test/context',
    contextRel: '.takt/runs/20260409-force-fail-test/context',
    contextKnowledgeAbs: '/tmp/project/.takt/runs/20260409-force-fail-test/context/knowledge',
    contextKnowledgeRel: '.takt/runs/20260409-force-fail-test/context/knowledge',
    contextPolicyAbs: '/tmp/project/.takt/runs/20260409-force-fail-test/context/policy',
    contextPolicyRel: '.takt/runs/20260409-force-fail-test/context/policy',
    contextPreviousResponsesAbs: '/tmp/project/.takt/runs/20260409-force-fail-test/context/previous_responses',
    contextPreviousResponsesRel: '.takt/runs/20260409-force-fail-test/context/previous_responses',
    logsAbs: '/tmp/project/.takt/runs/20260409-force-fail-test/logs',
    logsRel: '.takt/runs/20260409-force-fail-test/logs',
    metaAbs: '/tmp/project/.takt/runs/20260409-force-fail-test/meta.json',
    metaRel: '.takt/runs/20260409-force-fail-test/meta.json',
  };
}

describe('RunMetaManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should persist currentStep and currentIteration on updateStep', () => {
    const manager = new RunMetaManager(createRunPaths(), 'Force fail task', 'default');

    manager.updateStep('implement', 2);

    expect(vi.mocked(ensureDir)).toHaveBeenCalledWith('/tmp/project/.takt/runs/20260409-force-fail-test');
    expect(vi.mocked(writeFileAtomic)).toHaveBeenCalledTimes(2);

    const initialMeta = JSON.parse(String(vi.mocked(writeFileAtomic).mock.calls[0]![1])) as {
      status: string;
      currentStep?: string;
      currentIteration?: number;
    };
    const updatedMeta = JSON.parse(String(vi.mocked(writeFileAtomic).mock.calls[1]![1])) as {
      status: string;
      currentStep?: string;
      currentIteration?: number;
    };

    expect(initialMeta.status).toBe('running');
    expect(initialMeta.currentStep).toBeUndefined();
    expect(initialMeta.currentIteration).toBeUndefined();
    expect(updatedMeta.status).toBe('running');
    expect(updatedMeta.currentStep).toBe('implement');
    expect(updatedMeta.currentIteration).toBe(2);
  });

  it('should keep currentStep and currentIteration when finalize is called', () => {
    const manager = new RunMetaManager(createRunPaths(), 'Force fail task', 'default');
    manager.updateStep('review', 3);

    manager.finalize('completed', 3);

    expect(vi.mocked(writeFileAtomic)).toHaveBeenCalledTimes(3);

    const finalizedMeta = JSON.parse(String(vi.mocked(writeFileAtomic).mock.calls[2]![1])) as {
      status: string;
      currentStep?: string;
      currentIteration?: number;
      iterations?: number;
      endTime?: string;
    };

    expect(finalizedMeta.status).toBe('completed');
    expect(finalizedMeta.currentStep).toBe('review');
    expect(finalizedMeta.currentIteration).toBe(3);
    expect(finalizedMeta.iterations).toBe(3);
    expect(finalizedMeta.endTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should persist and retain resume point metadata for workflow_call retries', () => {
    const manager = new RunMetaManager(createRunPaths(), 'Force fail task', 'default');
    const resumePoint = {
      version: 1,
      stack: [
        { workflow: 'default', step: 'dev', kind: 'workflow_call' },
        { workflow: 'takt/coding', step: 'review', kind: 'agent' },
      ],
      iteration: 7,
      elapsed_ms: 183245,
    };

    (
      manager as unknown as {
        updateStep: (stepName: string, iteration: number, nextResumePoint: unknown) => void;
      }
    ).updateStep('review', 7, resumePoint);

    manager.finalize('aborted', 7);

    const updatedMeta = JSON.parse(String(vi.mocked(writeFileAtomic).mock.calls[1]![1])) as {
      resume_point?: typeof resumePoint;
    };
    const finalizedMeta = JSON.parse(String(vi.mocked(writeFileAtomic).mock.calls[2]![1])) as {
      resume_point?: typeof resumePoint;
    };

    expect(updatedMeta).not.toHaveProperty('resumePoint');
    expect(finalizedMeta).not.toHaveProperty('resumePoint');
    expect(updatedMeta.resume_point).toEqual(resumePoint);
    expect(finalizedMeta.resume_point).toEqual(resumePoint);
  });

  it('should refresh resume point without rolling back current step metadata', () => {
    const manager = new RunMetaManager(createRunPaths(), 'Force fail task', 'default');
    const staleResumePoint = {
      version: 1,
      stack: [
        { workflow: 'default', step: 'delegate', kind: 'workflow_call' },
        { workflow: 'takt/coding', step: 'review', kind: 'agent' },
      ],
      iteration: 7,
      elapsed_ms: 183245,
    };
    const refreshedResumePoint = {
      version: 1,
      stack: [
        { workflow: 'default', step: 'delegate', kind: 'workflow_call' },
      ],
      iteration: 7,
      elapsed_ms: 183900,
    };

    manager.updateStep('delegate', 7, staleResumePoint);
    manager.updateResumePoint(refreshedResumePoint);
    manager.finalize('aborted', 7);

    const refreshedMeta = JSON.parse(String(vi.mocked(writeFileAtomic).mock.calls[2]![1])) as {
      currentStep?: string;
      currentIteration?: number;
      resume_point?: typeof refreshedResumePoint;
    };
    const finalizedMeta = JSON.parse(String(vi.mocked(writeFileAtomic).mock.calls[3]![1])) as {
      currentStep?: string;
      currentIteration?: number;
      resume_point?: typeof refreshedResumePoint;
    };

    expect(refreshedMeta.currentStep).toBe('delegate');
    expect(refreshedMeta.currentIteration).toBe(7);
    expect(refreshedMeta.resume_point).toEqual(refreshedResumePoint);
    expect(finalizedMeta.currentStep).toBe('delegate');
    expect(finalizedMeta.currentIteration).toBe(7);
    expect(finalizedMeta.resume_point).toEqual(refreshedResumePoint);
  });
});
