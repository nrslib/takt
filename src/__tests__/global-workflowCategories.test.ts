/**
 * Tests for global workflow category path resolution.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolvedState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigDir: () => '/tmp/.takt',
}));

vi.mock('../infra/config/resolveWorkflowConfigValue.js', () => ({
  resolveWorkflowConfigValue: (_projectDir: string, key: string) => {
    return resolvedState.value[key];
  },
  resolveWorkflowConfigValues: (_projectDir: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = resolvedState.value[key];
    }
    return result;
  },
}));

const { getWorkflowCategoriesPath, resetWorkflowCategories } = await import(
  '../infra/config/global/workflowCategories.js'
);

function createTempCategoriesPath(): string {
  const tempRoot = mkdtempSync(join(tmpdir(), 'takt-workflow-categories-'));
  return join(tempRoot, 'preferences', 'workflow-categories.yaml');
}

describe('getWorkflowCategoriesPath', () => {
  beforeEach(() => {
    resolvedState.value = {};
  });

  it('should return configured path when workflowCategoriesFile is set', () => {
    // Given
    resolvedState.value = { workflowCategoriesFile: '/custom/workflow-categories.yaml' };

    // When
    const path = getWorkflowCategoriesPath(process.cwd());

    // Then
    expect(path).toBe('/custom/workflow-categories.yaml');
  });

  it('should return default path when workflowCategoriesFile is not set', () => {
    // Given
    resolvedState.value = {};

    // When
    const path = getWorkflowCategoriesPath(process.cwd());

    // Then
    expect(path).toBe('/tmp/.takt/preferences/workflow-categories.yaml');
  });

  it('should rethrow when global config loading fails', () => {
    // Given
    resolvedState.value = new Proxy({}, {
      get() {
        throw new Error('invalid global config');
      },
    }) as Record<string, unknown>;

    // When / Then
    expect(() => getWorkflowCategoriesPath(process.cwd())).toThrow('invalid global config');
  });
});

describe('resetWorkflowCategories', () => {
  const tempRoots: string[] = [];

  beforeEach(() => {
    resolvedState.value = {};
  });

  afterEach(() => {
    for (const tempRoot of tempRoots) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots.length = 0;
  });

  it('should create parent directory and initialize with empty user categories', () => {
    // Given
    const categoriesPath = createTempCategoriesPath();
    tempRoots.push(dirname(dirname(categoriesPath)));
    resolvedState.value = { workflowCategoriesFile: categoriesPath };

    // When
    resetWorkflowCategories(process.cwd());

    // Then
    expect(existsSync(dirname(categoriesPath))).toBe(true);
    expect(readFileSync(categoriesPath, 'utf-8')).toBe('workflow_categories: {}\n');
  });

  it('should overwrite existing file with empty user categories', () => {
    // Given
    const categoriesPath = createTempCategoriesPath();
    const categoriesDir = dirname(categoriesPath);
    const tempRoot = dirname(categoriesDir);
    tempRoots.push(tempRoot);
    resolvedState.value = { workflowCategoriesFile: categoriesPath };
    mkdirSync(categoriesDir, { recursive: true });
    writeFileSync(categoriesPath, 'workflow_categories:\n  old:\n    - stale-workflow\n', 'utf-8');

    // When
    resetWorkflowCategories(process.cwd());

    // Then
    expect(readFileSync(categoriesPath, 'utf-8')).toBe('workflow_categories: {}\n');
  });
});
