/**
 * Tests for workflow category (subdirectory) support — Issue #85
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listWorkflows,
  listWorkflowEntries,
  loadAllWorkflows,
  loadWorkflow,
} from '../infra/config/loaders/workflowLoader.js';
import type { WorkflowDirEntry } from '../infra/config/loaders/workflowLoader.js';
import {
  buildWorkflowSelectionItems,
  buildTopLevelSelectOptions,
  parseCategorySelection,
  buildCategoryWorkflowOptions,
  type WorkflowSelectionItem,
} from '../features/workflowSelection/index.js';

const SAMPLE_WORKFLOW = `name: test-workflow
description: Test workflow
initial_step: step1
max_iterations: 1

steps:
  - name: step1
    agent: coder
    instruction: "{task}"
`;

function createWorkflow(dir: string, name: string, content?: string): void {
  writeFileSync(join(dir, `${name}.yaml`), content ?? SAMPLE_WORKFLOW);
}

describe('workflow categories - directory scanning', () => {
  let tempDir: string;
  let workflowsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-cat-test-'));
    workflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should discover root-level workflows', () => {
    createWorkflow(workflowsDir, 'simple');
    createWorkflow(workflowsDir, 'advanced');

    const workflows = listWorkflows(tempDir);
    expect(workflows).toContain('simple');
    expect(workflows).toContain('advanced');
  });

  it('should discover workflows in subdirectories with category prefix', () => {
    const frontendDir = join(workflowsDir, 'frontend');
    mkdirSync(frontendDir);
    createWorkflow(frontendDir, 'react');
    createWorkflow(frontendDir, 'vue');

    const workflows = listWorkflows(tempDir);
    expect(workflows).toContain('frontend/react');
    expect(workflows).toContain('frontend/vue');
  });

  it('should discover both root-level and categorized workflows', () => {
    createWorkflow(workflowsDir, 'simple');

    const frontendDir = join(workflowsDir, 'frontend');
    mkdirSync(frontendDir);
    createWorkflow(frontendDir, 'react');

    const backendDir = join(workflowsDir, 'backend');
    mkdirSync(backendDir);
    createWorkflow(backendDir, 'api');

    const workflows = listWorkflows(tempDir);
    expect(workflows).toContain('simple');
    expect(workflows).toContain('frontend/react');
    expect(workflows).toContain('backend/api');
  });

  it('should not scan deeper than 1 level', () => {
    const deepDir = join(workflowsDir, 'category', 'subcategory');
    mkdirSync(deepDir, { recursive: true });
    createWorkflow(deepDir, 'deep');

    const workflows = listWorkflows(tempDir);
    // category/subcategory should be treated as a directory entry, not scanned further
    expect(workflows).not.toContain('category/subcategory/deep');
    // Only 1-level: category/deep would not exist since deep.yaml is in subcategory
    expect(workflows).not.toContain('deep');
  });
});

describe('workflow categories - listWorkflowEntries', () => {
  let tempDir: string;
  let workflowsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-cat-test-'));
    workflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return entries with category information', () => {
    createWorkflow(workflowsDir, 'simple');

    const frontendDir = join(workflowsDir, 'frontend');
    mkdirSync(frontendDir);
    createWorkflow(frontendDir, 'react');

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

describe('workflow categories - loadAllWorkflows', () => {
  let tempDir: string;
  let workflowsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-cat-test-'));
    workflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load categorized workflows with qualified names as keys', () => {
    const frontendDir = join(workflowsDir, 'frontend');
    mkdirSync(frontendDir);
    createWorkflow(frontendDir, 'react');

    const workflows = loadAllWorkflows(tempDir);
    expect(workflows.has('frontend/react')).toBe(true);
  });
});

describe('workflow categories - loadWorkflow', () => {
  let tempDir: string;
  let workflowsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-cat-test-'));
    workflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load workflow by category/name identifier', () => {
    const frontendDir = join(workflowsDir, 'frontend');
    mkdirSync(frontendDir);
    createWorkflow(frontendDir, 'react');

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
      const options = buildTopLevelSelectOptions(items, '');
      const categoryOption = options.find((o) => o.label.includes('frontend'));
      expect(categoryOption).toBeDefined();
      expect(categoryOption!.value).toBe('__category__:frontend');
    });

    it('should mark current workflow', () => {
      const options = buildTopLevelSelectOptions(items, 'simple');
      const simpleOption = options.find((o) => o.value === 'simple');
      expect(simpleOption!.label).toContain('(current)');
    });

    it('should mark category containing current workflow', () => {
      const options = buildTopLevelSelectOptions(items, 'frontend/react');
      const frontendOption = options.find((o) => o.value === '__category__:frontend');
      expect(frontendOption!.label).toContain('(current)');
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
      const options = buildCategoryWorkflowOptions(items, 'frontend', '');
      expect(options).not.toBeNull();
      expect(options).toHaveLength(2);
      expect(options![0]!.value).toBe('frontend/react');
      expect(options![0]!.label).toBe('react');
    });

    it('should mark current workflow in category', () => {
      const options = buildCategoryWorkflowOptions(items, 'frontend', 'frontend/vue');
      const vueOption = options!.find((o) => o.value === 'frontend/vue');
      expect(vueOption!.label).toContain('(current)');
    });

    it('should return null for non-existent category', () => {
      expect(buildCategoryWorkflowOptions(items, 'nonexistent', '')).toBeNull();
    });
  });
});
