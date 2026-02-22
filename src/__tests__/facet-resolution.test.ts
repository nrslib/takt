/**
 * Tests for name-based facet resolution (layer system).
 *
 * Covers:
 * - isResourcePath() helper
 * - resolveFacetByName() 3-layer resolution (project → user → builtin)
 * - resolveRefToContent() with facetType and context
 * - resolvePersona() with context (name-based resolution)
 * - parseFacetType() CLI mapping
 * - Facet directory path helpers
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isResourcePath,
  resolveFacetByName,
  resolveRefToContent,
  resolveRefList,
  resolvePersona,
  type FacetResolutionContext,
  type PieceSections,
} from '../infra/config/loaders/resource-resolver.js';
import {
  getProjectFacetDir,
  getGlobalFacetDir,
  getBuiltinFacetDir,
  type FacetType,
} from '../infra/config/paths.js';
import { parseFacetType, VALID_FACET_TYPES } from '../features/config/ejectBuiltin.js';
import { normalizePieceConfig } from '../infra/config/loaders/pieceParser.js';

describe('isResourcePath', () => {
  it('should return true for relative paths starting with ./', () => {
    expect(isResourcePath('./personas/coder.md')).toBe(true);
  });

  it('should return true for relative paths starting with ../', () => {
    expect(isResourcePath('../personas/coder.md')).toBe(true);
  });

  it('should return true for absolute paths', () => {
    expect(isResourcePath('/home/user/coder.md')).toBe(true);
  });

  it('should return true for home directory paths', () => {
    expect(isResourcePath('~/coder.md')).toBe(true);
  });

  it('should return true for paths ending with .md', () => {
    expect(isResourcePath('coder.md')).toBe(true);
  });

  it('should return false for plain names', () => {
    expect(isResourcePath('coder')).toBe(false);
    expect(isResourcePath('architecture-reviewer')).toBe(false);
    expect(isResourcePath('coding')).toBe(false);
  });
});

describe('resolveFacetByName', () => {
  let tempDir: string;
  let projectDir: string;
  let context: FacetResolutionContext;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-facet-test-'));
    projectDir = join(tempDir, 'project');
    mkdirSync(projectDir, { recursive: true });
    context = { projectDir, lang: 'ja' };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should resolve from builtin when no project/user override exists', () => {
    // Builtin personas exist in the real builtins directory
    const content = resolveFacetByName('coder', 'personas', context);
    expect(content).toBeDefined();
    expect(content).toContain(''); // Just verify it returns something
  });

  it('should resolve from project layer over builtin', () => {
    const projectPersonasDir = join(projectDir, '.takt', 'facets', 'personas');
    mkdirSync(projectPersonasDir, { recursive: true });
    writeFileSync(join(projectPersonasDir, 'coder.md'), 'Project-level coder persona');

    const content = resolveFacetByName('coder', 'personas', context);
    expect(content).toBe('Project-level coder persona');
  });

  it('should return undefined when facet not found in any layer', () => {
    const content = resolveFacetByName('nonexistent-facet-xyz', 'personas', context);
    expect(content).toBeUndefined();
  });

  it('should resolve different facet types', () => {
    const projectPoliciesDir = join(projectDir, '.takt', 'facets', 'policies');
    mkdirSync(projectPoliciesDir, { recursive: true });
    writeFileSync(join(projectPoliciesDir, 'custom-policy.md'), 'Custom policy content');

    const content = resolveFacetByName('custom-policy', 'policies', context);
    expect(content).toBe('Custom policy content');
  });

  it('should try project before builtin', () => {
    // Create project override
    const projectPersonasDir = join(projectDir, '.takt', 'facets', 'personas');
    mkdirSync(projectPersonasDir, { recursive: true });
    writeFileSync(join(projectPersonasDir, 'coder.md'), 'OVERRIDE');

    const content = resolveFacetByName('coder', 'personas', context);
    expect(content).toBe('OVERRIDE');
  });
});

describe('resolveRefToContent with layer resolution', () => {
  let tempDir: string;
  let context: FacetResolutionContext;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-ref-test-'));
    context = { projectDir: tempDir, lang: 'ja' };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should prefer resolvedMap over layer resolution', () => {
    const resolvedMap = { 'coding': 'Map content for coding' };
    const content = resolveRefToContent('coding', resolvedMap, tempDir, 'policies', context);
    expect(content).toBe('Map content for coding');
  });

  it('should use layer resolution for name refs when not in resolvedMap', () => {
    const policiesDir = join(tempDir, '.takt', 'facets', 'policies');
    mkdirSync(policiesDir, { recursive: true });
    writeFileSync(join(policiesDir, 'coding.md'), 'Project coding policy');

    const content = resolveRefToContent('coding', undefined, tempDir, 'policies', context);
    expect(content).toBe('Project coding policy');
  });

  it('should use path resolution for path-like refs', () => {
    const policyFile = join(tempDir, 'my-policy.md');
    writeFileSync(policyFile, 'Inline policy');

    const content = resolveRefToContent('./my-policy.md', undefined, tempDir);
    expect(content).toBe('Inline policy');
  });

  it('should fall back to path resolution when no context', () => {
    const content = resolveRefToContent('some-name', undefined, tempDir);
    // No context, no file — returns the spec as-is (inline content behavior)
    expect(content).toBe('some-name');
  });

  it('should fall back to resolveResourceContent when facet not found with context', () => {
    // Given: facetType and context provided, but no matching facet file exists
    // When: resolveRefToContent is called with a name that has no facet file
    const content = resolveRefToContent(
      'nonexistent-facet-xyz',
      undefined,
      tempDir,
      'policies',
      context,
    );

    // Then: falls back to resolveResourceContent, which returns the ref as inline content
    expect(content).toBe('nonexistent-facet-xyz');
  });
});

describe('resolveRefList with layer resolution', () => {
  let tempDir: string;
  let context: FacetResolutionContext;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-reflist-test-'));
    context = { projectDir: tempDir, lang: 'ja' };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should resolve array of name refs via layer resolution', () => {
    const policiesDir = join(tempDir, '.takt', 'facets', 'policies');
    mkdirSync(policiesDir, { recursive: true });
    writeFileSync(join(policiesDir, 'policy-a.md'), 'Policy A content');
    writeFileSync(join(policiesDir, 'policy-b.md'), 'Policy B content');

    const result = resolveRefList(
      ['policy-a', 'policy-b'],
      undefined,
      tempDir,
      'policies',
      context,
    );

    expect(result).toEqual(['Policy A content', 'Policy B content']);
  });

  it('should handle mixed array of name refs and path refs', () => {
    const policiesDir = join(tempDir, '.takt', 'facets', 'policies');
    mkdirSync(policiesDir, { recursive: true });
    writeFileSync(join(policiesDir, 'name-policy.md'), 'Name-resolved policy');

    const pathFile = join(tempDir, 'local-policy.md');
    writeFileSync(pathFile, 'Path-resolved policy');

    const result = resolveRefList(
      ['name-policy', './local-policy.md'],
      undefined,
      tempDir,
      'policies',
      context,
    );

    expect(result).toEqual(['Name-resolved policy', 'Path-resolved policy']);
  });

  it('should return undefined for undefined input', () => {
    const result = resolveRefList(undefined, undefined, tempDir, 'policies', context);
    expect(result).toBeUndefined();
  });

  it('should handle single string ref (not array)', () => {
    const policiesDir = join(tempDir, '.takt', 'facets', 'policies');
    mkdirSync(policiesDir, { recursive: true });
    writeFileSync(join(policiesDir, 'single.md'), 'Single policy');

    const result = resolveRefList(
      'single',
      undefined,
      tempDir,
      'policies',
      context,
    );

    expect(result).toEqual(['Single policy']);
  });

  it('should prefer resolvedMap over layer resolution', () => {
    const resolvedMap = { coding: 'Map content for coding' };
    const result = resolveRefList(
      ['coding'],
      resolvedMap,
      tempDir,
      'policies',
      context,
    );

    expect(result).toEqual(['Map content for coding']);
  });
});

describe('resolvePersona with layer resolution', () => {
  let tempDir: string;
  let projectDir: string;
  let context: FacetResolutionContext;
  const emptySections: PieceSections = {};

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-persona-test-'));
    projectDir = join(tempDir, 'project');
    mkdirSync(projectDir, { recursive: true });
    context = { projectDir, lang: 'ja' };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should resolve persona by name from builtin', () => {
    const result = resolvePersona('coder', emptySections, tempDir, context);
    expect(result.personaSpec).toBe('coder');
    expect(result.personaPath).toBeDefined();
    expect(result.personaPath).toContain('coder.md');
  });

  it('should resolve persona from project layer', () => {
    const projectPersonasDir = join(projectDir, '.takt', 'facets', 'personas');
    mkdirSync(projectPersonasDir, { recursive: true });
    const personaPath = join(projectPersonasDir, 'custom-persona.md');
    writeFileSync(personaPath, 'Custom persona content');

    const result = resolvePersona('custom-persona', emptySections, tempDir, context);
    expect(result.personaSpec).toBe('custom-persona');
    expect(result.personaPath).toBe(personaPath);
  });

  it('should prefer section map over layer resolution', () => {
    const personaFile = join(tempDir, 'explicit.md');
    writeFileSync(personaFile, 'Explicit persona');

    const sections: PieceSections = {
      personas: { 'my-persona': './explicit.md' },
    };

    const result = resolvePersona('my-persona', sections, tempDir, context);
    expect(result.personaSpec).toBe('./explicit.md');
    expect(result.personaPath).toBe(personaFile);
  });

  it('should handle path-like persona specs directly', () => {
    const personaFile = join(tempDir, 'personas', 'coder.md');
    mkdirSync(join(tempDir, 'personas'), { recursive: true });
    writeFileSync(personaFile, 'Path persona');

    const result = resolvePersona('../personas/coder.md', emptySections, tempDir);
    // Path-like spec should be resolved as resource path, not name
    expect(result.personaSpec).toBe('../personas/coder.md');
  });

  it('should return empty for undefined persona', () => {
    const result = resolvePersona(undefined, emptySections, tempDir, context);
    expect(result).toEqual({});
  });
});

describe('facet directory path helpers', () => {
  it('getProjectFacetDir should return .takt/{type}/ path', () => {
    const dir = getProjectFacetDir('/my/project', 'personas');
    expect(dir).toContain('.takt');
    expect(dir).toContain('personas');
  });

  it('getGlobalFacetDir should return path with facet type', () => {
    const dir = getGlobalFacetDir('policies');
    expect(dir).toContain('policies');
  });

  it('getBuiltinFacetDir should return path with lang and facet type', () => {
    const dir = getBuiltinFacetDir('ja', 'knowledge');
    expect(dir).toContain('ja');
    expect(dir).toContain('knowledge');
  });

  it('should work with all facet types', () => {
    const types: FacetType[] = ['personas', 'policies', 'knowledge', 'instructions', 'output-contracts'];
    for (const t of types) {
      expect(getProjectFacetDir('/proj', t)).toContain(t);
      expect(getGlobalFacetDir(t)).toContain(t);
      expect(getBuiltinFacetDir('en', t)).toContain(t);
    }
  });
});

describe('parseFacetType', () => {
  it('should map singular to plural facet types', () => {
    expect(parseFacetType('persona')).toBe('personas');
    expect(parseFacetType('policy')).toBe('policies');
    expect(parseFacetType('knowledge')).toBe('knowledge');
    expect(parseFacetType('instruction')).toBe('instructions');
    expect(parseFacetType('output-contract')).toBe('output-contracts');
  });

  it('should return undefined for invalid facet types', () => {
    expect(parseFacetType('invalid')).toBeUndefined();
    expect(parseFacetType('personas')).toBeUndefined();
    expect(parseFacetType('')).toBeUndefined();
  });

  it('VALID_FACET_TYPES should contain all singular forms', () => {
    expect(VALID_FACET_TYPES).toContain('persona');
    expect(VALID_FACET_TYPES).toContain('policy');
    expect(VALID_FACET_TYPES).toContain('knowledge');
    expect(VALID_FACET_TYPES).toContain('instruction');
    expect(VALID_FACET_TYPES).toContain('output-contract');
    expect(VALID_FACET_TYPES).toHaveLength(5);
  });
});

describe('normalizePieceConfig with layer resolution', () => {
  let tempDir: string;
  let pieceDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-normalize-test-'));
    pieceDir = join(tempDir, 'pieces');
    projectDir = join(tempDir, 'project');
    mkdirSync(pieceDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should resolve persona by name when section map is absent and context provided', () => {
    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          instruction: '{task}',
        },
      ],
    };

    const context: FacetResolutionContext = { projectDir, lang: 'ja' };
    const config = normalizePieceConfig(raw, pieceDir, context);

    expect(config.movements[0]!.persona).toBe('coder');
    // With context, it should find the builtin coder persona
    expect(config.movements[0]!.personaPath).toBeDefined();
    expect(config.movements[0]!.personaPath).toContain('coder.md');
  });

  it('should resolve policy by name when section map is absent', () => {
    // Create project-level policy
    const policiesDir = join(projectDir, '.takt', 'facets', 'policies');
    mkdirSync(policiesDir, { recursive: true });
    writeFileSync(join(policiesDir, 'custom-policy.md'), '# Custom Policy\nBe nice.');

    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          policy: 'custom-policy',
          instruction: '{task}',
        },
      ],
    };

    const context: FacetResolutionContext = { projectDir, lang: 'ja' };
    const config = normalizePieceConfig(raw, pieceDir, context);

    expect(config.movements[0]!.policyContents).toBeDefined();
    expect(config.movements[0]!.policyContents![0]).toBe('# Custom Policy\nBe nice.');
  });

  it('should prefer section map over layer resolution', () => {
    // Create section map entry
    const personaFile = join(pieceDir, 'my-coder.md');
    writeFileSync(personaFile, 'Section map coder');

    const raw = {
      name: 'test-piece',
      personas: {
        coder: './my-coder.md',
      },
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          instruction: '{task}',
        },
      ],
    };

    const context: FacetResolutionContext = { projectDir, lang: 'ja' };
    const config = normalizePieceConfig(raw, pieceDir, context);

    // Section map should be used, not layer resolution
    expect(config.movements[0]!.persona).toBe('./my-coder.md');
    expect(config.movements[0]!.personaPath).toBe(personaFile);
  });

  it('should work without context (backward compatibility)', () => {
    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          instruction: '{task}',
        },
      ],
    };

    // No context — backward compatibility mode
    const config = normalizePieceConfig(raw, pieceDir);

    // Without context, name 'coder' resolves as relative path from pieceDir
    expect(config.movements[0]!.persona).toBe('coder');
  });

  it('should resolve knowledge by name from project layer', () => {
    const knowledgeDir = join(projectDir, '.takt', 'facets', 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    writeFileSync(join(knowledgeDir, 'domain-kb.md'), '# Domain Knowledge');

    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          knowledge: 'domain-kb',
          instruction: '{task}',
        },
      ],
    };

    const context: FacetResolutionContext = { projectDir, lang: 'ja' };
    const config = normalizePieceConfig(raw, pieceDir, context);

    expect(config.movements[0]!.knowledgeContents).toBeDefined();
    expect(config.movements[0]!.knowledgeContents![0]).toBe('# Domain Knowledge');
  });

  it('should resolve instruction_template from section map before layer resolution', () => {
    const raw = {
      name: 'test-piece',
      instructions: {
        implement: 'Mapped instruction template',
      },
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          instruction_template: 'implement',
          instruction: '{task}',
        },
      ],
    };

    const context: FacetResolutionContext = { projectDir, lang: 'ja' };
    const config = normalizePieceConfig(raw, pieceDir, context);

    expect(config.movements[0]!.instructionTemplate).toBe('Mapped instruction template');
  });

  it('should resolve instruction_template by name via layer resolution', () => {
    const instructionsDir = join(projectDir, '.takt', 'facets', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });
    writeFileSync(join(instructionsDir, 'implement.md'), 'Project implement template');

    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          instruction_template: 'implement',
          instruction: '{task}',
        },
      ],
    };

    const context: FacetResolutionContext = { projectDir, lang: 'ja' };
    const config = normalizePieceConfig(raw, pieceDir, context);

    expect(config.movements[0]!.instructionTemplate).toBe('Project implement template');
  });

  it('should keep inline instruction_template when no facet is found', () => {
    const inlineTemplate = `Use this inline template.
Second line remains inline.`;
    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          instruction_template: inlineTemplate,
          instruction: '{task}',
        },
      ],
    };

    const context: FacetResolutionContext = { projectDir, lang: 'ja' };
    const config = normalizePieceConfig(raw, pieceDir, context);

    expect(config.movements[0]!.instructionTemplate).toBe(inlineTemplate);
  });

  it('should resolve loop monitor judge instruction_template via layer resolution', () => {
    const instructionsDir = join(projectDir, '.takt', 'facets', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });
    writeFileSync(join(instructionsDir, 'judge-template.md'), 'Project judge template');

    const raw = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          instruction: '{task}',
          rules: [{ condition: 'next', next: 'step2' }],
        },
        {
          name: 'step2',
          persona: 'coder',
          instruction: '{task}',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
      loop_monitors: [
        {
          cycle: ['step1', 'step2'],
          threshold: 2,
          judge: {
            persona: 'coder',
            instruction_template: 'judge-template',
            rules: [{ condition: 'continue', next: 'step2' }],
          },
        },
      ],
    };

    const context: FacetResolutionContext = { projectDir, lang: 'ja' };
    const config = normalizePieceConfig(raw, pieceDir, context);

    expect(config.loopMonitors?.[0]?.judge.instructionTemplate).toBe('Project judge template');
  });
});
