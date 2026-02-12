import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Reset categories command (takt reset categories)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('should reset categories and create overlay file', () => {
    // Given: a local repo with isolated env

    // When: running takt reset categories
    const result = runTakt({
      args: ['reset', 'categories'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: exits successfully and outputs reset message
    expect(result.exitCode).toBe(0);
    const output = result.stdout;
    expect(output).toMatch(/reset/i);

    // Then: piece-categories.yaml exists with initial content
    const categoriesPath = join(isolatedEnv.taktDir, 'preferences', 'piece-categories.yaml');
    expect(existsSync(categoriesPath)).toBe(true);
    const content = readFileSync(categoriesPath, 'utf-8');
    expect(content).toContain('piece_categories: {}');
  });
});
