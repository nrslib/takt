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
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// vi.hoisted runs before vi.mock hoisting — safe for shared state
const mocks = vi.hoisted(() => {
  let builtinDir = '';
  let projectFacetDir = '';
  let globalFacetDir = '';

  return {
    get builtinDir() { return builtinDir; },
    set builtinDir(v: string) { builtinDir = v; },
    get projectFacetDir() { return projectFacetDir; },
    set projectFacetDir(v: string) { projectFacetDir = v; },
    get globalFacetDir() { return globalFacetDir; },
    set globalFacetDir(v: string) { globalFacetDir = v; },
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
  getGlobalPiecesDir: vi.fn(),
  getProjectPiecesDir: vi.fn(),
  getBuiltinPiecesDir: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => mocks.ui);

import { ejectFacet } from '../features/config/ejectBuiltin.js';

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
});
