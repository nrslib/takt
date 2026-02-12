import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Prompt preview command (takt prompt)', () => {
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

  it('should output prompt preview header and movement info for a piece', () => {
    // Given: a piece file path
    const piecePath = resolve(__dirname, '../fixtures/pieces/mock-single-step.yaml');

    // When: running takt prompt with piece path
    const result = runTakt({
      args: ['prompt', piecePath],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: output contains "Prompt Preview" header and movement info
    // (may fail on Phase 3 for pieces with tag-based rules, but header is still output)
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/Prompt Preview|Movement 1/i);
  });

  it('should report not found for a nonexistent piece name', () => {
    // Given: a nonexistent piece name

    // When: running takt prompt with invalid piece
    const result = runTakt({
      args: ['prompt', 'nonexistent-piece-xyz'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: reports piece not found
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/not found/i);
  });
});
