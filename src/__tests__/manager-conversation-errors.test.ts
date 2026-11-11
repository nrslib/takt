import { describe, expect, it } from 'vitest';
import { ConversationError, conversationErrorResult } from '../features/manager/conversationErrors.js';
import { getLabel } from '../shared/i18n/index.js';

describe('conversationErrorResult', () => {
  it('preserves the actual ECONNRESET failure detail', () => {
    const reason = 'provider.transport: ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch() (status 200)';

    expect(conversationErrorResult(new Error(reason), 'ja')).toMatchObject({
      code: 'operation_failed', message: expect.stringContaining(reason),
    });
  });

  it.each(['ja', 'en'] as const)('includes the sanitized provider failure reason for %s', (language) => {
    const error = new Error('provider.transport: ECONNRESET\nsocket closed; api_token=abc123xyz\u001b[31m');
    const result = conversationErrorResult(error, language);

    expect(result).toMatchObject({ kind: 'error', code: 'operation_failed' });
    expect(result.message).toContain('provider.transport: ECONNRESET socket closed');
    expect(result.message).toContain('api_token=[REDACTED]');
    expect(result.message).not.toContain('abc123xyz');
    expect(result.message).not.toContain('\u001b');
    expect(result.message).not.toContain('\n');
  });

  it('bounds an unclassified failure reason', () => {
    const result = conversationErrorResult(new Error(`prefix ${'x'.repeat(2_000)}`), 'en');

    expect(result.message).toContain('prefix');
    expect(result.message).toContain('…');
    expect(result.message.length).toBeLessThan(600);
  });

  it('redacts sensitive assignments after removing terminal formatting', () => {
    const result = conversationErrorResult(new Error('ECONNRESET api_\u001b[31mtoken\u001b[0m=abc123xyz'), 'en');

    expect(result.message).toContain('ECONNRESET');
    expect(result.message).toContain('api_token=[REDACTED]');
    expect(result.message).not.toContain('abc123xyz');
  });

  it('flattens all line separators in the displayed reason', () => {
    const result = conversationErrorResult(new Error('ECONNRESET\rretry\u2028socket\u2029closed'), 'en');

    expect(result.message).toContain('ECONNRESET retry socket closed');
    expect(result.message).not.toMatch(/[\r\n\u2028\u2029]/u);
  });

  it.each(['', '\n\tother="fixture-extra"'])('redacts a long line of Cookie candidates and keeps the following diagnosis (continuation=%j)', (continuation) => {
    const candidates = 'Cookie: sid=fixture-secret; '.repeat(25_000);
    const error = new Error(`${candidates}Cookie: sid="fixture-last"${continuation}\nprovider.transport: ECONNRESET`);

    const result = conversationErrorResult(error, 'en');

    expect(result.message).toBe(getLabel('manager.conversation.operation_failed_with_reason', 'en', {
      reason: 'Cookie: [REDACTED] provider.transport: ECONNRESET',
    }));
  });

  it.each(['ja', 'en'] as const)('keeps classified operation and registration errors unchanged for %s', (language) => {
    const recovery = Object.assign(new Error('private provider detail'), { code: 'registration_recovery' });
    for (const error of [new ConversationError('operation_failed'), recovery]) {
      expect(conversationErrorResult(error, language)).toEqual({
        kind: 'error', code: error.code, message: getLabel(`manager.conversation.${error.code}`, language),
      });
    }
  });

  it('keeps classified conversation errors unchanged', () => {
    expect(conversationErrorResult(new ConversationError('invalid_input'), 'ja')).toEqual({
      kind: 'error',
      code: 'invalid_input',
      message: '操作の入力が正しくありません。',
    });
  });
});
