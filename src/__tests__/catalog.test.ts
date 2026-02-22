/**
 * Tests for facet catalog scanning and display.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractDescription,
  parseFacetType,
  scanFacets,
  displayFacets,
  showCatalog,
  type FacetEntry,
} from '../features/catalog/catalogFacets.js';

// Mock external dependencies to isolate unit tests
vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: () => ({}),
}));

const mockLogError = vi.fn();
const mockInfo = vi.fn();
vi.mock('../shared/ui/index.js', () => ({
  error: (...args: unknown[]) => mockLogError(...args),
  info: (...args: unknown[]) => mockInfo(...args),
  section: (title: string) => console.log(title),
}));

let mockBuiltinDir: string;
vi.mock('../infra/resources/index.js', () => ({
  getLanguageResourcesDir: () => mockBuiltinDir,
}));

let mockGlobalDir: string;
vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigDir: () => mockGlobalDir,
  getProjectConfigDir: (cwd: string) => join(cwd, '.takt'),
  getGlobalFacetDir: (facetType: string) => join(mockGlobalDir, 'facets', facetType),
  getProjectFacetDir: (cwd: string, facetType: string) => join(cwd, '.takt', 'facets', facetType),
  getBuiltinFacetDir: (_lang: string, facetType: string) => join(mockBuiltinDir, 'facets', facetType),
}));

describe('parseFacetType', () => {
  it('should return FacetType for valid inputs', () => {
    expect(parseFacetType('personas')).toBe('personas');
    expect(parseFacetType('policies')).toBe('policies');
    expect(parseFacetType('knowledge')).toBe('knowledge');
    expect(parseFacetType('instructions')).toBe('instructions');
    expect(parseFacetType('output-contracts')).toBe('output-contracts');
  });

  it('should return null for invalid inputs', () => {
    expect(parseFacetType('unknown')).toBeNull();
    expect(parseFacetType('persona')).toBeNull();
    expect(parseFacetType('')).toBeNull();
  });
});

describe('extractDescription', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-catalog-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should extract first heading from markdown file', () => {
    const filePath = join(tempDir, 'test.md');
    writeFileSync(filePath, '# My Persona\n\nSome content here.');

    expect(extractDescription(filePath)).toBe('My Persona');
  });

  it('should return first non-empty line when no heading exists', () => {
    const filePath = join(tempDir, 'test.md');
    writeFileSync(filePath, 'No heading in this file\nJust plain text.');

    expect(extractDescription(filePath)).toBe('No heading in this file');
  });

  it('should return empty string when file is empty', () => {
    const filePath = join(tempDir, 'test.md');
    writeFileSync(filePath, '');

    expect(extractDescription(filePath)).toBe('');
  });

  it('should skip blank lines and return first non-empty line', () => {
    const filePath = join(tempDir, 'test.md');
    writeFileSync(filePath, '\n\n  \nActual content here\nMore text.');

    expect(extractDescription(filePath)).toBe('Actual content here');
  });

  it('should extract from first heading, ignoring later headings', () => {
    const filePath = join(tempDir, 'test.md');
    writeFileSync(filePath, 'Preamble\n# First Heading\n# Second Heading');

    expect(extractDescription(filePath)).toBe('First Heading');
  });

  it('should trim whitespace from heading text', () => {
    const filePath = join(tempDir, 'test.md');
    writeFileSync(filePath, '#   Spaced Heading  \n');

    expect(extractDescription(filePath)).toBe('Spaced Heading');
  });
});

describe('scanFacets', () => {
  let tempDir: string;
  let builtinDir: string;
  let globalDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-catalog-test-'));
    builtinDir = join(tempDir, 'builtin-lang');
    globalDir = join(tempDir, 'global');
    projectDir = join(tempDir, 'project');

    mockBuiltinDir = builtinDir;
    mockGlobalDir = globalDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should collect facets from all three layers', () => {
    // Given: facets in builtin, user, and project layers
    const builtinPersonas = join(builtinDir, 'facets', 'personas');
    const globalPersonas = join(globalDir, 'facets', 'personas');
    const projectPersonas = join(projectDir, '.takt', 'facets', 'personas');
    mkdirSync(builtinPersonas, { recursive: true });
    mkdirSync(globalPersonas, { recursive: true });
    mkdirSync(projectPersonas, { recursive: true });

    writeFileSync(join(builtinPersonas, 'coder.md'), '# Coder Agent');
    writeFileSync(join(globalPersonas, 'my-reviewer.md'), '# My Reviewer');
    writeFileSync(join(projectPersonas, 'project-coder.md'), '# Project Coder');

    // When: scanning personas
    const entries = scanFacets('personas', projectDir);

    // Then: all three entries are collected
    expect(entries).toHaveLength(3);

    const coder = entries.find((e) => e.name === 'coder');
    expect(coder).toBeDefined();
    expect(coder!.source).toBe('builtin');
    expect(coder!.description).toBe('Coder Agent');

    const myReviewer = entries.find((e) => e.name === 'my-reviewer');
    expect(myReviewer).toBeDefined();
    expect(myReviewer!.source).toBe('user');

    const projectCoder = entries.find((e) => e.name === 'project-coder');
    expect(projectCoder).toBeDefined();
    expect(projectCoder!.source).toBe('project');
  });

  it('should detect override when higher layer has same name', () => {
    // Given: same facet name in builtin and user layers
    const builtinPersonas = join(builtinDir, 'facets', 'personas');
    const globalPersonas = join(globalDir, 'facets', 'personas');
    mkdirSync(builtinPersonas, { recursive: true });
    mkdirSync(globalPersonas, { recursive: true });

    writeFileSync(join(builtinPersonas, 'coder.md'), '# Builtin Coder');
    writeFileSync(join(globalPersonas, 'coder.md'), '# Custom Coder');

    // When: scanning personas
    const entries = scanFacets('personas', tempDir);

    // Then: builtin entry is marked as overridden by user
    const builtinCoder = entries.find((e) => e.name === 'coder' && e.source === 'builtin');
    expect(builtinCoder).toBeDefined();
    expect(builtinCoder!.overriddenBy).toBe('user');

    const userCoder = entries.find((e) => e.name === 'coder' && e.source === 'user');
    expect(userCoder).toBeDefined();
    expect(userCoder!.overriddenBy).toBeUndefined();
  });

  it('should detect override through project layer', () => {
    // Given: same facet name in builtin and project layers
    const builtinPolicies = join(builtinDir, 'facets', 'policies');
    const projectPolicies = join(projectDir, '.takt', 'facets', 'policies');
    mkdirSync(builtinPolicies, { recursive: true });
    mkdirSync(projectPolicies, { recursive: true });

    writeFileSync(join(builtinPolicies, 'coding.md'), '# Builtin Coding');
    writeFileSync(join(projectPolicies, 'coding.md'), '# Project Coding');

    // When: scanning policies
    const entries = scanFacets('policies', projectDir);

    // Then: builtin entry is marked as overridden by project
    const builtinCoding = entries.find((e) => e.name === 'coding' && e.source === 'builtin');
    expect(builtinCoding).toBeDefined();
    expect(builtinCoding!.overriddenBy).toBe('project');
  });

  it('should handle non-existent directories gracefully', () => {
    // Given: no directories exist
    // When: scanning a facet type
    const entries = scanFacets('knowledge', projectDir);

    // Then: returns empty array
    expect(entries).toEqual([]);
  });

  it('should only include .md files', () => {
    // Given: directory with mixed file types
    const builtinKnowledge = join(builtinDir, 'facets', 'knowledge');
    mkdirSync(builtinKnowledge, { recursive: true });

    writeFileSync(join(builtinKnowledge, 'valid.md'), '# Valid');
    writeFileSync(join(builtinKnowledge, 'ignored.txt'), 'Not a markdown');
    writeFileSync(join(builtinKnowledge, 'also-ignored.yaml'), 'name: yaml');

    // When: scanning knowledge
    const entries = scanFacets('knowledge', tempDir);

    // Then: only .md file is included
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('valid');
  });

  it('should work with all facet types', () => {
    // Given: one facet in each type directory
    const types = ['personas', 'policies', 'knowledge', 'instructions', 'output-contracts'] as const;
    for (const type of types) {
      const dir = join(builtinDir, 'facets', type);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'test.md'), `# Test ${type}`);
    }

    // When/Then: each type is scannable
    for (const type of types) {
      const entries = scanFacets(type, tempDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.name).toBe('test');
    }
  });
});

describe('displayFacets', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should display entries with name, description, and source', () => {
    // Given: a list of facet entries
    const entries: FacetEntry[] = [
      { name: 'coder', description: 'Coder Agent', source: 'builtin' },
      { name: 'my-reviewer', description: 'My Reviewer', source: 'user' },
    ];

    // When: displaying facets
    displayFacets('personas', entries);

    // Then: output contains facet names
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('coder');
    expect(output).toContain('my-reviewer');
    expect(output).toContain('Personas');
  });

  it('should display (none) when entries are empty', () => {
    // Given: empty entries
    const entries: FacetEntry[] = [];

    // When: displaying facets
    displayFacets('policies', entries);

    // Then: output shows (none)
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('(none)');
  });

  it('should display override information', () => {
    // Given: an overridden entry
    const entries: FacetEntry[] = [
      { name: 'coder', description: 'Builtin Coder', source: 'builtin', overriddenBy: 'user' },
    ];

    // When: displaying facets
    displayFacets('personas', entries);

    // Then: output contains override info
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('overridden by user');
  });
});

describe('showCatalog', () => {
  let tempDir: string;
  let builtinDir: string;
  let globalDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-catalog-test-'));
    builtinDir = join(tempDir, 'builtin-lang');
    globalDir = join(tempDir, 'global');

    mockBuiltinDir = builtinDir;
    mockGlobalDir = globalDir;
    mockLogError.mockClear();
    mockInfo.mockClear();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should display only the specified facet type when valid type is given', () => {
    // Given: personas facet exists
    const builtinPersonas = join(builtinDir, 'facets', 'personas');
    mkdirSync(builtinPersonas, { recursive: true });
    writeFileSync(join(builtinPersonas, 'coder.md'), '# Coder Agent');

    // When: showing catalog for personas only
    showCatalog(tempDir, 'personas');

    // Then: output contains the facet name and no error
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('coder');
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('should show error when invalid facet type is given', () => {
    // When: showing catalog for an invalid type
    showCatalog(tempDir, 'invalid-type');

    // Then: error is logged with the invalid type name
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('invalid-type'),
    );
    // Then: available types are shown via info
    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining('personas'),
    );
  });

  it('should display all five facet types when no type is specified', () => {
    // Given: no facets exist (empty directories)

    // When: showing catalog without specifying a type
    showCatalog(tempDir);

    // Then: all 5 facet type headings are displayed
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Personas');
    expect(output).toContain('Policies');
    expect(output).toContain('Knowledge');
    expect(output).toContain('Instructions');
    expect(output).toContain('Output-contracts');
  });
});
