import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractDescription,
  parseFacetType,
  scanFacets,
} from '../features/catalog/catalogFacets.js';

const paths = vi.hoisted(() => ({ builtin: '', global: '' }));

vi.mock('../infra/config/global/globalConfig.js', () => ({ loadGlobalConfig: () => ({}) }));
vi.mock('../infra/resources/index.js', () => ({
  getLanguageResourcesDir: () => paths.builtin,
}));
vi.mock('../infra/config/paths.js', () => ({
  getGlobalConfigDir: () => paths.global,
  getProjectConfigDir: (cwd: string) => join(cwd, '.takt'),
  getGlobalFacetDir: (type: string) => join(paths.global, 'facets', type),
  getProjectFacetDir: (cwd: string, type: string) => join(cwd, '.takt', 'facets', type),
  getBuiltinFacetDir: (_language: string, type: string) => join(paths.builtin, 'facets', type),
}));

describe('facet catalog data boundaries', () => {
  it('accepts only supported facet types', () => {
    expect(parseFacetType('personas')).toBe('personas');
    expect(parseFacetType('output-contracts')).toBe('output-contracts');
    expect(parseFacetType('unknown')).toBeNull();
  });

  it('extracts a stable description from user-provided Markdown content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'takt-catalog-description-'));
    try {
      const headingPath = join(dir, 'heading.md');
      const plainPath = join(dir, 'plain.md');
      writeFileSync(headingPath, '\n#  Dynamic heading  \n\nbody');
      writeFileSync(plainPath, '\n\nplain first line\nbody');

      expect(extractDescription(headingPath)).toBe('Dynamic heading');
      expect(extractDescription(plainPath)).toBe('plain first line');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects symlinked facet content at the catalog boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'takt-catalog-symlink-'));
    try {
      const external = mkdtempSync(join(tmpdir(), 'takt-catalog-external-'));
      try {
        const target = join(external, 'secret.md');
        const link = join(dir, 'linked.md');
        writeFileSync(target, '# secret');
        symlinkSync(target, link);

        expect(() => extractDescription(link)).toThrow();
      } finally {
        rmSync(external, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('scanFacets', () => {
    let root: string;
    let project: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'takt-catalog-scan-'));
      project = join(root, 'project');
      paths.builtin = join(root, 'builtin');
      paths.global = join(root, 'global');
      mkdirSync(project, { recursive: true });
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('merges builtin, user, and project layers while preserving override provenance', () => {
      const builtin = join(paths.builtin, 'facets', 'personas');
      const global = join(paths.global, 'facets', 'personas');
      const projectDir = join(project, '.takt', 'facets', 'personas');
      mkdirSync(builtin, { recursive: true });
      mkdirSync(global, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(builtin, 'shared.md'), '# builtin');
      writeFileSync(join(global, 'shared.md'), '# global');
      writeFileSync(join(projectDir, 'project.md'), '# project');

      const entries = scanFacets('personas', project);
      expect(entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(['shared', 'project']));
      expect(entries.find((entry) => entry.name === 'shared' && entry.source === 'builtin')?.overriddenBy)
        .toBe('user');
      expect(entries.find((entry) => entry.name === 'shared' && entry.source === 'user')?.overriddenBy)
        .toBeUndefined();
    });

    it('ignores non-Markdown files and missing facet directories', () => {
      const knowledge = join(paths.builtin, 'facets', 'knowledge');
      mkdirSync(knowledge, { recursive: true });
      writeFileSync(join(knowledge, 'kept.md'), '# kept');
      writeFileSync(join(knowledge, 'ignored.txt'), '# ignored');

      expect(scanFacets('knowledge', project).map((entry) => entry.name)).toEqual(['kept']);
      expect(scanFacets('instructions', project)).toEqual([]);
    });
  });
});
