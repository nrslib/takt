import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { findDeprecatedTerms } from '../../test/helpers/deprecated-terminology.js';

const repositoryRoot = process.cwd();
const scanFileSuffixes = ['.ts', '.json', '.sh', '.yaml', '.yml'];
const skipRelativePaths = new Set(['src/__tests__/test-terminology-guard.test.ts']);
const requiredUntrackedGuardPaths = [
  'test/helpers/deprecated-terminology.ts',
  'test/helpers/unknown-contract-test-keys.ts',
];

function shouldScanFile(relativePath: string): boolean {
  if (skipRelativePaths.has(relativePath)) {
    return false;
  }

  if (basename(relativePath).startsWith('CHANGELOG')) {
    return false;
  }

  return scanFileSuffixes.some((suffix) => relativePath.endsWith(suffix));
}

function collectTrackedRepositoryFiles(): string[] {
  const trackedPaths = execFileSync('git', ['ls-files', '--cached', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf-8',
  });

  return trackedPaths
    .split('\0')
    .filter((relativePath) => relativePath.length > 0)
    .filter(shouldScanFile)
    .filter((relativePath) => existsSync(join(repositoryRoot, relativePath)))
    .map((relativePath) => join(repositoryRoot, relativePath));
}

function resolveRequiredRepositoryFile(relativePath: string): string {
  const absolutePath = join(repositoryRoot, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Required terminology guard target does not exist: ${relativePath}`);
  }
  return absolutePath;
}

function collectTerminologyGuardTargets(): string[] {
  return Array.from(
    new Set([
      ...collectTrackedRepositoryFiles(),
      ...requiredUntrackedGuardPaths.map(resolveRequiredRepositoryFile),
    ]),
  ).sort();
}

function collectDeprecatedTermViolations(files: string[]): string[] {
  const violations: string[] = [];

  for (const file of files) {
    const relativePath = relative(repositoryRoot, file);

    for (const match of findDeprecatedTerms(relativePath)) {
      violations.push(`${relativePath}:path:${match}`);
    }

    const content = readFileSync(file, 'utf-8').split(repositoryRoot).join('');
    for (const match of findDeprecatedTerms(content)) {
      violations.push(`${relativePath}:content:${match}`);
    }
  }

  return violations;
}

describe('test terminology guard', () => {
  it('includes changed builtin workflow assets in the recursive guard scope', () => {
    const files = collectTerminologyGuardTargets().map((file) => relative(repositoryRoot, file));

    expect(files).toContain('builtins/en/workflows/default.yaml');
  });

  it('includes tracked helper, source, and hidden-directory files covered by the repository-wide terminology contract', () => {
    const files = collectTerminologyGuardTargets().map((file) => relative(repositoryRoot, file));

    expect(files).toContain('test/helpers/deprecated-terminology.ts');
    expect(files).toContain('test/helpers/unknown-contract-test-keys.ts');
    expect(files).toContain('src/core/models/config-schemas.ts');
    expect(files).toContain('src/infra/config/configNormalizers.ts');
    expect(files).toContain('src/infra/config/traced/tracedConfigLoader.ts');
    expect(files).toContain('.github/workflows/ci.yml');
    expect(files).toContain('.devcontainer/devcontainer.json');
    expect(files).toContain('package.json');
  });

  it('does not expand the guard scope to arbitrary untracked files in the worktree', () => {
    const relativeTempFile = 'tmp-terminology-guard-untracked.md';
    const absoluteTempFile = join(repositoryRoot, relativeTempFile);
    writeFileSync(absoluteTempFile, 'temporary file for terminology guard scope test');

    try {
      const files = collectTerminologyGuardTargets().map((file) => relative(repositoryRoot, file));
      expect(files).not.toContain(relativeTempFile);
    } finally {
      rmSync(absoluteTempFile, { force: true });
    }
  });

  it('keeps deprecated terminology out of file paths and contents across non-documentation assets', () => {
    const files = collectTerminologyGuardTargets();
    const violations = collectDeprecatedTermViolations(files);

    expect(violations).toEqual([]);
  });
});
