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
    ['an @ at the start of the password', 'https://u:@pa55@host', 'https://[REDACTED]@host'],
    ['a password of @ only', 'https://u:@@host', 'https://[REDACTED]@host'],
    ['an empty user and an @ in the password', 'redis://:p@ss@host', 'redis://[REDACTED]@host'],
    ['an empty user and an @ at the start of the password', 'redis://:@pa55@host', 'redis://[REDACTED]@host'],
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

  it('redacts a password that starts with @ when streaming and where it is echoed later', () => {
    const text = 'clone https://alice:@pa55@host/repo.git failed';

    expect(sanitizeSensitiveText(text)).toBe('clone https://[REDACTED]@host/repo.git failed');
    expect(maskSensitiveRanges(text, sensitiveTextRanges(text, new Set()))).toBe('clone https://[REDACTED]@host/repo.git failed');
    expect(sanitizeSensitiveTextWithKnownValues('echoed @pa55', { command: text })).toBe('echoed [REDACTED]');
    expect(sanitizeSensitiveTextWithKnownValues('alice: ready', { command: text })).toBe('alice: ready');
    expect(sanitizeSensitiveTextWithKnownValues('{"k": "v"}', { command: 'redis://:@pa55@host' })).toBe('{"k": "v"}');
  });

  // Known limit of reading the password up to the last `@` of the authority: when `;` separates
  // a later address, the host is hidden too.
  it('hides the host when `;` separates a later address', () => {
    expect(sanitizeSensitiveText('url=https://u:p@db.internal;owner=ops@example.test'))
      .toBe('url=https://[REDACTED]@example.test');
  });

  it('redacts the whole value of a secret assignment that follows a URL after `;`', () => {
    const text = 'curl https://u:p@host;TOKEN=left@RIGHT_SECRET';
    const expected = 'curl https://[REDACTED]@host;TOKEN=[REDACTED]';

    expect(sanitizeSensitiveText(text)).toBe(expected);
    expect(sanitizeSensitiveText(text)).not.toContain('RIGHT_SECRET');
    expect(maskSensitiveRanges(text, sensitiveTextRanges(text, new Set()))).toBe(expected);
    expect(sanitizeSensitiveTextWithKnownValues('echoed left@RIGHT_SECRET', { command: text })).toBe('echoed [REDACTED]');
  });

  it.each([
    ['semicolon before TOKEN', 'curl https://u:p@host;TOKEN=left@RIGHT_SECRET', 'curl https://[REDACTED]@host;TOKEN=[REDACTED]'],
    ['comma before TOKEN', 'curl https://u:p@host,TOKEN=left@RIGHT_SECRET', 'curl https://[REDACTED]@host,TOKEN=[REDACTED]'],
    ['ampersand before TOKEN', 'curl https://u:p@host&TOKEN=left@RIGHT_SECRET', 'curl https://[REDACTED]@host&TOKEN=[REDACTED]'],
    ['pipe before TOKEN', 'curl https://u:p@host|TOKEN=left@RIGHT_SECRET', 'curl https://[REDACTED]@host|TOKEN=[REDACTED]'],
    ['single-quoted TOKEN after semicolon', "curl https://u:p@host;TOKEN='left@RIGHT_SECRET'", "curl https://[REDACTED]@host;TOKEN='[REDACTED]'"],
    ['double-quoted URL and TOKEN', 'curl "https://u:p@host;TOKEN=left@RIGHT_SECRET"', 'curl "https://[REDACTED]@host;TOKEN=[REDACTED]"'],
    ['no delimiter before TOKEN', 'curl https://u:p@hostTOKEN=left@RIGHT_SECRET', 'curl https://[REDACTED]@hostTOKEN=[REDACTED]'],
    ['second URL after semicolon before TOKEN', 'curl https://u:p@host;curl https://v:q@host2;TOKEN=left@RIGHT_SECRET', 'curl https://[REDACTED]@host;curl https://[REDACTED]@host2;TOKEN=[REDACTED]'],
    ['leading-@ password alone', 'curl https://u:@pa55@host', 'curl https://[REDACTED]@host'],
    ['leading-@ password followed by semicolon TOKEN', 'curl https://u:@pa55@host;TOKEN=left@RIGHT_SECRET', 'curl https://[REDACTED]@host;TOKEN=[REDACTED]'],
    ['double-quoted leading-@ password and TOKEN', 'curl "https://u:@pa55@host;TOKEN=left@RIGHT_SECRET"', 'curl "https://[REDACTED]@host;TOKEN=[REDACTED]"'],
    ['leading-@ password followed by comma TOKEN', 'curl https://u:@pa55@host,TOKEN=left@RIGHT_SECRET', 'curl https://[REDACTED]@host,TOKEN=[REDACTED]'],
  ])('redacts adversarial URL+assignment input (%s) without leaking credentials or hiding host/keys', (_name, text, expected) => {
    expect(sanitizeSensitiveText(text)).toBe(expected);
    expect(maskSensitiveRanges(text, sensitiveTextRanges(text, new Set()))).toBe(expected);
    expect(sanitizeSensitiveText(text)).not.toContain('RIGHT_SECRET');
    expect(sanitizeSensitiveText(text)).not.toContain('pa55');
  });

  it.each([
    ['assignment inside URL password (Codex P1)', 'https://alice:LEFT;token=RIGHT@host', 'https://[REDACTED]@host', ['LEFT', 'RIGHT']],
    ['uppercase assignment inside URL password (CodeRabbit Major)', 'https://alice:LEFT_SECRET;TOKEN=RIGHT_SECRET@host', 'https://[REDACTED]@host', ['LEFT_SECRET', 'RIGHT_SECRET']],
    ['assignment inside URL password followed by second assignment', 'https://alice:LEFT;token=RIGHT@host;TOKEN2=a@SECRET', 'https://[REDACTED]@host;TOKEN2=[REDACTED]', ['LEFT', 'RIGHT', 'SECRET']],
    ['URL followed immediately by @token=@SECRET', 'https://u:p@token=@SECRET/path', 'https://[REDACTED]@token=[REDACTED]', ['SECRET']],
    ['username matching a sensitive key name', 'https://token:SECRET@host', 'https://[REDACTED]@host', ['SECRET']],
    ['ambiguous leading-@ with trailing assignment merges union without leaking', 'https://alice:@LEFT;token=RIGHT@host', 'https://[REDACTED]', ['LEFT', 'RIGHT']],
    ['ambiguous empty-password URL with trailing assignment merges union without leaking', 'https://user:@host;TOKEN=left@RIGHT_SECRET', 'https://[REDACTED]', ['RIGHT_SECRET']],
  ])('handles overlapping URL and assignment ranges (%s)', (_name, text, expected, secrets) => {
    const sanitized = sanitizeSensitiveText(text);
    expect(sanitized).toBe(expected);
    expect(maskSensitiveRanges(text, sensitiveTextRanges(text, new Set()))).toBe(expected);
    for (const secret of secrets) {
      expect(sanitized).not.toContain(secret);
    }
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
    'https://user:@host,admin@example.test',
    '["https://user:@host","admin@example.test"]',
    '(https://user:@host)(admin@example.test)',
    'https://user:@host/admin@example.test',
    'https://user:@host admin@example.test',
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

  describe('property test against naive brute-force reference implementation', () => {
    interface RefRange {
      readonly start: number;
      readonly end: number;
    }

    const REF_KEY_CHAR = String.raw`[A-Za-z0-9_.-]`;
    const REF_KEY_WORD = String.raw`api[_-]?key|token|password|secret|credentials?|access[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key`;
    const REF_KEY = String.raw`(?=${REF_KEY_CHAR}*(?:${REF_KEY_WORD}))${REF_KEY_CHAR}+`;
    const REF_HEADER_KEY = String.raw`(?:proxy[_-]?)?authorization|(?:set[_-]?)?cookies?|session[_-]?id`;
    const REF_TEXT_KEY = String.raw`(?:${REF_KEY}|${REF_HEADER_KEY})`;
    const REF_BARE_KEY = String.raw`(?<!${REF_KEY_CHAR})(?:(?=(?:${REF_HEADER_KEY})\b)${REF_KEY_CHAR})*(?!(?:${REF_HEADER_KEY})\b)${REF_KEY}`;
    const REF_ASSIGN_KEY = String.raw`(?:["'](?:${REF_TEXT_KEY})["']|${REF_BARE_KEY})`;
    const REF_QUOTED_VAL = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
    const REF_JSON_QUOTED_VAL = String.raw`\\"(?:[^"\\]|\\{4}|\\{1,3}[^"\\]|\\{3}")*\\"`;
    const REF_QUOTED_ASSIGN = new RegExp(
      String.raw`(${REF_ASSIGN_KEY}\s*[:=]\s*)(${REF_JSON_QUOTED_VAL}|${REF_QUOTED_VAL})`,
      'gi',
    );
    const REF_BARE_ASSIGN = new RegExp(
      String.raw`(${REF_ASSIGN_KEY}\s*[:=]\s*["']?)(?!\\")([^"'[{,\s}\]]+)(["']?)`,
      'gi',
    );
    const REF_HEADER_BARE = new RegExp(
      String.raw`((?:${REF_HEADER_KEY})\s*=\s*["']?)([^"';,\s}\]]+)(["']?)`,
      'gi',
    );
    const REF_HEADER_COLON = new RegExp(
      String.raw`((?:session[_-]?id)\s*:\s*["']?)([^"';,\s}\]]+)(["']?)`,
      'gi',
    );
    const REF_OPTION = new RegExp(
      String.raw`((?<!-)--(?:${REF_KEY})(?:=|\s+))(${REF_QUOTED_VAL}|[^\s]+)`,
      'gi',
    );
    const REF_HTTP_HEADER_PREFIX = /\b(Authorization|(?:Set-)?Cookie)\s*:\s*/gi;
    const REF_CURL_VAL = [
      String.raw`(?<=\\")(?!\+)[^":]*:[^"]*?(?=\\")`,
      String.raw`"(?!\+)[^":]*:[^"]*"`,
      String.raw`'(?!\+)[^':]*:[^']*'`,
      String.raw`(?<!\\")(?![+"']|\\")[^\s:]*:[^\s]*`,
    ].join('|');
    const REF_CURL_EQ = new RegExp(
      String.raw`(\B--(?:proxy-)?user=)(?:\\")?(${REF_CURL_VAL})(?:\\")?`,
      'gi',
    );
    const REF_CURL_SPACE = new RegExp(
      String.raw`(\B(?:-u|--(?:proxy-)?user)\s+)(?:\\")?(${REF_CURL_VAL})(?:\\")?`,
      'gi',
    );
    const REF_CURL_COMPACT = new RegExp(
      String.raw`(^|\s)(-u)(?:\\")?(${REF_CURL_VAL})(?:\\")?`,
      'gi',
    );
    const REF_QUERY = /([?&](?:api[_-]?key|token|password|secret)=)([^&\s]+)/gi;
    const REF_KNOWN_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g;
    const REF_PEM = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g;
    const REF_TRAILING_PATTERNS: readonly RegExp[] = [
      REF_BARE_ASSIGN,
      REF_HEADER_BARE,
      REF_HEADER_COLON,
      REF_OPTION,
      REF_CURL_EQ,
      REF_HTTP_HEADER_PREFIX,
    ];

    function naiveContainingExclusion(index: number, exclusions: readonly RefRange[]): RefRange | undefined {
      let best: RefRange | undefined;
      for (const ex of exclusions) {
        if (ex.start <= index && index < ex.end) {
          if (best === undefined || ex.end > best.end) best = ex;
        }
      }
      return best;
    }

    function naiveScanOutside(text: string, pattern: RegExp, exclusions: readonly RefRange[]): RegExpExecArray[] {
      const re = new RegExp(pattern.source, pattern.flags);
      const out: RegExpExecArray[] = [];
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        const hit = naiveContainingExclusion(m.index, exclusions);
        if (hit !== undefined) {
          re.lastIndex = hit.end;
          continue;
        }
        out.push(m);
      }
      return out;
    }

    function naiveHttpHeaderEnd(text: string, start: number, shellQuote: "'" | '"' | '\\"' | undefined): number {
      let valueQuote: string | undefined;
      let prevNonSpace: string | undefined;
      let cursor = start;
      while (cursor < text.length) {
        const ch = text[cursor]!;
        if (ch === '\r' || ch === '\n') break;
        if (shellQuote === '\\"' && ch === '\\') {
          let slashEnd = cursor + 1;
          while (text[slashEnd] === '\\') slashEnd += 1;
          if (text[slashEnd] === '"' && (slashEnd - cursor) % 4 === 1) return slashEnd - 1;
          cursor = slashEnd;
          if (text[cursor] === '"') cursor += 1;
          continue;
        }
        if (ch === '\\' && shellQuote !== "'" && text[cursor + 1] !== '\r' && text[cursor + 1] !== '\n') {
          cursor = Math.min(cursor + 2, text.length);
          continue;
        }
        if (shellQuote !== undefined) {
          if (ch === shellQuote || (shellQuote === '\\"' && ch === '"')) break;
        } else if (valueQuote !== undefined) {
          if (ch === valueQuote) valueQuote = undefined;
        } else if (ch === '"' || ch === "'") {
          if (cursor !== start && prevNonSpace !== '=') break;
          valueQuote = ch;
        }
        if (ch !== ' ' && ch !== '\t') prevNonSpace = ch;
        cursor += 1;
      }
      return cursor;
    }

    function naiveUrlRanges(text: string, quotedExclusions: readonly RefRange[]): { ranges: RefRange[]; exclusions: RefRange[] } {
      const ranges: RefRange[] = [];
      const exclusions: RefRange[] = [];
      let pos = 0;
      while (pos < text.length) {
        const sep = text.indexOf('://', pos);
        if (sep < 0) break;
        const hit = naiveContainingExclusion(sep, quotedExclusions);
        if (hit !== undefined) {
          pos = hit.end;
          continue;
        }
        // Check scheme backwards: run of [0-9+.-] preceded by at least one ASCII letter.
        let s = sep - 1;
        while (s >= 0 && /[0-9+.-]/.test(text[s]!)) s -= 1;
        if (s < 0 || !/[A-Za-z]/.test(text[s]!)) {
          pos = sep + 3;
          continue;
        }
        const uStart = sep + 3;
        // Scan user up to first `:` before any of /?#\s@
        let colon = uStart;
        while (colon < text.length && !/[/?#\s@:]/.test(text[colon]!)) colon += 1;
        if (text[colon] !== ':') {
          pos = sep + 3;
          continue;
        }
        // Scan password and find all `@` positions in the authority
        let cursor = colon + 1;
        const atPositions: number[] = [];
        if (text[cursor] === '@') {
          atPositions.push(cursor);
          cursor += 1;
          while (cursor < text.length && !/[/?#\s"'`,<>()[\]{}]/.test(text[cursor]!)) {
            if (text[cursor] === '@') atPositions.push(cursor);
            cursor += 1;
          }
        } else {
          while (cursor < text.length && !/[/?#\s@]/.test(text[cursor]!)) cursor += 1;
          if (cursor > colon + 1 && text[cursor] === '@') {
            atPositions.push(cursor);
            cursor += 1;
            while (cursor < text.length && !/[/?#\s"'`,<>()[\]{}]/.test(text[cursor]!)) {
              if (text[cursor] === '@') atPositions.push(cursor);
              cursor += 1;
            }
          }
        }
        const validAts = atPositions.filter((at) => at >= colon + 2);
        if (validAts.length === 0) {
          pos = sep + 3;
          continue;
        }
        const firstValidAt = validAts[0]!;
        const rawEnd = validAts[validAts.length - 1]!;
        let uEnd = rawEnd;
        if (firstValidAt < rawEnd) {
          // Brute-force: scan the authority tail up to the trailing delimiter and find the earliest
          // trailing sensitive assignment starting in (firstValidAt, rawEnd).
          let segEnd = rawEnd + 1;
          while (segEnd < text.length && !/[/?#\s"'`,<>()[\]{}]/.test(text[segEnd]!)) segEnd += 1;
          const segment = text.slice(firstValidAt + 1, segEnd);
          let earliest = -1;
          for (const pat of REF_TRAILING_PATTERNS) {
            const re = new RegExp(pat.source, pat.flags);
            const m = re.exec(segment);
            if (m !== null && (earliest < 0 || m.index < earliest)) earliest = m.index;
          }
          if (earliest >= 0 && firstValidAt + 1 + earliest < rawEnd) {
            const boundary = firstValidAt + 1 + earliest;
            let trimmed = firstValidAt;
            for (const at of validAts) {
              if (at < boundary) trimmed = at;
            }
            uEnd = trimmed;
          }
        }
        ranges.push({ start: uStart, end: uEnd });
        exclusions.push(text[colon + 1] === '@' ? { start: uStart, end: colon + 1 } : { start: uStart, end: uEnd + 1 });
        pos = rawEnd + 1;
      }
      return { ranges, exclusions };
    }

    function naiveReferenceSanitize(text: string): string {
      if (!text) return text;
      const ranges: RefRange[] = [];
      const quotedExclusions: RefRange[] = [];
      for (const m of text.matchAll(REF_QUOTED_ASSIGN)) {
        const quoteWidth = m[2]!.startsWith('\\"') ? 2 : 1;
        ranges.push({ start: m.index + m[1]!.length + quoteWidth, end: m.index + m[0].length - quoteWidth });
        quotedExclusions.push({ start: m.index, end: m.index + m[0].length });
      }
      const urls = naiveUrlRanges(text, quotedExclusions);
      for (const r of urls.ranges) ranges.push(r);
      const exclusions = [...quotedExclusions, ...urls.exclusions];

      for (const pat of [REF_BARE_ASSIGN, REF_HEADER_BARE, REF_HEADER_COLON, REF_OPTION, REF_QUERY]) {
        for (const m of naiveScanOutside(text, pat, exclusions)) {
          const start = m.index + m[1]!.length;
          ranges.push({ start, end: start + m[2]!.length });
        }
      }
      // HTTP headers
      const headers = new RegExp(REF_HTTP_HEADER_PREFIX.source, REF_HTTP_HEADER_PREFIX.flags);
      const authScheme = /([A-Za-z]+)[ \t]+/y;
      for (let m = headers.exec(text); m !== null; m = headers.exec(text)) {
        const hit = naiveContainingExclusion(m.index, exclusions);
        if (hit !== undefined) {
          headers.lastIndex = hit.end;
          continue;
        }
        const start = headers.lastIndex;
        authScheme.lastIndex = start;
        const scheme = m[1]!.toLowerCase() === 'authorization' ? authScheme.exec(text) : null;
        const credentialStart = scheme === null ? start : authScheme.lastIndex;
        const enclosingQuote = text[m.index - 1];
        const shellQuote = enclosingQuote === '"' && text[m.index - 2] === '\\'
          ? '\\"'
          : enclosingQuote === '"' || enclosingQuote === "'" ? enclosingQuote : undefined;
        const end = naiveHttpHeaderEnd(text, credentialStart, shellQuote);
        if (end > start) ranges.push({ start: credentialStart, end });
        headers.lastIndex = end;
      }
      for (const pat of [REF_CURL_EQ, REF_CURL_SPACE]) {
        for (const m of naiveScanOutside(text, pat, exclusions)) {
          ranges.push({ start: m.index + m[1]!.length, end: m.index + m[0].length });
        }
      }
      for (const m of naiveScanOutside(text, REF_CURL_COMPACT, exclusions)) {
        ranges.push({ start: m.index + m[1]!.length + m[2]!.length, end: m.index + m[0].length });
      }
      for (const pat of [REF_KNOWN_TOKEN, REF_PEM]) {
        for (const m of text.matchAll(pat)) {
          ranges.push({ start: m.index, end: m.index + m[0].length });
        }
      }

      // Brute-force character-level union merge and single-pass replacement.
      const masked = new Array<boolean>(text.length).fill(false);
      for (const { start, end } of ranges) {
        for (let i = Math.max(0, start); i < Math.min(text.length, end); i += 1) {
          masked[i] = true;
        }
      }
      let out = '';
      for (let i = 0; i < text.length;) {
        if (!masked[i]) {
          out += text[i]!;
          i += 1;
        } else {
          while (i < text.length && masked[i]) i += 1;
          out += '[REDACTED]';
        }
      }
      return out;
    }

    function createPrng(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function minimizeCounterexample(input: string, predicate: (candidate: string) => boolean): string {
      let current = input;
      // Coarse chunk removal, then single-character deletion until fixed point.
      for (let step = Math.max(1, Math.floor(current.length / 2)); step >= 1; step = Math.floor(step / 2)) {
        let changed = true;
        while (changed) {
          changed = false;
          for (let i = 0; i + step <= current.length; i += 1) {
            const candidate = current.slice(0, i) + current.slice(i + step);
            if (predicate(candidate)) {
              current = candidate;
              changed = true;
              break;
            }
          }
        }
      }
      return current;
    }

    it('matches the naive brute-force reference implementation across 1,000 seeded random inputs and all adversarial cases', () => {
      const rand = createPrng(0x2103c0de);
      const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;

      const schemes = ['https://', 'http://', 'redis://', 'git+https://', '1-http://', '_http://', 'a://', '://', '1://'];
      const users = ['', 'u', 'alice', 'token', 'a'];
      const passwords = [
        '', 'p', 'LEFT', 'pa55', '@pa55', '@', 'p@ss', 'p@@s', 'a:b',
        'LEFT;token=RIGHT', 'LEFT&token=RIGHT', 'sk-1234567890',
      ];
      const hosts = ['host', 'host2', 'db.internal', 'hostTOKEN', 'example.test', 'admin@example.test', 'token'];
      const separators = ['', ';', ',', '&', '|', ' ', "'", '"', '\\"', '/', '?', '#', '(', ')', '[', ']'];
      const fragments = [
        'curl ',
        'TOKEN=left@RIGHT_SECRET',
        'token=RIGHT',
        "TOKEN='left@RIGHT_SECRET'",
        'TOKEN="left@RIGHT_SECRET"',
        'TOKEN=\\"left@RIGHT_SECRET\\"',
        'password=sec@val',
        'api_key:val@end',
        'session_id=sid@end',
        'session_id:sid@end',
        'cookie=ck@end',
        'owner=ops@example.test',
        '--token=opt@sec',
        '--user=u:p@c',
        '-u a:b',
        'Authorization: Bearer tok@sec',
        'Cookie: a=b',
        'sk-1234567890',
        '@',
        '@@',
        '@@@',
        '@a@b@',
        'tail',
      ];

      const makeUrl = (): string => `${pick(schemes)}${pick(users)}:${pick(passwords)}@${pick(hosts)}`;
      const inputs: string[] = [
        'curl https://u:p@host;TOKEN=left@RIGHT_SECRET',
        'curl https://u:p@host,TOKEN=left@RIGHT_SECRET',
        'curl https://u:p@host&TOKEN=left@RIGHT_SECRET',
        'curl https://u:p@host|TOKEN=left@RIGHT_SECRET',
        "curl https://u:p@host;TOKEN='left@RIGHT_SECRET'",
        'curl "https://u:p@host;TOKEN=left@RIGHT_SECRET"',
        'curl https://u:p@hostTOKEN=left@RIGHT_SECRET',
        'curl https://u:p@host;curl https://v:q@host2;TOKEN=left@RIGHT_SECRET',
        'curl https://u:@pa55@host',
        'curl https://u:@pa55@host;TOKEN=left@RIGHT_SECRET',
        'curl "https://u:@pa55@host;TOKEN=left@RIGHT_SECRET"',
        'curl https://u:@pa55@host,TOKEN=left@RIGHT_SECRET',
        'https://alice:LEFT;token=RIGHT@host',
        'https://alice:LEFT_SECRET;TOKEN=RIGHT_SECRET@host',
        'https://alice:LEFT;token=RIGHT@host;TOKEN2=a@SECRET',
        'https://u:p@token=@SECRET/path',
        'https://user:@host;TOKEN=left@RIGHT_SECRET',
        'https://alice:@LEFT;token=RIGHT@host',
      ];

      for (let i = 0; i < 1_000; i += 1) {
        const partCount = 1 + Math.floor(rand() * 6);
        let built = '';
        for (let p = 0; p < partCount; p += 1) {
          if (p > 0) built += pick(separators);
          built += rand() < 0.45 ? makeUrl() : pick(fragments);
        }
        // Randomly wrap or affix quotes / `@` runs to stress boundary interactions.
        if (rand() < 0.2) built = '"' + built + '"';
        if (rand() < 0.15) built = "'" + built + "'";
        if (rand() < 0.2) built += pick(['@', '@@', '@end', ';TOKEN=a@b']);
        inputs.push(built);
      }

      for (const input of inputs) {
        const actual = sanitizeSensitiveText(input);
        const expected = naiveReferenceSanitize(input);
        const ranged = maskSensitiveRanges(input, sensitiveTextRanges(input, new Set()));
        if (actual !== expected || actual !== ranged) {
          const minimized = minimizeCounterexample(
            input,
            (candidate) => sanitizeSensitiveText(candidate) !== naiveReferenceSanitize(candidate)
              || sanitizeSensitiveText(candidate) !== maskSensitiveRanges(candidate, sensitiveTextRanges(candidate, new Set())),
          );
          throw new Error([
            'Property test mismatch between sanitizeSensitiveText and naive reference implementation.',
            `Original input   : ${JSON.stringify(input)}`,
            `Minimized input  : ${JSON.stringify(minimized)}`,
            `Actual output    : ${JSON.stringify(sanitizeSensitiveText(minimized))}`,
            `Reference output : ${JSON.stringify(naiveReferenceSanitize(minimized))}`,
            `Ranges output    : ${JSON.stringify(maskSensitiveRanges(minimized, sensitiveTextRanges(minimized, new Set())))}`,
          ].join('\n'));
        }
      }
    });
  });
});
