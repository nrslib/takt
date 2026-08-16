/**
 * Unit tests for repertoire pack-summary utilities.
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

function providerOptionsPreset(name: string, allowedTools: string[]) {
  return {
    name: `${name}.yaml`,
    relativePath: `provider-options/${name}.yaml`,
    content: `claude:\n  allowed_tools: [${allowedTools.join(', ')}]\n`,
  };
}

const editPreset = providerOptionsPreset('edit', ['Bash', 'Write', 'Edit']);
const readonlyPreset = providerOptionsPreset('readonly', ['Read']);

describe('summarizeFacetsByType', () => {
  it('should return "0" for an empty list', () => {
    expect(summarizeFacetsByType([])).toBe('0');
  });

  it('should count single type correctly', () => {
    expect(summarizeFacetsByType([
      'facets/personas/coder.md',
      'facets/personas/reviewer.md',
    ])).toBe('2 personas');
  });

  it('should count multiple types and skip malformed paths', () => {
    const result = summarizeFacetsByType([
      'facets/personas/coder.md',
      'facets/personas/reviewer.md',
      'facets/policies/coding.md',
      'facets/knowledge/typescript.md',
      'facets/',
      'facets//ignored.md',
    ]);
    expect(result).toContain('2 personas');
    expect(result).toContain('1 policies');
    expect(result).toContain('1 knowledge');
  });
});

describe('detectEditWorkflows', () => {
  it('should return empty array for empty input and non-permission workflows', () => {
    expect(detectEditWorkflows([])).toEqual([]);
    expect(detectEditWorkflows([{
      name: 'simple.yaml',
      content: 'steps:\n  - name: run\n    edit: false\n',
    }])).toEqual([]);
  });

  it('should resolve capability references for editable steps', () => {
    const result = detectEditWorkflows([{
      name: 'coder.yaml',
      content: 'steps:\n  - name: implement\n    edit: true\n    capabilities: edit\n',
    }], [editPreset]);

    expect(result).toEqual([{
      name: 'coder.yaml',
      allowedTools: ['Bash', 'Write', 'Edit'],
      hasEdit: true,
      requiredPermissionModes: [],
    }]);
  });

  it('should merge workflow and step capability sets', () => {
    const result = detectEditWorkflows([{
      name: 'workflow.yaml',
      content: `capabilities: readonly
steps:
  - name: plan
    edit: false
  - name: implement
    edit: true
    capabilities: edit
`,
    }], [editPreset, readonlyPreset]);

    expect(result).toHaveLength(1);
    expect(result[0]!.hasEdit).toBe(true);
    expect(result[0]!.allowedTools).toEqual(['Read', 'Bash', 'Write', 'Edit']);
  });

  it('should collect capabilities from fixed and pool parallel sub-steps', () => {
    const result = detectEditWorkflows([{
      name: 'parallel.yaml',
      content: `steps:
  - name: reviewers
    parallel:
      fixed:
        - name: architecture
          capabilities: edit
          edit: true
      pool:
        - name: security
          capabilities: readonly
          required_permission_mode: bypassPermissions
      selection:
        mode: replace
`,
    }], [editPreset, readonlyPreset]);

    expect(result).toEqual([{
      name: 'parallel.yaml',
      allowedTools: ['Bash', 'Write', 'Edit', 'Read'],
      hasEdit: true,
      requiredPermissionModes: ['bypassPermissions'],
    }]);
  });

  it('should resolve capabilities inherited from a package step fragment', () => {
    const packageRoot = mkdtempSync(join(tmpdir(), 'takt-pack-summary-step-fragment-'));
    try {
      const stepsDir = join(packageRoot, 'steps');
      mkdirSync(stepsDir, { recursive: true });
      writeFileSync(join(stepsDir, 'permissioned.yaml'), `capabilities: edit
edit: true
required_permission_mode: bypassPermissions
`);

      const result = detectEditWorkflows([{
        name: 'workflow.yaml',
        content: `steps:
  - name: permissioned
    uses: permissioned
    rules:
      - condition: COMPLETE
        next: COMPLETE
`,
        relativePath: 'workflows/workflow.yaml',
      }], [editPreset], {
        stepFragmentCandidateDirs: [stepsDir],
        context: {
          lang: 'en',
          projectDir: packageRoot,
          repertoireDir: join(packageRoot, 'repertoire'),
          workflowDir: join(packageRoot, 'workflows'),
        },
      });

      expect(result).toEqual([{
        name: 'workflow.yaml',
        allowedTools: ['Bash', 'Write', 'Edit'],
        hasEdit: true,
        requiredPermissionModes: ['bypassPermissions'],
      }]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('should resolve self-scoped capabilities from a package provider-options preset', () => {
    const result = detectEditWorkflows([{
      name: 'workflow.yaml',
      content: `steps:
  - name: review
    capabilities: "@nrslib/takt-review/edit"
`,
      relativePath: 'workflows/workflow.yaml',
    }], [editPreset], {
      providerOptionsScopedCandidateDirs: new Map([
        [getScopedProviderOptionsCandidateKey('nrslib', 'takt-review'), [PACKAGE_PROVIDER_OPTIONS_DIR]],
      ]),
      context: {
        lang: 'ja',
        repertoireDir: '/not-installed-yet',
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.allowedTools).toEqual(['Bash', 'Write', 'Edit']);
  });

  it('should resolve capabilities from fallback provider-options directories', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-pack-summary-provider-options-'));
    try {
      const providerOptionsDir = join(tempDir, 'provider-options');
      mkdirSync(providerOptionsDir, { recursive: true });
      writeFileSync(join(providerOptionsDir, 'review.yaml'), 'claude:\n  allowed_tools: [Read]\n');

      const result = detectEditWorkflows([{
        name: 'workflow.yaml',
        content: 'steps:\n  - name: review\n    capabilities: review\n',
        relativePath: 'workflows/workflow.yaml',
      }], [], { providerOptionsCandidateDirs: [providerOptionsDir] });

      expect(result).toHaveLength(1);
      expect(result[0]!.allowedTools).toEqual(['Read']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should prefer package capability presets over fallback directories', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-pack-summary-provider-options-priority-'));
    try {
      const fallbackDir = join(tempDir, 'provider-options');
      mkdirSync(fallbackDir, { recursive: true });
      writeFileSync(join(fallbackDir, 'review.yaml'), 'claude:\n  allowed_tools: [Read]\n');

      const result = detectEditWorkflows([{
        name: 'workflow.yaml',
        content: 'steps:\n  - name: review\n    capabilities: review\n',
        relativePath: 'workflows/workflow.yaml',
      }], [providerOptionsPreset('review', ['Bash'])], {
        providerOptionsCandidateDirs: [fallbackDir],
      });

      expect(result).toHaveLength(1);
      expect(result[0]!.allowedTools).toEqual(['Bash']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should reject an unresolved capability reference', () => {
    expect(() => detectEditWorkflows([{
      name: 'workflow.yaml',
      content: 'steps:\n  - name: review\n    capabilities: missing\n',
      relativePath: 'workflows/workflow.yaml',
    }], [])).toThrow(/provider_options\.extends not found: missing/);
  });

  it('should skip invalid YAML and keep valid workflows', () => {
    const result = detectEditWorkflows([
      { name: 'invalid.yaml', content: ': bad: yaml: [[[' },
      { name: 'valid.yaml', content: 'steps:\n  - name: run\n    edit: true\n' },
    ]);
    expect(result).toEqual([{
      name: 'valid.yaml',
      allowedTools: [],
      hasEdit: true,
      requiredPermissionModes: [],
    }]);
  });

  it('should detect required permission mode without edit capability', () => {
    const result = detectEditWorkflows([{
      name: 'planner.yaml',
      content: 'steps:\n  - name: plan\n    required_permission_mode: bypassPermissions\n',
    }]);
    expect(result).toEqual([{
      name: 'planner.yaml',
      allowedTools: [],
      hasEdit: false,
      requiredPermissionModes: ['bypassPermissions'],
    }]);
  });
});

describe('formatEditWorkflowWarnings', () => {
  it('should sanitize terminal control sequences in workflow warnings', () => {
    const warnings = formatEditWorkflowWarnings({
      name: '\x1b]0;spoof\x07workflow.yaml',
      hasEdit: false,
      allowedTools: ['Bash\x1b[2J'],
      requiredPermissionModes: ['\x1b[31mbypassPermissions'],
    });
    expect(warnings.join('\n')).not.toContain('\x1b');
    expect(warnings.join('\n')).toContain('workflow.yaml');
  });

  it('should keep warning values on one terminal line', () => {
    const warnings = formatEditWorkflowWarnings({
      name: 'review.yaml',
      hasEdit: false,
      allowedTools: ['Write\n[forged] installed'],
      requiredPermissionModes: [],
    });
    expect(warnings).toEqual([
      '\n   ⚠ review.yaml: capabilities.allowed_tools: [Write\\n[forged] installed]',
    ]);
  });

  it('should format edit and capability warnings', () => {
    expect(formatEditWorkflowWarnings({
      name: 'workflow.yaml',
      hasEdit: true,
      allowedTools: ['Bash', 'Edit'],
      requiredPermissionModes: [],
    })).toEqual(['\n   ⚠ workflow.yaml: edit: true, capabilities.allowed_tools: [Bash, Edit]']);

    expect(formatEditWorkflowWarnings({
      name: 'runner.yaml',
      hasEdit: false,
      allowedTools: ['Bash'],
      requiredPermissionModes: [],
    })).toEqual(['\n   ⚠ runner.yaml: capabilities.allowed_tools: [Bash]']);
  });

  it('should combine capability and required permission warnings', () => {
    expect(formatEditWorkflowWarnings({
      name: 'combo.yaml',
      hasEdit: false,
      allowedTools: ['Bash'],
      requiredPermissionModes: ['bypassPermissions'],
    })).toEqual([
      '\n   ⚠ combo.yaml: capabilities.allowed_tools: [Bash]',
      '\n   ⚠ combo.yaml: required_permission_mode: bypassPermissions',
    ]);
  });

  it('should return empty array when no permission-related fields are present', () => {
    expect(formatEditWorkflowWarnings({
      name: 'review.yaml',
      hasEdit: false,
      allowedTools: [],
      requiredPermissionModes: [],
    })).toEqual([]);
  });
});
