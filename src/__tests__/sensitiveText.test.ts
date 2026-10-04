import { describe, expect, it } from 'vitest';
import {
  createBoundedSensitiveValues,
  MAX_INSPECTED_BYTES_PER_SOURCE,
  MAX_TRACKED_SENSITIVE_VALUE_BYTES,
  MAX_TRACKED_SENSITIVE_VALUES,
  createSensitiveTextStreamRedactor,
  sanitizeSensitiveTextWithKnownValues,
  sanitizeSensitiveValue,
  sanitizeSensitiveValueWithKnownValues,
  sanitizeSensitiveText,
} from '../shared/utils/sensitiveText.js';
import { sanitizeOpenCodeToolInput } from '../infra/opencode/tool-input-sanitizer.js';

describe('sensitiveText', () => {
  const privateKey = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAA',
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n');

  it('redacts complete PEM private key blocks', () => {
    const sanitized = sanitizeSensitiveText(`before\n${privateKey}\nafter`);

    expect(sanitized).toBe('before\n[REDACTED]\nafter');
    expect(sanitized).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
  });

  it('redacts an unterminated PEM private key through the end of the input', () => {
    const unterminatedKey = 'before\n-----BEGIN PRIVATE KEY-----\nLEAK-ME';

    expect(sanitizeSensitiveText(unterminatedKey)).toBe('before\n[REDACTED]');
  });

  it('redacts an unterminated PEM private key when the stream is flushed', () => {
    const redactor = createSensitiveTextStreamRedactor();

    const output = redactor.write('-----BEGIN PRIVATE KEY-----\n', {})
      + redactor.write('LEAK-ME', {})
      + redactor.flush({});

    expect(output).toBe('[REDACTED]');
    expect(output).not.toContain('LEAK-ME');
  });

  it('redacts a PEM private key split at every stream boundary', () => {
    for (let split = 1; split < privateKey.length; split += 1) {
      const redactor = createSensitiveTextStreamRedactor();
      const output = redactor.write(privateKey.slice(0, split), {})
        + redactor.write(privateKey.slice(split), {})
        + redactor.flush({});
      expect(output).toBe('[REDACTED]');
    }
  });

  it('bounds retained sensitive candidates and remains fail-closed after exhaustion', () => {
    const byCount = createBoundedSensitiveValues();
    for (let index = 0; index <= MAX_TRACKED_SENSITIVE_VALUES; index += 1) {
      byCount.collect({ token: `secret-${index}` });
    }
    expect(byCount.exhausted).toBe(true);
    expect(byCount.exhaustReason).toBe('candidate_count');
    expect(byCount.values.size).toBe(0);
    expect(sanitizeSensitiveTextWithKnownValues('unknown-secret', byCount)).toBe('[REDACTED]');

    const byBytes = createBoundedSensitiveValues();
    byBytes.collect({ token: 'x'.repeat(MAX_TRACKED_SENSITIVE_VALUE_BYTES + 1) });
    expect(byBytes.exhausted).toBe(true);
    expect(byBytes.exhaustReason).toBe('candidate_bytes');
    expect(byBytes.values.size).toBe(0);
    expect(sanitizeSensitiveTextWithKnownValues('another-secret', byBytes)).toBe('[REDACTED]');

    const bySourceScan = createBoundedSensitiveValues();
    bySourceScan.collect({ token: 'x'.repeat(MAX_INSPECTED_BYTES_PER_SOURCE + 1) });
    expect(bySourceScan.exhausted).toBe(true);
    expect(bySourceScan.exhaustReason).toBe('source_scan');
  });

  it('accepts exactly 1,024 sensitive candidates', () => {
    const bounded = createBoundedSensitiveValues();
    bounded.collect({
      token: Array.from({ length: MAX_TRACKED_SENSITIVE_VALUES }, (_, index) => `secret-${index}`),
    });

    expect(bounded.exhausted).toBe(false);
    expect(bounded.values.size).toBe(MAX_TRACKED_SENSITIVE_VALUES);
  });

  it('accepts exactly 1MiB of retained sensitive candidate bytes', () => {
    const bounded = createBoundedSensitiveValues();
    bounded.collect({ token: 'x'.repeat(MAX_TRACKED_SENSITIVE_VALUE_BYTES) });

    expect(bounded.exhausted).toBe(false);
    expect(bounded.storedValueBytes).toBe(MAX_TRACKED_SENSITIVE_VALUE_BYTES);
  });

  it('accepts exactly 16MiB from one inspected source', () => {
    const bounded = createBoundedSensitiveValues();
    bounded.collect('x'.repeat(MAX_INSPECTED_BYTES_PER_SOURCE));

    expect(bounded.exhausted).toBe(false);
  });

  it('redacts sensitive-key values when repeated in sibling, nested, and array fields', () => {
    const secret = 'opaque-secret';
    const sanitized = sanitizeOpenCodeToolInput({
      password: secret,
      note: `echo ${secret}`,
      nested: { text: secret },
      items: [secret],
    });

    expect(sanitized).toEqual({
      password: '[REDACTED]',
      note: 'echo [REDACTED]',
      nested: { text: '[REDACTED]' },
      items: ['[REDACTED]'],
    });
  });

  it.each([
    ['token=split-token-secret', 'split-token-secret'],
    ['Authorization: Bearer split-authorization-secret', 'split-authorization-secret'],
    ['session_id: split-session-secret', 'split-session-secret'],
  ])('redacts an unregistered credential split at every stream boundary: %s', (text, secret) => {
    for (let split = 1; split < text.length; split += 1) {
      const redactor = createSensitiveTextStreamRedactor();
      const output = redactor.write(text.slice(0, split), {})
        + redactor.write(text.slice(split), {})
        + redactor.flush({});
      expect(output).not.toContain(secret);
      expect(output).toContain('[REDACTED]');
    }
  });

  it.each([
    ['Authorization: Bearer ', 'authorization'],
    ['session_id: ', 'session'],
    ['token=', 'token'],
  ])('redacts credential values longer than the stream boundary window: %s', (prefix, label) => {
    const secret = `${label}-${'x'.repeat(512)}`;
    const redactor = createSensitiveTextStreamRedactor();

    const output = redactor.write(prefix, {})
      + redactor.write(secret, {})
      + redactor.flush({});

    expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED]');
  });

  it('fails closed without emitting an oversized pending credential', () => {
    const secret = `oversized-${'x'.repeat(10_050)}`;
    const redactor = createSensitiveTextStreamRedactor();

    const output = redactor.write('Authorization: Bearer ', {})
      + redactor.write(secret, {})
      + redactor.flush({});

    expect(output).toBe('[REDACTED]');
    expect(output).not.toContain(secret);
  });

  it.each([
    ['write', { content: 'private write body' }, 'content'],
    ['apply_patch', { patchText: 'private patch body' }, 'patchText'],
  ])('replaces %s tool body content with a descriptor', (tool, input, key) => {
    const sanitized = sanitizeOpenCodeToolInput(input, tool);
    const body = Object.values(input)[0]!;

    expect(sanitized[key]).toEqual({
      sha256: expect.stringMatching(/^[a-f0-9]{12}$/),
      length: body.length,
    });
    expect(JSON.stringify(sanitized)).not.toContain(body);
  });
  it.each([
    [{ command: 'curl --token option-secret' }, 'option-secret'],
    [{ command: 'curl -H "Authorization: Bearer authorization-secret" https://example.test' }, 'authorization-secret'],
    [{ command: 'curl https://user:url-secret@example.test' }, 'url-secret'],
    [{ command: 'curl https://example.test?token=query-secret' }, 'query-secret'],
    [{ command: 'credentials=assignment-secret' }, 'assignment-secret'],
  ])('redacts a secret extracted from an embedded tool argument when it is echoed alone', (source, echo) => {
    expect(sanitizeSensitiveTextWithKnownValues(`echoed ${echo}`, source)).toBe('echoed [REDACTED]');
  });

  it('sanitizes deeply nested provider input without recursive stack growth', () => {
    interface DeepNode {
      next?: DeepNode;
      token?: string;
    }
    const source: DeepNode = {};
    let cursor = source;
    for (let depth = 0; depth < 2_000; depth += 1) {
      const next: DeepNode = {};
      cursor.next = next;
      cursor = next;
    }
    cursor.token = 'deep-secret';

    const sanitized = sanitizeSensitiveValue(source) as DeepNode;
    let sanitizedCursor = sanitized;
    for (let depth = 0; depth < 2_000; depth += 1) {
      sanitizedCursor = sanitizedCursor.next!;
    }
    expect(sanitizedCursor.token).toBe('[REDACTED]');
    expect(sanitizeSensitiveTextWithKnownValues('deep-secret', source)).toBe('[REDACTED]');
  });

  it('redacts circular references instead of traversing them repeatedly', () => {
    const source: Record<string, unknown> = { token: 'cycle-secret' };
    source['self'] = source;

    expect(sanitizeSensitiveValue(source)).toEqual({
      token: '[REDACTED]',
      self: '[REDACTED]',
    });
    expect(sanitizeSensitiveTextWithKnownValues('cycle-secret', source)).toBe('[REDACTED]');
  });

  it('redacts values beyond the traversal limit', () => {
    const source = Array.from({ length: 10_050 }, (_, index) => `value-${index}`);

    expect(sanitizeSensitiveValue(source)).toBe('[REDACTED]');
  });

  it('fails closed when known-value collection exceeds the traversal limit', () => {
    const source = Array.from({ length: 10_050 }, (_, index) => (
      index === 10_049 ? { token: 'unvisited-secret' } : index
    ));

    expect(sanitizeSensitiveValueWithKnownValues(
      { content: 'unvisited-secret' },
      source,
    )).toEqual({ content: '[REDACTED]' });
    expect(sanitizeSensitiveTextWithKnownValues('unvisited-secret', source)).toBe('[REDACTED]');
    expect(sanitizeSensitiveTextWithKnownValues('', source)).toBe('');
  });
});
