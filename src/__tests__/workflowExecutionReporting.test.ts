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
});
