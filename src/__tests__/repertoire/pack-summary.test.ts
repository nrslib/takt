/**
 * Unit tests for pack-summary utility functions.
 *
 * Covers:
 * - summarizeFacetsByType: counting facets by type from relative paths
 * - detectEditPieces: detecting pieces with edit: true movements
 * - formatEditPieceWarnings: formatting warning lines per EditPieceInfo
 */

import { describe, it, expect } from 'vitest';
import { summarizeFacetsByType, detectEditPieces, formatEditPieceWarnings } from '../../features/repertoire/pack-summary.js';

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
// detectEditPieces
// ---------------------------------------------------------------------------

describe('detectEditPieces', () => {
  it('should return empty array for empty input', () => {
    expect(detectEditPieces([])).toEqual([]);
  });

  it('should return empty array when piece has edit: false, no allowed_tools, and no required_permission_mode', () => {
    const pieces = [
      { name: 'simple.yaml', content: 'movements:\n  - name: run\n    edit: false\n' },
    ];
    expect(detectEditPieces(pieces)).toEqual([]);
  });

  it('should detect piece with edit: true and collect allowed_tools', () => {
    const content = `
movements:
  - name: implement
    edit: true
    allowed_tools: [Bash, Write, Edit]
`.trim();
    const result = detectEditPieces([{ name: 'coder.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('coder.yaml');
    expect(result[0]!.allowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit']));
    expect(result[0]!.allowedTools).toHaveLength(3);
  });

  it('should merge allowed_tools from multiple edit movements', () => {
    const content = `
movements:
  - name: implement
    edit: true
    allowed_tools: [Bash, Write]
  - name: fix
    edit: true
    allowed_tools: [Edit, Bash]
`.trim();
    const result = detectEditPieces([{ name: 'coder.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.allowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit']));
    expect(result[0]!.allowedTools).toHaveLength(3);
  });

  it('should detect piece with edit: true and no allowed_tools', () => {
    const content = `
movements:
  - name: implement
    edit: true
`.trim();
    const result = detectEditPieces([{ name: 'coder.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.allowedTools).toEqual([]);
  });

  it('should skip pieces with invalid YAML silently', () => {
    const pieces = [
      { name: 'invalid.yaml', content: ': bad: yaml: [[[' },
      {
        name: 'valid.yaml',
        content: 'movements:\n  - name: run\n    edit: true\n',
      },
    ];
    const result = detectEditPieces(pieces);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('valid.yaml');
  });

  it('should skip piece that has no movements field', () => {
    const pieces = [{ name: 'empty.yaml', content: 'description: no movements' }];
    expect(detectEditPieces(pieces)).toEqual([]);
  });

  it('should return multiple results when multiple pieces have edit: true', () => {
    const pieces = [
      {
        name: 'coder.yaml',
        content: 'movements:\n  - name: impl\n    edit: true\n    allowed_tools: [Write]\n',
      },
      {
        name: 'reviewer.yaml',
        content: 'movements:\n  - name: review\n    edit: false\n',
      },
      {
        name: 'fixer.yaml',
        content: 'movements:\n  - name: fix\n    edit: true\n    allowed_tools: [Edit]\n',
      },
    ];
    const result = detectEditPieces(pieces);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.name)).toEqual(expect.arrayContaining(['coder.yaml', 'fixer.yaml']));
  });

  it('should set hasEdit: true for pieces with edit: true', () => {
    const content = 'movements:\n  - name: impl\n    edit: true\n    allowed_tools: [Write]\n';
    const result = detectEditPieces([{ name: 'coder.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.hasEdit).toBe(true);
    expect(result[0]!.requiredPermissionModes).toEqual([]);
  });

  it('should detect required_permission_mode and set hasEdit: false when no edit: true', () => {
    const content = `
movements:
  - name: plan
    required_permission_mode: bypassPermissions
`.trim();
    const result = detectEditPieces([{ name: 'planner.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('planner.yaml');
    expect(result[0]!.hasEdit).toBe(false);
    expect(result[0]!.requiredPermissionModes).toEqual(['bypassPermissions']);
    expect(result[0]!.allowedTools).toEqual([]);
  });

  it('should detect both edit: true and required_permission_mode in same piece', () => {
    const content = `
movements:
  - name: implement
    edit: true
    allowed_tools: [Write, Edit]
  - name: plan
    required_permission_mode: bypassPermissions
`.trim();
    const result = detectEditPieces([{ name: 'mixed.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.hasEdit).toBe(true);
    expect(result[0]!.allowedTools).toEqual(expect.arrayContaining(['Write', 'Edit']));
    expect(result[0]!.requiredPermissionModes).toEqual(['bypassPermissions']);
  });

  it('should deduplicate required_permission_mode values across movements', () => {
    const content = `
movements:
  - name: plan
    required_permission_mode: bypassPermissions
  - name: execute
    required_permission_mode: bypassPermissions
`.trim();
    const result = detectEditPieces([{ name: 'dup.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.requiredPermissionModes).toEqual(['bypassPermissions']);
  });

  it('should return empty array when piece has edit: false, empty allowed_tools, and no required_permission_mode', () => {
    const content = 'movements:\n  - name: review\n    edit: false\n';
    expect(detectEditPieces([{ name: 'reviewer.yaml', content }])).toEqual([]);
  });

  it('should detect piece with edit: false and non-empty allowed_tools', () => {
    const content = `
movements:
  - name: run
    edit: false
    allowed_tools: [Bash]
`.trim();
    const result = detectEditPieces([{ name: 'runner.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('runner.yaml');
    expect(result[0]!.hasEdit).toBe(false);
    expect(result[0]!.allowedTools).toEqual(['Bash']);
    expect(result[0]!.requiredPermissionModes).toEqual([]);
  });

  it('should exclude piece with edit: false and empty allowed_tools', () => {
    const content = `
movements:
  - name: run
    edit: false
    allowed_tools: []
`.trim();
    expect(detectEditPieces([{ name: 'runner.yaml', content }])).toEqual([]);
  });

  it('should detect piece with edit: false and required_permission_mode set', () => {
    const content = `
movements:
  - name: plan
    edit: false
    required_permission_mode: bypassPermissions
`.trim();
    const result = detectEditPieces([{ name: 'planner.yaml', content }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.hasEdit).toBe(false);
    expect(result[0]!.requiredPermissionModes).toEqual(['bypassPermissions']);
    expect(result[0]!.allowedTools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatEditPieceWarnings
// ---------------------------------------------------------------------------

describe('formatEditPieceWarnings', () => {
  it('should format edit:true warning without allowed_tools', () => {
    const warnings = formatEditPieceWarnings({
      name: 'piece.yaml',
      hasEdit: true,
      allowedTools: [],
      requiredPermissionModes: [],
    });
    expect(warnings).toEqual(['\n   ⚠ piece.yaml: edit: true']);
  });

  it('should format edit:true warning with allowed_tools appended inline', () => {
    const warnings = formatEditPieceWarnings({
      name: 'piece.yaml',
      hasEdit: true,
      allowedTools: ['Bash', 'Edit'],
      requiredPermissionModes: [],
    });
    expect(warnings).toEqual(['\n   ⚠ piece.yaml: edit: true, allowed_tools: [Bash, Edit]']);
  });

  it('should format allowed_tools-only warning when edit:false', () => {
    const warnings = formatEditPieceWarnings({
      name: 'runner.yaml',
      hasEdit: false,
      allowedTools: ['Bash'],
      requiredPermissionModes: [],
    });
    expect(warnings).toEqual(['\n   ⚠ runner.yaml: allowed_tools: [Bash]']);
  });

  it('should return empty array when edit:false and no allowed_tools and no required_permission_mode', () => {
    const warnings = formatEditPieceWarnings({
      name: 'review.yaml',
      hasEdit: false,
      allowedTools: [],
      requiredPermissionModes: [],
    });
    expect(warnings).toEqual([]);
  });

  it('should format required_permission_mode warnings', () => {
    const warnings = formatEditPieceWarnings({
      name: 'planner.yaml',
      hasEdit: false,
      allowedTools: [],
      requiredPermissionModes: ['bypassPermissions'],
    });
    expect(warnings).toEqual(['\n   ⚠ planner.yaml: required_permission_mode: bypassPermissions']);
  });

  it('should combine allowed_tools and required_permission_mode warnings when edit:false', () => {
    const warnings = formatEditPieceWarnings({
      name: 'combo.yaml',
      hasEdit: false,
      allowedTools: ['Bash'],
      requiredPermissionModes: ['bypassPermissions'],
    });
    expect(warnings).toEqual([
      '\n   ⚠ combo.yaml: allowed_tools: [Bash]',
      '\n   ⚠ combo.yaml: required_permission_mode: bypassPermissions',
    ]);
  });

  it('should format both edit:true and required_permission_mode warnings', () => {
    const warnings = formatEditPieceWarnings({
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
