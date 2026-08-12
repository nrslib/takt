import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskReviewScope } from '../core/workflow/review-scope.js';
import { isSensitiveProjectFilePath } from '../shared/utils/sensitive-file-path.js';
import {
  collectReviewCompletionEvidence,
  reviewCompletionClaimedPaths,
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

  it.each([
    ['client-secret.json', true],
    ['github-token.json', true],
    ['config/production-secrets.yaml', true],
    ['prod-secrets.txt', true],
    ['service_account.toml', true],
    ['credentials.ini', true],
    ['authorization.config', true],
    ['secrets', true],
    ['client-secret', true],
    ['github_secrets', true],
    ['auth', false],
    ['token', false],
    ['token-bucket', false],
    ['src/client-secret.ts', false],
    ['src/github-token.ts', false],
    ['src/prod-secrets.ts', false],
    ['src/service_account.ts', false],
    ['src/token-bucket.ts', false],
    ['src/auth/middleware.ts', false],
    ['src/authorization-policy.ts', false],
    ['src/secretary.ts', false],
  ] as const)('classifies purpose-boundary path %s as sensitive=%s', (path, expected) => {
    expect(isSensitiveProjectFilePath(path)).toBe(expected);
  });

  it('provides sanitized source while excluding sensitive, symlink, binary, and outside paths', () => {
    const cwd = createDirectory('takt-review-completion-evidence-');
    const outside = createDirectory('takt-review-completion-outside-');
    mkdirSync(join(cwd, 'src'));
    mkdirSync(join(cwd, 'src', 'auth'));
    mkdirSync(join(cwd, 'config'));
    writeFileSync(join(cwd, 'src', 'auth', 'middleware.ts'), 'export const middleware = 1;\n');
    writeFileSync(join(cwd, 'src', 'authorization-policy.ts'), 'export const policy = 1;\n');
    writeFileSync(join(cwd, 'src', 'safe.ts'), 'const api_key = "visible-secret";\nexport const value = 1;\n');
    writeFileSync(join(cwd, 'src', 'secretary.ts'), 'export const office = 1;\n');
    writeFileSync(join(cwd, 'src', 'token-bucket.ts'), 'export const bucket = 1;\n');
    writeFileSync(join(cwd, '.env'), 'TOKEN=must-not-leak\n');
    writeFileSync(join(cwd, 'client-secret'), 'client-secret-extensionless-marker\n');
    writeFileSync(join(cwd, 'config', 'production-secrets.yaml'), 'token: production-secret\n');
    writeFileSync(join(cwd, 'client-secret.json'), '{"value":"client-secret-marker"}\n');
    writeFileSync(join(cwd, 'credentials.json'), '{"opaque":"credential-file-marker"}\n');
    writeFileSync(join(cwd, 'github-token.json'), '{"value":"github-token-marker"}\n');
    writeFileSync(join(cwd, 'github_secrets'), 'github-secrets-extensionless-marker\n');
    writeFileSync(join(cwd, 'prod-secrets.txt'), 'prod-secret-marker\n');
    writeFileSync(join(cwd, 'secrets.txt'), 'opaque-secret-file-marker\n');
    writeFileSync(join(cwd, 'service-account.json'), '{"private_key":"service-account-marker"}\n');
    writeFileSync(join(cwd, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(outside, 'outside.ts'), 'outside-marker');
    symlinkSync(join(outside, 'outside.ts'), join(cwd, 'linked.ts'));

    const evidence = collectReviewCompletionEvidence({
      cwd,
      reviewScope: scope([
        '.env',
        '../outside.ts',
        'binary.dat',
        'client-secret',
        'client-secret.json',
        'config/production-secrets.yaml',
        'credentials.json',
        'github-token.json',
        'github_secrets',
        'linked.ts',
        'prod-secrets.txt',
        'secrets.txt',
        'service-account.json',
        'src/auth/middleware.ts',
        'src/authorization-policy.ts',
        'src/safe.ts',
        'src/secretary.ts',
        'src/token-bucket.ts',
      ]),
    });

    expect(evidence.status).toBe('collected');
    expect(evidence.files).toEqual([
      {
        path: 'src/auth/middleware.ts',
        content: 'export const middleware = 1;\n',
        truncated: false,
      },
      {
        path: 'src/authorization-policy.ts',
        content: 'export const policy = 1;\n',
        truncated: false,
      },
      {
        path: 'src/safe.ts',
        content: 'const api_key = "[REDACTED]";\nexport const value = 1;\n',
        truncated: false,
      },
      {
        path: 'src/secretary.ts',
        content: 'export const office = 1;\n',
        truncated: false,
      },
      {
        path: 'src/token-bucket.ts',
        content: 'export const bucket = 1;\n',
        truncated: false,
      },
    ]);
    expect(JSON.stringify(evidence))
      .not.toMatch(/visible-secret|must-not-leak|client-secret-extensionless-marker|client-secret-marker|production-secret|credential-file-marker|github-token-marker|github-secrets-extensionless-marker|prod-secret-marker|opaque-secret-file-marker|service-account-marker|outside-marker/);
    expect(Object.fromEntries(evidence.omissions.map(({ reason, count }) => [reason, count])))
      .toMatchObject({
        binary_file: 1,
        file_unavailable: 2,
        sensitive_path: 10,
      });
  });

  it('includes a deleted source file in diff evidence without requiring a source body', () => {
    const cwd = createDirectory('takt-review-completion-deleted-evidence-');
    execFileSync('git', ['init'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd });
    writeFileSync(join(cwd, 'removed.ts'), 'export const removed = true;\n');
    execFileSync('git', ['add', 'removed.ts'], { cwd });
    execFileSync('git', ['commit', '-m', 'base'], { cwd });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    rmSync(join(cwd, 'removed.ts'));

    const evidence = collectReviewCompletionEvidence({
      cwd,
      reviewScope: {
        kind: 'collected',
        paths: ['removed.ts'],
        source: { kind: 'working_tree', baseRange: { kind: 'branch_base', baseCommit } },
      },
    });

    expect(evidence.files).toEqual([]);
    expect(evidence.diff).toMatch(/-export const removed = true;/);
    expect(evidence.omissions).toContainEqual({ reason: 'file_unavailable', count: 1 });
  });

  it('admits structured claimed consumers as path-only metadata after validation', () => {
    const cwd = createDirectory('takt-review-completion-claimed-evidence-');
    execFileSync('git', ['init'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd });
    writeFileSync(join(cwd, 'changed.ts'), 'export const changed = 1;\n');
    writeFileSync(join(cwd, 'consumer.ts'), 'export const consumer = true;\n');
    writeFileSync(join(cwd, 'secrets.txt'), 'opaque-secret-marker\n');
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-m', 'base'], { cwd });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    writeFileSync(join(cwd, 'changed.ts'), 'export const changed = 2;\n');
    const claimedPaths = reviewCompletionClaimedPaths({
      rawFindings: [{
        candidate: {
          target: { kind: 'code', paths: ['consumer.ts', 'secrets.txt', '../outside.ts'] },
          evidenceRequests: [{ kind: 'file_quote', path: 'consumer.ts' }],
        },
      }],
    });

    const evidence = collectReviewCompletionEvidence({
      cwd,
      reviewScope: {
        kind: 'collected',
        paths: ['changed.ts'],
        source: { kind: 'working_tree', baseRange: { kind: 'branch_base', baseCommit } },
      },
      claimedPaths,
    });

    expect(evidence.files.map(({ path }) => path)).toEqual(['changed.ts']);
    expect(evidence.claimedPaths).toEqual(['consumer.ts']);
    expect(JSON.stringify(evidence)).not.toContain('opaque-secret-marker');
    expect(evidence.omissions).toEqual(expect.arrayContaining([
      { reason: 'claimed_path_unverified', count: 1 },
      { reason: 'sensitive_path', count: 1 },
    ]));
  });

  it('discovers tracked unchanged consumers without exporting their source bodies', () => {
    const cwd = createDirectory('takt-review-completion-reference-evidence-');
    const outside = createDirectory('takt-review-completion-reference-outside-');
    execFileSync('git', ['init'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd });
    writeFileSync(join(cwd, 'changed.ts'), 'export const stableContract = 1;\n');
    writeFileSync(
      join(cwd, 'consumer.ts'),
      'import { stableContract } from "./changed.js";\nconst unchangedBodyMarker = stableContract;\n',
    );
    writeFileSync(join(cwd, '.env.ts'), 'const secretConsumer = stableContract;\n');
    writeFileSync(join(cwd, 'binary.ts'), Buffer.from('stableContract\0binary-body-marker'));
    mkdirSync(join(cwd, 'config'));
    writeFileSync(
      join(cwd, 'config', 'production-secrets.yaml'),
      'stableContract: production-secret-reference\n',
    );
    writeFileSync(join(cwd, 'prod-secrets.json'), '{"value":"stableContractProdSecret"}\n');
    writeFileSync(join(cwd, 'service_account.toml'), 'value = "stableContractServiceAccount"\n');
    writeFileSync(join(cwd, 'client-secret.json'), '{"value":"stableContractClientSecret"}\n');
    writeFileSync(join(cwd, 'client-secret'), 'stableContractClientSecretExtensionless\n');
    writeFileSync(join(cwd, 'github-token.json'), '{"value":"stableContractGithubToken"}\n');
    writeFileSync(join(cwd, 'github_secrets'), 'stableContractGithubSecretsExtensionless\n');
    mkdirSync(join(cwd, 'auth'));
    writeFileSync(join(cwd, 'auth', 'middleware.ts'), 'const middleware = stableContract;\n');
    writeFileSync(join(cwd, 'authorization-policy.ts'), 'const policy = stableContract;\n');
    writeFileSync(join(cwd, 'secretary.ts'), 'const secretary = stableContract;\n');
    writeFileSync(join(cwd, 'token-bucket.ts'), 'const bucket = stableContract;\n');
    writeFileSync(join(outside, 'outside.ts'), 'const outsideConsumer = stableContract;\n');
    symlinkSync(join(outside, 'outside.ts'), join(cwd, 'linked.ts'));
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['commit', '-m', 'base'], { cwd });
    writeFileSync(join(cwd, 'untracked.ts'), 'const untrackedConsumer = stableContract;\n');
    writeFileSync(join(cwd, 'changed.ts'), 'export const stableContract = 2;\n');

    const evidence = collectReviewCompletionEvidence({
      cwd,
      reviewScope: {
        kind: 'collected',
        paths: ['changed.ts'],
        source: { kind: 'working_tree', baseRange: { kind: 'base_branch_head' } },
      },
    });

    expect(evidence.references).toEqual([
      {
        path: 'auth/middleware.ts',
        line: 1,
        relationKind: 'declaration',
        seed: 'stableContract',
      },
      {
        path: 'authorization-policy.ts',
        line: 1,
        relationKind: 'declaration',
        seed: 'stableContract',
      },
      {
        path: 'consumer.ts',
        line: 1,
        relationKind: 'module_name',
        seed: 'changed',
      },
      {
        path: 'secretary.ts',
        line: 1,
        relationKind: 'declaration',
        seed: 'stableContract',
      },
      {
        path: 'token-bucket.ts',
        line: 1,
        relationKind: 'declaration',
        seed: 'stableContract',
      },
    ]);
    expect(evidence.references.map(({ path }) => path)).not.toEqual(expect.arrayContaining([
      '.env.ts',
      'binary.ts',
      'client-secret',
      'client-secret.json',
      'config/production-secrets.yaml',
      'github-token.json',
      'github_secrets',
      'linked.ts',
      'prod-secrets.json',
      'service_account.toml',
      'untracked.ts',
    ]));
    expect(JSON.stringify(evidence)).not.toMatch(
      /unchangedBodyMarker|secretConsumer|binary-body-marker|stableContractClientSecret|stableContractClientSecretExtensionless|production-secret-reference|stableContractGithubToken|stableContractGithubSecretsExtensionless|stableContractProdSecret|stableContractServiceAccount|outsideConsumer|untrackedConsumer/,
    );
    expect(evidence.omissions).toEqual(expect.arrayContaining([
      { reason: 'reference_binary_file', count: 1 },
      { reason: 'reference_file_unavailable', count: 1 },
    ]));
  });

  it('includes commits after a materialized PR head in local diff evidence', () => {
    const cwd = createDirectory('takt-review-completion-pr-local-evidence-');
    execFileSync('git', ['init'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd });
    writeFileSync(join(cwd, 'source.ts'), 'export const version = 0;\n');
    execFileSync('git', ['add', 'source.ts'], { cwd });
    execFileSync('git', ['commit', '-m', 'base'], { cwd });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    writeFileSync(join(cwd, 'source.ts'), 'export const version = 1;\n');
    execFileSync('git', ['commit', '-am', 'pull request head'], { cwd });
    const pullRequestHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(cwd, 'source.ts'), 'export const version = 2;\n');
    execFileSync('git', ['commit', '-am', 'local follow-up'], { cwd });

    const evidence = collectReviewCompletionEvidence({
      cwd,
      reviewScope: {
        kind: 'collected',
        paths: ['source.ts'],
        source: {
          kind: 'pull_request',
          prNumber: 1,
          diffRange: { baseDiffRef: baseCommit, headDiffRef: pullRequestHead },
          includesWorkingTree: true,
          baseRange: { kind: 'branch_base', baseCommit },
        },
      },
    });

    expect(evidence.files).toEqual([{
      path: 'source.ts',
      content: 'export const version = 2;\n',
      truncated: false,
    }]);
    expect(evidence.diff).toMatch(/\+export const version = 1;/);
    expect(evidence.diff).toMatch(/\+export const version = 2;/);
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
