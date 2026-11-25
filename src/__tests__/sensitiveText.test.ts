import { describe, expect, it } from 'vitest';
import {
  createBoundedSensitiveValues,
  MAX_INSPECTED_BYTES_PER_SOURCE,
  MAX_TRACKED_SENSITIVE_VALUE_BYTES,
  MAX_TRACKED_SENSITIVE_VALUES,
  createSensitiveTextStreamRedactor,
  sanitizeSensitiveTextWithKnownValues,
  sanitizeSensitiveValue,
  sanitizeSensitiveText,
} from '../shared/utils/sensitiveText.js';
import { sanitizeOpenCodeToolInput } from '../infra/opencode/tool-input-sanitizer.js';
import { collectSensitiveStringValues } from '../shared/utils/sensitive-value.js';
import { maskSensitiveRanges, sensitiveTextRanges, substringSensitiveRanges } from '../shared/utils/sensitive-text.js';

describe('sensitiveText', () => {
  describe.each([
    ['a plain scheme', 'https://', 'https://'],
    ['a scheme with a plus', 'git+https://', 'git+https://'],
    ['a scheme after a digit and a hyphen', '1-http://', '1-http://'],
    ['a scheme after a long hyphenated run', 'abc-'.repeat(64) + 'ssh://', 'abc-'.repeat(64) + 'ssh://'],
    ['a scheme after a digit', '9http://', '9http://'],
    ['a scheme after an underscore', '_http://', '_http://'],
    ['a scheme that ends in digits', 'see s3://', 'see s3://'],
  ])('URL userinfo behind %s', (_name, scheme, keptPrefix) => {
    const text = `clone ${scheme}user:pa55-word@host/repo.git failed`;

    it('redacts the user and password', () => {
      expect(sanitizeSensitiveText(text)).toBe(`clone ${keptPrefix}[REDACTED]@host/repo.git failed`);
    });

    it('redacts the same range when streaming', () => {
      expect(maskSensitiveRanges(text, sensitiveTextRanges(text, new Set())))
        .toBe(`clone ${keptPrefix}[REDACTED]@host/repo.git failed`);
    });

    it('redacts the password where it is echoed later', () => {
      expect(sanitizeSensitiveTextWithKnownValues('echoed pa55-word', { command: text })).toBe('echoed [REDACTED]');
    });
  });

  it.each([
    ['a password that contains colons', 'https://user:pa:ss:word@host', 'https://[REDACTED]@host'],
    ['an empty user followed by a colon in the password', 'https://::word@host', 'https://[REDACTED]@host'],
    ['each URL in a list', 'a://u:p@h,b://v:q@i', 'a://[REDACTED]@h,b://[REDACTED]@i'],
    ['the URL after one without credentials', 'a://b://u:p@h', 'a://b://[REDACTED]@h'],
    ['an empty user', 'redis://:pa55-word@host:6379/0', 'redis://[REDACTED]@host:6379/0'],
    ['an @ in the password', 'https://user:p@ss@host/path', 'https://[REDACTED]@host/path'],
    ['several @ in the password', 'https://user:p@s@s@host', 'https://[REDACTED]@host'],
    ['an @ at the end of the password', 'https://user:pass@@host', 'https://[REDACTED]@host'],
    ['an empty user and an @ in the password', 'redis://:p@ss@host', 'redis://[REDACTED]@host'],
  ])('redacts URL userinfo with %s', (_name, text, expected) => {
    expect(sanitizeSensitiveText(text)).toBe(expected);
  });

  it.each([
    ['a quoted list', '["https://user:pass@host","admin@example.test"]', '["https://[REDACTED]@host","admin@example.test"]'],
    ['a comma-separated list', 'https://user:pass@host,admin@example.test', 'https://[REDACTED]@host,admin@example.test'],
    ['a parenthesized URL', '(https://user:pass@host)(admin@example.test)', '(https://[REDACTED]@host)(admin@example.test)'],
    ['a path', 'https://user:pass@host/admin@example.test', 'https://[REDACTED]@host/admin@example.test'],
    ['a following word', 'https://user:pass@host admin@example.test', 'https://[REDACTED]@host admin@example.test'],
  ])('keeps the host and a later address readable in %s', (_name, text, expected) => {
    expect(sanitizeSensitiveText(text)).toBe(expected);
    expect(maskSensitiveRanges(text, sensitiveTextRanges(text, new Set()))).toBe(expected);
  });

  it('redacts a password with an @ where it is echoed later and when streaming', () => {
    const text = 'clone https://user:p@55-word@host/repo.git failed';

    expect(maskSensitiveRanges(text, sensitiveTextRanges(text, new Set()))).toBe('clone https://[REDACTED]@host/repo.git failed');
    expect(sanitizeSensitiveTextWithKnownValues('echoed p@55-word', { command: text })).toBe('echoed [REDACTED]');
  });

  // Known limit of reading the password up to the last `@` of the authority: when `;` separates
  // a later address, the host is hidden too.
  it('hides the host when `;` separates a later address', () => {
    expect(sanitizeSensitiveText('url=https://u:p@db.internal;owner=ops@example.test'))
      .toBe('url=https://[REDACTED]@example.test');
  });

  it.each([
    'url=https://u:pa55-word@db.internal;owner=ops@example.test',
    'https://u:pa55-word@host&notify=ops@example.test',
    'https://u:pa55-word@host|ops@example.test',
    'https://u:pa55-word@host:8080;ops@example.test',
    'https://u:pa55-word@host!ops@x',
  ])('redacts the password where it is echoed later when a later @ follows in %s', (command) => {
    expect(sanitizeSensitiveTextWithKnownValues('echoed pa55-word', { command })).toBe('echoed [REDACTED]');
  });

  it.each([
    ['url=https://u:pw55@db.internal;owner=ops@example.test', 'paged the ops team'],
    ['url=https://u:pw55@db;database=prod@x', 'production product'],
  ])('keeps a later output readable that only shares a word with what follows the first @ in %s', (command, output) => {
    expect(sanitizeSensitiveTextWithKnownValues(output, { command })).toBe(output);
  });

  it('keeps tracking the password when a long run of @ follows it in a stream', () => {
    const redactor = createSensitiveTextStreamRedactor();
    redactor.write('clone https://u:pa55-word@' + 'x@'.repeat(300 * 1024) + 'host failed\n', {});

    expect(redactor.write('echoed pa55-word\n', {})).toBe('echoed [REDACTED]\n');
  });

  it('redacts a password with an @ where it is echoed later when the user is long', () => {
    const command = `clone https://${'u'.repeat(250)}:pa55@word@host failed\n`;
    const redactor = createSensitiveTextStreamRedactor();
    redactor.write(command, {});

    expect(sanitizeSensitiveTextWithKnownValues('echoed pa55@word', { command })).toBe('echoed [REDACTED]');
    expect(redactor.write('echoed pa55@word\n', {})).toBe('echoed [REDACTED]\n');
  });

  it('keeps tracking a later secret after a long run of @ follows a URL password in a stream', () => {
    const redactor = createSensitiveTextStreamRedactor();
    redactor.write('clone https://u:pa55-word@' + 'x@'.repeat(300 * 1024) + 'host failed\n', {});
    redactor.write('token=later-secret-value\n', {});

    expect(redactor.write('echoed later-secret-value\n', {})).toBe('echoed [REDACTED]\n');
  });

  // Known limit: a scheme is ASCII letters, digits, `+`, `-` and `.` with at least one letter.
  it.each(['aé://user:name@host', 'é://user:name@host'])('does not treat %s as a URL with credentials', (text) => {
    expect(sanitizeSensitiveText(text)).toBe(text);
  });

  it.each([
    'https://user@host/path',
    'https://user@host:8080/path@v2',
    'https://:@host',
    'https://user:@host',
    'https://host:8080/path@v2',
    'https://host/a:b@c',
    'mailto:user:name@host',
    '://user:name@host',
    '1://user:name@host',
  ])('leaves %s readable', (text) => {
    expect(sanitizeSensitiveText(text)).toBe(text);
  });

  it.each(['known', 'substring'] as const)('masks the union of overlapping %s matches without hiding surrounding text', (matching) => {
    for (const [value, text] of [['abcab', 'before abcabcab after'], ['aaaa', 'before aaaaaa after']] as const) {
      const masked = matching === 'known'
        ? sanitizeSensitiveTextWithKnownValues(text, { token: value })
        : maskSensitiveRanges(text, substringSensitiveRanges(text, [value]));
      expect(masked).toBe('before [REDACTED] after');
    }
  });

  it('masks overlapping short configured substrings without changing input-derived word matching', () => {
    const text = 'before ababa after';
    expect(maskSensitiveRanges(text, substringSensitiveRanges(text, ['aba']))).toBe('before [REDACTED] after');
    expect(sanitizeSensitiveTextWithKnownValues(text, { token: 'aba' })).toBe(text);
  });

  describe.each(["'", '"'])('shell header enclosed in %s', (quote) => {
    it.each([
      ['Authorization', 'Basic c2VjcmV0==', 'Basic [REDACTED]'],
      ['Authorization', 'Bearer fixture-secret==', 'Bearer [REDACTED]'],
      ['Cookie', 'sid=fixture-secret==; other=fixture-extra', '[REDACTED]'],
      ['Set-Cookie', 'sid=fixture-secret==; Path=/', '[REDACTED]'],
    ])('keeps the URL after a padded %s value', (header, value, expected) => {
      const command = 'curl -H ' + quote + header + ': ' + value + quote;
      const suffix = " 'https://example.test/path' --verbose\nprovider.transport: ECONNRESET";

      expect(sanitizeSensitiveText(command + suffix))
        .toBe('curl -H ' + quote + header + ': ' + expected + quote + suffix);
    });
  });

  it.each([
    ['Authorization', 'Digest username=\\"alice\\", response=\\"fixture-secret\\"', 'Digest [REDACTED]'],
    ['Authorization', 'Bearer \\"fixture-secret\\"', 'Bearer [REDACTED]'],
    ['Authorization', 'Basic \\"fixture-secret\\"', 'Basic [REDACTED]'],
    ['Authorization', 'Bearer fixture-secret\\\\', 'Bearer [REDACTED]'],
    ['Cookie', 'sid=\\"fixture-secret\\"; other=\\"fixture-extra\\"', '[REDACTED]'],
    ['Set-Cookie', 'sid=\\"fixture-secret\\"; Path=/', '[REDACTED]'],
  ])('handles escaped quotes and backslash pairs in a double-quoted %s argument', (header, value, expected) => {
    const suffix = " 'https://example.test/path' --verbose\nprovider.transport: ECONNRESET";
    const command = 'curl -H "' + header + ': ' + value + '"';

    expect(sanitizeSensitiveText(command + suffix)).toBe('curl -H "' + header + ': ' + expected + '"' + suffix);
    expect(sanitizeSensitiveText(JSON.stringify({ command: command + suffix })))
      .toBe(JSON.stringify({ command: 'curl -H "' + header + ': ' + expected + '"' + suffix }));
  });

  it('treats a backslash as literal inside a single-quoted shell header', () => {
    const command = "curl -H 'Cookie: sid=fixture-secret\\' 'https://example.test/path'";

    expect(sanitizeSensitiveText(command)).toBe("curl -H 'Cookie: [REDACTED]' 'https://example.test/path'");
  });

  it('redacts quoted sensitive assignments before interpreting embedded header text', () => {
    const text = 'token="metadata Authorization: Basic c2VjcmV0==" https://example.test/path';

    expect(sanitizeSensitiveText(text)).toBe('token="[REDACTED]" https://example.test/path');
  });

  describe.each(["'", '"'])('sensitive assignment enclosed in %s', (quote) => {
    it.each([
      ['Authorization', 'Basic c2VjcmV0==', 'c2VjcmV0=='],
      ['Cookie', 'sid=fixture-secret==', 'fixture-secret=='],
      ['Set-Cookie', 'sid=fixture-secret==', 'fixture-secret=='],
    ])('collects the embedded %s credential without collecting the following URL', (header, value, credential) => {
      const text = 'token=' + quote + 'metadata ' + header + ': ' + value + quote + ' https://example.test/path';

      const collected = collectSensitiveStringValues(text);

      expect(collected.values.has(credential)).toBe(true);
      expect([...collected.values].some((candidate) => candidate.includes('example.test/path'))).toBe(false);
      expect(sanitizeSensitiveTextWithKnownValues('echoed ' + credential + ' https://example.test/path', text))
        .toBe('echoed [REDACTED] https://example.test/path');
      expect(sanitizeSensitiveTextWithKnownValues(text, text))
        .toBe('token=' + quote + '[REDACTED]' + quote + ' https://example.test/path');
    });

    it.each([
      ['Authorization', 'Basic c2VjcmV0==', 'c2VjcmV0=='],
      ['Cookie', 'sid=fixture-secret==', 'fixture-secret=='],
      ['Set-Cookie', 'sid=fixture-secret==', 'fixture-secret=='],
    ])('collects the JSON-escaped %s credential without collecting the following URL', (header, value, credential) => {
      const command = 'token=' + quote + 'metadata ' + header + ': ' + value + quote + ' https://example.test/path';
      const source = JSON.stringify({ command });
      const expected = JSON.stringify({ command: 'token=' + quote + '[REDACTED]' + quote + ' https://example.test/path' });

      const collected = collectSensitiveStringValues(source);

      expect(collected.values.has(credential)).toBe(true);
      expect([...collected.values].some((candidate) => candidate.includes('example.test/path'))).toBe(false);
      expect(sanitizeSensitiveTextWithKnownValues('echoed ' + credential + ' https://example.test/path', source))
        .toBe('echoed [REDACTED] https://example.test/path');
      expect(sanitizeSensitiveText(source)).toBe(expected);
      expect(sanitizeSensitiveTextWithKnownValues(source, source)).toBe(expected);
    });
  });

  it.each([
    'metadata \\"quoted\\" ',
    'metadata \\\\ ',
    'metadata \\\\\\"quoted\\\\\\" ',
  ])('keeps JSON assignment boundaries after escaped metadata: %s', (metadata) => {
    const command = 'token="' + metadata + 'Authorization: Basic c2VjcmV0==" https://example.test/path';
    const source = JSON.stringify({ command });

    expect(sanitizeSensitiveTextWithKnownValues('echoed c2VjcmV0== https://example.test/path', source))
      .toBe('echoed [REDACTED] https://example.test/path');
    expect(sanitizeSensitiveText(source))
      .toBe(JSON.stringify({ command: 'token="[REDACTED]" https://example.test/path' }));
  });

  it('bounds header collection inside a long JSON-escaped assignment', () => {
    const metadata = 'metadata \\"quoted\\" \\\\ '.repeat(4_096);
    const command = 'token="' + metadata + 'Authorization: Basic c2VjcmV0==" https://example.test/path';
    const source = JSON.stringify({ command });

    expect(sanitizeSensitiveTextWithKnownValues('echoed c2VjcmV0== https://example.test/path', source))
      .toBe('echoed [REDACTED] https://example.test/path');
    expect(sanitizeSensitiveText(source))
      .toBe(JSON.stringify({ command: 'token="[REDACTED]" https://example.test/path' }));
  });

  it.each(['\n', '\r\n'])('keeps the following diagnosis after an unterminated quoted header (%j)', (separator) => {
    const command = 'curl -H "Authorization: Digest response=\\"fixture-secret\\"';

    expect(sanitizeSensitiveText(command + separator + 'provider.transport: ECONNRESET'))
      .toBe('curl -H "Authorization: Digest [REDACTED]' + separator + 'provider.transport: ECONNRESET');
  });

  it('redacts a long escaped header and preserves the next argument and diagnosis', () => {
    const parameters = 'response=\\"fixture-secret\\", '.repeat(4_096);
    const command = 'curl -H "Authorization: Digest ' + parameters + 'nonce=\\"fixture-extra\\""';
    const suffix = " 'https://example.test/path'\nprovider.transport: ECONNRESET";

    expect(sanitizeSensitiveText(command + suffix))
      .toBe('curl -H "Authorization: Digest [REDACTED]"' + suffix);
  });

  it.each([
    ["curl -H 'Authorization: Basic c2VjcmV0==' 'https://example.test/path'", 'c2VjcmV0=='],
    ["curl -H 'Cookie: sid=fixture-secret==' 'https://example.test/path'", 'fixture-secret=='],
    ["curl -H 'Set-Cookie: sid=fixture-secret==' 'https://example.test/path'", 'fixture-secret=='],
  ])('collects the credential without collecting a subsequent URL: %s', (command, credential) => {
    expect(sanitizeSensitiveTextWithKnownValues('echoed ' + credential + ' https://example.test/path', { command }))
      .toBe('echoed [REDACTED] https://example.test/path');
  });

  it.each([
    ['Authorization', 'Digest token="fixture-secret", nonce="fixture-extra"'],
    ['Cookie', 'token="fixture-secret"; other=fixture-extra'],
    ['Set-Cookie', 'token="fixture-secret"; Path=/'],
  ])('collects the complete %s value containing a quoted sensitive assignment', (header, value) => {
    const command = "curl -H '" + header + ': ' + value + "'";

    expect(sanitizeSensitiveTextWithKnownValues('echoed ' + value, { command }))
      .toBe('echoed [REDACTED]');
  });

  it.each([
    {
      command: "curl -H 'Authorization: Basic c2VjcmV0==' 'https://example.test/path'",
      expected: "curl -H 'Authorization: Basic [REDACTED]' 'https://example.test/path'",
      secrets: ['c2VjcmV0=='],
    },
    {
      command: String.raw`curl -H "Authorization: Digest username=\"alice\", response=\"fixture-secret\""`,
      expected: 'curl -H "Authorization: Digest [REDACTED]"',
      secrets: ['alice', 'fixture-secret'],
    },
  ])('redacts the complete shell header without consuming subsequent arguments: $command', ({ command, expected, secrets }) => {
    expect(sanitizeSensitiveText(command)).toBe(expected);

    const sanitized = sanitizeSensitiveText(`${command} --verbose\nprovider.transport: ECONNRESET`);

    expect(sanitized).toBe(`${expected} --verbose\nprovider.transport: ECONNRESET`);
    for (const secret of secrets) {
      expect(sanitized).not.toContain(secret);
    }
  });

  it.each([
    ['Digest', 'realm="fixture-secret", nonce="fixture-extra"'],
    ['Bearer', 'realm="fixture-secret"'],
    ['Basic', 'realm="fixture-secret"'],
    ['Bearer', '"fixture-secret"'],
    ['Basic', '"fixture-secret"'],
    ['Digest', "realm='fixture-secret', nonce='fixture-extra'"],
    ['Bearer', "'fixture-secret'"],
    ['Basic', "'fixture-secret'"],
  ])('redacts quoted Authorization %s %s while preserving command quotes and diagnosis', (scheme, value) => {
    const quote = value.includes('"') ? "'" : '"';
    const text = `curl -H ${quote}Authorization: ${scheme} ${value}${quote} https://example.test\nprovider.transport: ECONNRESET`;

    const sanitized = sanitizeSensitiveText(text);

    expect(sanitized).toBe(`curl -H ${quote}Authorization: ${scheme} [REDACTED]${quote} https://example.test\nprovider.transport: ECONNRESET`);
    expect(sanitized).not.toContain('fixture-secret');
    expect(sanitized).not.toContain('fixture-extra');
  });

  it.each(['Cookie', 'Set-Cookie'])('redacts quoted %s values while preserving the enclosing command and subsequent diagnosis', (header) => {
    const text = `curl -H '${header}: sid="fixture-secret"; other="fixture-extra"' https://example.test\nprovider.transport: ECONNRESET`;

    const sanitized = sanitizeSensitiveText(text);

    expect(sanitized).toBe(`curl -H '${header}: [REDACTED]' https://example.test\nprovider.transport: ECONNRESET`);
    expect(sanitized).not.toContain('fixture-secret');
    expect(sanitized).not.toContain('fixture-extra');
  });

  describe.each(['-u ', '-u', '--user ', '--user=', '--proxy-user ', '--proxy-user='])(
    'user option %s', (option) => {
      it.each([
        'a:x', 'a1.b_c-d:abc', '"a1.b_c-d:abc"', "'alice:abc'",
        'al+ice:abc', 'al%ice:abc', ':abc', 'alice:', ':',
        '"al+ice:abc"', "'al%ice:abc'", '":abc"', "':abc'",
        '"alice:"', "'alice:'", '":"', "':'",
        '"alice:abc def"', "'alice:abc def'", '"al ice:abc"', "'al ice:abc'",
      ])(
        'redacts a colon-containing value in original and JSON text: %s', (value) => {
          const text = `inspect ${option}${value} tail`;
          const expected = `inspect ${option}[REDACTED] tail`;

          expect(sanitizeSensitiveText(text)).toBe(expected);
          expect(sanitizeSensitiveText(JSON.stringify({ command: text })))
            .toBe(JSON.stringify({ command: expected }));
        },
      );

      it.each([
        '+%Y-%m-%dT%H:%M:%SZ',
        '"+%Y-%m-%dT%H:%M:%SZ"',
        "'+%Y-%m-%dT%H:%M:%SZ'",
        '+al+ice:abc',
        '"+al+ice:abc def"',
        "'+al%ice:abc def'",
        'alice',
        '"alice"',
        "'alice'",
        '"aliceabc def"',
        "'aliceabc def'",
      ])('preserves a plus-prefixed or colon-free value before a URL in original and JSON text: %s', (value) => {
        const text = `inspect ${option}${value} https://example.com tail`;
        const json = JSON.stringify({ command: text });

        expect(sanitizeSensitiveText(text)).toBe(text);
        expect(sanitizeSensitiveText(json)).toBe(json);
      });

      it.each([
        ['"a1.b_c-d:abc"', 'a1.b_c-d:abc', 'abc'],
        ['"al+ice:s3cret value"', 'al+ice:s3cret value', 's3cret value'],
        ["'al%ice:s3cret value'", 'al%ice:s3cret value', 's3cret value'],
        ['":abc"', ':abc', 'abc'],
      ])('redacts collected credentials and their password when echoed alone: %s', (value, credential, password) => {
        const source = { command: `inspect ${option}${value}` };

        const sanitized = sanitizeSensitiveTextWithKnownValues(`echoed ${credential} ${password}`, source);

        expect(sanitized).toBe('echoed [REDACTED] [REDACTED]');
      });

      it.each(['', '"', "'"])('does not collect a date format or its colon suffix as a sensitive value: %s', (quote) => {
        const format = '+%Y-%m-%dT%H:%M:%SZ';
        const source = { command: `inspect ${option}${quote}${format}${quote}` };
        const echo = `echoed ${format} %M:%SZ`;

        expect(sanitizeSensitiveTextWithKnownValues(echo, source)).toBe(echo);
        expect(sanitizeSensitiveTextWithKnownValues(echo, JSON.stringify(source))).toBe(echo);
      });

      it.each(['"', "'"])('does not collect a plus-prefixed quoted credential: %s', (quote) => {
        const source = { command: `inspect ${option}${quote}+al+ice:s3cret value${quote}` };
        const echo = 'echoed al+ice:s3cret value s3cret value';

        expect(sanitizeSensitiveTextWithKnownValues(echo, source)).toBe(echo);
        expect(sanitizeSensitiveTextWithKnownValues(echo, JSON.stringify(source))).toBe(echo);
      });

      it.each([
        ['alice:', 'alice:'], ['"alice:"', 'alice:'], ["'alice:'", 'alice:'], [':', ':'],
      ])(
        'collects the complete credential with an empty password: %s', (value, credential) => {
          const source = { command: `inspect ${option}${value} tail` };

          expect(sanitizeSensitiveTextWithKnownValues(`echoed ${credential} tail`, source))
            .toBe('echoed [REDACTED] tail');
          expect(sanitizeSensitiveTextWithKnownValues(`echoed ${credential} tail`, JSON.stringify(source)))
            .toBe('echoed [REDACTED] tail');
        },
      );

      it.each(['"', "'"])(
        'collects credentials without JSON quote boundaries: %s', (quote) => {
          const source = JSON.stringify({ command: `inspect ${option}${quote}alice:s3cretvalue${quote}` });

          expect(sanitizeSensitiveTextWithKnownValues('echoed alice:s3cretvalue s3cretvalue', source))
            .toBe('echoed [REDACTED] [REDACTED]');
        },
      );

      it.each([
        ['"al+ice:s3cretvalue"', 'al+ice:s3cretvalue', 's3cretvalue'],
        ['"alice:s3cretvalue tail"', 'alice:s3cretvalue tail', 's3cretvalue tail'],
        ['"al+ice:s3cret value"', 'al+ice:s3cret value', 's3cret value'],
      ])(
        'collects a JSON quoted credential and its complete password: %s', (value, credential, password) => {
          const source = JSON.stringify({ command: `inspect ${option}${value}` });
          const echo = `echoed ${credential} ${password}`;

          expect(sanitizeSensitiveTextWithKnownValues(echo, source)).toBe('echoed [REDACTED] [REDACTED]');
        },
      );
    },
  );

  it('redacts both the API token assignment and API key option', () => {
    const sanitized = sanitizeSensitiveText('api_token=abc123xyz --api-key=def456uvw');

    expect(sanitized).toBe('api_token=[REDACTED] --api-key=[REDACTED]');
    expect(sanitized).not.toContain('abc123xyz');
    expect(sanitized).not.toContain('def456uvw');
  });

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

  it('does not withhold an ordinary line when known sensitive values are tracked', () => {
    const redactor = createSensitiveTextStreamRedactor();

    expect(redactor.write('ready\n', { api_key: 'test-secret-label' })).toBe('ready\n');
  });

  it('keeps an unterminated PEM block pending when known sensitive values are tracked', () => {
    const redactor = createSensitiveTextStreamRedactor();
    const source = { api_key: 'test-secret-label' };

    const output = redactor.write('-----BEGIN PRIVATE KEY-----\n', source)
      + redactor.write('LEAK-ME', source)
      + redactor.flush(source);

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
});
