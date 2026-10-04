import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const languageState = vi.hoisted(() => ({
  value: 'en' as 'en' | 'ja',
}));

const pathsState = vi.hoisted(() => ({
  resourcesRoot: '',
}));
vi.mock('../infra/config/global/globalConfig.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    loadGlobalConfig: () => ({}),
  };
});

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: (_cwd: string, key: string) => {
    if (key === 'language') return languageState.value;
    return undefined;
  },
  resolveConfigValues: (_cwd: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === 'language') result[key] = languageState.value;
    }
    return result;
  },
}));

vi.mock('../infra/resources/index.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getLanguageResourcesDir: (lang: string) => join(pathsState.resourcesRoot, lang),
  };
});

const { getDefaultCategoriesPath, loadDefaultCategories } = await import(
  '../infra/config/loaders/workflowCategories.js'
);

describe('builtin workflow-categories.yaml path and loading', () => {
  let testDir: string;
  let enResources: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-wf-cat-path-${randomUUID()}`);
    enResources = join(testDir, 'resources', 'en');
    mkdirSync(enResources, { recursive: true });
    mkdirSync(join(testDir, 'resources', 'ja'), { recursive: true });
    pathsState.resourcesRoot = join(testDir, 'resources');
    languageState.value = 'en';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should point getDefaultCategoriesPath at workflow-categories.yaml under language resources', () => {
    // Given: resolved language en
    // When
    const path = getDefaultCategoriesPath(testDir);
    // Then
    expect(path).toBe(join(enResources, 'workflow-categories.yaml'));
  });
});

describe('builtin workflow-categories.yaml workflow_categories / workflows keys', () => {
  let testDir: string;
  let enResources: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-wf-cat-keys-${randomUUID()}`);
    enResources = join(testDir, 'resources', 'en');
    mkdirSync(enResources, { recursive: true });
    mkdirSync(join(testDir, 'resources', 'ja'), { recursive: true });
    pathsState.resourcesRoot = join(testDir, 'resources');
    languageState.value = 'en';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load workflow_categories with workflows list', () => {
    // Given: builtin-style file using new root and child keys only
    writeFileSync(
      join(enResources, 'workflow-categories.yaml'),
      `workflow_categories:
  Quick Start:
    workflows:
      - default
`,
      'utf-8',
    );

    // When
    const config = loadDefaultCategories(testDir);

    // Then
    expect(config).not.toBeNull();
    expect(config!.workflowCategories).toEqual([
      { name: 'Quick Start', workflows: ['default'], children: [] },
    ]);
  });

});
