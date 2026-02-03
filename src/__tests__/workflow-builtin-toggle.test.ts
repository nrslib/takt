/**
 * Tests for builtin workflow enable/disable flag
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
    getBuiltinWorkflowsEnabled: () => false,
  };
});

const { listWorkflows } = await import('../infra/config/loaders/workflowLoader.js');

const SAMPLE_WORKFLOW = `name: test-workflow
steps:
  - name: step1
    agent: coder
    instruction: "{task}"
`;

describe('builtin workflow toggle', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should exclude builtin workflows when disabled', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'project-custom.yaml'), SAMPLE_WORKFLOW);

    const workflows = listWorkflows(tempDir);
    expect(workflows).toContain('project-custom');
    expect(workflows).not.toContain('default');
  });
});
