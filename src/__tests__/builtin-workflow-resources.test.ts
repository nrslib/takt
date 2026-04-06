import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

import { getLanguageResourcesDir } from '../infra/resources/index.js';
import { getBuiltinWorkflowsDir } from '../infra/config/paths.js';

describe('getBuiltinWorkflowsDir', () => {
  it('should resolve en builtin workflows directory under builtins/en/workflows', () => {
    // Given
    const root = getLanguageResourcesDir('en');
    // When
    const dir = getBuiltinWorkflowsDir('en');
    // Then
    expect(dir).toBe(join(root, 'workflows'));
  });

  it('should resolve ja builtin workflows directory under builtins/ja/workflows', () => {
    const root = getLanguageResourcesDir('ja');
    const dir = getBuiltinWorkflowsDir('ja');
    expect(dir).toBe(join(root, 'workflows'));
  });

  it('should not use the legacy pieces segment as the builtin workflow root', () => {
    const enDir = getBuiltinWorkflowsDir('en');
    expect(enDir).not.toMatch(/[/\\]pieces[/\\]?$/);
    expect(enDir).toMatch(/[/\\]workflows$/);
  });
});

describe('pieceResolver builtin layer uses workflows directory', () => {
  it('should list names from builtin workflows directory', async () => {
    const { listBuiltinPieceNames } = await import('../infra/config/loaders/pieceResolver.js');
    // Given / When
    const names = new Set(listBuiltinPieceNames(process.cwd()));
    // Then
    expect(names.has('default')).toBe(true);
  });

  it('should load default builtin workflow by name', async () => {
    const { getBuiltinPiece } = await import('../infra/config/loaders/pieceResolver.js');
    // Given / When
    const piece = getBuiltinPiece('default', process.cwd());
    // Then
    expect(piece).not.toBeNull();
    expect(piece!.name).toBe('default');
  });

  it('should store builtin YAML files under workflows directory on disk', () => {
    const dir = getBuiltinWorkflowsDir('en');
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'default.yaml'))).toBe(true);
  });

  // Regression: builtin review-default must live under workflows/ (not legacy pieces/) — #565 / 565-TESTS-REVIEW-PIECE-PATH
  it('should expose review-default.yaml under builtin workflows directory', () => {
    const path = join(getBuiltinWorkflowsDir('en'), 'review-default.yaml');
    expect(existsSync(path)).toBe(true);
  });

  it('should use claude-sdk for compound-eye parallel claude substep (en/ja)', () => {
    for (const lang of ['en', 'ja'] as const) {
      const path = join(getBuiltinWorkflowsDir(lang), 'compound-eye.yaml');
      const doc = YAML.parse(readFileSync(path, 'utf-8')) as {
        steps: Array<{
          name: string;
          parallel?: Array<{ name: string; provider?: string }>;
        }>;
      };
      const evaluate = doc.steps.find((s) => s.name === 'evaluate');
      const claudeEye = evaluate?.parallel?.find((p) => p.name === 'claude-eye');
      expect(claudeEye?.provider).toBe('claude-sdk');
    }
  });
});
