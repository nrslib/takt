import { describe, expect, it } from 'vitest';
import {
  createBoundedSensitiveValues, createSensitiveTextStreamRedactor, MAX_TRACKED_SENSITIVE_VALUES,
  MAX_TRACKED_SENSITIVE_VALUE_BYTES, sanitizeSensitiveText, sanitizeSensitiveTextWithKnownValues,
  sanitizeSensitiveValue, sanitizeSensitiveValueWithKnownValues,
} from '../shared/utils/sensitiveText.js';
import { SensitiveTextStreamBuffer, maskSensitiveTextChunks } from '../shared/utils/sensitive-stream.js';
import { maskSensitiveRanges } from '../shared/utils/sensitive-text.js';
import { scenarioText, secretFragmentsIn, splitSecretScenarios } from './helpers/split-secret-scenarios.js';

describe('sensitiveText', () => {
  it('commits only complete lines and flushes the final unterminated line', () => {
    const redactor = createSensitiveTextStreamRedactor();
    expect(redactor.write('ready', {})).toBe('');
    expect(redactor.write('\nnext', {})).toBe('ready\n');
    expect(redactor.write(' line\nlast', {})).toBe('next line\n');
    expect(redactor.flush({})).toBe('last');
    expect(redactor.flush({})).toBe('');
  });

  it.each(['token:', '--token', '"api_key" =', 'Authorization:', 'Cookie:', 'session-id:'])(
    'holds the valueless main prefix %s until the next value line is complete', (prefix) => {
      for (const separator of ['\n', '\r\n']) {
        const redactor = createSensitiveTextStreamRedactor();
        expect(redactor.write(`ready${separator}${prefix}${separator}`, {})).toBe(`ready${separator}`);
        expect(redactor.write('unknown-', {})).toBe('');
        expect(redactor.write(`secret${separator}after${separator}`, {}))
          .toBe(sanitizeSensitiveText(`${prefix}${separator}unknown-secret${separator}after${separator}`));
        const whole = createSensitiveTextStreamRedactor();
        expect(whole.write(`${prefix}${separator}unknown-secret${separator}`, {}))
          .toBe(sanitizeSensitiveText(`${prefix}${separator}unknown-secret${separator}`));
      }
    },
  );

  it.each([
    ['token=', '"'], ['password=', "'"], ['"api_key" = ', '"'],
    ['token=', '\\"'], ['--token=', '"'], ['--password ', "'"],
  ])('holds the multiline quoted value after %s%s until its closing quote', (prefix, quote) => {
    for (const newline of ['\n', '\r\n']) {
      const redactor = createSensitiveTextStreamRedactor();
      const text = `${prefix}${quote}first-private${newline}middle-private${newline}second-private${quote}${newline}`;
      const expected = sanitizeSensitiveText(text);
      for (const secret of ['first-private', 'middle-private', 'second-private']) expect(expected).not.toContain(secret);
      expect(redactor.write(`ready${newline}${prefix}${quote}first-private${newline}`, {})).toBe(`ready${newline}`);
      expect(redactor.write(`middle-private${newline}second-private`, {})).toBe('');
      expect(redactor.write(`${quote}${newline}after${newline}`, {})).toBe(`${expected}after${newline}`);
      const whole = createSensitiveTextStreamRedactor();
      expect(whole.write(text, {})).toBe(expected);
      const split = createSensitiveTextStreamRedactor();
      let output = '';
      for (const char of text) output += split.write(char, {});
      expect(output + split.flush({})).toBe(expected);
    }
  });

  it('does not treat an escaped quote as the end of a held multiline value', () => {
    const redactor = createSensitiveTextStreamRedactor();
    const first = 'token="first-private\\"still-private\n';
    const second = 'second-private\\"still-private\n';
    expect(redactor.write(first, {})).toBe('');
    expect(redactor.write(second, {})).toBe('');
    expect(redactor.write('last-private"\nafter\n', {})).toBe(sanitizeSensitiveText(first + second + 'last-private"\nafter\n'));
  });

  it('masks every line of a held quoted value in its provisional preview before the closing quote arrives', () => {
    const buffer = new SensitiveTextStreamBuffer();
    expect(buffer.write('token="first-private\nsecond-private', {}).text).toBe('');
    expect(buffer.preview({})).toBe('token="[REDACTED]');
    expect(buffer.write('\nlast-private', {}).text).toBe('');
    expect(buffer.preview({})).toBe('token="[REDACTED]');
    const commit = buffer.write('"\nafter\n', {});
    expect(maskSensitiveRanges(commit.text, commit.ranges)).toBe('token="[REDACTED]"\nafter\n');
  });

  it('flushes a held quoted value at completion or a tool boundary without carrying its quote forward', () => {
    const redactor = createSensitiveTextStreamRedactor();
    const text = 'token="first-private\n';
    expect(redactor.write(text, {})).toBe('');
    expect(redactor.flush({})).toBe(sanitizeSensitiveText(text));
    expect(redactor.write('ordinary next output"\n', {})).toBe('ordinary next output"\n');
  });

  it('keeps the oversized unterminated-line boundary for an unclosed quoted value', () => {
    const redactor = createSensitiveTextStreamRedactor();
    const text = 'token="' + 'Q'.repeat(10000);
    expect(redactor.write(text, {})).toBe(sanitizeSensitiveText(text));
    expect(redactor.write('ordinary tail\n', {})).toBe('ordinary tail\n');
  });

  it('flushes a held valueless key at completion or a tool boundary without carrying its context forward', () => {
    const redactor = createSensitiveTextStreamRedactor();
    expect(redactor.write('token:\n', {})).toBe('');
    expect(redactor.flush({})).toBe('token:\n');
    expect(redactor.write('ordinary next response\n', {})).toBe('ordinary next response\n');
    expect(redactor.write('token:\nunknown-secret', {})).toBe('');
    expect(redactor.flush({})).toBe('token:\n[REDACTED]');
  });

  it('does not hold an ordinary valueless key or a complete key/value line', () => {
    const redactor = createSensitiveTextStreamRedactor();
    expect(redactor.write('path:\nordinary path\ntoken=known-value\n', {}))
      .toBe('path:\nordinary path\ntoken=[REDACTED]\n');
  });

  it.each(['prefix-ghp_abcdefgh-suffix', 'prefix-sk-abcdefgh-suffix'])(
    'masks the entire known value %s even when an explicit token pattern overlaps it', (value) => {
      const source = { token: value };
      const redactor = createSensitiveTextStreamRedactor();
      expect(redactor.write(`before ${value}`, source)).toBe('');
      expect(redactor.write(' after\n', source)).toBe('before [REDACTED] after\n');
      expect(sanitizeSensitiveTextWithKnownValues(`before ${value} after\n`, source)).toBe('before [REDACTED] after\n');
    },
  );

  it.each(['Bearer', 'Basic'])('masks the Authorization %s scheme together with a known value that includes it', (scheme) => {
    const redactor = createSensitiveTextStreamRedactor();
    const source = { token: `${scheme} private-value` };
    expect(redactor.write(`Authorization: ${scheme} private-value\n`, source)).toBe('Authorization: [REDACTED]\n');
    expect(redactor.write(`${scheme} private-value\n`, source)).toBe('[REDACTED]\n');
  });

  it('discovers values throughout the complete line before emitting any of it', () => {
    const redactor = createSensitiveTextStreamRedactor();
    expect(redactor.write('echo opaque-value password=opaque-', {})).toBe('');
    expect(redactor.write('value token=' + 'Z'.repeat(5000), {})).toBe('');
    expect(redactor.write(' now opaque-value\n', {})).toBe('echo [REDACTED] password=[REDACTED] token=[REDACTED] now [REDACTED]\n');
  });

  it('masks only required spans when an unfinished line exceeds 10000 characters', () => {
    const redactor = createSensitiveTextStreamRedactor();
    const prefix = 'public ' + 'x'.repeat(9972) + ' password=opaque-value';
    expect(redactor.write(prefix.slice(0, 10000), {})).toBe('');
    const shown = redactor.write(prefix.slice(10000), {});
    expect(shown).toBe('public ' + 'x'.repeat(9972) + ' password=[REDACTED]');
    expect(redactor.write('ordinary tail\n', {})).toBe('ordinary tail\n');
  });

  it('does not continue masking across the explicit oversized-line limitation', () => {
    const redactor = createSensitiveTextStreamRedactor();
    expect(redactor.write('token=' + 'Z'.repeat(10000), {})).toBe('token=[REDACTED]');
    expect(redactor.write('remaining-part\n', {})).toBe('remaining-part\n');
  });

  it.each(['PRIVATE KEY', 'RSA PRIVATE KEY', 'OPENSSH PRIVATE KEY'])('holds a complete %s block until its closing marker', (label) => {
    const redactor = createSensitiveTextStreamRedactor();
    expect(redactor.write(`before\n-----BEGIN ${label}-----\n`, {})).toBe('before\n');
    expect(redactor.write('private-material\n' + 'Z'.repeat(11000) + '\n', {})).toBe('');
    expect(redactor.write(`-----END ${label}-----`, {})).toBe('[REDACTED]');
    expect(redactor.write('\nafter\n', {})).toBe('\nafter\n');
  });

  it.each(['PRIVATE KEY', 'RSA PRIVATE KEY', 'OPENSSH PRIVATE KEY'])('recognizes split %s delimiters across byte-sized chunks', (label) => {
    const buffer = createSensitiveTextStreamRedactor();
    const text = `public -----BEGIN ${label}-----\nprivate material\n-----END ${label}-----\nafter\n`;
    let output = '';
    for (const char of text) output += buffer.write(char, {});
    expect(output + buffer.flush({})).toBe('public [REDACTED]\nafter\n');
  });

  it('masks an unfinished PEM block on final flush', () => {
    const redactor = createSensitiveTextStreamRedactor();
    expect(redactor.write('-----BEGIN PRIVATE KEY-----\nprivate\n', {})).toBe('');
    expect(redactor.flush({})).toBe('[REDACTED]');
    expect(redactor.write('after\n', {})).toBe('after\n');
  });

  it('provides a replacement-only masked preview without registering provisional candidates', () => {
    const buffer = new SensitiveTextStreamBuffer();
    const source = { token: 'opaque-value' };
    expect(buffer.write('ready\nopaque-', source).text).toBe('ready\n');
    expect(buffer.preview(source)).toBe('[REDACTED]');
    expect(buffer.write('not-the-value', source).text).toBe('');
    expect(buffer.preview(source)).toBe('opaque-not-the-value');
    expect(buffer.sensitiveValues.values.has('opaque-not-the-value')).toBe(false);
    expect(maskSensitiveRanges(buffer.flush(source).text, [])).toBe('opaque-not-the-value');
  });

  it('masks complete key/value forms and earlier echoes in a provisional line', () => {
    const buffer = new SensitiveTextStreamBuffer();
    buffer.write('opaque-value password=opaque-value', {});
    expect(buffer.preview({})).toBe('[REDACTED] password=[REDACTED]');
    expect(buffer.sensitiveValues.values.size).toBe(0);
    expect(buffer.write('\n', {}).text).toBe('opaque-value password=opaque-value\n');
  });

  it.each([
    [['ab', 'abc', 'abcd'], 'zabz ab abc abcd', 'zabz [REDACTED] [REDACTED] [REDACTED]'],
    [['abacredential'], 'xababab', 'xabab[REDACTED]'],
    [['秘密'], '公開秘密値 秘密', '公開秘密値 [REDACTED]'],
    [['Bearer private', 'private'], 'Authorization: Bearer private', 'Authorization: [REDACTED]'],
    [['opaque echo private', 'private'], 'token=opaque echo private next', 'token=[REDACTED] next'],
  ] as const)('masks preview matches and proper suffix prefixes for %j', (values, text, expected) => {
    const buffer = new SensitiveTextStreamBuffer();
    buffer.write(text, { token: values });
    expect(buffer.preview({})).toBe(expected);
  });

  it('bounds the masked preview to the last 8KiB without splitting UTF-8 or consuming the pending line', () => {
    const buffer = new SensitiveTextStreamBuffer();
    const text = 'omitted-head ' + 'あ'.repeat(3000) + ' tail opaque-';
    buffer.write(text, { token: 'opaque-value' });
    const preview = buffer.preview({});
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(8192);
    expect(preview.endsWith(' tail [REDACTED]')).toBe(true);
    expect(preview).not.toContain('omitted-head');
    expect(preview).not.toContain('\uFFFD');
    expect(buffer.flush({}).text).toBe(text);
  });

  it.each(['complete', 'prefix', 'assignment'] as const)('keeps a %s secret masked when it is longer than the preview', (kind) => {
    const buffer = new SensitiveTextStreamBuffer();
    const value = 'opaque-' + 'q'.repeat(9500);
    if (kind === 'assignment') buffer.write('password=' + value.slice(0, 9000), {});
    else buffer.write(value.slice(0, 9000), { token: kind === 'complete' ? value.slice(0, 9000) : value });
    expect(buffer.preview({})).toBe(kind === 'assignment' ? 'password=[REDACTED]' : '[REDACTED]');
  });

  it('masks a known prefix split inside a UTF-16 surrogate pair before encoding the preview', () => {
    const buffer = new SensitiveTextStreamBuffer();
    buffer.write('prefix-\ud83d', { token: 'prefix-😀-private' });
    expect(buffer.preview({})).toBe('[REDACTED]');
    buffer.write('\ude00-private', {});
    expect(buffer.preview({})).toBe('[REDACTED]');
  });

  it('keeps a PEM preview masked when its opening marker is outside the 8KiB window', () => {
    const buffer = new SensitiveTextStreamBuffer();
    buffer.write('-----BEGIN PRIVATE KEY-----\n' + 'Q'.repeat(20000), {});
    expect(buffer.preview({})).toBe('[REDACTED]');
  });

  it('keeps text and thinking ownership while committing a masked whole line', () => {
    const buffer = new SensitiveTextStreamBuffer();
    expect(buffer.write('echo opaque-', {}).text).toBe('');
    const commit = buffer.write('value password=opaque-value\n', {});
    const chunks = maskSensitiveTextChunks(commit, [
      { channel: 'text', text: 'echo opaque-' }, { channel: 'thinking', text: 'value password=opaque-value\n' },
    ]);
    expect(chunks.committed).toEqual([{ channel: 'text', text: 'echo [REDACTED]' }, { channel: 'thinking', text: ' password=[REDACTED]\n' }]);
    expect(chunks.pending).toEqual([]);
  });

  it('retains scoped substring matching for configured short values', () => {
    const buffer = new SensitiveTextStreamBuffer();
    expect(buffer.write('xab', { token: 'abc' }, ['abc']).text).toBe('');
    const commit = buffer.write('cx\n', {}, ['abc']);
    expect(maskSensitiveRanges(commit.text, commit.ranges)).toBe('x[REDACTED]x\n');
  });

  it('masks each known multiline value line even when followed by unrelated text', () => {
    const source = { private_key: 'first-line-secret\nsecond-line-secret' };
    const text = 'safe\nfirst-line-secret\nmore\nsecond-line-secret\n';
    const expected = 'safe\n[REDACTED]\nmore\n[REDACTED]\n';
    const redactor = createSensitiveTextStreamRedactor();
    expect(redactor.write(text, source) + redactor.flush(source)).toBe(expected);
    expect(sanitizeSensitiveTextWithKnownValues(text, source)).toBe(expected);
  });

  it.each([
    ['token=one-secret ready', 'token=[REDACTED] ready'],
    ['password="one-secret" ready', 'password="[REDACTED]" ready'],
    ["password='one-secret' ready", "password='[REDACTED]' ready"],
    ['{"api_key": "one-secret", "ok": true}', '{"api_key": "[REDACTED]", "ok": true}'],
    ['--api-key one-secret --verbose', '--api-key [REDACTED] --verbose'],
    ['--api-key=one-secret --verbose', '--api-key=[REDACTED] --verbose'],
    ['Authorization: Bearer one-secret', 'Authorization: Bearer [REDACTED]'],
    ['Authorization: Basic one-secret', 'Authorization: Basic [REDACTED]'],
    ['Authorization: Bearer "one-secret"', 'Authorization: Bearer [REDACTED]'],
    ['Authorization: Basic "one-secret"', 'Authorization: Basic [REDACTED]'],
    ['Authorization: Bearer one-secret ready', 'Authorization: Bearer [REDACTED]'],
    ['Cookie: sid=one-secret; session=another-value', 'Cookie: [REDACTED]'],
    ['cookies=sid=one-secret ready', 'cookies=[REDACTED] ready'],
    ['session_id=one-secret ready', 'session_id=[REDACTED] ready'],
    ['url?token=one-secret&safe=yes', 'url?token=[REDACTED]'],
  ])('masks an explicit key and value on the same line: %s', (text, expected) => {
    expect(sanitizeSensitiveText(text)).toBe(expected);
  });

  it.each(["'", '"'])('preserves command quoting and a URL after a %s header', (quote) => {
    const text = `curl -H ${quote}Authorization: Bearer one-secret${quote} https://example.test\nready`;
    expect(sanitizeSensitiveText(text)).toBe(`curl -H ${quote}Authorization: Bearer [REDACTED]${quote} https://example.test\nready`);
  });

  describe.each(["'", '"'])('same-line shell header enclosed in %s', (quote) => {
    it.each([
      ['Authorization', 'Basic c2VjcmV0==', 'Basic [REDACTED]'],
      ['Authorization', 'Bearer fixture-secret==', 'Bearer [REDACTED]'],
      ['Cookie', 'sid=fixture-secret==; other=fixture-extra', '[REDACTED]'],
      ['Set-Cookie', 'sid=fixture-secret==; Path=/', '[REDACTED]'],
    ])('preserves the URL and diagnosis after %s', (header, value, expected) => {
      const suffix = " 'https://example.test/path' --verbose\nprovider.transport: ECONNRESET";
      expect(sanitizeSensitiveText(`curl -H ${quote}${header}: ${value}${quote}${suffix}`))
        .toBe(`curl -H ${quote}${header}: ${expected}${quote}${suffix}`);
    });
  });

  it.each([
    ['Authorization', 'Digest username=\\"alice\\", response=\\"fixture-secret\\"', 'Digest [REDACTED]'],
    ['Authorization', 'Bearer \\"fixture-secret\\"', 'Bearer [REDACTED]'],
    ['Authorization', 'Basic \\"fixture-secret\\"', 'Basic [REDACTED]'],
    ['Authorization', 'Bearer fixture-secret\\\\', 'Bearer [REDACTED]'],
    ['Cookie', 'sid=\\"fixture-secret\\"; other=\\"fixture-extra\\"', '[REDACTED]'],
    ['Set-Cookie', 'sid=\\"fixture-secret\\"; Path=/', '[REDACTED]'],
  ])('handles escaped quotes and backslash pairs inside a %s header', (header, value, expected) => {
    const suffix = " 'https://example.test/path' --verbose\nprovider.transport: ECONNRESET";
    const command = `curl -H "${header}: ${value}"`;
    const masked = `curl -H "${header}: ${expected}"${suffix}`;
    expect(sanitizeSensitiveText(command + suffix)).toBe(masked);
    expect(sanitizeSensitiveText(JSON.stringify({ command: command + suffix }))).toBe(JSON.stringify({ command: masked }));
  });

  it('treats a backslash as literal inside a single-quoted shell header', () => {
    expect(sanitizeSensitiveText("curl -H 'Cookie: sid=fixture-secret\\' 'https://example.test/path'"))
      .toBe("curl -H 'Cookie: [REDACTED]' 'https://example.test/path'");
  });

  it('masks the complete quoted assignment before interpreting embedded header text', () => {
    expect(sanitizeSensitiveText('token="metadata Authorization: Basic c2VjcmV0==" https://example.test/path'))
      .toBe('token="[REDACTED]" https://example.test/path');
  });

  it.each(['metadata \\"quoted\\" ', 'metadata \\\\ ', 'metadata \\\\\\"quoted\\\\\\" '])(
    'preserves JSON assignment boundaries after escaped metadata: %s', (metadata) => {
      const command = `token="${metadata}Authorization: Basic c2VjcmV0==" https://example.test/path`;
      expect(sanitizeSensitiveText(JSON.stringify({ command })))
        .toBe(JSON.stringify({ command: 'token="[REDACTED]" https://example.test/path' }));
    },
  );

  it('preserves the next argument after a long JSON-escaped assignment', () => {
    const command = 'token="' + 'metadata \\"quoted\\" \\\\ '.repeat(4096) + 'Authorization: Basic c2VjcmV0==" https://example.test/path';
    expect(sanitizeSensitiveText(JSON.stringify({ command })))
      .toBe(JSON.stringify({ command: 'token="[REDACTED]" https://example.test/path' }));
  });

  it.each(['\n', '\r\n'])('keeps the next physical line after an unclosed header (%j)', (separator) => {
    expect(sanitizeSensitiveText('curl -H "Authorization: Digest response=\\"fixture-secret\\"' + separator + 'provider.transport: ECONNRESET'))
      .toBe('curl -H "Authorization: Digest [REDACTED]' + separator + 'provider.transport: ECONNRESET');
  });

  it('masks a long same-line escaped header without consuming the next argument', () => {
    const command = 'curl -H "Authorization: Digest ' + 'response=\\"fixture-secret\\", '.repeat(4096) + 'nonce=\\"fixture-extra\\""';
    const suffix = " 'https://example.test/path'\nprovider.transport: ECONNRESET";
    expect(sanitizeSensitiveText(command + suffix)).toBe('curl -H "Authorization: Digest [REDACTED]"' + suffix);
  });

  it.each([
    ['Digest', 'realm="fixture-secret", nonce="fixture-extra"'],
    ['Bearer', 'realm="fixture-secret"'], ['Basic', 'realm="fixture-secret"'],
    ['Bearer', '"fixture-secret"'], ['Basic', '"fixture-secret"'],
    ['Digest', "realm='fixture-secret', nonce='fixture-extra'"],
    ['Bearer', "'fixture-secret'"], ['Basic', "'fixture-secret'"],
  ])('preserves command quotes around Authorization %s %s', (scheme, value) => {
    const quote = value.includes('"') ? "'" : '"';
    const suffix = ' https://example.test\nprovider.transport: ECONNRESET';
    const expected = `${scheme} [REDACTED]`;
    expect(sanitizeSensitiveText(`curl -H ${quote}Authorization: ${scheme} ${value}${quote}${suffix}`))
      .toBe(`curl -H ${quote}Authorization: ${expected}${quote}${suffix}`);
  });

  it.each(['Cookie', 'Set-Cookie'])('preserves command quotes around a %s value containing quotes', (header) => {
    const suffix = ' https://example.test\nprovider.transport: ECONNRESET';
    expect(sanitizeSensitiveText(`curl -H '${header}: sid="fixture-secret"; other="fixture-extra"'${suffix}`))
      .toBe(`curl -H '${header}: [REDACTED]'${suffix}`);
  });

  it.each([
    ['sk-unknownopaquevalue', '[REDACTED]'], ['ghp_unknownopaquevalue', '[REDACTED]'],
    ['xoxb-unknown-opaque-value', '[REDACTED]'],
    ['https://user:unknown-secret@example.test/path', 'https://[REDACTED]@example.test/path'],
    ['curl -u user:unknown-secret https://example.test', 'curl -u [REDACTED] https://example.test'],
    ['-----BEGIN PRIVATE KEY-----\nunknown-secret\n-----END PRIVATE KEY-----', '[REDACTED]'],
    ['token:\nunknown-secret', 'token:\n[REDACTED]'], ['--token\nunknown-secret', '--token\n[REDACTED]'],
  ])('preserves existing main masking for %s', (text, expected) => {
    expect(sanitizeSensitiveText(text)).toBe(expected);
  });

  it('preserves existing masking for a complete multiline quoted assignment', () => {
    expect(sanitizeSensitiveText('token="first-secret\nsecond-line\nlast"\nready')).toBe('token="[REDACTED]"\nready');
  });

  it('preserves existing word boundaries for short known values', () => {
    expect(sanitizeSensitiveTextWithKnownValues('abc abc xabcy', { token: 'abc' })).toBe('[REDACTED] [REDACTED] xabcy');
    expect(sanitizeSensitiveTextWithKnownValues('echo opaque-value password=opaque-value\n', {})).toBe('echo opaque-value password=[REDACTED]\n');
  });

  it('masks known values repeated in sibling, nested, and array fields', () => {
    const value = { api_key: 'opaque-value', echo: 'opaque-value', nested: { echo: 'opaque-value' }, items: ['opaque-value'] };
    expect(sanitizeSensitiveValueWithKnownValues(value, value)).toEqual({ api_key: '[REDACTED]', echo: '[REDACTED]', nested: { echo: '[REDACTED]' }, items: ['[REDACTED]'] });
  });

  it('does not carry a completed key/value mask into text after flush', () => {
    const redactor = createSensitiveTextStreamRedactor();
    expect(redactor.write('token=known-value', {}) + redactor.flush({})).toBe('token=[REDACTED]');
    expect(redactor.write('ordinary progress\n', {})).toBe('ordinary progress\n');
    expect(redactor.write('known-value\n', {})).toBe('[REDACTED]\n');
  });

  it.each(splitSecretScenarios)('masks same-line keys split across notifications: $name', (scenario) => {
    const redactor = createSensitiveTextStreamRedactor();
    let shown = '';
    for (const chunk of scenario.chunks) { shown += redactor.write(chunk, {}); expect(secretFragmentsIn(shown, scenario)).toEqual([]); }
    shown += redactor.flush({});
    expect(secretFragmentsIn(shown, scenario)).toEqual([]);
    expect(shown).toContain('[REDACTED]');
    expect(scenarioText(scenario).length).toBeGreaterThan(0);
  });

  it('keeps tracking values of later inputs after one input exceeds the inspection limit', () => {
    const values = createBoundedSensitiveValues();
    values.collect({ token: 'known-0-value' });
    values.collect({ note: Array.from({ length: 12000 }, () => 'ordinary') });
    values.collect({ token: 'later-value' });
    expect(sanitizeSensitiveTextWithKnownValues('echo later-value', values)).toBe('echo [REDACTED]');
    expect(sanitizeSensitiveTextWithKnownValues('known-0-value', values)).toBe('[REDACTED]');
    expect(sanitizeSensitiveTextWithKnownValues('ordinary progress', values)).toBe('ordinary progress');
  });

  it.each(['count', 'bytes'])('bounds known-value tracking without masking unrelated output after the %s limit', (budget) => {
    const values = createBoundedSensitiveValues();
    values.collect({ token: 'known-0-value' });
    if (budget === 'count') for (let index = 1; index < MAX_TRACKED_SENSITIVE_VALUES + 10; index++) values.collect({ token: `known-${index}-value` });
    else values.collect({ token: 'x'.repeat(MAX_TRACKED_SENSITIVE_VALUE_BYTES + 1) });
    expect(values.exhausted).toBe(true);
    expect(values.values.size).toBeLessThanOrEqual(MAX_TRACKED_SENSITIVE_VALUES);
    expect(values.storedValueBytes).toBeLessThanOrEqual(MAX_TRACKED_SENSITIVE_VALUE_BYTES);
    expect(sanitizeSensitiveTextWithKnownValues('ordinary progress', values)).toBe('ordinary progress');
    expect(sanitizeSensitiveTextWithKnownValues('known-0-value', values)).toBe('[REDACTED]');
  });

  it('masks every explicit key/value after reaching the candidate limit', () => {
    const text = Array.from({ length: MAX_TRACKED_SENSITIVE_VALUES + 1 }, (_, index) => `token=opaque-${String(index).padStart(5, '0')}`).join(' ');
    const redactor = createSensitiveTextStreamRedactor();
    const masked = redactor.write(text + '\n', {});
    expect(masked).not.toContain('opaque-');
    expect(masked).toContain('token=[REDACTED]');
  });

  it('does not mask ordinary structured input merely because it has many nodes', () => {
    const value = Array.from({ length: 12000 }, () => ({ note: 'ordinary progress' }));
    expect(sanitizeSensitiveValue(value)).toEqual(value);
    expect(sanitizeSensitiveValueWithKnownValues(value, value)).toEqual(value);
  });

  it('handles deep and cyclic structured input without recursive stack growth', () => {
    const root: Record<string, unknown> = { token: 'known-value' };
    let current = root;
    for (let index = 0; index < 1000; index++) { const next: Record<string, unknown> = {}; current.child = next; current = next; }
    current.token = 'known-value'; current.cycle = root;
    const result = sanitizeSensitiveValue(root) as Record<string, unknown>;
    expect(result.token).toBe('[REDACTED]');
    let tail = result;
    for (let index = 0; index < 1000; index++) tail = tail.child as Record<string, unknown>;
    expect(tail.token).toBe('[REDACTED]');
    expect(tail.cycle).toBe('[REDACTED]');
  });
});
