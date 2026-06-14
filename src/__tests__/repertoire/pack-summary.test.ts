/**
 * Unit tests for pack-summary utility functions.
 *
 * Covers:
 * - summarizeFacetsByType: counting facets by type from relative paths
 * - detectEditWorkflows: detecting workflows with edit: true steps
 * - formatEditWorkflowWarnings: formatting warning lines per EditWorkflowInfo
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PACKAGE_PROVIDER_OPTIONS_DIR,
  summarizeFacetsByType,
  detectEditWorkflows,
  formatEditWorkflowWarnings,
} from '../../features/repertoire/pack-summary.js';
import { getScopedProviderOptionsCandidateKey } from '../../infra/config/loaders/providerOptionsLookupDirectories.js';

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

  it('should not crash when steps, promotion, or parallel use object form', () => {
    const workflows = [
      { name: 'object-steps.yaml', content: 'steps: {}\n' },
      {
        name: 'object-promotion.yaml',
        content: `
steps:
  - name: promote
    required_permission_mode: bypassPermissions
    promotion: {}
`.trim(),
      },
      {
        name: 'object-parallel.yaml',
        content: `
steps:
  - name: reviewers
    edit: true
    parallel: {}
`.trim(),
      },
    ];

    const result = detectEditWorkflows(workflows);

    expect(result.map((workflow) => workflow.name)).toEqual([
      'object-promotion.yaml',
      'object-parallel.yaml',
    ]);
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

  it('should respect empty step allowed_tools as an override of workflow_config tools', () => {
    const content = `
workflow_config:
  provider_options:
    claude:
      allowed_tools: [Read]
steps:
  - name: review
    edit: true
    provider_options:
      claude:
        allowed_tools: []
`.trim();
    const result = detectEditWorkflows([{ name: 'workflow-level-override.yaml', content }]);

    expect(result).toHaveLength(1);
    expect(result[0]!.allowedTools).toEqual([]);
  });

  it('should detect provider_options named $ref tools from package provider-options presets', () => {
    const content = `
workflow_config:
  provider_options:
    $ref: edit
steps:
  - name: plan
    edit: false
`.trim();
    const result = detectEditWorkflows(
      [{ name: 'workflow.yaml', content, relativePath: 'workflows/workflow.yaml' }],
      [{
        name: 'edit.yaml',
        relativePath: 'provider-options/edit.yaml',
        content: 'claude:\n  allowed_tools: [Bash, Write]\n',
      }],
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.allowedTools).toEqual(expect.arrayContaining(['Bash', 'Write']));
  });

  it('should detect provider_options path $ref tools from workflow-relative presets', () => {
    const content = `
steps:
  - name: plan
    provider_options:
      $ref: provider-options/edit.yaml
`.trim();
    const result = detectEditWorkflows(
      [{ name: 'workflow.yaml', content, relativePath: 'workflows/workflow.yaml' }],
      [{
        name: 'edit.yaml',
        relativePath: 'workflows/provider-options/edit.yaml',
        content: 'claude:\n  allowed_tools: [Bash, Edit]\n',
      }],
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.allowedTools).toEqual(expect.arrayContaining(['Bash', 'Edit']));
  });

  it('should throw when provider_options named $ref is missing from package provider-options presets', () => {
    const content = `
steps:
  - name: plan
    provider_options:
      $ref: missing
`.trim();

    expect(() => detectEditWorkflows(
      [{ name: 'workflow.yaml', content, relativePath: 'workflows/workflow.yaml' }],
      [],
    )).toThrow(/provider_options\.\$ref not found: missing/);
  });

  it('should throw when provider_options $ref contains a circular reference', () => {
    const content = `
steps:
  - name: plan
    provider_options:
      $ref: first
`.trim();

    expect(() => detectEditWorkflows(
      [{ name: 'workflow.yaml', content, relativePath: 'workflows/workflow.yaml' }],
      [
        { name: 'first.yaml', relativePath: 'provider-options/first.yaml', content: '$ref: second\n' },
        { name: 'second.yaml', relativePath: 'provider-options/second.yaml', content: '$ref: first\n' },
      ],
    )).toThrow(/provider_options\.\$ref contains a circular reference/);
  });

  it('should not resolve nested provider-options files by basename as bare named $ref', () => {
    const content = `
steps:
  - name: plan
    provider_options:
      $ref: edit
`.trim();

    expect(() => detectEditWorkflows(
      [{ name: 'workflow.yaml', content, relativePath: 'workflows/workflow.yaml' }],
      [{
        name: 'edit.yaml',
        relativePath: 'provider-options/nested/edit.yaml',
        content: 'claude:\n  allowed_tools: [Bash]\n',
      }],
    )).toThrow(/provider_options\.\$ref not found: edit/);
  });

  it('should detect provider_options named $ref tools from promotion entries and workflow_call overrides', () => {
    const content = `
steps:
  - name: implement
    promotion:
      - at: 2
        provider_options:
          $ref: promotion-edit
  - name: delegate
    kind: workflow_call
    call: child
    overrides:
      provider_options:
        $ref: call-edit
`.trim();

    const result = detectEditWorkflows(
      [{ name: 'workflow.yaml', content, relativePath: 'workflows/workflow.yaml' }],
      [
        {
          name: 'promotion-edit.yaml',
          relativePath: 'provider-options/promotion-edit.yaml',
          content: 'claude:\n  allowed_tools: [Bash]\n',
        },
        {
          name: 'call-edit.yaml',
          relativePath: 'provider-options/call-edit.yaml',
          content: 'claude:\n  allowed_tools: [Write]\n',
        },
      ],
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.hasEdit).toBe(false);
    expect(result[0]!.allowedTools).toEqual(expect.arrayContaining(['Bash', 'Write']));
    expect(result[0]!.allowedTools).toHaveLength(2);
  });

  it('should detect provider_options named $ref tools from parallel sub-steps', () => {
    const content = `
steps:
  - name: reviewers
    parallel:
      - name: coding-review
        provider_options:
          $ref: edit
`.trim();

    const result = detectEditWorkflows(
      [{ name: 'workflow.yaml', content, relativePath: 'workflows/workflow.yaml' }],
      [{
        name: 'edit.yaml',
        relativePath: 'provider-options/edit.yaml',
        content: 'claude:\n  allowed_tools: [Bash]\n',
      }],
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.hasEdit).toBe(false);
    expect(result[0]!.allowedTools).toEqual(['Bash']);
  });

  it('should detect provider_options named $ref tools from fallback provider-options candidate directories', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-pack-summary-provider-options-fallback-'));
    try {
      const builtinProviderOptionsDir = join(tempDir, 'builtins', 'ja', 'provider-options');
      mkdirSync(builtinProviderOptionsDir, { recursive: true });
      writeFileSync(join(builtinProviderOptionsDir, 'review-readonly.yaml'), 'claude:\n  allowed_tools: [Read]\n');

      const content = `
steps:
  - name: review
    provider_options:
      $ref: review-readonly
`.trim();

      const result = detectEditWorkflows(
        [{ name: 'workflow.yaml', content, relativePath: 'workflows/workflow.yaml' }],
        [],
        { providerOptionsCandidateDirs: [builtinProviderOptionsDir] },
      );

      expect(result).toHaveLength(1);
      expect(result[0]!.allowedTools).toEqual(['Read']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should prefer package provider-options over fallback candidate directories', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-pack-summary-provider-options-priority-'));
    try {
      const builtinProviderOptionsDir = join(tempDir, 'builtins', 'ja', 'provider-options');
      mkdirSync(builtinProviderOptionsDir, { recursive: true });
      writeFileSync(join(builtinProviderOptionsDir, 'review.yaml'), 'claude:\n  allowed_tools: [Read]\n');

      const content = `
steps:
  - name: review
    provider_options:
      $ref: review
`.trim();

      const result = detectEditWorkflows(
        [{ name: 'workflow.yaml', content, relativePath: 'workflows/workflow.yaml' }],
        [{
          name: 'review.yaml',
          relativePath: 'provider-options/review.yaml',
          content: 'claude:\n  allowed_tools: [Bash]\n',
        }],
        { providerOptionsCandidateDirs: [builtinProviderOptionsDir] },
      );

      expect(result).toHaveLength(1);
      expect(result[0]!.allowedTools).toEqual(['Bash']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should resolve scoped provider_options refs when a context is provided', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-pack-summary-provider-options-scope-'));
    try {
      const scopedProviderOptionsDir = join(tempDir, '@nrslib', 'takt-review', 'provider-options');
      mkdirSync(scopedProviderOptionsDir, { recursive: true });
      writeFileSync(join(scopedProviderOptionsDir, 'edit.yaml'), 'claude:\n  allowed_tools: [Bash]\n');

      const content = `
steps:
  - name: review
    provider_options:
      $ref: "@nrslib/takt-review/edit"
`.trim();

      const result = detectEditWorkflows(
        [{ name: 'workflow.yaml', content, relativePath: 'workflows/workflow.yaml' }],
        [],
        {
          context: {
            lang: 'ja',
            repertoireDir: tempDir,
          },
        },
      );

      expect(result).toHaveLength(1);
      expect(result[0]!.allowedTools).toEqual(['Bash']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should resolve self scoped provider_options refs from package provider-options presets', () => {
    const content = `
steps:
  - name: review
    provider_options:
      $ref: "@nrslib/takt-review/edit"
`.trim();

    const result = detectEditWorkflows(
      [{ name: 'workflow.yaml', content, relativePath: 'workflows/workflow.yaml' }],
      [{
        name: 'edit.yaml',
        relativePath: 'provider-options/edit.yaml',
        content: 'claude:\n  allowed_tools: [Bash]\n',
      }],
      {
        providerOptionsScopedCandidateDirs: new Map([
          [getScopedProviderOptionsCandidateKey('nrslib', 'takt-review'), [PACKAGE_PROVIDER_OPTIONS_DIR]],
        ]),
        context: {
          lang: 'ja',
          repertoireDir: '/not-installed-yet',
        },
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.allowedTools).toEqual(['Bash']);
  });

  it('should detect opencode provider_options named $ref tools from package provider-options presets', () => {
    const content = `
steps:
  - name: run
    provider_options:
      $ref: opencode-edit
`.trim();

    const result = detectEditWorkflows(
      [{ name: 'workflow.yaml', content, relativePath: 'workflows/workflow.yaml' }],
      [{
        name: 'opencode-edit.yaml',
        relativePath: 'provider-options/opencode-edit.yaml',
        content: 'opencode:\n  allowed_tools: [read, bash]\n',
      }],
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.allowedTools).toEqual(expect.arrayContaining(['read', 'bash']));
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
    expect(warnings).toEqual(['\n   ⚠ workflow.yaml: edit: true, provider_options.allowed_tools: [Bash, Edit]']);
  });

  it('should format provider_options.claude.allowed_tools-only warning when edit:false', () => {
    const warnings = formatEditWorkflowWarnings({
      name: 'runner.yaml',
      hasEdit: false,
      allowedTools: ['Bash'],
      requiredPermissionModes: [],
    });
    expect(warnings).toEqual(['\n   ⚠ runner.yaml: provider_options.allowed_tools: [Bash]']);
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
      '\n   ⚠ combo.yaml: provider_options.allowed_tools: [Bash]',
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
