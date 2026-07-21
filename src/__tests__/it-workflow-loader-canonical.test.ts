import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const languageState = vi.hoisted(() => ({ value: 'en' as 'en' | 'ja' }));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: vi.fn((_cwd: string, key: string) => {
    if (key === 'language') return languageState.value;
    if (key === 'enableBuiltinWorkflows') return true;
    if (key === 'disabledBuiltins') return [];
    return undefined;
  }),
  resolveConfigValues: vi.fn((_cwd: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === 'language') result[key] = languageState.value;
      if (key === 'enableBuiltinWorkflows') result[key] = true;
      if (key === 'disabledBuiltins') result[key] = [];
    }
    return result;
  }),
}));

import { loadWorkflow } from '../infra/config/loaders/index.js';

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-workflow-'));
  mkdirSync(join(dir, '.takt'), { recursive: true });
  return dir;
}

describe('Workflow Loader IT: canonical workflow loading', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
    languageState.value = 'en';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load project-local workflows only from .takt/workflows', () => {
    // Given
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    const agentsDir = join(testDir, '.takt', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'custom.md'), 'Custom agent');

    writeFileSync(join(workflowsDir, 'custom.yaml'), `
name: custom
description: Custom project workflow
max_steps: 5
initial_step: start

steps:
  - name: start
    persona: ../agents/custom.md
    instruction: "Do the work"
    rules:
      - condition: Done
        next: COMPLETE
`);

    // When
    const config = loadWorkflow('custom', testDir);

    // Then
    expect(config).not.toBeNull();
    expect(config!.name).toBe('custom');
    expect(config!.steps).toHaveLength(1);
    expect(config!.steps[0]!.name).toBe('start');
  });
});
