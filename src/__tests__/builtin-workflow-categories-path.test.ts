/**
 * Issue #565: builtin default categories file is `workflow-categories.yaml`
 * under `builtins/{lang}/` and removed legacy filenames must stay unread.
 */

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
const removedCategoriesFile = `${['p', 'i', 'e', 'c', 'e'].join('')}-categories.yaml`;
const removedWorkflowListKey = ['p', 'i', 'e', 'c', 'e', 's'].join('');

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
    expect(path).not.toMatch(new RegExp(`${removedCategoriesFile.replace('.', '\\.')}$`));
  });

  it('should reject removed workflow list key in workflow-categories.yaml', () => {
    writeFileSync(
      join(enResources, 'workflow-categories.yaml'),
      `workflow_categories:
  Quick Start:
    ${removedWorkflowListKey}:
      - default
`,
      'utf-8',
    );

    expect(() => loadDefaultCategories(testDir)).toThrow(new RegExp(`"${removedWorkflowListKey}" has been removed\\. Use "workflows" instead`, 'i'));
  });

  it('should return null when only the removed builtin categories filename exists', () => {
    // Given: old builtin filename only — loader must not read it after #565
    writeFileSync(
      join(enResources, removedCategoriesFile),
      `workflow_categories:
  Legacy:
    ${removedWorkflowListKey}:
      - default
`,
      'utf-8',
    );

    // When
    const config = loadDefaultCategories(testDir);

    // Then
    expect(config).toBeNull();
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

  it('should reject duplicate workflow_categories keys in the same file', () => {
    writeFileSync(
      join(enResources, 'workflow-categories.yaml'),
      `workflow_categories:
  Quick:
    pieces:
      - default
workflow_categories:
  Quick:
    workflows:
      - default
`,
      'utf-8',
    );

    expect(() => loadDefaultCategories(testDir)).toThrow(/Map keys must be unique/i);
  });

  it('should reject duplicate workflow_categories keys before category conflict resolution', () => {
    writeFileSync(
      join(enResources, 'workflow-categories.yaml'),
      `workflow_categories:
  Legacy:
    pieces:
      - default
workflow_categories:
  Modern:
    workflows:
      - default
`,
      'utf-8',
    );

    expect(() => loadDefaultCategories(testDir)).toThrow(/Map keys must be unique/i);
  });

  it('should reject when a category node defines a removed legacy workflow-list key', () => {
    writeFileSync(
      join(enResources, 'workflow-categories.yaml'),
      `workflow_categories:
  Mixed:
    pieces:
      - research
    workflows:
      - default
`,
      'utf-8',
    );

    expect(() => loadDefaultCategories(testDir)).toThrow(/"pieces" has been removed\. Use "workflows" instead/i);
  });
});
