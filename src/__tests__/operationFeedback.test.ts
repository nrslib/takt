import { describe, expect, it, vi } from 'vitest';
import type { IssueEnqueueResult } from '../infra/task/enqueueService.js';
import {
  createOperationMessage, describeExecutionResult, describeIssueResult,
  describeSavedTask, prependOperationResults, runConversationOperation,
} from '../features/interactive/operationFeedback.js';

describe('operation feedback', () => {
  it.each(['en', 'ja'] as const)('reports saved task names in %s', (lang) => {
    const saved = describeSavedTask({ taskName: 'actual-task' }, lang);
    expect(saved.kind).toBe('dispatched');
    expect(saved.notice).toContain('actual-task');
    expect(saved.notice).toMatch(lang === 'en' ? /Task saved:/ : /タスクを保存しました/);
  });

  it.each(['en', 'ja'] as const)('reports cancellation and no saved task in %s', (lang) => {
    const cancelled = describeSavedTask({ kind: 'cancelled' }, lang);
    expect(cancelled.kind).toBe('cancelled');
    expect(cancelled.notice).toMatch(lang === 'en' ? /cancelled/i : /キャンセル/);
    expect(cancelled.notice).toMatch(lang === 'en' ? /no task was saved/i : /保存されていません/);
    expect(cancelled.notice).not.toMatch(lang === 'en' ? /Task saved:/i : /タスクを保存しました/);
  });

  it.each([
    { success: true, created: { taskName: 'issue-task', tasksFile: 'tasks.yaml', workflow: 'default', issueNumber: 42 } },
    { success: false, failure: { issueCreated: true, taskEnqueued: false, issueNumber: 42, stage: 'task_saving', error: new Error('disk full') } },
    { success: false, failure: { issueCreated: true, taskEnqueued: false, issueNumber: 42, stage: 'cancelled_after_issue_creation', error: 'cancelled' } },
    { success: false, failure: { issueCreated: true, taskEnqueued: false, stage: 'issue_number_parsing', error: 'number unavailable' } },
    { success: false, failure: { issueCreated: false, taskEnqueued: false, stage: 'issue_creation', error: 'permission denied' } },
  ] satisfies IssueEnqueueResult[])('preserves Issue and task facts: %j', (actual) => {
    const outcome = describeIssueResult(actual, 'en');
    if (actual.success) {
      expect(outcome.notice).toContain('#42');
      expect(outcome.notice).toContain('issue-task');
    } else {
      expect(outcome.notice).toContain(actual.failure.error instanceof Error
        ? actual.failure.error.message : actual.failure.error);
      expect(outcome.notice).toMatch(/no task was saved/i);
      if ('issueNumber' in actual.failure) {
        expect(outcome.notice).toContain('#42');
      } else {
        expect(outcome.notice).not.toMatch(/#\d+/);
      }
      expect(outcome.kind).toBe(actual.failure.stage === 'cancelled_after_issue_creation' ? 'cancelled' : 'dispatched');
    }
  });

  it('reports Issue creation and task saving failure in Japanese', () => {
    const actual = {
      success: false,
      failure: {
        issueCreated: true,
        taskEnqueued: false,
        issueNumber: 42,
        stage: 'task_saving',
        error: new Error('disk full'),
      },
    } satisfies IssueEnqueueResult;

    const outcome = describeIssueResult(actual, 'ja');

    expect(outcome.notice).toContain('Issue #42');
    expect(outcome.notice).toContain('作成されました');
    expect(outcome.notice).toContain('タスクは保存されていません');
    expect(outcome.notice).toContain('disk full');
  });

  it.each(['en', 'ja'] as const)('distinguishes successful completion, failure, and cancellation before execution in %s', (lang) => {
    const succeeded = describeExecutionResult({ success: true }, lang);
    const failed = describeExecutionResult({ success: false }, lang);
    const cancelled = describeExecutionResult({ kind: 'cancelled' }, lang);
    expect(succeeded.notice).toMatch(lang === 'en' ? /successfully/ : /成功/);
    expect(failed.notice).toMatch(lang === 'en' ? /failure/ : /失敗/);
    expect(failed.notice).not.toMatch(/Reason:|理由:|Task failed|undefined/);
    expect(cancelled.kind).toBe('cancelled');
    expect(cancelled.notice).toMatch(lang === 'en' ? /cancelled before starting/ : /実行開始前.*キャンセル/);
    expect(cancelled.notice).not.toBe(succeeded.notice);
  });

  it.each(['en', 'ja'] as const)('reports the sanitized execution failure reason in %s', (lang) => {
    const outcome = describeExecutionResult({ success: false, reason: 'workflow\x1b[31m aborted\n' }, lang);
    expect(outcome.kind).toBe('dispatched');
    expect(outcome.notice).toMatch(lang === 'en' ? /failure/ : /失敗/);
    expect(outcome.notice).toContain('workflow aborted\\n');
    expect(outcome.notice).not.toContain('\x1b');
  });

  it('does not invent an Issue number when a successful result omits it', () => {
    const result = describeIssueResult({
      success: true, created: { taskName: 'issue-task', tasksFile: 'tasks.yaml', workflow: 'default' },
    }, 'en');
    expect(result.notice).toContain('issue-task');
    expect(result.notice).not.toMatch(/#\d+|undefined/);
  });

  it('converts an exception once without retrying the operation', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('disk full'));
    const result = await runConversationOperation('save_task', 'en', operation);
    expect(result.kind).toBe('dispatched');
    expect(result.notice).toContain('Save as Task');
    expect(result.notice).toContain('disk full');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('keeps the returned outcome and uses only operation records as quoted reference data', async () => {
    const outcome = describeSavedTask({ taskName: 'actual-task' }, 'en');
    expect(await runConversationOperation('save_task', 'en', async () => outcome)).toEqual(outcome);
    const record = createOperationMessage(outcome.notice);
    expect(record.content).toBe(outcome.notice);
    expect(prependOperationResults('question', [record, { role: 'assistant', content: 'proposal' }], 'en'))
      .toContain(outcome.notice);
    expect(prependOperationResults('question', [{ role: 'assistant', content: 'proposal' }], 'en')).toBe('question');
  });
});
