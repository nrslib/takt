/**
 * Unit tests for pack-summary utility functions.
 *
 * Covers:
 * - summarizeFacetsByType: counting facets by type from relative paths
 * - detectEditWorkflows: detecting workflows with edit: true steps
 * - formatEditWorkflowWarnings: formatting warning lines per EditWorkflowInfo
 */

import { describe, it, expect } from 'vitest';
import { summarizeFacetsByType, detectEditWorkflows, formatEditWorkflowWarnings } from '../../features/repertoire/pack-summary.js';

// ---------------------------------------------------------------------------
// summarizeFacetsByType
// ---------------------------------------------------------------------------

describe('summarizeFacetsByType', () => {
  it('should return "0" for an empty list', () => {
    expect(summarizeFacetsByType([])).toBe('0');
  });

  it('should count single type correctly', () => {
    const paths = [
      'facets/personas/coder.md',
      'facets/personas/reviewer.md',
    ];
    expect(summarizeFacetsByType(paths)).toBe('2 personas');
  });

  it('should count multiple types and join with commas', () => {
    const paths = [
      'facets/personas/coder.md',
      'facets/personas/reviewer.md',
      'facets/policies/coding.md',
      'facets/knowledge/typescript.md',
      'facets/knowledge/react.md',
    ];
    const result = summarizeFacetsByType(paths);
    // Order depends on insertion order; check all types are present
    expect(result).toContain('2 personas');
    expect(result).toContain('1 policies');
    expect(result).toContain('2 knowledge');
  });

  it('should skip paths that do not have at least 2 segments', () => {
    const paths = ['facets/', 'facets/personas/coder.md'];
    expect(summarizeFacetsByType(paths)).toBe('1 personas');
  });

  it('should skip paths where second segment is empty', () => {
    // 'facets//coder.md' splits to ['facets', '', 'coder.md']
    const paths = ['facets//coder.md', 'facets/personas/coder.md'];
    expect(summarizeFacetsByType(paths)).toBe('1 personas');
  });
});

// ---------------------------------------------------------------------------
// detectEditWorkflows
// ---------------------------------------------------------------------------

describe('detectEditWorkflows', () => {
  it('should return empty array for empty input', () => {
    expect(detectEditWorkflows([])).toEqual([]);
  });

  it('should return empty array when a workflow has edit: false, no provider_options.claude.allowed_tools, and no required_permission_mode', () => {
    const workflows = [
      { name: 'simple.yaml', content: 'steps:\n  - name: run\n    edit: false\n' },
    ];
    expect(detectEditWorkflows(workflows)).toEqual([]);
  });

  it('should detect a workflow with edit: true and collect provider_options.claude.allowed_tools', () => {
    const content = `
steps:
  - name: implement
    edit: true
    provider_options:
      claude:
        allowed_tools: [Bash, Write, Edit]
`.trim();
    const result = detectEditWorkflows([{ name: 'coder.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('coder.yaml');
    expect(result[0]!.allowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit']));
    expect(result[0]!.allowedTools).toHaveLength(3);
  });

  it('should merge provider_options.claude.allowed_tools from multiple edit steps', () => {
    const content = `
steps:
  - name: implement
    edit: true
    provider_options:
      claude:
        allowed_tools: [Bash, Write]
  - name: fix
    edit: true
    provider_options:
      claude:
        allowed_tools: [Edit, Bash]
`.trim();
    const result = detectEditWorkflows([{ name: 'coder.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.allowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit']));
    expect(result[0]!.allowedTools).toHaveLength(3);
  });

  it('should detect a workflow with edit: true and no provider_options.claude.allowed_tools', () => {
    const content = `
steps:
  - name: implement
    edit: true
`.trim();
    const result = detectEditWorkflows([{ name: 'coder.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.allowedTools).toEqual([]);
  });

  it('should skip workflows with invalid YAML silently', () => {
    const workflows = [
      { name: 'invalid.yaml', content: ': bad: yaml: [[[' },
      {
        name: 'valid.yaml',
        content: 'steps:\n  - name: run\n    edit: true\n',
      },
    ];
    const result = detectEditWorkflows(workflows);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('valid.yaml');
  });

  it('should skip a workflow that has no steps field', () => {
    const workflows = [{ name: 'empty.yaml', content: 'description: no steps' }];
    expect(detectEditWorkflows(workflows)).toEqual([]);
  });

  it('should return multiple results when multiple workflows have edit: true', () => {
    const workflows = [
      {
        name: 'coder.yaml',
        content: 'steps:\n  - name: impl\n    edit: true\n    provider_options:\n      claude:\n        allowed_tools: [Write]\n',
      },
      {
        name: 'reviewer.yaml',
        content: 'steps:\n  - name: review\n    edit: false\n',
      },
      {
        name: 'fixer.yaml',
        content: 'steps:\n  - name: fix\n    edit: true\n    provider_options:\n      claude:\n        allowed_tools: [Edit]\n',
      },
    ];
    const result = detectEditWorkflows(workflows);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.name)).toEqual(expect.arrayContaining(['coder.yaml', 'fixer.yaml']));
  });

  it('should set hasEdit: true for workflows with edit: true', () => {
    const content = 'steps:\n  - name: impl\n    edit: true\n    provider_options:\n      claude:\n        allowed_tools: [Write]\n';
    const result = detectEditWorkflows([{ name: 'coder.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.hasEdit).toBe(true);
    expect(result[0]!.requiredPermissionModes).toEqual([]);
  });

  it('should detect required_permission_mode and set hasEdit: false when no edit: true', () => {
    const content = `
steps:
  - name: plan
    required_permission_mode: bypassPermissions
`.trim();
    const result = detectEditWorkflows([{ name: 'planner.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('planner.yaml');
    expect(result[0]!.hasEdit).toBe(false);
    expect(result[0]!.requiredPermissionModes).toEqual(['bypassPermissions']);
    expect(result[0]!.allowedTools).toEqual([]);
  });

  it('should detect both edit: true and required_permission_mode in the same workflow', () => {
    const content = `
steps:
  - name: implement
    edit: true
    provider_options:
      claude:
        allowed_tools: [Write, Edit]
  - name: plan
    required_permission_mode: bypassPermissions
`.trim();
    const result = detectEditWorkflows([{ name: 'mixed.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.hasEdit).toBe(true);
    expect(result[0]!.allowedTools).toEqual(expect.arrayContaining(['Write', 'Edit']));
    expect(result[0]!.requiredPermissionModes).toEqual(['bypassPermissions']);
  });

  it('should deduplicate required_permission_mode values across steps', () => {
    const content = `
steps:
  - name: plan
    required_permission_mode: bypassPermissions
  - name: execute
    required_permission_mode: bypassPermissions
`.trim();
    const result = detectEditWorkflows([{ name: 'dup.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.requiredPermissionModes).toEqual(['bypassPermissions']);
  });

  it('should return empty array when a workflow has edit: false, empty provider_options.claude.allowed_tools, and no required_permission_mode', () => {
    const content = 'steps:\n  - name: review\n    edit: false\n';
    expect(detectEditWorkflows([{ name: 'reviewer.yaml', content }])).toEqual([]);
  });

  it('should detect a workflow with edit: false and non-empty provider_options.claude.allowed_tools', () => {
    const content = `
steps:
  - name: run
    edit: false
    provider_options:
      claude:
        allowed_tools: [Bash]
`.trim();
    const result = detectEditWorkflows([{ name: 'runner.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('runner.yaml');
    expect(result[0]!.hasEdit).toBe(false);
    expect(result[0]!.allowedTools).toEqual(['Bash']);
    expect(result[0]!.requiredPermissionModes).toEqual([]);
  });

  it('should detect workflow using workflow_config provider_options.claude.allowed_tools when a step does not define tools', () => {
    const content = `
workflow_config:
  provider_options:
    claude:
      allowed_tools: [Read, Grep]
steps:
  - name: plan
    edit: false
  - name: supervise
    edit: true
`.trim();
    const result = detectEditWorkflows([{ name: 'workflow-level.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('workflow-level.yaml');
    expect(result[0]!.hasEdit).toBe(true);
    expect(result[0]!.allowedTools).toEqual(expect.arrayContaining(['Read', 'Grep']));
    expect(result[0]!.allowedTools).toHaveLength(2);
  });

  it('should exclude a workflow with edit: false and empty provider_options.claude.allowed_tools', () => {
    const content = `
steps:
  - name: run
    edit: false
    provider_options:
      claude:
        allowed_tools: []
`.trim();
    expect(detectEditWorkflows([{ name: 'runner.yaml', content }])).toEqual([]);
  });

  it('should detect a workflow with edit: false and required_permission_mode set', () => {
    const content = `
steps:
  - name: plan
    edit: false
    required_permission_mode: bypassPermissions
`.trim();
    const result = detectEditWorkflows([{ name: 'planner.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.hasEdit).toBe(false);
    expect(result[0]!.requiredPermissionModes).toEqual(['bypassPermissions']);
    expect(result[0]!.allowedTools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatEditWorkflowWarnings
// ---------------------------------------------------------------------------

describe('formatEditWorkflowWarnings', () => {
  it('should format edit:true warning without provider_options.claude.allowed_tools', () => {
    const warnings = formatEditWorkflowWarnings({
      name: 'workflow.yaml',
      hasEdit: true,
      allowedTools: [],
      requiredPermissionModes: [],
    });
    expect(warnings).toEqual(['\n   ⚠ workflow.yaml: edit: true']);
  });

  it('should format edit:true warning with provider_options.claude.allowed_tools appended inline', () => {
    const warnings = formatEditWorkflowWarnings({
      name: 'workflow.yaml',
      hasEdit: true,
      allowedTools: ['Bash', 'Edit'],
      requiredPermissionModes: [],
    });
    expect(warnings).toEqual(['\n   ⚠ workflow.yaml: edit: true, provider_options.claude.allowed_tools: [Bash, Edit]']);
  });

  it('should format provider_options.claude.allowed_tools-only warning when edit:false', () => {
    const warnings = formatEditWorkflowWarnings({
      name: 'runner.yaml',
      hasEdit: false,
      allowedTools: ['Bash'],
      requiredPermissionModes: [],
    });
    expect(warnings).toEqual(['\n   ⚠ runner.yaml: provider_options.claude.allowed_tools: [Bash]']);
  });

  it('should return empty array when edit:false and no provider_options.claude.allowed_tools and no required_permission_mode', () => {
    const warnings = formatEditWorkflowWarnings({
      name: 'review.yaml',
      hasEdit: false,
      allowedTools: [],
      requiredPermissionModes: [],
    });
    expect(warnings).toEqual([]);
  });

  it('should format required_permission_mode warnings', () => {
    const warnings = formatEditWorkflowWarnings({
      name: 'planner.yaml',
      hasEdit: false,
      allowedTools: [],
      requiredPermissionModes: ['bypassPermissions'],
    });
    expect(warnings).toEqual(['\n   ⚠ planner.yaml: required_permission_mode: bypassPermissions']);
  });

  it('should combine provider_options.claude.allowed_tools and required_permission_mode warnings when edit:false', () => {
    const warnings = formatEditWorkflowWarnings({
      name: 'combo.yaml',
      hasEdit: false,
      allowedTools: ['Bash'],
      requiredPermissionModes: ['bypassPermissions'],
    });
    expect(warnings).toEqual([
      '\n   ⚠ combo.yaml: provider_options.claude.allowed_tools: [Bash]',
      '\n   ⚠ combo.yaml: required_permission_mode: bypassPermissions',
    ]);
  });

  it('should format both edit:true and required_permission_mode warnings', () => {
    const warnings = formatEditWorkflowWarnings({
      name: 'mixed.yaml',
      hasEdit: true,
      allowedTools: [],
      requiredPermissionModes: ['bypassPermissions'],
    });
    expect(warnings).toEqual([
      '\n   ⚠ mixed.yaml: edit: true',
      '\n   ⚠ mixed.yaml: required_permission_mode: bypassPermissions',
    ]);
  });
});
