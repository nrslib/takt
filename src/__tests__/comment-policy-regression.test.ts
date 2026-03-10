import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const TEST_FILES = [
  'config.test.ts',
  'projectConfig.test.ts',
  'globalConfig.test.ts',
] as const;

describe('test comment policy regression', () => {
  it('should not contain Given/When/Then explanation comments in config-related tests', () => {
    for (const file of TEST_FILES) {
      const content = readFileSync(new URL(file, import.meta.url), 'utf-8');
      expect(content).not.toMatch(/\bGiven:\b/);
      expect(content).not.toMatch(/\bWhen:\b/);
      expect(content).not.toMatch(/\bThen:\b/);
    }
  });
});
