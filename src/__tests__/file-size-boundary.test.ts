import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readModule(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf-8');
}

describe('file size boundary', () => {
  it.each([
    '../agents/runner.ts',
    '../core/workflow/engine/OptionsBuilder.ts',
    '../core/workflow/engine/TeamLeaderRunner.ts',
  ])('keeps %s under the 300-line architecture limit', (path) => {
    const source = readModule(path);
    expect(source.trimEnd().split('\n').length).toBeLessThanOrEqual(299);
  });
});
