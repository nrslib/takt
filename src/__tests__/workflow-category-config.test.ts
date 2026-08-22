/**
 * Tests for workflow category configuration loading and building
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { WorkflowWithSource } from '../infra/config/index.js';
import type { WorkflowDirEntry } from '../infra/config/loaders/workflowLoader.js';
import {
  buildWorkflowSelectionItems,
  buildTopLevelSelectOptions,
  parseCategorySelection,
  buildCategoryWorkflowOptions,
  type WorkflowSelectionItem,
} from '../features/workflowSelection/index.js';

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
  getWorkflowDescriptions,
  loadDefaultCategories,
  resolveIgnoredWorkflows,
  buildCategorizedWorkflows,
  findWorkflowCategories,
} = await import('../infra/config/loaders/workflowCategories.js');
const { listBuiltinWorkflowNamesForDir } = await import('../infra/config/loaders/workflowDiscovery.js');
const {
  parseWorkflowCategoryConfig,
  parseWorkflowCategoryOverlay,
} = await import('../infra/config/loaders/workflowCategoryParser.js');
const {
  listWorkflows,
  listWorkflowEntries,
  loadAllWorkflows,
  loadWorkflow,
} = await import('../infra/config/loaders/workflowLoader.js');

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

  it('should load workflow descriptions from the category file', () => {
    writeYaml(join(resourcesDir, 'workflow-categories.yaml'), `
workflow_categories:
  Quick Start:
    workflows:
      - default
workflow_descriptions:
  default: Standard coding workflow
  user-only: User workflow description
`);

    const config = loadDefaultCategories(testDir);

    expect(config!.workflowDescriptions).toEqual({
      default: 'Standard coding workflow',
      'user-only': 'User workflow description',
    });
  });

  it('should let user descriptions override builtin names and add user-only names', () => {
    writeYaml(join(resourcesDir, 'workflow-categories.yaml'), `
workflow_categories:
  Main:
    workflows:
      - default
workflow_descriptions:
  default: Builtin description
  review: Builtin review description
`);
    writeYaml(pathsState.userCategoriesPath, `
workflow_descriptions:
  default: User description
  custom: User-only description
`);

    const config = getWorkflowCategories(testDir);

    expect(config!.workflowDescriptions).toEqual({
      default: 'User description',
      review: 'Builtin review description',
      custom: 'User-only description',
    });
  });

  it('should load descriptions for the flat path when categories are unavailable', () => {
    writeYaml(pathsState.userCategoriesPath, `
workflow_descriptions:
  custom: User-only description
`);

    expect(getWorkflowDescriptions(testDir)).toEqual({
      custom: 'User-only description',
    });
  });

  it('should reject empty workflow descriptions', () => {
    expect(() => parseWorkflowCategoryOverlay({
      workflow_descriptions: { default: '   ' },
    }, 'test-categories.yaml')).toThrow(
      'description must be a non-empty string in test-categories.yaml at workflow_descriptions > default',
    );
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

const SAMPLE_WORKFLOW = `name: test-workflow
description: Test workflow
initial_step: step1
max_steps: 1

steps:
  - name: step1
    persona: coder
    instruction: "{task}"
`;

function createWorkflowFile(dir: string, name: string, content?: string): void {
  writeFileSync(join(dir, `${name}.yaml`), content ?? SAMPLE_WORKFLOW);
}

describe('workflow categories (directory scanning and loading)', () => {
  let tempDir: string;
  let workflowsDir: string;

  beforeEach(() => {
    languageState.value = 'en';
    configState.enableBuiltinWorkflows = false;
    configState.disabledBuiltins = [];
    tempDir = mkdtempSync(join(tmpdir(), 'takt-cat-test-'));
    workflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('directory scanning', () => {
    it('should discover root-level workflows', () => {
      createWorkflowFile(workflowsDir, 'simple');
      createWorkflowFile(workflowsDir, 'advanced');

      const workflows = listWorkflows(tempDir);
      expect(workflows).toContain('simple');
      expect(workflows).toContain('advanced');
    });

    it('should discover workflows in subdirectories with category prefix', () => {
      const frontendDir = join(workflowsDir, 'frontend');
      mkdirSync(frontendDir);
      createWorkflowFile(frontendDir, 'react');
      createWorkflowFile(frontendDir, 'vue');

      const workflows = listWorkflows(tempDir);
      expect(workflows).toContain('frontend/react');
      expect(workflows).toContain('frontend/vue');
    });

    it('should discover both root-level and categorized workflows', () => {
      createWorkflowFile(workflowsDir, 'simple');

      const frontendDir = join(workflowsDir, 'frontend');
      mkdirSync(frontendDir);
      createWorkflowFile(frontendDir, 'react');

      const backendDir = join(workflowsDir, 'backend');
      mkdirSync(backendDir);
      createWorkflowFile(backendDir, 'api');

      const workflows = listWorkflows(tempDir);
      expect(workflows).toContain('simple');
      expect(workflows).toContain('frontend/react');
      expect(workflows).toContain('backend/api');
    });

    it('should not scan deeper than 1 level', () => {
      const deepDir = join(workflowsDir, 'category', 'subcategory');
      mkdirSync(deepDir, { recursive: true });
      createWorkflowFile(deepDir, 'deep');

      const workflows = listWorkflows(tempDir);
      // category/subcategory should be treated as a directory entry, not scanned further
      expect(workflows).not.toContain('category/subcategory/deep');
      // Only 1-level: category/deep would not exist since deep.yaml is in subcategory
      expect(workflows).not.toContain('deep');
    });
  });

  describe('listWorkflowEntries', () => {
    it('should return entries with category information', () => {
      createWorkflowFile(workflowsDir, 'simple');

      const frontendDir = join(workflowsDir, 'frontend');
      mkdirSync(frontendDir);
      createWorkflowFile(frontendDir, 'react');

      const entries = listWorkflowEntries(tempDir);
      const simpleEntry = entries.find((e) => e.name === 'simple');
      const reactEntry = entries.find((e) => e.name === 'frontend/react');

      expect(simpleEntry).toBeDefined();
      expect(simpleEntry!.category).toBeUndefined();
      expect(simpleEntry!.source).toBe('project');

      expect(reactEntry).toBeDefined();
      expect(reactEntry!.category).toBe('frontend');
      expect(reactEntry!.source).toBe('project');
    });
  });

  describe('loadAllWorkflows', () => {
    it('should load categorized workflows with qualified names as keys', () => {
      const frontendDir = join(workflowsDir, 'frontend');
      mkdirSync(frontendDir);
      createWorkflowFile(frontendDir, 'react');

      const workflows = loadAllWorkflows(tempDir);
      expect(workflows.has('frontend/react')).toBe(true);
    });
  });

  describe('loadWorkflow', () => {
    it('should load workflow by category/name identifier', () => {
      const frontendDir = join(workflowsDir, 'frontend');
      mkdirSync(frontendDir);
      createWorkflowFile(frontendDir, 'react');

      const workflow = loadWorkflow('frontend/react', tempDir);
      expect(workflow).not.toBeNull();
      expect(workflow!.name).toBe('test-workflow');
    });

    it('should return null for non-existent category/name', () => {
      const workflow = loadWorkflow('nonexistent/workflow', tempDir);
      expect(workflow).toBeNull();
    });

    it('should support .yml extension in subdirectories', () => {
      const backendDir = join(workflowsDir, 'backend');
      mkdirSync(backendDir);
      writeFileSync(join(backendDir, 'api.yml'), SAMPLE_WORKFLOW);

      const workflow = loadWorkflow('backend/api', tempDir);
      expect(workflow).not.toBeNull();
    });
  });
});

describe('buildWorkflowSelectionItems', () => {
  it('should separate root workflows and categories', () => {
    const entries: WorkflowDirEntry[] = [
      { name: 'simple', path: '/tmp/simple.yaml', source: 'project' },
      { name: 'frontend/react', path: '/tmp/frontend/react.yaml', category: 'frontend', source: 'project' },
      { name: 'frontend/vue', path: '/tmp/frontend/vue.yaml', category: 'frontend', source: 'project' },
      { name: 'backend/api', path: '/tmp/backend/api.yaml', category: 'backend', source: 'project' },
    ];

    const items = buildWorkflowSelectionItems(entries);

    const workflows = items.filter((i) => i.type === 'workflow');
    const categories = items.filter((i) => i.type === 'category');

    expect(workflows).toHaveLength(1);
    expect(workflows[0]!.name).toBe('simple');

    expect(categories).toHaveLength(2);
    const frontend = categories.find((c) => c.name === 'frontend');
    expect(frontend).toBeDefined();
    expect(frontend!.type === 'category' && frontend!.workflows).toEqual(['frontend/react', 'frontend/vue']);

    const backend = categories.find((c) => c.name === 'backend');
    expect(backend).toBeDefined();
    expect(backend!.type === 'category' && backend!.workflows).toEqual(['backend/api']);
  });

  it('should sort items alphabetically', () => {
    const entries: WorkflowDirEntry[] = [
      { name: 'zebra', path: '/tmp/zebra.yaml', source: 'project' },
      { name: 'alpha', path: '/tmp/alpha.yaml', source: 'project' },
      { name: 'misc/playground', path: '/tmp/misc/playground.yaml', category: 'misc', source: 'project' },
    ];

    const items = buildWorkflowSelectionItems(entries);
    const names = items.map((i) => i.name);
    expect(names).toEqual(['alpha', 'misc', 'zebra']);
  });

  it('should return empty array for empty input', () => {
    const items = buildWorkflowSelectionItems([]);
    expect(items).toEqual([]);
  });
});

describe('2-stage category selection helpers', () => {
  const items: WorkflowSelectionItem[] = [
    { type: 'workflow', name: 'simple' },
    { type: 'category', name: 'frontend', workflows: ['frontend/react', 'frontend/vue'] },
    { type: 'category', name: 'backend', workflows: ['backend/api'] },
  ];

  describe('buildTopLevelSelectOptions', () => {
    it('should encode categories with prefix in value', () => {
      const options = buildTopLevelSelectOptions(items);
      const categoryOption = options.find((o) => o.label.includes('frontend'));
      expect(categoryOption).toBeDefined();
      expect(categoryOption!.value).toBe('__category__:frontend');
    });
  });

  describe('parseCategorySelection', () => {
    it('should return category name for category selection', () => {
      expect(parseCategorySelection('__category__:frontend')).toBe('frontend');
    });

    it('should return null for direct workflow selection', () => {
      expect(parseCategorySelection('simple')).toBeNull();
    });
  });

  describe('buildCategoryWorkflowOptions', () => {
    it('should return options for workflows in a category', () => {
      const options = buildCategoryWorkflowOptions(items, 'frontend');
      expect(options).not.toBeNull();
      expect(options).toHaveLength(2);
      expect(options![0]!.value).toBe('frontend/react');
      expect(options![0]!.label).toBe('react');
    });

    it('should return null for non-existent category', () => {
      expect(buildCategoryWorkflowOptions(items, 'nonexistent')).toBeNull();
    });
  });
});
