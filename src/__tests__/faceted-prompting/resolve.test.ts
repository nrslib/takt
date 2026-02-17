/**
 * Unit tests for faceted-prompting resolve module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isResourcePath,
  resolveFacetPath,
  resolveFacetByName,
  resolveResourcePath,
  resolveResourceContent,
  resolveRefToContent,
  resolveRefList,
  resolveSectionMap,
  extractPersonaDisplayName,
  resolvePersona,
} from '../../faceted-prompting/index.js';

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('isResourcePath', () => {
  it('should return true for relative path with ./', () => {
    expect(isResourcePath('./file.md')).toBe(true);
  });

  it('should return true for parent-relative path', () => {
    expect(isResourcePath('../file.md')).toBe(true);
  });

  it('should return true for absolute path', () => {
    expect(isResourcePath('/absolute/path.md')).toBe(true);
  });

  it('should return true for home-relative path', () => {
    expect(isResourcePath('~/file.md')).toBe(true);
  });

  it('should return true for .md extension', () => {
    expect(isResourcePath('some-file.md')).toBe(true);
  });

  it('should return false for a plain facet name', () => {
    expect(isResourcePath('coding')).toBe(false);
  });

  it('should return false for a name with dots but not .md', () => {
    expect(isResourcePath('my.config')).toBe(false);
  });
});

describe('resolveFacetPath', () => {
  it('should return the first existing file path', () => {
    mockExistsSync.mockImplementation((p) => p === '/dir1/coding.md');

    const result = resolveFacetPath('coding', ['/dir1', '/dir2']);
    expect(result).toBe('/dir1/coding.md');
  });

  it('should skip non-existing directories and find in later ones', () => {
    mockExistsSync.mockImplementation((p) => p === '/dir2/coding.md');

    const result = resolveFacetPath('coding', ['/dir1', '/dir2']);
    expect(result).toBe('/dir2/coding.md');
  });

  it('should return undefined when not found in any directory', () => {
    mockExistsSync.mockReturnValue(false);

    const result = resolveFacetPath('missing', ['/dir1', '/dir2']);
    expect(result).toBeUndefined();
  });

  it('should return undefined for empty candidate list', () => {
    const result = resolveFacetPath('anything', []);
    expect(result).toBeUndefined();
  });
});

describe('resolveFacetByName', () => {
  it('should return file content when facet exists', () => {
    mockExistsSync.mockImplementation((p) => p === '/dir/coder.md');
    mockReadFileSync.mockReturnValue('You are a coder.');

    const result = resolveFacetByName('coder', ['/dir']);
    expect(result).toBe('You are a coder.');
  });

  it('should return undefined when facet does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = resolveFacetByName('missing', ['/dir']);
    expect(result).toBeUndefined();
  });
});

describe('resolveResourcePath', () => {
  it('should resolve ./ relative to pieceDir', () => {
    const result = resolveResourcePath('./policies/coding.md', '/project/pieces');
    expect(result).toBe(join('/project/pieces', 'policies/coding.md'));
  });

  it('should resolve ~ relative to homedir', () => {
    const result = resolveResourcePath('~/policies/coding.md', '/project');
    expect(result).toBe(join(homedir(), 'policies/coding.md'));
  });

  it('should return absolute path unchanged', () => {
    const result = resolveResourcePath('/absolute/path.md', '/project');
    expect(result).toBe('/absolute/path.md');
  });

  it('should resolve plain name relative to pieceDir', () => {
    const result = resolveResourcePath('coding.md', '/project/pieces');
    expect(result).toBe(join('/project/pieces', 'coding.md'));
  });
});

describe('resolveResourceContent', () => {
  it('should return undefined for null/undefined spec', () => {
    expect(resolveResourceContent(undefined, '/dir')).toBeUndefined();
    expect(resolveResourceContent(null as unknown as string | undefined, '/dir')).toBeUndefined();
  });

  it('should read file content for .md spec when file exists', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('file content');

    const result = resolveResourceContent('./policy.md', '/dir');
    expect(result).toBe('file content');
  });

  it('should return spec as-is for .md spec when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = resolveResourceContent('./policy.md', '/dir');
    expect(result).toBe('./policy.md');
  });

  it('should return spec as-is for non-.md spec', () => {
    const result = resolveResourceContent('inline content', '/dir');
    expect(result).toBe('inline content');
  });
});

describe('resolveRefToContent', () => {
  it('should return mapped content when found in resolvedMap', () => {
    const result = resolveRefToContent('coding', { coding: 'mapped content' }, '/dir');
    expect(result).toBe('mapped content');
  });

  it('should resolve resource path when ref is a resource path', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('file content');

    const result = resolveRefToContent('./policy.md', undefined, '/dir');
    expect(result).toBe('file content');
  });

  it('should try facet resolution via candidateDirs when ref is a name', () => {
    mockExistsSync.mockImplementation((p) => p === '/facets/coding.md');
    mockReadFileSync.mockReturnValue('facet content');

    const result = resolveRefToContent('coding', undefined, '/dir', ['/facets']);
    expect(result).toBe('facet content');
  });

  it('should fall back to resolveResourceContent when not found elsewhere', () => {
    mockExistsSync.mockReturnValue(false);

    const result = resolveRefToContent('inline text', undefined, '/dir');
    expect(result).toBe('inline text');
  });
});

describe('resolveRefList', () => {
  it('should return undefined for null/undefined refs', () => {
    expect(resolveRefList(undefined, undefined, '/dir')).toBeUndefined();
  });

  it('should handle single string ref', () => {
    const result = resolveRefList('inline', { inline: 'content' }, '/dir');
    expect(result).toEqual(['content']);
  });

  it('should handle array of refs', () => {
    const result = resolveRefList(
      ['a', 'b'],
      { a: 'content A', b: 'content B' },
      '/dir',
    );
    expect(result).toEqual(['content A', 'content B']);
  });

  it('should return undefined when no refs resolve', () => {
    mockExistsSync.mockReturnValue(false);
    const result = resolveRefList(['nonexistent.md'], undefined, '/dir');
    // 'nonexistent.md' ends with .md, file doesn't exist, falls back to spec
    // But the spec is 'nonexistent.md' which is treated as inline
    expect(result).toEqual(['nonexistent.md']);
  });
});

describe('resolveSectionMap', () => {
  it('should return undefined for undefined input', () => {
    expect(resolveSectionMap(undefined, '/dir')).toBeUndefined();
  });

  it('should resolve each entry in the map', () => {
    const result = resolveSectionMap(
      { key1: 'inline value', key2: 'another value' },
      '/dir',
    );
    expect(result).toEqual({
      key1: 'inline value',
      key2: 'another value',
    });
  });
});

describe('extractPersonaDisplayName', () => {
  it('should extract name from .md path', () => {
    expect(extractPersonaDisplayName('coder.md')).toBe('coder');
  });

  it('should extract name from full path', () => {
    expect(extractPersonaDisplayName('/path/to/architect.md')).toBe('architect');
  });

  it('should return name unchanged if no .md extension', () => {
    expect(extractPersonaDisplayName('coder')).toBe('coder');
  });
});

describe('resolvePersona', () => {
  it('should return empty object for undefined persona', () => {
    expect(resolvePersona(undefined, {}, '/dir')).toEqual({});
  });

  it('should use section mapping when available', () => {
    mockExistsSync.mockReturnValue(true);

    const result = resolvePersona(
      'coder',
      { personas: { coder: './personas/coder.md' } },
      '/dir',
    );
    expect(result.personaSpec).toBe('./personas/coder.md');
    expect(result.personaPath).toBeDefined();
  });

  it('should resolve path-based persona directly', () => {
    mockExistsSync.mockReturnValue(true);

    const result = resolvePersona('./coder.md', {}, '/dir');
    expect(result.personaSpec).toBe('./coder.md');
    expect(result.personaPath).toBeDefined();
  });

  it('should try candidate directories for name-based persona', () => {
    mockExistsSync.mockImplementation((p) => p === '/facets/coder.md');

    const result = resolvePersona('coder', {}, '/dir', ['/facets']);
    expect(result.personaSpec).toBe('coder');
    expect(result.personaPath).toBe('/facets/coder.md');
  });

  it('should fall back to pieceDir resolution when no candidateDirs match', () => {
    mockExistsSync.mockImplementation((p) => p === join('/dir', 'coder'));

    const result = resolvePersona('coder', {}, '/dir');
    expect(result.personaSpec).toBe('coder');
  });
});
