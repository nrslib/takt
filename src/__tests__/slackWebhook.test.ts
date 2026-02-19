/**
 * Unit tests for Slack Incoming Webhook notification
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendSlackNotification, getSlackWebhookUrl, buildSlackRunSummary } from '../shared/utils/slackWebhook.js';
import type { SlackRunSummaryParams, SlackTaskDetail } from '../shared/utils/slackWebhook.js';

describe('sendSlackNotification', () => {
  const webhookUrl = 'https://hooks.slack.com/services/T00/B00/xxx';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should send POST request with correct payload', async () => {
    // Given
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    // When
    await sendSlackNotification(webhookUrl, 'Hello from TAKT');

    // Then
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      webhookUrl,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello from TAKT' }),
      }),
    );
  });

  it('should include AbortSignal for timeout', async () => {
    // Given
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    // When
    await sendSlackNotification(webhookUrl, 'test');

    // Then
    const callArgs = mockFetch.mock.calls[0]![1] as RequestInit;
    expect(callArgs.signal).toBeInstanceOf(AbortSignal);
  });

  it('should write to stderr on non-ok response', async () => {
    // Given
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });
    vi.stubGlobal('fetch', mockFetch);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    // When
    await sendSlackNotification(webhookUrl, 'test');

    // Then: no exception thrown, error written to stderr
    expect(stderrSpy).toHaveBeenCalledWith(
      'Slack webhook failed: HTTP 403 Forbidden\n',
    );
  });

  it('should write to stderr on fetch error without throwing', async () => {
    // Given
    const mockFetch = vi.fn().mockRejectedValue(new Error('network timeout'));
    vi.stubGlobal('fetch', mockFetch);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    // When
    await sendSlackNotification(webhookUrl, 'test');

    // Then: no exception thrown, error written to stderr
    expect(stderrSpy).toHaveBeenCalledWith(
      'Slack webhook error: network timeout\n',
    );
  });

  it('should handle non-Error thrown values', async () => {
    // Given
    const mockFetch = vi.fn().mockRejectedValue('string error');
    vi.stubGlobal('fetch', mockFetch);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    // When
    await sendSlackNotification(webhookUrl, 'test');

    // Then
    expect(stderrSpy).toHaveBeenCalledWith(
      'Slack webhook error: string error\n',
    );
  });
});

describe('getSlackWebhookUrl', () => {
  const envKey = 'TAKT_NOTIFY_WEBHOOK';
  let originalValue: string | undefined;

  beforeEach(() => {
    originalValue = process.env[envKey];
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = originalValue;
    }
  });

  it('should return the webhook URL when environment variable is set', () => {
    // Given
    process.env[envKey] = 'https://hooks.slack.com/services/T00/B00/xxx';

    // When
    const url = getSlackWebhookUrl();

    // Then
    expect(url).toBe('https://hooks.slack.com/services/T00/B00/xxx');
  });

  it('should return undefined when environment variable is not set', () => {
    // Given
    delete process.env[envKey];

    // When
    const url = getSlackWebhookUrl();

    // Then
    expect(url).toBeUndefined();
  });
});

describe('buildSlackRunSummary', () => {
  function makeTask(overrides: Partial<SlackTaskDetail> & { name: string }): SlackTaskDetail {
    return {
      success: true,
      piece: 'default',
      durationSec: 30,
      ...overrides,
    };
  }

  function makeParams(overrides?: Partial<SlackRunSummaryParams>): SlackRunSummaryParams {
    return {
      runId: 'run-20260219-105815',
      total: 3,
      success: 2,
      failed: 1,
      durationSec: 120,
      concurrency: 2,
      tasks: [],
      ...overrides,
    };
  }

  it('should include summary header with runId, counts, duration, and concurrency', () => {
    // Given
    const params = makeParams({ tasks: [] });

    // When
    const result = buildSlackRunSummary(params);

    // Then
    expect(result).toContain('\uD83C\uDFC3 TAKT Run run-20260219-105815');
    expect(result).toContain('total=3');
    expect(result).toContain('success=2');
    expect(result).toContain('failed=1');
    expect(result).toContain('duration=120s');
    expect(result).toContain('concurrency=2');
  });

  it('should display successful task with piece and issue', () => {
    // Given
    const task = makeTask({
      name: 'task-a',
      piece: 'default',
      issueNumber: 42,
      durationSec: 30,
      branch: 'feat/task-a',
      worktreePath: '.worktrees/task-a',
      prUrl: 'https://github.com/org/repo/pull/10',
    });
    const params = makeParams({ total: 1, success: 1, failed: 0, tasks: [task] });

    // When
    const result = buildSlackRunSummary(params);

    // Then
    expect(result).toContain('\u2705 task-a | piece=default | issue=#42 | duration=30s');
    expect(result).toContain('branch=feat/task-a');
    expect(result).toContain('worktree=.worktrees/task-a');
    expect(result).toContain('pr=https://github.com/org/repo/pull/10');
  });

  it('should display failed task with error details', () => {
    // Given
    const task = makeTask({
      name: 'task-b',
      success: false,
      piece: 'review',
      durationSec: 45,
      branch: 'feat/task-b',
      failureMovement: 'ai_review',
      failureError: 'Lint failed',
      failureLastMessage: 'Fix attempt timed out',
    });
    const params = makeParams({ total: 1, success: 0, failed: 1, tasks: [task] });

    // When
    const result = buildSlackRunSummary(params);

    // Then
    expect(result).toContain('\u274C task-b | piece=review | duration=45s');
    expect(result).toContain('movement=ai_review');
    expect(result).toContain('error=Lint failed');
    expect(result).toContain('last=Fix attempt timed out');
    expect(result).toContain('branch=feat/task-b');
  });

  it('should omit issue when issueNumber is undefined', () => {
    // Given
    const task = makeTask({ name: 'task-no-issue', piece: 'default', durationSec: 10 });
    const params = makeParams({ total: 1, success: 1, failed: 0, tasks: [task] });

    // When
    const result = buildSlackRunSummary(params);

    // Then
    expect(result).not.toContain('issue=');
  });

  it('should omit second line when no detail fields exist for success task', () => {
    // Given
    const task = makeTask({ name: 'task-minimal', piece: 'default', durationSec: 5 });
    const params = makeParams({ total: 1, success: 1, failed: 0, tasks: [task] });

    // When
    const result = buildSlackRunSummary(params);

    // Then
    const taskLines = result.split('\n').filter((line) => line.includes('task-minimal'));
    expect(taskLines).toHaveLength(1);
  });

  it('should preserve task submission order', () => {
    // Given
    const tasks = [
      makeTask({ name: 'first', durationSec: 10 }),
      makeTask({ name: 'second', success: false, durationSec: 20, failureError: 'err' }),
      makeTask({ name: 'third', durationSec: 30 }),
    ];
    const params = makeParams({ total: 3, success: 2, failed: 1, tasks });

    // When
    const result = buildSlackRunSummary(params);

    // Then
    const firstIdx = result.indexOf('first');
    const secondIdx = result.indexOf('second');
    const thirdIdx = result.indexOf('third');
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  it('should truncate and add "...and N more" when exceeding character limit', () => {
    // Given
    const tasks: SlackTaskDetail[] = [];
    for (let i = 0; i < 50; i++) {
      tasks.push(makeTask({
        name: `long-task-name-number-${String(i).padStart(3, '0')}`,
        piece: 'default',
        durationSec: 60,
        branch: `feat/long-branch-name-for-testing-purposes-${String(i)}`,
        worktreePath: `.worktrees/long-task-name-number-${String(i).padStart(3, '0')}`,
        prUrl: `https://github.com/organization/repository/pull/${String(i + 100)}`,
      }));
    }
    const params = makeParams({ total: 50, success: 50, failed: 0, tasks });

    // When
    const result = buildSlackRunSummary(params);

    // Then
    expect(result.length).toBeLessThanOrEqual(3800);
    expect(result).toMatch(/\.\.\.and \d+ more$/);
  });

  it('should normalize newlines in error messages', () => {
    // Given
    const task = makeTask({
      name: 'task-err',
      success: false,
      failureError: 'Line one\nLine two\r\nLine three',
    });
    const params = makeParams({ total: 1, success: 0, failed: 1, tasks: [task] });

    // When
    const result = buildSlackRunSummary(params);

    // Then
    expect(result).toContain('error=Line one Line two Line three');
    expect(result).not.toContain('\n  error=Line one\n');
  });

  it('should truncate long error text at 120 characters', () => {
    // Given
    const longError = 'A'.repeat(200);
    const task = makeTask({
      name: 'task-long-err',
      success: false,
      failureError: longError,
    });
    const params = makeParams({ total: 1, success: 0, failed: 1, tasks: [task] });

    // When
    const result = buildSlackRunSummary(params);

    // Then
    expect(result).toContain(`error=${'A'.repeat(117)}...`);
    expect(result).not.toContain('A'.repeat(200));
  });

  it('should handle mixed success and failure tasks with PR present only on some', () => {
    // Given
    const tasks = [
      makeTask({
        name: 'with-pr',
        prUrl: 'https://github.com/org/repo/pull/1',
        branch: 'feat/with-pr',
      }),
      makeTask({
        name: 'no-pr',
        branch: 'feat/no-pr',
      }),
      makeTask({
        name: 'failed-with-pr',
        success: false,
        branch: 'feat/failed',
        prUrl: 'https://github.com/org/repo/pull/2',
        failureError: 'build failed',
      }),
    ];
    const params = makeParams({ total: 3, success: 2, failed: 1, tasks });

    // When
    const result = buildSlackRunSummary(params);

    // Then
    expect(result).toContain('pr=https://github.com/org/repo/pull/1');
    expect(result).toContain('pr=https://github.com/org/repo/pull/2');
    const lines = result.split('\n');
    const noPrLine = lines.find((l) => l.includes('no-pr'));
    expect(noPrLine).not.toContain('pr=');
  });

  it('should handle empty tasks list', () => {
    // Given
    const params = makeParams({ total: 0, success: 0, failed: 0, tasks: [] });

    // When
    const result = buildSlackRunSummary(params);

    // Then
    expect(result).toContain('\uD83C\uDFC3 TAKT Run');
    expect(result).toContain('total=0');
    expect(result).not.toContain('...and');
  });
});
