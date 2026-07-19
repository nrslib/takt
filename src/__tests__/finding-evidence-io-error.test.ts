import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const failingPath = vi.hoisted(() => ({
  suffix: '',
  beforeOpen: undefined as (() => void) | undefined,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    openSync(...args: Parameters<typeof actual.openSync>) {
      const beforeOpen = failingPath.beforeOpen;
      failingPath.beforeOpen = undefined;
      beforeOpen?.();
      return actual.openSync(...args);
    },
    readFileSync(...args: Parameters<typeof actual.readFileSync>) {
      if (failingPath.suffix.length > 0 && typeof args[0] === 'number') {
        throw Object.assign(new Error('injected read failure'), { code: 'EIO' });
      }
      return actual.readFileSync(...args);
    },
  };
});

import { verifySourceQuoteEvidence } from '../core/workflow/findings/admission-validation.js';

describe('source quote filesystem failures', () => {
  let cwd: string;

  afterEach(() => {
    failingPath.suffix = '';
    failingPath.beforeOpen = undefined;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('EIO を quote-mismatch に変換せず unverifiable として返す', () => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-evidence-eio-'));
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'a.ts'), 'const value = 1;\n');
    failingPath.suffix = join('src', 'a.ts');

    expect(verifySourceQuoteEvidence(cwd, {
      kind: 'source_quote',
      path: 'src/a.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'const value = 1;',
      snapshotId: 'snapshot',
    }, 'snapshot')).toMatchObject({
      outcome: 'unverifiable',
      reason: expect.stringContaining('injected read failure'),
    });
  });

  it('検査後の祖先差し替えでは外部ファイルを読まず unverifiable にする', () => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-evidence-swap-'));
    const sourceDir = join(cwd, 'src');
    const movedSourceDir = join(cwd, 'original-src');
    const outsideDir = join(cwd, 'outside');
    mkdirSync(sourceDir);
    mkdirSync(outsideDir);
    writeFileSync(join(sourceDir, 'a.ts'), 'const inside = 1;\n');
    writeFileSync(join(outsideDir, 'a.ts'), 'const outside = 2;\n');
    failingPath.beforeOpen = () => {
      renameSync(sourceDir, movedSourceDir);
      symlinkSync(outsideDir, sourceDir, 'dir');
    };

    const result = verifySourceQuoteEvidence(cwd, {
      kind: 'source_quote',
      path: 'src/a.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'const outside = 2;',
      snapshotId: 'snapshot',
    }, 'snapshot');

    expect(result).toMatchObject({
      outcome: 'unverifiable',
      reason: expect.stringContaining('identity changed'),
    });
    expect(readFileSync(join(outsideDir, 'a.ts'), 'utf-8')).toBe('const outside = 2;\n');
  });
});
