import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskReviewScope } from '../core/workflow/review-scope.js';
import {
  collectReviewCompletionEvidence,
  REVIEW_COMPLETION_EVIDENCE_MAX_FILE_BYTES,
  REVIEW_COMPLETION_EVIDENCE_MAX_TOTAL_BYTES,
} from '../core/workflow/review-completion-evidence.js';

function scope(paths: readonly string[]): TaskReviewScope {
  return {
    kind: 'collected',
    paths,
    source: { kind: 'working_tree', baseRange: { kind: 'no_commits' } },
  };
}

describe('review completion evidence', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function createDirectory(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  }

  it('provides sanitized source while excluding sensitive, symlink, binary, and outside paths', () => {
    const cwd = createDirectory('takt-review-completion-evidence-');
    const outside = createDirectory('takt-review-completion-outside-');
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'safe.ts'), 'const api_key = "visible-secret";\nexport const value = 1;\n');
    writeFileSync(join(cwd, '.env'), 'TOKEN=must-not-leak\n');
    writeFileSync(join(cwd, 'credentials.json'), '{"opaque":"credential-file-marker"}\n');
    writeFileSync(join(cwd, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(outside, 'outside.ts'), 'outside-marker');
    symlinkSync(join(outside, 'outside.ts'), join(cwd, 'linked.ts'));

    const evidence = collectReviewCompletionEvidence({
      cwd,
      reviewScope: scope([
        '.env',
        '../outside.ts',
        'binary.dat',
        'credentials.json',
        'linked.ts',
        'src/safe.ts',
      ]),
    });

    expect(evidence.status).toBe('collected');
    expect(evidence.files).toEqual([{
      path: 'src/safe.ts',
      content: 'const api_key = "[REDACTED]";\nexport const value = 1;\n',
      truncated: false,
    }]);
    expect(JSON.stringify(evidence))
      .not.toMatch(/visible-secret|must-not-leak|credential-file-marker|outside-marker/);
    expect(Object.fromEntries(evidence.omissions.map(({ reason, count }) => [reason, count])))
      .toMatchObject({
        binary_file: 1,
        file_unavailable: 2,
        sensitive_path: 2,
      });
  });

  it('enforces per-file and serialized evidence limits', () => {
    const cwd = createDirectory('takt-review-completion-limits-');
    const paths: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const path = `source-${index}.ts`;
      paths.push(path);
      writeFileSync(join(cwd, path), 'x'.repeat(REVIEW_COMPLETION_EVIDENCE_MAX_FILE_BYTES));
    }
    writeFileSync(
      join(cwd, 'oversized.ts'),
      'y'.repeat(REVIEW_COMPLETION_EVIDENCE_MAX_FILE_BYTES + 1),
    );

    const evidence = collectReviewCompletionEvidence({
      cwd,
      reviewScope: scope([...paths, 'oversized.ts']),
    });

    expect(Buffer.byteLength(JSON.stringify(evidence), 'utf8'))
      .toBeLessThanOrEqual(REVIEW_COMPLETION_EVIDENCE_MAX_TOTAL_BYTES);
    expect(evidence.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'file_size_limit', count: 1 }),
      expect.objectContaining({ reason: 'total_size_limit' }),
    ]));
  });

  it('omits a git diff that exceeds its collection bound and reports the coverage gap', () => {
    const cwd = createDirectory('takt-review-completion-diff-limit-');
    execFileSync('git', ['init'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd });
    const paths: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const path = `changed-${index}.ts`;
      paths.push(path);
      writeFileSync(join(cwd, path), `export const before${index} = "${'a'.repeat(30_000)}";\n`);
    }
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-m', 'base'], { cwd });
    for (let index = 0; index < paths.length; index += 1) {
      writeFileSync(join(cwd, paths[index]!), `export const after${index} = "${'b'.repeat(30_000)}";\n`);
    }

    const evidence = collectReviewCompletionEvidence({
      cwd,
      reviewScope: {
        kind: 'collected',
        paths,
        source: { kind: 'working_tree', baseRange: { kind: 'base_branch_head' } },
      },
    });

    expect(evidence.diff).toBeUndefined();
    expect(evidence.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'diff_unavailable', count: 1 }),
    ]));
  });
});
