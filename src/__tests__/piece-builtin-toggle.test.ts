/**
 * Tests for builtin piece enable/disable flag
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../infra/config/global/globalConfig.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getLanguage: () => 'en',
    getDisabledBuiltins: () => [],
    getBuiltinPiecesEnabled: () => false,
  };
});

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: (_cwd: string, key: string) => {
    if (key === 'language') return 'en';
    if (key === 'enableBuiltinPieces') return false;
    if (key === 'disabledBuiltins') return [];
    return undefined;
  },
  resolveConfigValues: (_cwd: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === 'language') result[key] = 'en';
      if (key === 'enableBuiltinPieces') result[key] = false;
      if (key === 'disabledBuiltins') result[key] = [];
    }
    return result;
  },
}));

const { listPieces } = await import('../infra/config/loaders/pieceLoader.js');

const SAMPLE_PIECE = `name: test-piece
movements:
  - name: step1
    persona: coder
    instruction: "{task}"
`;

describe('builtin piece toggle', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should exclude builtin pieces when disabled', () => {
    const projectPiecesDir = join(tempDir, '.takt', 'pieces');
    mkdirSync(projectPiecesDir, { recursive: true });
    writeFileSync(join(projectPiecesDir, 'project-custom.yaml'), SAMPLE_PIECE);

    const pieces = listPieces(tempDir);
    expect(pieces).toContain('project-custom');
    expect(pieces).not.toContain('default');
  });
});
