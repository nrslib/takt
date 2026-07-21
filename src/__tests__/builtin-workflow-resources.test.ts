import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getLanguageResourcesDir } from '../infra/resources/index.js';
import { getBuiltinWorkflowsDir } from '../infra/config/paths.js';

describe('getBuiltinWorkflowsDir', () => {
  it('should resolve en builtin workflows directory under builtins/en/workflows', () => {
    // Given
    const root = getLanguageResourcesDir('en');
    // When
    const dir = getBuiltinWorkflowsDir('en');
    // Then
    expect(dir).toBe(join(root, 'workflows'));
  });

  it('should resolve ja builtin workflows directory under builtins/ja/workflows', () => {
    const root = getLanguageResourcesDir('ja');
    const dir = getBuiltinWorkflowsDir('ja');
    expect(dir).toBe(join(root, 'workflows'));
  });

});

describe('workflowResolver builtin layer uses workflows directory', () => {
  it('should list names from builtin workflows directory', async () => {
    const { listBuiltinWorkflowNames } = await import('../infra/config/loaders/workflowResolver.js');
    // Given / When
    const names = new Set(listBuiltinWorkflowNames(process.cwd()));
    // Then
    expect(names.has('default')).toBe(true);
  });

  it('should load default builtin workflow by name', async () => {
    const { getBuiltinWorkflow } = await import('../infra/config/loaders/workflowResolver.js');
    // Given / When
    const workflow = getBuiltinWorkflow('default', process.cwd());
    // Then
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('default');
  });

  it('should store builtin YAML files under workflows directory on disk', () => {
    const dir = getBuiltinWorkflowsDir('en');
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'default.yaml'))).toBe(true);
  });

});
