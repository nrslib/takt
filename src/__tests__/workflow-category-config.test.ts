/**
 * Tests for workflow category configuration loading and building
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { WorkflowWithSource } from '../infra/config/index.js';

const pathsState = vi.hoisted(() => ({
  globalConfigPath: '',
  projectConfigPath: '',
  resourcesDir: '',
}));

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getGlobalConfigPath: () => pathsState.globalConfigPath,
    getProjectConfigPath: () => pathsState.projectConfigPath,
  };
});

vi.mock('../infra/resources/index.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getLanguageResourcesDir: () => pathsState.resourcesDir,
  };
});

const workflowCategoriesState = vi.hoisted(() => ({
  categories: undefined as any,
  showOthersCategory: undefined as boolean | undefined,
  othersCategoryName: undefined as string | undefined,
}));

vi.mock('../infra/config/global/globalConfig.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getLanguage: () => 'en',
  };
});

vi.mock('../infra/config/global/workflowCategories.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getWorkflowCategoriesConfig: () => workflowCategoriesState.categories,
    getShowOthersCategory: () => workflowCategoriesState.showOthersCategory,
    getOthersCategoryName: () => workflowCategoriesState.othersCategoryName,
  };
});

const {
  getWorkflowCategories,
  loadDefaultCategories,
  buildCategorizedWorkflows,
  findWorkflowCategories,
} = await import('../infra/config/loaders/workflowCategories.js');

function writeYaml(path: string, content: string): void {
  writeFileSync(path, content.trim() + '\n', 'utf-8');
}

function createWorkflowMap(entries: { name: string; source: 'builtin' | 'user' | 'project' }[]):
  Map<string, WorkflowWithSource> {
  const workflows = new Map<string, WorkflowWithSource>();
  for (const entry of entries) {
    workflows.set(entry.name, {
      source: entry.source,
      config: {
        name: entry.name,
        steps: [],
        initialStep: 'start',
        maxIterations: 1,
      },
    });
  }
  return workflows;
}

describe('workflow category config loading', () => {
  let testDir: string;
  let resourcesDir: string;
  let globalConfigPath: string;
  let projectConfigPath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-cat-config-${randomUUID()}`);
    resourcesDir = join(testDir, 'resources');
    globalConfigPath = join(testDir, 'global-config.yaml');
    projectConfigPath = join(testDir, 'project-config.yaml');

    mkdirSync(resourcesDir, { recursive: true });
    pathsState.globalConfigPath = globalConfigPath;
    pathsState.projectConfigPath = projectConfigPath;
    pathsState.resourcesDir = resourcesDir;

    // Reset workflow categories state
    workflowCategoriesState.categories = undefined;
    workflowCategoriesState.showOthersCategory = undefined;
    workflowCategoriesState.othersCategoryName = undefined;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load default categories when no configs define workflow_categories', () => {
    writeYaml(join(resourcesDir, 'default-categories.yaml'), `
workflow_categories:
  Default:
    workflows:
      - simple
show_others_category: true
others_category_name: "Others"
`);

    const config = getWorkflowCategories(testDir);
    expect(config).not.toBeNull();
    expect(config!.workflowCategories).toEqual([
      { name: 'Default', workflows: ['simple'], children: [] },
    ]);
  });

  it('should prefer project config over default when workflow_categories is defined', () => {
    writeYaml(join(resourcesDir, 'default-categories.yaml'), `
workflow_categories:
  Default:
    workflows:
      - simple
`);

    writeYaml(projectConfigPath, `
workflow_categories:
  Project:
    workflows:
      - custom
show_others_category: false
`);

    const config = getWorkflowCategories(testDir);
    expect(config).not.toBeNull();
    expect(config!.workflowCategories).toEqual([
      { name: 'Project', workflows: ['custom'], children: [] },
    ]);
    expect(config!.showOthersCategory).toBe(false);
  });

  it('should prefer user config over project config when workflow_categories is defined', () => {
    writeYaml(join(resourcesDir, 'default-categories.yaml'), `
workflow_categories:
  Default:
    workflows:
      - simple
`);

    writeYaml(projectConfigPath, `
workflow_categories:
  Project:
    workflows:
      - custom
`);

    // Simulate user config from separate file
    workflowCategoriesState.categories = {
      User: {
        workflows: ['preferred'],
      },
    };

    const config = getWorkflowCategories(testDir);
    expect(config).not.toBeNull();
    expect(config!.workflowCategories).toEqual([
      { name: 'User', workflows: ['preferred'], children: [] },
    ]);
  });

  it('should ignore configs without workflow_categories and fall back to default', () => {
    writeYaml(join(resourcesDir, 'default-categories.yaml'), `
workflow_categories:
  Default:
    workflows:
      - simple
`);

    writeYaml(globalConfigPath, `
show_others_category: false
`);

    const config = getWorkflowCategories(testDir);
    expect(config).not.toBeNull();
    expect(config!.workflowCategories).toEqual([
      { name: 'Default', workflows: ['simple'], children: [] },
    ]);
  });

  it('should return null when default categories file is missing', () => {
    const config = loadDefaultCategories();
    expect(config).toBeNull();
  });
});

describe('buildCategorizedWorkflows', () => {
  it('should warn for missing workflows and generate Others', () => {
    const allWorkflows = createWorkflowMap([
      { name: 'a', source: 'user' },
      { name: 'b', source: 'user' },
      { name: 'c', source: 'builtin' },
    ]);
    const config = {
      workflowCategories: [
        {
          name: 'Cat',
          workflows: ['a', 'missing', 'c'],
          children: [],
        },
      ],
      showOthersCategory: true,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedWorkflows(allWorkflows, config);
    expect(categorized.categories).toEqual([
      { name: 'Cat', workflows: ['a'], children: [] },
      { name: 'Others', workflows: ['b'], children: [] },
    ]);
    expect(categorized.builtinCategories).toEqual([
      { name: 'Cat', workflows: ['c'], children: [] },
    ]);
    expect(categorized.missingWorkflows).toEqual([
      { categoryPath: ['Cat'], workflowName: 'missing' },
    ]);
  });

  it('should skip empty categories', () => {
    const allWorkflows = createWorkflowMap([
      { name: 'a', source: 'user' },
    ]);
    const config = {
      workflowCategories: [
        { name: 'Empty', workflows: [], children: [] },
      ],
      showOthersCategory: false,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedWorkflows(allWorkflows, config);
    expect(categorized.categories).toEqual([]);
    expect(categorized.builtinCategories).toEqual([]);
  });

  it('should find categories containing a workflow', () => {
    const categories = [
      { name: 'A', workflows: ['shared'], children: [] },
      { name: 'B', workflows: ['shared'], children: [] },
    ];

    const paths = findWorkflowCategories('shared', categories).sort();
    expect(paths).toEqual(['A', 'B']);
  });

  it('should handle nested category paths', () => {
    const categories = [
      {
        name: 'Parent',
        workflows: [],
        children: [
          { name: 'Child', workflows: ['nested'], children: [] },
        ],
      },
    ];

    const paths = findWorkflowCategories('nested', categories);
    expect(paths).toEqual(['Parent / Child']);
  });
});
