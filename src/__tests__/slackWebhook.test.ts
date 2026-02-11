/**
 * Unit tests for Slack Incoming Webhook notification
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendSlackNotification, getSlackWebhookUrl } from '../shared/utils/slackWebhook.js';

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
