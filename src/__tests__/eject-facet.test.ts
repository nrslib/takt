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
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';

// vi.hoisted runs before vi.mock hoisting — safe for shared state
const mocks = vi.hoisted(() => {
  let builtinDir = '';
  let projectFacetDir = '';
  let globalFacetDir = '';
  let projectWorkflowsDir = '';
  let globalWorkflowsDir = '';
  let builtinLanguageStepsDir = '';
  let projectStepsDir = '';
  let globalStepsDir = '';

  return {
    get builtinDir() { return builtinDir; },
    set builtinDir(v: string) { builtinDir = v; },
    get projectFacetDir() { return projectFacetDir; },
    set projectFacetDir(v: string) { projectFacetDir = v; },
    get globalFacetDir() { return globalFacetDir; },
    set globalFacetDir(v: string) { globalFacetDir = v; },
    get projectWorkflowsDir() { return projectWorkflowsDir; },
    set projectWorkflowsDir(v: string) { projectWorkflowsDir = v; },
    get globalWorkflowsDir() { return globalWorkflowsDir; },
    set globalWorkflowsDir(v: string) { globalWorkflowsDir = v; },
    get builtinLanguageStepsDir() { return builtinLanguageStepsDir; },
    set builtinLanguageStepsDir(v: string) { builtinLanguageStepsDir = v; },
    get projectStepsDir() { return projectStepsDir; },
    set projectStepsDir(v: string) { projectStepsDir = v; },
    get globalStepsDir() { return globalStepsDir; },
    set globalStepsDir(v: string) { globalStepsDir = v; },
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
  getGlobalWorkflowsDir: () => mocks.globalWorkflowsDir,
  getProjectWorkflowsDir: () => mocks.projectWorkflowsDir,
  getBuiltinWorkflowsDir: () => mocks.builtinDir,
  getBuiltinLanguageStepsDir: () => mocks.builtinLanguageStepsDir,
  getProjectStepsDir: () => mocks.projectStepsDir,
  getGlobalStepsDir: () => mocks.globalStepsDir,
  getBuiltinLanguageFacetPoolsDir: () => mocks.builtinDir,
  getBuiltinLanguageResourcesDir: () => mocks.builtinDir,
  getGlobalFacetPoolsDir: () => mocks.globalFacetDir,
  getProjectFacetPoolsDir: () => mocks.projectFacetDir,
  invalidateGlobalConfigCache: vi.fn(),
  invalidateAllResolvedConfigCache: vi.fn(),
  isPathSafe: (basePath: string, targetPath: string) => {
    const rel = relative(resolve(basePath), resolve(targetPath));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  },
}));

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/config/paths.js')>();
  return {
    ...actual,
    getBuiltinLanguageStepsDir: () => mocks.builtinLanguageStepsDir,
    getGlobalStepsDir: () => mocks.globalStepsDir,
  };
});

vi.mock('../shared/ui/index.js', () => mocks.ui);

import { ejectBuiltin, ejectFacet } from '../features/config/ejectBuiltin.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';

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
    mocks.projectWorkflowsDir = join(dirs.projectDir, '.takt', 'workflows');
    mocks.globalWorkflowsDir = join(dirs.globalDir, 'workflows');
    mocks.builtinLanguageStepsDir = join(dirs.baseDir, 'builtins', 'en', 'steps');
    mocks.projectStepsDir = join(dirs.projectDir, '.takt', 'steps');
    mocks.globalStepsDir = join(dirs.globalDir, 'steps');

    Object.values(mocks.ui).forEach((fn) => fn.mockClear());
  });

  afterEach(() => {
    dirs.cleanup();
  });

  it('should copy builtin facet to project .takt/{type}/', async () => {
    await ejectFacet('personas', 'coder', { projectDir: dirs.projectDir });

    const destPath = join(dirs.projectDir, '.takt', 'personas', 'coder.md');
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, 'utf-8')).toBe(readFileSync(join(dirs.builtinDir, 'coder.md'), 'utf-8'));
    expect(mocks.ui.success).toHaveBeenCalled();
  });

  it('should copy builtin facet to global ~/.takt/{type}/ with --global', async () => {
    await ejectFacet('personas', 'coder', { global: true, projectDir: dirs.projectDir });

    const destPath = join(dirs.globalDir, 'personas', 'coder.md');
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, 'utf-8')).toBe(readFileSync(join(dirs.builtinDir, 'coder.md'), 'utf-8'));
    expect(mocks.ui.success).toHaveBeenCalled();
  });

  it('should skip if facet already exists at destination', async () => {
    const destDir = join(dirs.projectDir, '.takt', 'personas');
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, 'coder.md'), 'Custom coder content');

    await ejectFacet('personas', 'coder', { projectDir: dirs.projectDir });

    // File should NOT be overwritten
    expect(readFileSync(join(destDir, 'coder.md'), 'utf-8')).toBe('Custom coder content');
    expect(mocks.ui.warn).toHaveBeenCalled();
  });

  it('should show error and list available facets when not found', async () => {
    await ejectFacet('personas', 'nonexistent', { projectDir: dirs.projectDir });

    expect(mocks.ui.error).toHaveBeenCalled();
  });

  it('should reject facet names that escape the builtin or target directory', async () => {
    await ejectFacet('personas', '../secrets', { projectDir: dirs.projectDir });

    expect(existsSync(join(dirs.projectDir, '.takt', 'secrets.md'))).toBe(false);
    expect(mocks.ui.error).toHaveBeenCalled();
  });
});

describe('ejectBuiltin', () => {
  let dirs: ReturnType<typeof createTestDirs>;

  beforeEach(() => {
    dirs = createTestDirs();
    mocks.builtinDir = join(dirs.baseDir, 'builtins', 'workflows');
    mocks.projectFacetDir = join(dirs.projectDir, '.takt', 'personas');
    mocks.globalFacetDir = join(dirs.globalDir, 'personas');
    mocks.projectWorkflowsDir = join(dirs.projectDir, '.takt', 'workflows');
    mocks.globalWorkflowsDir = join(dirs.globalDir, 'workflows');
    mocks.builtinLanguageStepsDir = join(dirs.baseDir, 'builtins', 'en', 'steps');
    mocks.projectStepsDir = join(dirs.projectDir, '.takt', 'steps');
    mocks.globalStepsDir = join(dirs.globalDir, 'steps');
    mkdirSync(mocks.builtinDir, { recursive: true });
    writeFileSync(join(mocks.builtinDir, 'default.yaml'), 'name: default\n');
    Object.values(mocks.ui).forEach((fn) => fn.mockClear());
  });

  afterEach(() => {
    dirs.cleanup();
  });

  it('should sanitize workflow names in builtin-not-found errors', async () => {
    await ejectBuiltin('bad\x1b[31m-workflow\n', { projectDir: dirs.projectDir });

    expect(mocks.ui.error).toHaveBeenCalled();
  });

  it('should sanitize destination paths in success output', async () => {
    mocks.projectWorkflowsDir = join(dirs.projectDir, '.takt', 'project-with-control\nchars', 'workflows');

    await ejectBuiltin('default', { projectDir: dirs.projectDir });

    expect(mocks.ui.success).toHaveBeenCalledWith(expect.stringContaining('project-with-control\\nchars'));
  });

  it('should reject workflow names that escape the builtin or target directory', async () => {
    await ejectBuiltin('../outside', { projectDir: dirs.projectDir });

    expect(existsSync(join(dirs.projectDir, '.takt', 'outside.yaml'))).toBe(false);
    expect(mocks.ui.error).toHaveBeenCalled();
  });

  it('should copy builtin step fragments so the ejected workflow passes the trust boundary', async () => {
    writeFileSync(join(mocks.builtinDir, 'default.yaml'), `name: default
initial_step: final-gate
max_steps: 1
steps:
  - name: final-gate
    uses: final-gate
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(mocks.builtinLanguageStepsDir, { recursive: true });
    writeFileSync(join(mocks.builtinLanguageStepsDir, 'final-gate.yaml'), 'uses: delegate\n');
    writeFileSync(join(mocks.builtinLanguageStepsDir, 'delegate.yaml'), `kind: workflow_call
call: called
`);

    await ejectBuiltin('default', { projectDir: dirs.projectDir });

    expect(existsSync(join(mocks.projectStepsDir, 'final-gate.yaml'))).toBe(true);
    expect(existsSync(join(mocks.projectStepsDir, 'delegate.yaml'))).toBe(true);
  });

  it('should reject a deep builtin fragment chain with the resolver depth error before copying output', async () => {
    writeFileSync(join(mocks.builtinDir, 'default.yaml'), `name: default
initial_step: depth-0
max_steps: 1
steps:
  - name: depth-0
    uses: depth-0
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(mocks.builtinLanguageStepsDir, { recursive: true });
    for (let index = 0; index <= 64; index += 1) {
      writeFileSync(
        join(mocks.builtinLanguageStepsDir, `depth-${index}.yaml`),
        index === 64 ? 'instruction: complete\n' : `uses: depth-${index + 1}\n`,
      );
    }

    await expect(ejectBuiltin('default', { projectDir: dirs.projectDir })).rejects.toThrow();

    expect(existsSync(join(mocks.projectStepsDir, 'depth-0.yaml'))).toBe(false);
    expect(existsSync(join(mocks.projectWorkflowsDir, 'default.yaml'))).toBe(false);
  });

  it('should retain the resolved source layer for nested builtin step fragments', async () => {
    writeFileSync(join(mocks.builtinDir, 'default.yaml'), `name: default
initial_step: parent
max_steps: 1
steps:
  - name: parent
    uses: parent
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(mocks.builtinLanguageStepsDir, { recursive: true });
    mkdirSync(mocks.globalStepsDir, { recursive: true });
    writeFileSync(join(mocks.builtinLanguageStepsDir, 'parent.yaml'), 'uses: child\n');
    writeFileSync(join(mocks.builtinLanguageStepsDir, 'child.yaml'), 'instruction: language child\n');
    writeFileSync(join(mocks.globalStepsDir, 'child.yaml'), 'instruction: global child\n');

    await ejectBuiltin('default', { projectDir: dirs.projectDir });

    expect(readFileSync(join(mocks.projectStepsDir, 'child.yaml'), 'utf-8')).toBe('instruction: language child\n');
  });

  it('should resolve nested global step fragments without reading project overrides', async () => {
    writeFileSync(join(mocks.builtinDir, 'default.yaml'), `name: default
initial_step: parent
max_steps: 1
steps:
  - name: parent
    uses: parent
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(mocks.globalStepsDir, { recursive: true });
    mkdirSync(mocks.projectStepsDir, { recursive: true });
    writeFileSync(join(mocks.globalStepsDir, 'parent.yaml'), 'uses: child\n');
    writeFileSync(join(mocks.globalStepsDir, 'child.yaml'), 'instruction: global child\n');
    writeFileSync(join(mocks.projectStepsDir, 'child.yaml'), '- not a step object\n');

    await ejectBuiltin('default', { projectDir: dirs.projectDir });

    expect(existsSync(join(mocks.projectStepsDir, 'parent.yaml'))).toBe(false);
    const workflowPath = join(mocks.projectWorkflowsDir, 'default.yaml');
    expect(existsSync(workflowPath)).toBe(true);
    expect(loadWorkflowFromFile(workflowPath, dirs.projectDir).steps[0]?.instruction).toBe('global child');
  });

  it.each([
    ['project', false],
    ['global', true],
  ])('should validate an existing %s step fragment that overrides a copied nested fragment', async (_target, global) => {
    writeFileSync(join(mocks.builtinDir, 'default.yaml'), `name: default
initial_step: parent
max_steps: 1
steps:
  - name: parent
    uses: parent
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(mocks.builtinLanguageStepsDir, { recursive: true });
    writeFileSync(join(mocks.builtinLanguageStepsDir, 'parent.yaml'), 'uses: child\n');
    writeFileSync(join(mocks.builtinLanguageStepsDir, 'child.yaml'), 'instruction: builtin child\n');

    const targetStepsDir = global ? mocks.globalStepsDir : mocks.projectStepsDir;
    mkdirSync(targetStepsDir, { recursive: true });
    writeFileSync(join(targetStepsDir, 'child.yaml'), '- not a step object\n');

    await expect(ejectBuiltin('default', { global, projectDir: dirs.projectDir })).rejects.toThrow();

    expect(existsSync(join(targetStepsDir, 'parent.yaml'))).toBe(false);
    expect(existsSync(join(global ? mocks.globalWorkflowsDir : mocks.projectWorkflowsDir, 'default.yaml'))).toBe(false);
  });

  it.each([
    ['project', false],
    ['global', true],
  ])('should warn when retaining an existing %s step fragment', async (_target, global) => {
    writeFileSync(join(mocks.builtinDir, 'default.yaml'), `name: default
initial_step: review
max_steps: 1
steps:
  - name: review
    uses: review
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(mocks.builtinLanguageStepsDir, { recursive: true });
    writeFileSync(join(mocks.builtinLanguageStepsDir, 'review.yaml'), 'instruction: builtin review\n');

    const targetStepsDir = global ? mocks.globalStepsDir : mocks.projectStepsDir;
    mkdirSync(targetStepsDir, { recursive: true });
    writeFileSync(join(targetStepsDir, 'review.yaml'), 'instruction: user review\n');

    await ejectBuiltin('default', { global, projectDir: dirs.projectDir });

    expect(readFileSync(join(targetStepsDir, 'review.yaml'), 'utf-8')).toBe('instruction: user review\n');
    expect(mocks.ui.warn).toHaveBeenCalled();
  });

  it('should reject an invalid builtin fragment before creating eject output', async () => {
    writeFileSync(join(mocks.builtinDir, 'default.yaml'), `name: default
initial_step: invalid
max_steps: 1
steps:
  - name: invalid
    uses: invalid
    rules:
      - condition: done
        next: COMPLETE
`);
    mkdirSync(mocks.builtinLanguageStepsDir, { recursive: true });
    writeFileSync(join(mocks.builtinLanguageStepsDir, 'invalid.yaml'), '- not a step object\n');

    await expect(ejectBuiltin('default', { projectDir: dirs.projectDir })).rejects.toThrow();

    expect(existsSync(join(mocks.projectStepsDir, 'invalid.yaml'))).toBe(false);
    expect(existsSync(join(mocks.projectWorkflowsDir, 'default.yaml'))).toBe(false);
  });

  it('should reject a scoped privileged fragment before creating project eject output', async () => {
    const previousConfigDir = process.env.TAKT_CONFIG_DIR;
    const configDir = join(dirs.baseDir, 'config');
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    try {
      writeFileSync(join(mocks.builtinDir, 'default.yaml'), `name: default
initial_step: review
max_steps: 1
steps:
  - name: review
    uses: "@owner/repo/unsafe"
    rules:
      - condition: done
        next: COMPLETE
`);
      const repertoireStepsDir = join(configDir, 'repertoire', '@owner', 'repo', 'steps');
      mkdirSync(repertoireStepsDir, { recursive: true });
      writeFileSync(join(repertoireStepsDir, 'unsafe.yaml'), 'instruction: review\nallow_git_commit: true\n');

      await expect(ejectBuiltin('default', { projectDir: dirs.projectDir })).rejects.toThrow();

      expect(existsSync(join(mocks.projectWorkflowsDir, 'default.yaml'))).toBe(false);
    } finally {
      if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
      else process.env.TAKT_CONFIG_DIR = previousConfigDir;
      invalidateGlobalConfigCache();
      invalidateAllResolvedConfigCache();
    }
  });
});
