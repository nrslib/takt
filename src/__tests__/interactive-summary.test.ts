/**
 * Tests for task history context formatting in interactive summary.
 */

import { describe, expect, it } from 'vitest';

import {
  buildSummaryPrompt,
  buildSummaryActionOptions,
  formatTaskHistorySummary,
  type WorkflowContext,
  type SummaryActionLabels,
  type TaskHistorySummaryItem,
} from '../features/interactive/interactive.js';

describe('formatTaskHistorySummary', () => {
  it('returns empty string when history is empty', () => {
    expect(formatTaskHistorySummary([], 'en')).toBe('');
  });

});

describe('buildSummaryPrompt', () => {
  it('includes taskHistory context when provided', () => {
    const history: TaskHistorySummaryItem[] = [
      {
        worktreeId: 'wt-1',
        status: 'completed',
        startedAt: '2026-02-10T00:00:00.000Z',
        completedAt: '2026-02-10T00:00:30.000Z',
        finalResult: 'completed',
        failureSummary: undefined,
        logKey: 'log-1',
      },
    ];
    const workflowContext: WorkflowContext = {
      name: 'my-workflow',
      description: 'desc',
      workflowStructure: '',
      stepPreviews: [],
      taskHistory: history,
    };

    const summary = buildSummaryPrompt(
      [{ role: 'user', content: 'Improve parser' }],
      false,
      'en',
      'No transcript',
      'Conversation:',
      workflowContext,
    );

    expect(summary).toContain('wt-1');
    expect(summary).toContain('Improve parser');
  });

  it('includes the existing Gherkin output rules when enabled', () => {
    const summary = buildSummaryPrompt(
      [{ role: 'user', content: 'Improve parser' }],
      false,
      'en',
      'No transcript',
      'Conversation:',
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(summary).toContain('## Markdown + Gherkin Output Format');
  });

  it('keeps the existing Markdown-only output contract when disabled', () => {
    const summary = buildSummaryPrompt(
      [{ role: 'user', content: 'Improve parser' }],
      false,
      'en',
      'No transcript',
      'Conversation:',
      undefined,
      undefined,
      undefined,
      false,
    );

    expect(summary).not.toContain('## Markdown + Gherkin Output Format');
    expect(summary).not.toContain('Write these in a fenced `gherkin` block:');
    expect(summary).not.toContain('Do not duplicate the same requirement in Markdown and Gherkin');
    expect(summary).toContain('Output only the final task instruction (no preamble).');
  });

});

describe('buildSummaryActionOptions', () => {
  const labels: SummaryActionLabels = {
    execute: 'Execute now',
    saveTask: 'Save as Task',
    continue: 'Continue editing',
  };

  it('should include all base actions when no exclude is given', () => {
    const options = buildSummaryActionOptions(labels);
    const values = options.map((o) => o.value);

    expect(values).toEqual(['execute', 'save_task', 'continue']);
  });

  it('should exclude specified actions', () => {
    const options = buildSummaryActionOptions(labels, [], ['execute']);
    const values = options.map((o) => o.value);

    expect(values).toEqual(['save_task', 'continue']);
    expect(values).not.toContain('execute');
  });

  it('should exclude multiple actions', () => {
    const options = buildSummaryActionOptions(labels, [], ['execute', 'continue']);
    const values = options.map((o) => o.value);

    expect(values).toEqual(['save_task']);
  });

  it('should handle append and exclude together', () => {
    const labelsWithIssue: SummaryActionLabels = {
      ...labels,
      createIssue: 'Create Issue',
    };
    const options = buildSummaryActionOptions(labelsWithIssue, ['create_issue'], ['execute']);
    const values = options.map((o) => o.value);

    expect(values).toEqual(['save_task', 'continue', 'create_issue']);
    expect(values).not.toContain('execute');
  });

  it('should return empty exclude by default (backward compatible)', () => {
    const options = buildSummaryActionOptions(labels, []);
    const values = options.map((o) => o.value);

    expect(values).toContain('execute');
    expect(values).toContain('save_task');
    expect(values).toContain('continue');
  });
});
