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

  it('should not reintroduce removed judge-provider explanatory comments (#556 policy)', () => {
    const banned: readonly { path: string; needle: string }[] = [
      { path: '../agents/judge-status-usecase.ts', needle: 'Same as Phase 1' },
      { path: '../core/piece/evaluation/RuleEvaluator.ts', needle: 'Phase-1-aligned' },
      { path: '../core/piece/engine/OptionsBuilder.ts', needle: 'same logic as buildBaseOptions' },
      { path: '../core/piece/phase-runner.ts', needle: 'Same provider/model resolution as Phase 1' },
      { path: 'judge-runagent-provider-resolution.test.ts', needle: '実装完了まで失敗' },
    ];
    for (const { path, needle } of banned) {
      const content = readFileSync(new URL(path, import.meta.url), 'utf-8');
      expect(content).not.toContain(needle);
    }
  });
});
