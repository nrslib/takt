import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PieceConfigRawSchema } from '../core/models/index.js';

const RESOURCES_DIR = join(import.meta.dirname, '../../builtins');

function loadReviewTaktDefaultYaml(lang: 'en' | 'ja') {
  const filePath = join(RESOURCES_DIR, lang, 'pieces', 'review-takt-default.yaml');
  const content = readFileSync(filePath, 'utf-8');
  return parseYaml(content);
}

type PieceMovementLike = {
  name: string;
  provider_options?: {
    claude?: {
      allowed_tools?: string[];
    };
  };
  parallel?: PieceMovementLike[];
};

type PieceLike = {
  movements: PieceMovementLike[];
};

function assertNoBashInReviewOnlyMovements(raw: PieceLike) {
  const gather = raw.movements.find((movement: { name: string }) => movement.name === 'gather');
  expect(gather.provider_options?.claude?.allowed_tools).not.toContain('Bash');

  const reviewers = raw.movements.find((movement: { name: string }) => movement.name === 'reviewers');
  for (const reviewer of reviewers.parallel ?? []) {
    expect(reviewer.provider_options?.claude?.allowed_tools).not.toContain('Bash');
  }
}

describe('review-takt-default piece', () => {
  it.each(['en', 'ja'] as const)('should pass schema validation for %s', (lang) => {
    const raw = loadReviewTaktDefaultYaml(lang);
    const result = PieceConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it.each(['en', 'ja'] as const)('should not allow Bash in review-only gather and reviewer movements for %s', (lang) => {
    const raw = loadReviewTaktDefaultYaml(lang) as PieceLike;
    assertNoBashInReviewOnlyMovements(raw);
  });
});
