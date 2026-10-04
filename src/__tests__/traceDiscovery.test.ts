import { describe, expect, it } from 'vitest';
import { buildTraceDiscovery } from '../core/workflow/observability/traceDiscovery.js';

describe('trace discovery', () => {
  it('Given run, task, and git metadata, When building trace discovery, Then it creates sanitized Tempo TraceQL hints', () => {
    const discovery = buildTraceDiscovery({
      runId: '20260617-run-843',
      workflowName: 'takt-default',
      sanitizeText: (text) => text.replaceAll('secret', '[REDACTED]'),
      traceTaskMetadata: {
        taskName: 'task-843',
        taskSlug: 'add-trace-discovery',
        taskSummary: `Find secret traces ${'x'.repeat(120)}\nsecond line`,
        taskSource: 'pr_review',
        issueNumber: 792,
        prNumber: 826,
        gitBranch: 'takt/843/add-"trace"\\discovery',
        gitBaseBranch: 'main',
        runDir: '/project/.takt/runs/20260617-run-843',
      },
    });

    expect(discovery.serviceName).toBe('takt');
    expect(discovery.runId).toBe('20260617-run-843');
    expect(discovery.workflowName).toBe('takt-default');
    expect(discovery.task).toMatchObject({
      name: 'task-843',
      slug: 'add-trace-discovery',
      source: 'pr_review',
      issueNumber: 792,
      prNumber: 826,
    });
    expect(discovery.task?.summary).toContain('Find [REDACTED] traces');
    expect(discovery.task?.summary).not.toContain('secret');
    expect(discovery.task?.summary).not.toContain('\n');
    expect(discovery.task?.summary).toHaveLength(80);
    expect(discovery.git).toEqual({
      branch: 'takt/843/add-"trace"\\discovery',
      baseBranch: 'main',
    });
    expect(discovery.queries).toEqual([
      '{ resource.service.name = "takt" && span."takt.run.id" = "20260617-run-843" }',
      '{ resource.service.name = "takt" && span."takt.task.pr_number" = 826 }',
      '{ resource.service.name = "takt" && span."takt.task.issue_number" = 792 }',
      '{ resource.service.name = "takt" && span."takt.git.branch" = "takt/843/add-\\"trace\\"\\\\discovery" }',
    ]);
  });

  it('Given only required run metadata, When building trace discovery, Then it omits empty optional queries', () => {
    const discovery = buildTraceDiscovery({
      runId: 'run-only',
      workflowName: 'takt-default',
      sanitizeText: (text) => text,
      traceTaskMetadata: {
        taskSummary: '',
        gitBranch: '',
      },
    });

    expect(discovery.task).toBeUndefined();
    expect(discovery.git).toBeUndefined();
    expect(discovery.queries).toEqual([
      '{ resource.service.name = "takt" && span."takt.run.id" = "run-only" }',
    ]);
  });

  it('Given blank required metadata, When building trace discovery, Then it fails fast instead of using fallback values', () => {
    expect(() => buildTraceDiscovery({
      runId: '   ',
      workflowName: 'takt-default',
      sanitizeText: (text) => text,
    })).toThrow('Trace discovery runId is required.');

    expect(() => buildTraceDiscovery({
      runId: 'run-843',
      workflowName: '',
      sanitizeText: (text) => text,
    })).toThrow('Trace discovery workflowName is required.');
  });

  it.each([
    ['issueNumber', 0],
    ['issueNumber', 1.5],
    ['prNumber', -1],
    ['prNumber', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('Given invalid %s, When building trace discovery, Then it rejects the metadata', (fieldName, value) => {
    expect(() => buildTraceDiscovery({
      runId: 'run-843',
      workflowName: 'takt-default',
      sanitizeText: (text) => text,
      traceTaskMetadata: {
        [fieldName]: value,
      },
    })).toThrow(`Trace discovery ${fieldName} must be a positive integer.`);
  });

  it('Given an unknown task source, When building trace discovery, Then it rejects the metadata without rewriting it', () => {
    expect(() => buildTraceDiscovery({
      runId: 'run-843',
      workflowName: 'takt-default',
      sanitizeText: (text) => text,
      traceTaskMetadata: {
        taskSource: 'legacy' as never,
      },
    })).toThrow('Trace discovery taskSource is invalid: legacy');
  });
});
