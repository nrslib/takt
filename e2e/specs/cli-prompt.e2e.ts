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

  it('should output workflow prompt preview header and step info for a workflow', () => {
    // Given: a workflow file path
    const workflowPath = resolve(__dirname, '../fixtures/workflows/mock-single-step.yaml');

    // When: running takt prompt with workflow path
    const result = runTakt({
      args: ['prompt', workflowPath],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: output contains workflow/step terminology
    // (may fail on Phase 3 for workflows with tag-based rules, but header is still output)
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('Workflow Prompt Preview:');
    expect(combined).toContain('Step 1:');
    expect(combined).not.toContain('Movement 1');
  });

  it('should report not found for a nonexistent workflow name', () => {
    // Given: a nonexistent workflow name

    // When: running takt prompt with an invalid workflow
    const result = runTakt({
      args: ['prompt', 'nonexistent-workflow-xyz'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: reports workflow not found
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('Workflow "nonexistent-workflow-xyz" not found.');
  });
});
