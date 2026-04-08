import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const targetDirs = ['src/__tests__', 'e2e/specs'];
const removedWorkflowTerm = ['p', 'i', 'e', 'c', 'e'].join('');
const removedStepTerm = ['m', 'o', 'v', 'e', 'm', 'e', 'n', 't'].join('');
const removedTerms = [
  removedWorkflowTerm,
  removedStepTerm,
  `${removedWorkflowTerm}s`,
  `${removedStepTerm}s`,
];
const removedTermsPattern = removedTerms.join('|');
const legacyPatternChecks = [
  {
    name: 'test titles',
    pattern: new RegExp(`\\b(?:it|describe)\\((['"\`])[^'"\\\`\\n]*\\b(?:${removedTermsPattern})\\b[^'"\\\`\\n]*\\1`, 'g'),
  },
  {
    name: 'comments',
    pattern: new RegExp(`^\\s*//.*\\b(?:${removedTermsPattern})\\b.*$`, 'gm'),
  },
  {
    name: 'helper variable names',
    pattern: new RegExp(`\\b(?:const|let)\\s+[A-Za-z0-9_]*(?:${removedTermsPattern})[A-Za-z0-9_]*\\b`, 'g'),
  },
  {
    name: 'fixture names',
    pattern: new RegExp(`name:\\s*(['"\`])[^'"\\\`\\n]*\\b(?:${removedTermsPattern})\\b[^'"\\\`\\n]*\\1`, 'g'),
  },
];

function collectTestFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
      continue;
    }
    if (entry.endsWith('.test.ts') || entry.endsWith('.e2e.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('test terminology guard', () => {
  it('keeps removed legacy terms out of test titles, comments, helper variables, and fixture names', () => {
    const files = targetDirs.flatMap((dir) => collectTestFiles(join(repositoryRoot, dir)));
    const violations: string[] = [];

    for (const file of files) {
      if (file.endsWith('test-terminology-guard.test.ts')) {
        continue;
      }

      const content = readFileSync(file, 'utf-8');

      for (const check of legacyPatternChecks) {
        const matches = content.match(check.pattern) ?? [];
        for (const match of matches) {
          violations.push(`${relative(repositoryRoot, file)} [${check.name}]: ${match.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
