/**
 * Issue #565: builtin default categories file is `workflow-categories.yaml`
 * under `builtins/{lang}/` (not `piece-categories.yaml`).
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
  '../infra/config/loaders/pieceCategories.js'
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
    expect(path).not.toMatch(/piece-categories\.yaml$/);
  });

  it('should load piece_categories from workflow-categories.yaml when present', () => {
    // Given: only workflow-categories.yaml (not legacy piece-categories.yaml)
    writeFileSync(
      join(enResources, 'workflow-categories.yaml'),
      `piece_categories:
  Quick Start:
    pieces:
      - default
`,
      'utf-8',
    );

    // When
    const config = loadDefaultCategories(testDir);

    // Then
    expect(config).not.toBeNull();
    expect(config!.pieceCategories).toEqual([
      { name: 'Quick Start', pieces: ['default'], children: [] },
    ]);
  });

  it('should return null when only legacy piece-categories.yaml exists (no workflow file)', () => {
    // Given: old builtin filename only — loader must not read it after #565
    writeFileSync(
      join(enResources, 'piece-categories.yaml'),
      `piece_categories:
  Legacy:
    pieces:
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
