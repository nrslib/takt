import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRunPaths, type RunPaths } from '../core/workflow/run/run-paths.js';

vi.mock('../infra/config/index.js', () => ({
  ensureDir: vi.fn(),
  writeFileAtomic: vi.fn(),
}));

import { ensureDir, writeFileAtomic } from '../infra/config/index.js';
import { RunMetaManager } from '../features/tasks/execute/runMeta.js';

function createRunPaths(): RunPaths {
  return buildRunPaths('/tmp/project', '20260409-force-fail-test');
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
      updatedAt?: string;
      currentStep?: string;
      currentIteration?: number;
    };
    const updatedMeta = JSON.parse(String(vi.mocked(writeFileAtomic).mock.calls[1]![1])) as {
      status: string;
      updatedAt?: string;
      currentStep?: string;
      currentIteration?: number;
    };

    expect(initialMeta.status).toBe('running');
    expect(initialMeta.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(initialMeta.currentStep).toBeUndefined();
    expect(initialMeta.currentIteration).toBeUndefined();
    expect(updatedMeta.status).toBe('running');
    expect(updatedMeta.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(updatedMeta.currentStep).toBe('implement');
    expect(updatedMeta.currentIteration).toBe(2);
  });

  it('should persist the latest phase alongside step progress', () => {
    const manager = new RunMetaManager(createRunPaths(), 'Force fail task', 'default');
    manager.updateStep('review', 3);

    (
      manager as unknown as {
        updatePhase: (stepName: string, iteration: number, phase: 1 | 2 | 3) => void;
      }
    ).updatePhase('review', 3, 2);

    const phasedMeta = JSON.parse(String(vi.mocked(writeFileAtomic).mock.calls[2]![1])) as {
      status: string;
      updatedAt?: string;
      currentStep?: string;
      currentIteration?: number;
      phase?: number;
    };

    expect(phasedMeta.status).toBe('running');
    expect(phasedMeta.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(phasedMeta.currentStep).toBe('review');
    expect(phasedMeta.currentIteration).toBe(3);
    expect(phasedMeta.phase).toBe(2);
  });

  it('should persist and retain resume point metadata for workflow_call retries', () => {
    const manager = new RunMetaManager(createRunPaths(), 'Force fail task', 'default');
    const resumePoint = {
      version: 2,
      stack: [
        { workflow: 'default', workflow_ref: 'project:sha256:default', step: 'dev', kind: 'workflow_call', occurrence: 1, call_instance: 1 },
        { workflow: 'takt/coding', workflow_ref: 'project:sha256:coding', step: 'review', kind: 'agent', occurrence: 1 },
      ],
      iteration: 7,
      elapsed_ms: 183245,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };

    (
      manager as unknown as {
        updateStep: (stepName: string, iteration: number, nextResumePoint: unknown) => void;
      }
    ).updateStep('review', 7, resumePoint);

    const updatedMeta = JSON.parse(String(vi.mocked(writeFileAtomic).mock.calls[1]![1])) as {
      resume_point?: typeof resumePoint;
    };

    expect(updatedMeta).not.toHaveProperty('resumePoint');
    expect(updatedMeta.resume_point).toEqual(resumePoint);
  });

  it('should refresh resume point without rolling back current step metadata', () => {
    const manager = new RunMetaManager(createRunPaths(), 'Force fail task', 'default');
    const staleResumePoint = {
      version: 2,
      stack: [
        { workflow: 'default', workflow_ref: 'project:sha256:default', step: 'delegate', kind: 'workflow_call', occurrence: 1, call_instance: 1 },
        { workflow: 'takt/coding', workflow_ref: 'project:sha256:coding', step: 'review', kind: 'agent', occurrence: 1 },
      ],
      iteration: 7,
      elapsed_ms: 183245,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };
    const refreshedResumePoint = {
      version: 2,
      stack: [
        { workflow: 'default', workflow_ref: 'project:sha256:default', step: 'delegate', kind: 'workflow_call', occurrence: 1, call_instance: 1 },
      ],
      iteration: 7,
      elapsed_ms: 183900,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };

    manager.updateStep('delegate', 7, staleResumePoint);
    manager.updateResumePoint(refreshedResumePoint);
    const refreshedMeta = JSON.parse(String(vi.mocked(writeFileAtomic).mock.calls[2]![1])) as {
      currentStep?: string;
      currentIteration?: number;
      resume_point?: typeof refreshedResumePoint;
    };

    expect(refreshedMeta.currentStep).toBe('delegate');
    expect(refreshedMeta.currentIteration).toBe(7);
    expect(refreshedMeta.resume_point).toEqual(refreshedResumePoint);
  });

  it('should persist trace discovery metadata through progress updates', () => {
    const traceDiscovery = {
      serviceName: 'takt',
      runId: '20260409-force-fail-test',
      workflowName: 'default',
      task: {
        source: 'pr_review',
        issueNumber: 792,
        prNumber: 826,
        summary: 'Improve trace discovery',
      },
      git: {
        branch: 'takt/843/add-trace-discovery',
        baseBranch: 'main',
      },
      queries: [
        '{ resource.service.name = "takt" && span."takt.run.id" = "20260409-force-fail-test" }',
        '{ resource.service.name = "takt" && span."takt.task.pr_number" = 826 }',
      ],
    };
    const manager = new RunMetaManager(
      createRunPaths(),
      'Force fail task',
      'default',
      undefined,
      { traceDiscovery },
    );

    manager.updateStep('review', 3);

    const initialMeta = JSON.parse(String(vi.mocked(writeFileAtomic).mock.calls[0]![1])) as {
      observability?: { traceDiscovery?: typeof traceDiscovery };
    };
    const updatedMeta = JSON.parse(String(vi.mocked(writeFileAtomic).mock.calls[1]![1])) as {
      observability?: { traceDiscovery?: typeof traceDiscovery };
    };

    expect(initialMeta.observability?.traceDiscovery).toEqual(traceDiscovery);
    expect(updatedMeta.observability?.traceDiscovery).toEqual(traceDiscovery);
  });

  it('should persist the deepest workflow failure at terminal projection', () => {
    const manager = new RunMetaManager(createRunPaths(), 'Force fail task', 'default');

    manager.projectTerminal({
      status: 'failed',
      iterations: 4,
      reason: 'NEEDS_ADJUDICATION: finding invariant failed',
      failure: {
        step: 'reviewers',
        error: 'NEEDS_ADJUDICATION: finding invariant failed',
      },
      endTime: '2026-08-02T15:26:51.000Z',
    });

    const terminalMeta = JSON.parse(String(vi.mocked(writeFileAtomic).mock.calls[1]![1])) as {
      failure?: { step: string; error: string };
    };
    expect(terminalMeta.failure).toEqual({
      step: 'reviewers',
      error: 'NEEDS_ADJUDICATION: finding invariant failed',
    });
  });

  it('should persist direct resume source metadata for resumed runs', () => {
    const manager = new RunMetaManager(
      createRunPaths(),
      'Force fail task',
      'default',
      {
        sourceRunSlug: '20260409-source-run',
        resumeMode: 'retry',
      },
    );

    manager.updateStep('review', 3);

    const initialMeta = JSON.parse(String(vi.mocked(writeFileAtomic).mock.calls[0]![1])) as {
      source_run_slug?: string;
      resume_mode?: string;
    } & Record<string, unknown>;
    const updatedMeta = JSON.parse(String(vi.mocked(writeFileAtomic).mock.calls[1]![1])) as {
      source_run_slug?: string;
      resume_mode?: string;
    } & Record<string, unknown>;

    expect(initialMeta.source_run_slug).toBe('20260409-source-run');
    expect(initialMeta.resume_mode).toBe('retry');
    expect(initialMeta).not.toHaveProperty('sourceRunSlug');
    expect(initialMeta).not.toHaveProperty('resumeMode');
    expect(updatedMeta.source_run_slug).toBe('20260409-source-run');
    expect(updatedMeta.resume_mode).toBe('retry');
    expect(updatedMeta).not.toHaveProperty('sourceRunSlug');
    expect(updatedMeta).not.toHaveProperty('resumeMode');
  });

  it('should persist operation journal ownership metadata through progress updates', () => {
    const manager = new RunMetaManager(
      createRunPaths(),
      'Force fail task',
      'default',
      undefined,
      {
        operationJournalRunSlug: '20260409-original-run',
        operationClaimToken: 'claim-b',
      },
    );

    manager.updateStep('fix', 4);

    for (const call of vi.mocked(writeFileAtomic).mock.calls) {
      const meta = JSON.parse(String(call[1])) as Record<string, unknown>;
      expect(meta.operation_journal_run_slug).toBe('20260409-original-run');
      expect(meta.operation_claim_token).toBe('claim-b');
      expect(meta).not.toHaveProperty('operationJournalRunSlug');
      expect(meta).not.toHaveProperty('operationClaimToken');
    }
  });

  it('should persist a validated PR context through progress updates', () => {
    const prContext = {
      source: 'pr_review' as const,
      prNumber: 861,
      baseBranch: 'release/2026.07',
      headBranch: 'feature/pr-context',
      baseBranchSource: 'pull_request' as const,
    };
    const manager = new RunMetaManager(
      createRunPaths(),
      'Review PR changes',
      'default',
      undefined,
      { prContext },
    );

    manager.updateStep('review', 2);

    for (const call of vi.mocked(writeFileAtomic).mock.calls) {
      const meta = JSON.parse(String(call[1])) as Record<string, unknown>;
      expect(meta.pr_context).toEqual({
        source: 'pr_review',
        pr_number: 861,
        base_branch: 'release/2026.07',
        head_branch: 'feature/pr-context',
        base_branch_source: 'pull_request',
      });
      expect(meta).not.toHaveProperty('prContext');
    }
  });
});
