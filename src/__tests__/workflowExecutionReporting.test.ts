import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionLog } from '../shared/utils/index.js';

const { mockSaveSessionState } = vi.hoisted(() => ({
  mockSaveSessionState: vi.fn(),
}));

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveSessionState: (...args: unknown[]) => mockSaveSessionState(...args),
}));

import {
  finalizeWorkflowAbort,
  finalizeWorkflowSuccess,
  reportWorkflowAbort,
  reportWorkflowCompletion,
} from '../features/tasks/execute/workflowExecutionReporting.js';

function createSessionLog(): SessionLog {
  return {
    task: 'Implement subworkflow call',
    projectDir: '/project',
    workflowName: 'takt-default',
    iterations: 3,
    startTime: '2026-04-14T00:00:00.000Z',
    status: 'running',
    history: [],
  };
}

function createOut() {
  return {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };
}

describe('workflowExecutionReporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should warn with workflow, task, and project path when saving success session state fails', () => {
    const warnings: string[] = [];
    mockSaveSessionState.mockImplementation(() => {
      throw new Error('disk full');
    });

    const finalized = finalizeWorkflowSuccess(
      createSessionLog(),
      'Implement subworkflow call',
      'takt-default',
      'done',
      'fix',
      '/project',
      (warning) => {
        warnings.push(warning);
      },
    );

    expect(finalized.status).toBe('completed');
    expect(finalized.endTime).toBeDefined();
    expect(warnings).toEqual([
      expect.stringContaining('Failed to save session state for workflow "takt-default"'),
    ]);
    expect(warnings[0]).toContain('task "Implement subworkflow call"');
    expect(warnings[0]).toContain('in /project: disk full');
  });

  it('should warn with workflow, task, and project path when saving abort session state fails', () => {
    const warnings: string[] = [];
    mockSaveSessionState.mockImplementation(() => {
      throw new Error('permission denied');
    });

    const finalized = finalizeWorkflowAbort(
      createSessionLog(),
      'user_interrupted',
      'Implement subworkflow call',
      'takt-default',
      'fix',
      '/project',
      (warning) => {
        warnings.push(warning);
      },
    );

    expect(finalized.status).toBe('aborted');
    expect(finalized.endTime).toBeDefined();
    expect(warnings).toEqual([
      expect.stringContaining('Failed to save session state for workflow "takt-default"'),
    ]);
    expect(warnings[0]).toContain('task "Implement subworkflow call"');
    expect(warnings[0]).toContain('in /project: permission denied');
  });

  it('Given trace discovery metadata, When reporting workflow completion, Then it prints TraceQL query hints', () => {
    const out = createOut();

    reportWorkflowCompletion(
      out as never,
      {
        ...createSessionLog(),
        endTime: '2026-04-14T00:00:01.000Z',
      },
      3,
      '/tmp/project/.takt/runs/run-843/logs/session.jsonl',
      false,
      {
        queries: [
          '{ resource.service.name = "takt" && span."takt.run.id" = "run-843" }',
          '{ resource.service.name = "takt" && span."takt.task.pr_number" = 826 }',
        ],
      },
    );

    expect(out.success).toHaveBeenCalledWith(expect.stringContaining('Workflow completed (3 iterations'));
    expect(out.info).toHaveBeenCalledWith('Session log: /tmp/project/.takt/runs/run-843/logs/session.jsonl');
    expect(out.info).toHaveBeenCalledWith('TraceQL discovery:');
    expect(out.info).toHaveBeenCalledWith('  { resource.service.name = "takt" && span."takt.run.id" = "run-843" }');
    expect(out.info).toHaveBeenCalledWith('  { resource.service.name = "takt" && span."takt.task.pr_number" = 826 }');
  });

  it('Given unsafe trace discovery metadata, When reporting workflow completion, Then it sanitizes TraceQL query hints', () => {
    const out = createOut();

    reportWorkflowCompletion(
      out as never,
      {
        ...createSessionLog(),
        endTime: '2026-04-14T00:00:01.000Z',
      },
      3,
      '/tmp/project/.takt/runs/run-843/logs/session.jsonl',
      false,
      {
        queries: [
          '{ span."takt.run.id" = "run-843" }\x1b[31m\n\tbad\x1f',
        ],
      },
    );

    expect(out.info).toHaveBeenCalledWith('TraceQL discovery:');
    expect(out.info).toHaveBeenCalledWith('  { span."takt.run.id" = "run-843" }\\n\\tbad\\x1f');
  });

  it('Given trace discovery metadata, When reporting workflow abort, Then it prints the same TraceQL query hints', () => {
    const out = createOut();

    reportWorkflowAbort(
      out as never,
      {
        ...createSessionLog(),
        endTime: '2026-04-14T00:00:01.000Z',
      },
      2,
      'Step "write_tests" failed',
      '/tmp/project/.takt/runs/run-843/logs/session.jsonl',
      false,
      {
        queries: [
          '{ resource.service.name = "takt" && span."takt.run.id" = "run-843" }',
        ],
      },
    );

    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('Workflow aborted after 2 iterations'));
    expect(out.info).toHaveBeenCalledWith('Session log: /tmp/project/.takt/runs/run-843/logs/session.jsonl');
    expect(out.info).toHaveBeenCalledWith('TraceQL discovery:');
    expect(out.info).toHaveBeenCalledWith('  { resource.service.name = "takt" && span."takt.run.id" = "run-843" }');
  });
});
