/**
 * Unit tests for retryMode: buildRetryTemplateVars
 */

import { describe, it, expect } from 'vitest';
import { buildRetryTemplateVars, type RetryContext } from '../features/interactive/retryMode.js';

function createRetryContext(overrides?: Partial<RetryContext>): RetryContext {
  return {
    failure: {
      taskName: 'my-task',
      createdAt: '2026-02-15T10:00:00Z',
      failedMovement: 'review',
      error: 'Timeout',
      lastMessage: 'Agent stopped',
      retryNote: '',
    },
    branchName: 'takt/my-task',
    pieceContext: {
      name: 'default',
      description: '',
      pieceStructure: '1. plan → 2. implement → 3. review',
      movementPreviews: [],
    },
    run: null,
    ...overrides,
  };
}

describe('buildRetryTemplateVars', () => {
  it('should map failure info to template variables', () => {
    const ctx = createRetryContext();
    const vars = buildRetryTemplateVars(ctx, 'en');

    expect(vars.taskName).toBe('my-task');
    expect(vars.branchName).toBe('takt/my-task');
    expect(vars.createdAt).toBe('2026-02-15T10:00:00Z');
    expect(vars.failedMovement).toBe('review');
    expect(vars.failureError).toBe('Timeout');
    expect(vars.failureLastMessage).toBe('Agent stopped');
  });

  it('should set empty string for absent optional fields', () => {
    const ctx = createRetryContext({
      failure: {
        taskName: 'task',
        createdAt: '2026-01-01T00:00:00Z',
        failedMovement: '',
        error: 'Error',
        lastMessage: '',
        retryNote: '',
      },
    });
    const vars = buildRetryTemplateVars(ctx, 'en');

    expect(vars.failedMovement).toBe('');
    expect(vars.failureLastMessage).toBe('');
    expect(vars.retryNote).toBe('');
  });

  it('should set hasRun=false and empty run vars when run is null', () => {
    const ctx = createRetryContext({ run: null });
    const vars = buildRetryTemplateVars(ctx, 'en');

    expect(vars.hasRun).toBe(false);
    expect(vars.runLogsDir).toBe('');
    expect(vars.runReportsDir).toBe('');
    expect(vars.runTask).toBe('');
    expect(vars.runPiece).toBe('');
    expect(vars.runStatus).toBe('');
    expect(vars.runMovementLogs).toBe('');
    expect(vars.runReports).toBe('');
  });

  it('should set hasRun=true and populate run vars when run is provided', () => {
    const ctx = createRetryContext({
      run: {
        logsDir: '/project/.takt/runs/slug/logs',
        reportsDir: '/project/.takt/runs/slug/reports',
        task: 'Build feature',
        piece: 'default',
        status: 'failed',
        movementLogs: '### plan\nPlanned.',
        reports: '### 00-plan.md\n# Plan',
      },
    });
    const vars = buildRetryTemplateVars(ctx, 'en');

    expect(vars.hasRun).toBe(true);
    expect(vars.runLogsDir).toBe('/project/.takt/runs/slug/logs');
    expect(vars.runReportsDir).toBe('/project/.takt/runs/slug/reports');
    expect(vars.runTask).toBe('Build feature');
    expect(vars.runPiece).toBe('default');
    expect(vars.runStatus).toBe('failed');
    expect(vars.runMovementLogs).toBe('### plan\nPlanned.');
    expect(vars.runReports).toBe('### 00-plan.md\n# Plan');
  });

  it('should set hasPiecePreview=false when no movement previews', () => {
    const ctx = createRetryContext();
    const vars = buildRetryTemplateVars(ctx, 'en');

    expect(vars.hasPiecePreview).toBe(false);
    expect(vars.movementDetails).toBe('');
  });

  it('should set hasPiecePreview=true and format movement details when previews exist', () => {
    const ctx = createRetryContext({
      pieceContext: {
        name: 'default',
        description: '',
        pieceStructure: '1. plan',
        movementPreviews: [
          {
            name: 'plan',
            personaDisplayName: 'Architect',
            personaContent: 'You are an architect.',
            instructionContent: 'Plan the feature.',
            allowedTools: ['Read', 'Grep'],
            canEdit: false,
          },
        ],
      },
    });
    const vars = buildRetryTemplateVars(ctx, 'en');

    expect(vars.hasPiecePreview).toBe(true);
    expect(vars.movementDetails).toContain('plan');
    expect(vars.movementDetails).toContain('Architect');
  });

  it('should include retryNote when present', () => {
    const ctx = createRetryContext({
      failure: {
        taskName: 'task',
        createdAt: '2026-01-01T00:00:00Z',
        failedMovement: '',
        error: 'Error',
        lastMessage: '',
        retryNote: 'Added more specific error handling',
      },
    });
    const vars = buildRetryTemplateVars(ctx, 'en');

    expect(vars.retryNote).toBe('Added more specific error handling');
  });
});
