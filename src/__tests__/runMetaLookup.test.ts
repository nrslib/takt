import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRunningStepByRunSlug, readRunMeta } from '../core/workflow/run/run-meta.js';

function writeMeta(runRoot: string, slug: string, meta: Record<string, unknown>): void {
  const metaPath = path.join(runRoot, '.takt', 'runs', slug, 'meta.json');
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify({
    ...meta,
  }, null, 2), 'utf-8');
}

describe('run-meta lookup', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-run-meta-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('should read currentStep from the specified run slug even when meta.task differs', () => {
    writeMeta(projectDir, '20260409-run-b', {
      task: 'Stored from .takt/runs/.../context/task',
      workflow: 'default',
      runSlug: '20260409-run-b',
      runRoot: '.takt/runs/20260409-run-b',
      reportDirectory: '.takt/runs/20260409-run-b/reports',
      contextDirectory: '.takt/runs/20260409-run-b/context',
      logsDirectory: '.takt/runs/20260409-run-b/logs',
      status: 'running',
      startTime: '2026-04-09T00:00:00.000Z',
      currentStep: 'implement',
      currentIteration: 2,
    });
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Other task prompt',
      workflow: 'default',
      runSlug: '20260409-run-a',
      runRoot: '.takt/runs/20260409-run-a',
      reportDirectory: '.takt/runs/20260409-run-a/reports',
      contextDirectory: '.takt/runs/20260409-run-a/context',
      logsDirectory: '.takt/runs/20260409-run-a/logs',
      status: 'running',
      startTime: '2026-04-09T00:00:00.000Z',
      currentStep: 'review',
      currentIteration: 1,
    });

    const currentStep = findRunningStepByRunSlug(projectDir, '20260409-run-b');

    expect(currentStep).toBe('implement');
    expect(
      readRunMeta(path.join(projectDir, '.takt', 'runs', '20260409-run-b', 'meta.json'))?.currentIteration,
    ).toBe(2);
  });

  it('should ignore unreadable unrelated meta.json when run slug is known', () => {
    const newestMetaPath = path.join(projectDir, '.takt', 'runs', '20260409-run-z', 'meta.json');
    fs.mkdirSync(path.dirname(newestMetaPath), { recursive: true });
    fs.writeFileSync(newestMetaPath, '{ broken json', 'utf-8');
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Force fail me\nwith full prompt',
      workflow: 'default',
      runSlug: '20260409-run-a',
      runRoot: '.takt/runs/20260409-run-a',
      reportDirectory: '.takt/runs/20260409-run-a/reports',
      contextDirectory: '.takt/runs/20260409-run-a/context',
      logsDirectory: '.takt/runs/20260409-run-a/logs',
      status: 'running',
      startTime: '2026-04-09T00:00:00.000Z',
      currentStep: 'implement',
      currentIteration: 2,
    });

    expect(
      findRunningStepByRunSlug(projectDir, '20260409-run-a'),
    ).toBe('implement');
    expect(readRunMeta(newestMetaPath)).toBeNull();
  });

  it('should read the persisted workflow failure record', () => {
    const slug = '20260802-step-failure';
    writeMeta(projectDir, slug, {
      task: 'Review findings',
      workflow: 'default',
      runSlug: slug,
      runRoot: `.takt/runs/${slug}`,
      reportDirectory: `.takt/runs/${slug}/reports`,
      contextDirectory: `.takt/runs/${slug}/context`,
      logsDirectory: `.takt/runs/${slug}/logs`,
      status: 'failed',
      startTime: '2026-08-02T15:26:51.000Z',
      failure: {
        step: 'reviewers',
        error: 'NEEDS_ADJUDICATION: finding invariant failed',
      },
    });

    const meta = readRunMeta(
      path.join(projectDir, '.takt', 'runs', slug, 'meta.json'),
    );

    expect(meta?.failure).toEqual({
      step: 'reviewers',
      error: 'NEEDS_ADJUDICATION: finding invariant failed',
    });
  });

  it('should report broken run metadata with metaPath context', () => {
    const metaPath = path.join(projectDir, '.takt', 'runs', '20260409-run-z', 'meta.json');
    const warnings: string[] = [];
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, '{ broken json', 'utf-8');

    expect(readRunMeta(metaPath, (warning) => {
      warnings.push(warning);
    })).toBeNull();

    expect(warnings).toEqual([
      expect.stringContaining(`Failed to parse run metadata at ${metaPath}`),
    ]);
  });

  it('should reject run metadata missing the required run identity fields', () => {
    const metaPath = path.join(projectDir, '.takt', 'runs', '20260409-run-a', 'meta.json');
    const warnings: string[] = [];
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({
      task: 'Legacy run',
      workflow: 'default',
      status: 'failed',
      startTime: '2026-04-09T00:00:00.000Z',
    }), 'utf-8');

    expect(readRunMeta(metaPath, (warning) => warnings.push(warning))).toBeNull();
    expect(warnings).toEqual([
      expect.stringContaining('runSlug must be a non-empty string'),
    ]);
  });

  it('should forward warnings when the requested run metadata is unreadable', () => {
    const metaPath = path.join(projectDir, '.takt', 'runs', '20260409-run-a', 'meta.json');
    const warnings: string[] = [];
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, '{ broken json', 'utf-8');

    expect(findRunningStepByRunSlug(projectDir, '20260409-run-a', (warning) => {
      warnings.push(warning);
    })).toBeUndefined();

    expect(warnings).toEqual([
      expect.stringContaining(`Failed to parse run metadata at ${metaPath}`),
    ]);
  });

  it('should return undefined when currentStep is missing even if resumePoint exists', () => {
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Force fail me\nwith full prompt',
      workflow: 'default',
      runSlug: '20260409-run-a',
      runRoot: '.takt/runs/20260409-run-a',
      reportDirectory: '.takt/runs/20260409-run-a/reports',
      contextDirectory: '.takt/runs/20260409-run-a/context',
      logsDirectory: '.takt/runs/20260409-run-a/logs',
      status: 'running',
      startTime: '2026-04-09T00:00:00.000Z',
      currentIteration: 7,
      resumePoint: {
        version: 2,
        stack: [
          {
            workflow: 'default',
            workflow_ref: 'default',
            step: 'dev',
            kind: 'workflow_call',
            occurrence: 1,
            call_instance: 1,
          },
          {
            workflow: 'takt/coding',
            workflow_ref: 'takt/coding',
            step: 'review',
            kind: 'agent',
            occurrence: 1,
          },
        ],
        iteration: 7,
        elapsed_ms: 183245,
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
    });

    expect(findRunningStepByRunSlug(projectDir, '20260409-run-a')).toBeUndefined();
  });

  it('should validate canonical resume_point at read boundary', () => {
    const metaPath = path.join(projectDir, '.takt', 'runs', '20260409-run-a', 'meta.json');
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Force fail me\nwith full prompt',
      workflow: 'default',
      runSlug: '20260409-run-a',
      runRoot: '.takt/runs/20260409-run-a',
      reportDirectory: '.takt/runs/20260409-run-a/reports',
      contextDirectory: '.takt/runs/20260409-run-a/context',
      logsDirectory: '.takt/runs/20260409-run-a/logs',
      status: 'running',
      startTime: '2026-04-09T00:00:00.000Z',
      currentStep: 'delegate',
      currentIteration: 7,
      resume_point: {
        version: 2,
        stack: [
          { workflow: 'default', workflow_ref: 'project:sha256:default', step: 'delegate', kind: 'workflow_call', occurrence: 1, call_instance: 1 },
          { workflow: 'takt/coding', workflow_ref: 'project:sha256:coding', step: 'review', kind: 'agent', occurrence: 1 },
        ],
        iteration: 7,
        elapsed_ms: 183245,
        workflow_call_invocations: {
          '{"workflow":"project:sha256:default","step":"delegate","calls":[]}': {
            call_instance: 1,
            report_namespace_segment: 'iteration-1--step-delegate--workflow-takt%2Fcoding',
          },
        },
        workflow_step_participations: {},
      },
    });

    expect(readRunMeta(metaPath)?.resumePoint).toEqual({
      version: 2,
      stack: [
        { workflow: 'default', workflow_ref: 'project:sha256:default', step: 'delegate', kind: 'workflow_call', occurrence: 1, call_instance: 1 },
        { workflow: 'takt/coding', workflow_ref: 'project:sha256:coding', step: 'review', kind: 'agent', occurrence: 1 },
      ],
      iteration: 7,
      elapsed_ms: 183245,
      workflow_call_invocations: {
        '{"workflow":"project:sha256:default","step":"delegate","calls":[]}': {
          call_instance: 1,
          report_namespace_segment: 'iteration-1--step-delegate--workflow-takt%2Fcoding',
        },
      },
      workflow_step_participations: {},
    });
  });

  it('occurrenceが欠けたresume_pointを補完せず拒否する', () => {
    const metaPath = path.join(
      projectDir,
      '.takt',
      'runs',
      '20260409-run-a',
      'meta.json',
    );
    const warnings: string[] = [];
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Invalid resume',
      workflow: 'default',
      runSlug: '20260409-run-a',
      runRoot: '.takt/runs/20260409-run-a',
      reportDirectory: '.takt/runs/20260409-run-a/reports',
      contextDirectory: '.takt/runs/20260409-run-a/context',
      logsDirectory: '.takt/runs/20260409-run-a/logs',
      status: 'running',
      startTime: '2026-04-09T00:00:00.000Z',
      resume_point: {
        version: 2,
        stack: [{
          workflow: 'default',
          workflow_ref: 'project:sha256:default',
          step: 'delegate',
          kind: 'workflow_call',
        }],
        iteration: 1,
        elapsed_ms: 0,
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
    });

    expect(readRunMeta(metaPath, (warning) => warnings.push(warning))).toBeNull();
    expect(warnings[0]).toContain('occurrence');
  });
  it('should normalize operation journal ownership metadata at the read boundary', () => {
    const metaPath = path.join(projectDir, '.takt', 'runs', '20260409-run-a', 'meta.json');
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Resume durable operation',
      workflow: 'default',
      runSlug: '20260409-run-a',
      runRoot: '.takt/runs/20260409-run-a',
      reportDirectory: '.takt/runs/20260409-run-a/reports',
      contextDirectory: '.takt/runs/20260409-run-a/context',
      logsDirectory: '.takt/runs/20260409-run-a/logs',
      status: 'running',
      startTime: '2026-04-09T00:00:00.000Z',
      operation_journal_run_slug: '20260409-original-run',
      operation_claim_token: 'claim-b',
    });

    expect(readRunMeta(metaPath)).toMatchObject({
      operationJournalRunSlug: '20260409-original-run',
      operationClaimToken: 'claim-b',
    });
  });

  it('should decode persisted PR context at the read boundary', () => {
    const metaPath = path.join(projectDir, '.takt', 'runs', '20260409-run-a', 'meta.json');
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Review PR changes',
      workflow: 'default',
      runSlug: '20260409-run-a',
      runRoot: '.takt/runs/20260409-run-a',
      reportDirectory: '.takt/runs/20260409-run-a/reports',
      contextDirectory: '.takt/runs/20260409-run-a/context',
      logsDirectory: '.takt/runs/20260409-run-a/logs',
      status: 'running',
      startTime: '2026-04-09T00:00:00.000Z',
      pr_context: {
        source: 'pr_review',
        pr_number: 861,
        base_branch: 'release/2026.07',
        head_branch: 'feature/pr-context',
        base_branch_source: 'pull_request',
      },
    });

    expect(readRunMeta(metaPath)?.prContext).toEqual({
      source: 'pr_review',
      prNumber: 861,
      baseBranch: 'release/2026.07',
      headBranch: 'feature/pr-context',
      baseBranchSource: 'pull_request',
    });
  });

  it('should reject malformed persisted PR context with a warning', () => {
    const metaPath = path.join(projectDir, '.takt', 'runs', '20260409-run-a', 'meta.json');
    const warnings: string[] = [];
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Review PR changes',
      workflow: 'default',
      runSlug: '20260409-run-a',
      runRoot: '.takt/runs/20260409-run-a',
      reportDirectory: '.takt/runs/20260409-run-a/reports',
      contextDirectory: '.takt/runs/20260409-run-a/context',
      logsDirectory: '.takt/runs/20260409-run-a/logs',
      status: 'running',
      startTime: '2026-04-09T00:00:00.000Z',
      pr_context: {
        source: 'pr_review',
        pr_number: 861,
        base_branch: 'main',
        head_branch: 'HEAD',
        base_branch_source: 'pull_request',
      },
    });

    expect(readRunMeta(metaPath, (warning) => warnings.push(warning))).toBeNull();
    expect(warnings).toEqual([expect.stringContaining('snake_case PR context fields')]);
  });

  it('should return undefined when run slug is invalid', () => {
    writeMeta(projectDir, '20260409-run-z', {
      task: 'Force fail me\nwith full prompt',
      workflow: 'default',
      runSlug: '20260409-run-z',
      runRoot: '.takt/runs/20260409-run-z',
      reportDirectory: '.takt/runs/20260409-run-z/reports',
      contextDirectory: '.takt/runs/20260409-run-z/context',
      logsDirectory: '.takt/runs/20260409-run-z/logs',
      status: 'running',
      startTime: '2026-04-09T00:00:00.000Z',
      currentStep: 'wrong-step',
      currentIteration: 9,
    });
    writeMeta(projectDir, '20260409-run-a', {
      task: 'Force fail me\nwith full prompt',
      workflow: 'default',
      runSlug: '20260409-run-a',
      runRoot: '.takt/runs/20260409-run-a',
      reportDirectory: '.takt/runs/20260409-run-a/reports',
      contextDirectory: '.takt/runs/20260409-run-a/context',
      logsDirectory: '.takt/runs/20260409-run-a/logs',
      status: 'running',
      startTime: '2026-04-09T00:00:00.000Z',
      currentStep: 'implement',
      currentIteration: 2,
    });

    expect(findRunningStepByRunSlug(projectDir, '../20260409-run-a')).toBeUndefined();
  });
});
