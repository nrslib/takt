/**
 * Tests for workflow category configuration loading and building
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { WorkflowWithSource } from '../infra/config/index.js';

const languageState = vi.hoisted(() => ({
  value: 'en' as 'en' | 'ja',
}));

const pathsState = vi.hoisted(() => ({
  resourcesRoot: '',
  userCategoriesPath: '',
}));

const configState = vi.hoisted(() => ({
  enableBuiltinWorkflows: true,
  disabledBuiltins: [] as string[],
}));

const resolveConfigCallState = vi.hoisted(() => ({
  valueCalls: [] as string[][],
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
    if (key === 'enableBuiltinWorkflows') return configState.enableBuiltinWorkflows;
    if (key === 'disabledBuiltins') return configState.disabledBuiltins;
    return undefined;
  },
  resolveConfigValues: (_cwd: string, keys: readonly string[]) => {
    resolveConfigCallState.valueCalls.push([...keys]);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === 'language') result[key] = languageState.value;
      if (key === 'enableBuiltinWorkflows') result[key] = configState.enableBuiltinWorkflows;
      if (key === 'disabledBuiltins') result[key] = configState.disabledBuiltins;
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

vi.mock('../infra/config/global/workflowCategories.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    getWorkflowCategoriesPath: () => pathsState.userCategoriesPath,
  };
});

vi.mock('../infra/config/loaders/workflowResolver.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    listBuiltinWorkflowNames: () => {
      throw new Error('resolveIgnoredWorkflows should not call workflowResolver');
    },
  };
});

const {
  BUILTIN_CATEGORY_NAME,
  getWorkflowCategories,
  loadDefaultCategories,
  resolveIgnoredWorkflows,
  buildCategorizedWorkflows,
  findWorkflowCategories,
} = await import('../infra/config/loaders/workflowCategories.js');
const { listBuiltinWorkflowNamesForDir } = await import('../infra/config/loaders/workflowDiscovery.js');

function writeYaml(path: string, content: string): void {
  writeFileSync(path, content.trim() + '\n', 'utf-8');
}

function createWorkflowMap(entries: { name: string; source: 'builtin' | 'user' | 'project' | 'repertoire' }[]):
  Map<string, WorkflowWithSource> {
  const workflows = new Map<string, WorkflowWithSource>();
  for (const entry of entries) {
    workflows.set(entry.name, {
      source: entry.source,
      config: {
        name: entry.name,
      },
    });
  }
  return workflows;
}

describe('workflow category config loading', () => {
  let testDir: string;
  let resourcesDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-cat-config-${randomUUID()}`);
    resourcesDir = join(testDir, 'resources', 'en');

    mkdirSync(resourcesDir, { recursive: true });
    mkdirSync(join(testDir, 'resources', 'ja'), { recursive: true });
    pathsState.resourcesRoot = join(testDir, 'resources');
    languageState.value = 'en';
    pathsState.userCategoriesPath = join(testDir, 'user-workflow-categories.yaml');
    configState.enableBuiltinWorkflows = true;
    configState.disabledBuiltins = [];
    resolveConfigCallState.valueCalls = [];
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return null when builtin categories file is missing', () => {
    const config = getWorkflowCategories(testDir);
    expect(config).toBeNull();
  });

  it('should load default categories from resources', () => {
    writeYaml(join(resourcesDir, 'workflow-categories.yaml'), `
workflow_categories:
  Quick Start:
    workflows:
      - default
`);

    const config = loadDefaultCategories(testDir);
    expect(config).not.toBeNull();
    expect(config!.workflowCategories).toEqual([
      { name: 'Quick Start', workflows: ['default'], children: [] },
    ]);
    expect(config!.builtinWorkflowCategories).toEqual([
      { name: 'Quick Start', workflows: ['default'], children: [] },
    ]);
    expect(config!.userWorkflowCategories).toEqual([]);
    expect(config!.hasUserCategories).toBe(false);
  });

  it('should use builtin categories when user overlay file is missing', () => {
    writeYaml(join(resourcesDir, 'workflow-categories.yaml'), `
workflow_categories:
  Main:
    workflows:
      - default
show_others_category: true
others_category_name: Others
`);

    const config = getWorkflowCategories(testDir);
    expect(config).not.toBeNull();
    expect(config!.workflowCategories).toEqual([
      { name: 'Main', workflows: ['default'], children: [] },
    ]);
    expect(config!.userWorkflowCategories).toEqual([]);
    expect(config!.hasUserCategories).toBe(false);
    expect(config!.showOthersCategory).toBe(true);
    expect(config!.othersCategoryName).toBe('Others');
  });

  it('should separate user categories from builtin categories with builtin wrapper', () => {
    writeYaml(join(resourcesDir, 'workflow-categories.yaml'), `
workflow_categories:
  Main:
    workflows:
      - default
      - coding
    Child:
      workflows:
        - nested
  Review:
    workflows:
      - review
      - audit-e2e
show_others_category: true
others_category_name: Others
`);

    writeYaml(pathsState.userCategoriesPath, `
workflow_categories:
  Main:
    workflows:
      - custom
  My Team:
    workflows:
      - team-flow
show_others_category: false
others_category_name: Unclassified
`);

    const config = getWorkflowCategories(testDir);
    expect(config).not.toBeNull();
    expect(config!.workflowCategories).toEqual([
      { name: 'Main', workflows: ['custom'], children: [] },
      { name: 'My Team', workflows: ['team-flow'], children: [] },
      {
        name: BUILTIN_CATEGORY_NAME,
        workflows: [],
        children: [
          {
            name: 'Main',
            workflows: ['default', 'coding'],
            children: [
              { name: 'Child', workflows: ['nested'], children: [] },
            ],
          },
          { name: 'Review', workflows: ['review', 'audit-e2e'], children: [] },
        ],
      },
    ]);
    expect(config!.builtinWorkflowCategories).toEqual([
      {
        name: 'Main',
        workflows: ['default', 'coding'],
        children: [
          { name: 'Child', workflows: ['nested'], children: [] },
        ],
      },
      { name: 'Review', workflows: ['review', 'audit-e2e'], children: [] },
    ]);
    expect(config!.userWorkflowCategories).toEqual([
      { name: 'Main', workflows: ['custom'], children: [] },
      { name: 'My Team', workflows: ['team-flow'], children: [] },
    ]);
    expect(config!.hasUserCategories).toBe(true);
    expect(config!.showOthersCategory).toBe(false);
    expect(config!.othersCategoryName).toBe('Unclassified');
  });

  it('should load ja builtin categories and include audit-e2e under レビュー', () => {
    languageState.value = 'ja';

    writeYaml(join(testDir, 'resources', 'ja', 'workflow-categories.yaml'), `
workflow_categories:
  レビュー:
    workflows:
      - review
      - audit-e2e
`);

    const config = getWorkflowCategories(testDir);
    expect(config).not.toBeNull();
    expect(config!.workflowCategories).toEqual([
      { name: 'レビュー', workflows: ['review', 'audit-e2e'], children: [] },
    ]);
  });

  it('should override others settings without replacing categories when user overlay has no workflow_categories', () => {
    writeYaml(join(resourcesDir, 'workflow-categories.yaml'), `
workflow_categories:
  Main:
    workflows:
      - default
  Review:
    workflows:
      - review
show_others_category: true
others_category_name: Others
`);

    writeYaml(pathsState.userCategoriesPath, `
show_others_category: false
others_category_name: Unclassified
`);

    const config = getWorkflowCategories(testDir);
    expect(config).not.toBeNull();
    expect(config!.workflowCategories).toEqual([
      { name: 'Main', workflows: ['default'], children: [] },
      { name: 'Review', workflows: ['review'], children: [] },
    ]);
    expect(config!.builtinWorkflowCategories).toEqual([
      { name: 'Main', workflows: ['default'], children: [] },
      { name: 'Review', workflows: ['review'], children: [] },
    ]);
    expect(config!.userWorkflowCategories).toEqual([]);
    expect(config!.hasUserCategories).toBe(false);
    expect(config!.showOthersCategory).toBe(false);
    expect(config!.othersCategoryName).toBe('Unclassified');
  });
});

describe('buildCategorizedWorkflows', () => {
  let testDir: string;
  let resourcesDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-cat-build-${randomUUID()}`);
    resourcesDir = join(testDir, 'resources', 'en');

    mkdirSync(resourcesDir, { recursive: true });
    mkdirSync(join(testDir, 'resources', 'ja'), { recursive: true });
    pathsState.resourcesRoot = join(testDir, 'resources');
    languageState.value = 'en';
    pathsState.userCategoriesPath = join(testDir, 'user-workflow-categories.yaml');
    configState.enableBuiltinWorkflows = true;
    configState.disabledBuiltins = [];
    resolveConfigCallState.valueCalls = [];
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should resolve ignored builtin workflows outside the tree builder', () => {
    configState.disabledBuiltins = ['review'];

    const ignored = resolveIgnoredWorkflows(testDir);

    expect(ignored).toEqual(new Set(['review']));
  });

  it('should resolve all builtin workflows as ignored when builtins are disabled', () => {
    configState.enableBuiltinWorkflows = false;
    const builtinDir = join(resourcesDir, 'workflows');
    mkdirSync(builtinDir, { recursive: true });
    writeYaml(join(builtinDir, 'default.yaml'), 'name: default\nsteps: []\ninitial_step: start\nmax_steps: 1');
    writeYaml(join(builtinDir, 'review.yaml'), 'name: review\nsteps: []\ninitial_step: start\nmax_steps: 1');

    const ignored = resolveIgnoredWorkflows(testDir);

    expect(ignored).toEqual(new Set(['default', 'review']));
    expect(resolveConfigCallState.valueCalls).toContainEqual(['enableBuiltinWorkflows', 'disabledBuiltins', 'language']);
  });

  it('should enumerate nested builtin workflow names when builtins are disabled', () => {
    configState.enableBuiltinWorkflows = false;
    const builtinDir = join(resourcesDir, 'workflows');
    const nestedDir = join(builtinDir, 'reviews');
    mkdirSync(nestedDir, { recursive: true });
    writeYaml(join(nestedDir, 'security.yaml'), 'name: reviews/security\nsteps: []\ninitial_step: start\nmax_steps: 1');

    const ignored = resolveIgnoredWorkflows(testDir);

    expect(ignored).toEqual(new Set(['reviews/security']));
  });

  it('should derive ignored builtin workflows from the same builtin name listing used by the resolver', () => {
    configState.enableBuiltinWorkflows = false;
    const builtinDir = join(resourcesDir, 'workflows');
    const nestedDir = join(builtinDir, 'reviews');
    mkdirSync(nestedDir, { recursive: true });
    writeYaml(join(builtinDir, 'default.yaml'), 'name: default\nsteps: []\ninitial_step: start\nmax_steps: 1');
    writeYaml(join(nestedDir, 'security.yaml'), 'name: reviews/security\nsteps: []\ninitial_step: start\nmax_steps: 1');

    const builtinNames = listBuiltinWorkflowNamesForDir(builtinDir);
    const ignored = resolveIgnoredWorkflows(testDir);

    expect(ignored).toEqual(new Set(builtinNames));
  });

  it('should resolve ignored builtins from the test resources directory instead of the current working directory', () => {
    configState.enableBuiltinWorkflows = false;
    const builtinDir = join(resourcesDir, 'workflows');
    mkdirSync(builtinDir, { recursive: true });
    writeYaml(join(builtinDir, 'only-test-resource.yaml'), 'name: only-test-resource\nsteps: []\ninitial_step: start\nmax_steps: 1');

    const ignored = resolveIgnoredWorkflows(testDir);

    expect(ignored).toEqual(new Set(['only-test-resource']));
  });

  it('should use resolved ignored workflows when collecting missing workflows', () => {
    const allWorkflows = createWorkflowMap([
      { name: 'custom', source: 'user' },
    ]);
    const config = {
      workflowCategories: [
        { name: 'Main', workflows: ['custom'], children: [] },
      ],
      builtinWorkflowCategories: [
        { name: 'Builtin', workflows: ['disabled-builtin'], children: [] },
      ],
      userWorkflowCategories: [],
      hasUserCategories: false,
      showOthersCategory: true,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedWorkflows(allWorkflows, config, new Set(['disabled-builtin']));

    expect(categorized.missingWorkflows).toEqual([]);
  });

  it('should collect missing workflows with source information', () => {
    const allWorkflows = createWorkflowMap([
      { name: 'custom', source: 'user' },
      { name: 'nested', source: 'builtin' },
      { name: 'team-flow', source: 'user' },
    ]);
    const config = {
      workflowCategories: [
        {
          name: 'Main',
          workflows: ['custom'],
          children: [{ name: 'Nested', workflows: ['nested'], children: [] }],
        },
        { name: 'My Team', workflows: ['team-flow'], children: [] },
      ],
      builtinWorkflowCategories: [
        {
          name: 'Main',
          workflows: ['default'],
          children: [{ name: 'Nested', workflows: ['nested'], children: [] }],
        },
      ],
      userWorkflowCategories: [
        { name: 'My Team', workflows: ['missing-user-workflow'], children: [] },
      ],
      hasUserCategories: true,
      showOthersCategory: true,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedWorkflows(allWorkflows, config, new Set());
    expect(categorized.categories).toEqual([
      {
        name: 'Main',
        workflows: ['custom'],
        children: [{ name: 'Nested', workflows: ['nested'], children: [] }],
      },
      { name: 'My Team', workflows: ['team-flow'], children: [] },
    ]);
    expect(categorized.missingWorkflows).toEqual([
      { categoryPath: ['Main'], workflowName: 'default', source: 'builtin' },
      { categoryPath: ['My Team'], workflowName: 'missing-user-workflow', source: 'user' },
    ]);
  });

  it('should append Others category for uncategorized workflows', () => {
    const allWorkflows = createWorkflowMap([
      { name: 'default', source: 'builtin' },
      { name: 'extra', source: 'builtin' },
    ]);
    const config = {
      workflowCategories: [
        { name: 'Main', workflows: ['default'], children: [] },
      ],
      builtinWorkflowCategories: [
        { name: 'Main', workflows: ['default'], children: [] },
      ],
      userWorkflowCategories: [],
      hasUserCategories: false,
      showOthersCategory: true,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedWorkflows(allWorkflows, config, new Set());
    expect(categorized.categories).toEqual([
      { name: 'Main', workflows: ['default'], children: [] },
      { name: 'Others', workflows: ['extra'], children: [] },
    ]);
  });

  it('should not append Others when showOthersCategory is false', () => {
    const allWorkflows = createWorkflowMap([
      { name: 'default', source: 'builtin' },
      { name: 'extra', source: 'builtin' },
    ]);
    const config = {
      workflowCategories: [
        { name: 'Main', workflows: ['default'], children: [] },
      ],
      builtinWorkflowCategories: [
        { name: 'Main', workflows: ['default'], children: [] },
      ],
      userWorkflowCategories: [],
      hasUserCategories: false,
      showOthersCategory: false,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedWorkflows(allWorkflows, config, new Set());
    expect(categorized.categories).toEqual([
      { name: 'Main', workflows: ['default'], children: [] },
    ]);
  });

  it('should categorize workflows through builtin wrapper node', () => {
    const allWorkflows = createWorkflowMap([
      { name: 'custom', source: 'user' },
      { name: 'default', source: 'builtin' },
      { name: 'review', source: 'builtin' },
      { name: 'extra', source: 'builtin' },
    ]);
    const config = {
      workflowCategories: [
        { name: 'Custom', workflows: ['custom'], children: [] },
        {
          name: BUILTIN_CATEGORY_NAME,
          workflows: [],
          children: [
            { name: 'Default', workflows: ['default'], children: [] },
            { name: 'Review', workflows: ['review'], children: [] },
          ],
        },
      ],
      builtinWorkflowCategories: [
        { name: 'Default', workflows: ['default'], children: [] },
        { name: 'Review', workflows: ['review'], children: [] },
      ],
      userWorkflowCategories: [
        { name: 'Custom', workflows: ['custom'], children: [] },
      ],
      hasUserCategories: true,
      showOthersCategory: true,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedWorkflows(allWorkflows, config, new Set());
    expect(categorized.categories).toEqual([
      { name: 'Custom', workflows: ['custom'], children: [] },
      {
        name: BUILTIN_CATEGORY_NAME,
        workflows: [],
        children: [
          { name: 'Default', workflows: ['default'], children: [] },
          { name: 'Review', workflows: ['review'], children: [] },
        ],
      },
      { name: 'Others', workflows: ['extra'], children: [] },
    ]);
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

  it('should append repertoire category for @scope workflows', () => {
    const allWorkflows = createWorkflowMap([
      { name: 'default', source: 'builtin' },
      { name: '@nrslib/takt-ensemble/expert', source: 'repertoire' },
      { name: '@nrslib/takt-ensemble/reviewer', source: 'repertoire' },
    ]);
    const config = {
      workflowCategories: [{ name: 'Main', workflows: ['default'], children: [] }],
      builtinWorkflowCategories: [{ name: 'Main', workflows: ['default'], children: [] }],
      userWorkflowCategories: [],
      hasUserCategories: false,
      showOthersCategory: true,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedWorkflows(allWorkflows, config, new Set());

    // repertoire category is appended
    const repertoireCat = categorized.categories.find((c) => c.name === 'repertoire');
    expect(repertoireCat).toBeDefined();
    expect(repertoireCat!.children).toHaveLength(1);
    expect(repertoireCat!.children[0]!.name).toBe('@nrslib/takt-ensemble');
    expect(repertoireCat!.children[0]!.workflows).toEqual(
      expect.arrayContaining(['@nrslib/takt-ensemble/expert', '@nrslib/takt-ensemble/reviewer']),
    );

    // @scope workflows must not appear in Others
    const othersCat = categorized.categories.find((c) => c.name === 'Others');
    expect(othersCat?.workflows ?? []).not.toContain('@nrslib/takt-ensemble/expert');
  });

  it('should not append repertoire category when no @scope workflows exist', () => {
    const allWorkflows = createWorkflowMap([{ name: 'default', source: 'builtin' }]);
    const config = {
      workflowCategories: [{ name: 'Main', workflows: ['default'], children: [] }],
      builtinWorkflowCategories: [{ name: 'Main', workflows: ['default'], children: [] }],
      userWorkflowCategories: [],
      hasUserCategories: false,
      showOthersCategory: true,
      othersCategoryName: 'Others',
    };

    const categorized = buildCategorizedWorkflows(allWorkflows, config, new Set());

    const repertoireCat = categorized.categories.find((c) => c.name === 'repertoire');
    expect(repertoireCat).toBeUndefined();
  });
});
