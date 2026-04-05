/**
 * Tests for ejectFacet function.
 *
 * Covers:
 * - Normal copy from builtin to project layer
 * - Normal copy from builtin to global layer (--global)
 * - Skip when facet already exists at destination
 * - Error and listing when facet not found in builtins
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// vi.hoisted runs before vi.mock hoisting — safe for shared state
const mocks = vi.hoisted(() => {
  let builtinDir = '';
  let projectFacetDir = '';
  let globalFacetDir = '';
  let projectPiecesDir = '';
  let globalPiecesDir = '';

  return {
    get builtinDir() { return builtinDir; },
    set builtinDir(v: string) { builtinDir = v; },
    get projectFacetDir() { return projectFacetDir; },
    set projectFacetDir(v: string) { projectFacetDir = v; },
    get globalFacetDir() { return globalFacetDir; },
    set globalFacetDir(v: string) { globalFacetDir = v; },
    get projectPiecesDir() { return projectPiecesDir; },
    set projectPiecesDir(v: string) { projectPiecesDir = v; },
    get globalPiecesDir() { return globalPiecesDir; },
    set globalPiecesDir(v: string) { globalPiecesDir = v; },
    ui: {
      header: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      blankLine: vi.fn(),
    },
  };
});

vi.mock('../infra/config/index.js', () => ({
  getLanguage: () => 'en' as const,
  getBuiltinFacetDir: () => mocks.builtinDir,
  getProjectFacetDir: () => mocks.projectFacetDir,
  getGlobalFacetDir: () => mocks.globalFacetDir,
  getGlobalWorkflowsDir: () => mocks.globalPiecesDir,
  getProjectWorkflowsDir: () => mocks.projectPiecesDir,
  getBuiltinWorkflowsDir: () => mocks.builtinDir,
  isPathSafe: (basePath: string, targetPath: string) => {
    const rel = relative(resolve(basePath), resolve(targetPath));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  },
}));

vi.mock('../shared/ui/index.js', () => mocks.ui);

import { ejectBuiltin, ejectFacet } from '../features/config/ejectBuiltin.js';

function createTestDirs() {
  const baseDir = mkdtempSync(join(tmpdir(), 'takt-eject-facet-test-'));
  const builtinDir = join(baseDir, 'builtins', 'personas');
  const projectDir = join(baseDir, 'project');
  const globalDir = join(baseDir, 'global');

  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(globalDir, { recursive: true });

  writeFileSync(join(builtinDir, 'coder.md'), '# Coder Persona\nYou are a coder.');
  writeFileSync(join(builtinDir, 'planner.md'), '# Planner Persona\nYou are a planner.');

  return {
    baseDir,
    builtinDir,
    projectDir,
    globalDir,
    cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
  };
}

describe('ejectFacet', () => {
  let dirs: ReturnType<typeof createTestDirs>;

  beforeEach(() => {
    dirs = createTestDirs();
    mocks.builtinDir = dirs.builtinDir;
    mocks.projectFacetDir = join(dirs.projectDir, '.takt', 'personas');
    mocks.globalFacetDir = join(dirs.globalDir, 'personas');
    mocks.projectPiecesDir = join(dirs.projectDir, '.takt', 'workflows');
    mocks.globalPiecesDir = join(dirs.globalDir, 'workflows');

    Object.values(mocks.ui).forEach((fn) => fn.mockClear());
  });

  afterEach(() => {
    dirs.cleanup();
  });

  it('should copy builtin facet to project .takt/{type}/', async () => {
    await ejectFacet('personas', 'coder', { projectDir: dirs.projectDir });

    const destPath = join(dirs.projectDir, '.takt', 'personas', 'coder.md');
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, 'utf-8')).toBe('# Coder Persona\nYou are a coder.');
    expect(mocks.ui.success).toHaveBeenCalled();
  });

  it('should copy builtin facet to global ~/.takt/{type}/ with --global', async () => {
    await ejectFacet('personas', 'coder', { global: true, projectDir: dirs.projectDir });

    const destPath = join(dirs.globalDir, 'personas', 'coder.md');
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, 'utf-8')).toBe('# Coder Persona\nYou are a coder.');
    expect(mocks.ui.success).toHaveBeenCalled();
  });

  it('should skip if facet already exists at destination', async () => {
    const destDir = join(dirs.projectDir, '.takt', 'personas');
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, 'coder.md'), 'Custom coder content');

    await ejectFacet('personas', 'coder', { projectDir: dirs.projectDir });

    // File should NOT be overwritten
    expect(readFileSync(join(destDir, 'coder.md'), 'utf-8')).toBe('Custom coder content');
    expect(mocks.ui.warn).toHaveBeenCalledWith(expect.stringContaining('Already exists'));
  });

  it('should show error and list available facets when not found', async () => {
    await ejectFacet('personas', 'nonexistent', { projectDir: dirs.projectDir });

    expect(mocks.ui.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(mocks.ui.info).toHaveBeenCalledWith(expect.stringContaining('Available'));
  });

  it('should reject facet names that escape the builtin or target directory', async () => {
    await ejectFacet('personas', '../secrets', { projectDir: dirs.projectDir });

    expect(existsSync(join(dirs.projectDir, '.takt', 'secrets.md'))).toBe(false);
    expect(mocks.ui.error).toHaveBeenCalledWith('Invalid personas name: ../secrets');
  });
});

describe('ejectBuiltin', () => {
  let dirs: ReturnType<typeof createTestDirs>;

  beforeEach(() => {
    dirs = createTestDirs();
    mocks.builtinDir = join(dirs.baseDir, 'builtins', 'workflows');
    mocks.projectFacetDir = join(dirs.projectDir, '.takt', 'personas');
    mocks.globalFacetDir = join(dirs.globalDir, 'personas');
    mocks.projectPiecesDir = join(dirs.projectDir, '.takt', 'workflows');
    mocks.globalPiecesDir = join(dirs.globalDir, 'workflows');
    mkdirSync(mocks.builtinDir, { recursive: true });
    writeFileSync(join(mocks.builtinDir, 'default.yaml'), 'name: default\n');
    Object.values(mocks.ui).forEach((fn) => fn.mockClear());
  });

  afterEach(() => {
    dirs.cleanup();
  });

  it('should sanitize workflow names in builtin-not-found errors', async () => {
    await ejectBuiltin('bad\x1b[31m-workflow\n', { projectDir: dirs.projectDir });

    expect(mocks.ui.error).toHaveBeenCalledWith('Builtin workflow not found: bad-workflow\\n');
  });

  it('should sanitize destination paths in success output', async () => {
    mocks.projectPiecesDir = join(dirs.baseDir, 'project-with-control\nchars', '.takt', 'workflows');

    await ejectBuiltin('default', { projectDir: dirs.projectDir });

    expect(mocks.ui.success).toHaveBeenCalledWith(expect.stringContaining('project-with-control\\nchars'));
  });

  it('should reject workflow names that escape the builtin or target directory', async () => {
    await ejectBuiltin('../outside', { projectDir: dirs.projectDir });

    expect(existsSync(join(dirs.projectDir, '.takt', 'outside.yaml'))).toBe(false);
    expect(mocks.ui.error).toHaveBeenCalledWith('Invalid workflow name: ../outside');
  });
});
