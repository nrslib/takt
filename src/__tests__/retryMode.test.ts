/**
 * Unit tests for retryMode: buildRetryTemplateVars
 */

import { describe, it, expect } from 'vitest';
import { buildRetryTemplateVars, type RetryContext } from '../features/interactive/retryMode.js';

function createRetryContext(overrides?: Partial<RetryContext>): RetryContext {
  return {
    failure: {
      taskName: 'my-task',
      taskContent: 'Do something',
      createdAt: '2026-02-15T10:00:00Z',
      failedStep: 'review',
      error: 'Timeout',
      lastMessage: 'Agent stopped',
      retryNote: '',
    },
    branchName: 'takt/my-task',
    workflowContext: {
      name: 'default',
      description: '',
      workflowStructure: '1. plan → 2. implement → 3. review',
      stepPreviews: [],
    },
    run: null,
    previousOrderContent: null,
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
    expect(vars.failedStep).toBe('review');
    expect(vars.failureError).toBe('Timeout');
    expect(vars.failureLastMessage).toBe('Agent stopped');
  });

  it('should set empty string for absent optional fields', () => {
    const ctx = createRetryContext({
      failure: {
        taskName: 'task',
        taskContent: 'Do something',
        createdAt: '2026-01-01T00:00:00Z',
        failedStep: '',
        error: 'Error',
        lastMessage: '',
        retryNote: '',
      },
    });
    const vars = buildRetryTemplateVars(ctx, 'en');

    expect(vars.failedStep).toBe('');
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
    expect(vars.runWorkflow).toBe('');
    expect(vars.runStatus).toBe('');
    expect(vars.runStepLogs).toBe('');
    expect(vars.runReports).toBe('');
  });

  it('should set hasRun=true and populate run vars when run is provided', () => {
    const ctx = createRetryContext({
      run: {
        logsDir: '/project/.takt/runs/slug/logs',
        reportsDir: '/project/.takt/runs/slug/reports',
        task: 'Build feature',
        workflow: 'default',
        status: 'failed',
        stepLogs: '### plan\nPlanned.',
        reports: '### 00-plan.md\n# Plan',
      },
    });
    const vars = buildRetryTemplateVars(ctx, 'en');

    expect(vars.hasRun).toBe(true);
    expect(vars.runLogsDir).toBe('/project/.takt/runs/slug/logs');
    expect(vars.runReportsDir).toBe('/project/.takt/runs/slug/reports');
    expect(vars.runTask).toBe('Build feature');
    expect(vars.runWorkflow).toBe('default');
    expect(vars.runStatus).toBe('failed');
    expect(vars.runStepLogs).toBe('### plan\nPlanned.');
    expect(vars.runReports).toBe('### 00-plan.md\n# Plan');
  });

  it('should set hasWorkflowPreview=false when no step previews', () => {
    const ctx = createRetryContext();
    const vars = buildRetryTemplateVars(ctx, 'en');

    expect(vars.hasWorkflowPreview).toBe(false);
    expect(vars.stepDetails).toBe('');
  });

  it('should set hasWorkflowPreview=true and format step details when previews exist', () => {
    const ctx = createRetryContext({
      workflowContext: {
        name: 'default',
        description: '',
        workflowStructure: '1. plan',
        stepPreviews: [
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

    expect(vars.hasWorkflowPreview).toBe(true);
    expect(vars.stepDetails).toContain('plan');
    expect(vars.stepDetails).toContain('Architect');
  });

  it('should set hasOrderContent=false and empty orderContent when previousOrderContent is null (via ctx)', () => {
    const ctx = createRetryContext({ previousOrderContent: null });
    const vars = buildRetryTemplateVars(ctx, 'en');

    expect(vars.hasOrderContent).toBe(false);
    expect(vars.orderContent).toBe('');
  });

  it('should set hasOrderContent=true and populate orderContent when provided via parameter', () => {
    const ctx = createRetryContext();
    const vars = buildRetryTemplateVars(ctx, 'en', '# Order content');

    expect(vars.hasOrderContent).toBe(true);
    expect(vars.orderContent).toBe('# Order content');
  });

  it('should include retryNote when present', () => {
    const ctx = createRetryContext({
      failure: {
        taskName: 'task',
        taskContent: 'Do something',
        createdAt: '2026-01-01T00:00:00Z',
        failedStep: '',
        error: 'Error',
        lastMessage: '',
        retryNote: 'Added more specific error handling',
      },
    });
    const vars = buildRetryTemplateVars(ctx, 'en');

    expect(vars.retryNote).toBe('Added more specific error handling');
  });

  it('should set hasOrderContent=false when previousOrderContent is null', () => {
    const ctx = createRetryContext();
    const vars = buildRetryTemplateVars(ctx, 'en', null);

    expect(vars.hasOrderContent).toBe(false);
    expect(vars.orderContent).toBe('');
  });

  it('should set hasOrderContent=true and populate orderContent when provided', () => {
    const ctx = createRetryContext();
    const vars = buildRetryTemplateVars(ctx, 'en', '# Previous Order\nDo the thing');

    expect(vars.hasOrderContent).toBe(true);
    expect(vars.orderContent).toBe('# Previous Order\nDo the thing');
  });

  it('should default hasOrderContent to false when previousOrderContent is omitted', () => {
    const ctx = createRetryContext();
    const vars = buildRetryTemplateVars(ctx, 'en');

    expect(vars.hasOrderContent).toBe(false);
    expect(vars.orderContent).toBe('');
  });
});
