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

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: (_cwd: string, key: string) => {
    if (key === 'language') return 'en';
    if (key === 'enableBuiltinWorkflows') return false;
    if (key === 'disabledBuiltins') return [];
    return undefined;
  },
  resolveConfigValues: (_cwd: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === 'language') result[key] = 'en';
      if (key === 'enableBuiltinWorkflows') result[key] = false;
      if (key === 'disabledBuiltins') result[key] = [];
    }
    return result;
  },
}));

const { listWorkflows } = await import('../infra/config/loaders/workflowLoader.js');

const SAMPLE_WORKFLOW = `name: test-workflow
steps:
  - name: step1
    persona: coder
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
