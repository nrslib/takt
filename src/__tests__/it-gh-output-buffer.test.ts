import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listOpenPrs } from '../infra/github/pr.js';

describe('GitHub CLI output buffer', () => {
  it.skipIf(process.platform === 'win32')('実子プロセスの1MB超PR一覧を終端まで読み取る', () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-gh-buffer-'));
    const originalPath = process.env.PATH;
    const originalResponse = process.env.TAKT_GH_TEST_RESPONSE;
    try {
      const responseFile = join(directory, 'response.json');
      const items = Array.from({ length: 100 }, (_, index) => ({
        number: index + 1, state: 'open', user: { login: 'alice' }, body: 'x'.repeat(20_000),
        labels: [], draft: false, base: { ref: 'main', repo: { full_name: 'org/repo' } },
        head: { ref: `feature/${index + 1}`, repo: { full_name: 'org/repo' } },
        updated_at: '2026-10-08T00:00:00Z',
      }));
      const response = `HTTP/2 200 OK\n\n${JSON.stringify(items)}`;
      expect(Buffer.byteLength(response)).toBeGreaterThan(1024 * 1024);
      writeFileSync(responseFile, response);
      const fakeGh = join(directory, 'gh');
      writeFileSync(fakeGh, `#!/usr/bin/env node
if (process.argv[2] === 'repo') {
  process.stdout.write(JSON.stringify({ nameWithOwner: 'org/repo' }));
} else {
  process.stdout.write(require('node:fs').readFileSync(process.env.TAKT_GH_TEST_RESPONSE));
}
`);
      chmodSync(fakeGh, 0o755);
      process.env.PATH = `${directory}${delimiter}${originalPath}`;
      process.env.TAKT_GH_TEST_RESPONSE = responseFile;
      const prs = listOpenPrs(directory);
      expect(prs.map((pr) => pr.number)).toEqual(items.map((pr) => pr.number));
    } finally {
      process.env.PATH = originalPath;
      if (originalResponse === undefined) delete process.env.TAKT_GH_TEST_RESPONSE;
      else process.env.TAKT_GH_TEST_RESPONSE = originalResponse;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
