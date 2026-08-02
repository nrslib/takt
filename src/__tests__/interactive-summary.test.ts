/**
 * Tests for task history context formatting in interactive summary.
 */

import { describe, expect, it } from 'vitest';

import {
  buildSummaryPrompt,
  buildSummaryActionOptions,
  formatStepPreviews,
  formatTaskHistorySummary,
  type WorkflowContext,
  type SummaryActionLabels,
  type TaskHistorySummaryItem,
} from '../features/interactive/interactive.js';

describe('formatTaskHistorySummary', () => {
  it('returns empty string when history is empty', () => {
    expect(formatTaskHistorySummary([], 'en')).toBe('');
  });

  it('formats task history with required fields', () => {
    const history: TaskHistorySummaryItem[] = [
      {
        worktreeId: 'wt-1',
        status: 'interrupted',
        startedAt: '2026-02-18T00:00:00.000Z',
        completedAt: 'N/A',
        finalResult: 'interrupted',
        failureSummary: undefined,
        logKey: 'log-1',
      },
      {
        worktreeId: 'wt-2',
        status: 'failed',
        startedAt: '2026-02-17T00:00:00.000Z',
        completedAt: '2026-02-17T00:01:00.000Z',
        finalResult: 'failed',
        failureSummary: 'Syntax error in test',
        logKey: 'log-2',
      },
    ];

    const result = formatTaskHistorySummary(history, 'en');
    expect(result).toContain('## Task execution history');
    expect(result).toContain('Worktree ID: wt-1');
    expect(result).toContain('Status: interrupted');
    expect(result).toContain('Failure summary: Syntax error in test');
    expect(result).toContain('Log key: log-2');
  });

  it('normalizes empty start/end timestamps to N/A', () => {
    const history: TaskHistorySummaryItem[] = [
      {
        worktreeId: 'wt-3',
        status: 'interrupted',
        startedAt: '',
        completedAt: '',
        finalResult: 'interrupted',
        failureSummary: undefined,
        logKey: 'log-3',
      },
    ];

    const result = formatTaskHistorySummary(history, 'en');
    expect(result).toContain('Start/End: N/A / N/A');
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

    expect(summary).toContain('## Task execution history');
    expect(summary).toContain('Worktree ID: wt-1');
    expect(summary).toContain('Conversation:');
    expect(summary).toContain('User: Improve parser');
  });

});

describe('formatStepPreviews', () => {
  it('provider/model を workflow summary に表示する', () => {
    const result = formatStepPreviews([
      {
        kind: 'agent',
        name: 'review',
        personaDisplayName: 'Reviewer',
        personaContent: '',
        instructionContent: '',
        allowedTools: [],
        canEdit: false,
        provider: 'codex',
        model: 'gpt-5.5',
      },
    ], 'en');

    expect(result).toContain('**Provider:** codex');
    expect(result).toContain('**Model:** gpt-5.5');
  });

  it('selectorの非機密metadata・readonly・tool-free契約をworkflow summaryに表示する', () => {
    const result = formatStepPreviews([
      {
        kind: 'agent',
        name: 'dynamic-selector',
        personaDisplayName: 'TAKT internal selector',
        personaContent: '',
        instructionContent: '',
        allowedTools: [],
        canEdit: false,
        provider: 'codex',
        model: 'gpt-selector',
        providerSource: 'project',
        modelSource: 'global',
        permissionMode: 'readonly',
        internalAgent: true,
      },
    ], 'en');

    expect(result).toContain('**Provider source:** project');
    expect(result).toContain('**Model source:** global');
    expect(result).toContain('**Permission:** readonly');
    expect(result).toContain('**Tools:** None');
    expect(result).toContain('**Edit:** No');
  });

  it('workflow_callを子workflow付きのcontrol nodeとして表示する', () => {
    const result = formatStepPreviews([{
      kind: 'workflow_call',
      name: 'delegate',
      call: 'shared/review',
    }], 'en');

    expect(result).toContain('**Kind:** workflow_call');
    expect(result).toContain('**Child workflow:** shared/review');
    expect(result).not.toContain('**Provider:**');
    expect(result).not.toContain('**Persona:**');
    expect(result).not.toContain('**Tools:**');
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
