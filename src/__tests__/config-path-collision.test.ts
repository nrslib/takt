import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getConfigDirCollision,
  getGlobalConfigDir,
  getProjectConfigDir,
} from '../infra/config/paths.js';

const osState = vi.hoisted(() => ({ homeDir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => osState.homeDir,
  };
});

describe('configuration directory collision detection', () => {
  let testRoot: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'takt-config-path-collision-'));
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    delete process.env.TAKT_CONFIG_DIR;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalConfigDir;
    }
    osState.homeDir = '';
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('detects the default global and project directories when neither exists', () => {
    const projectDir = join(testRoot, 'home');
    mkdirSync(projectDir);
    osState.homeDir = projectDir;

    const projectConfigDir = getProjectConfigDir(projectDir);

    expect(getGlobalConfigDir()).toBe(projectConfigDir);
    expect(existsSync(projectConfigDir)).toBe(false);
    expect(getConfigDirCollision(projectDir)).toBe(resolve(projectConfigDir));
    expect(readdirSync(projectDir)).toEqual([]);
  });

  it('normalizes missing paths before comparing them', () => {
    const projectDir = join(testRoot, 'project');
    mkdirSync(projectDir);
    const projectConfigDir = getProjectConfigDir(projectDir);
    process.env.TAKT_CONFIG_DIR = join(projectDir, 'missing', '..', '.takt');

    expect(existsSync(projectConfigDir)).toBe(false);
    expect(getConfigDirCollision(projectDir)).toBe(resolve(projectConfigDir));
    expect(readdirSync(projectDir)).toEqual([]);
  });

  it('detects a project config symlink that resolves to the global directory', () => {
    const projectDir = join(testRoot, 'project');
    const globalDir = join(testRoot, 'global');
    mkdirSync(projectDir);
    mkdirSync(globalDir);
    process.env.TAKT_CONFIG_DIR = globalDir;
    symlinkSync(globalDir, getProjectConfigDir(projectDir), 'dir');

    expect(getConfigDirCollision(projectDir)).toBe(realpathSync(globalDir));
  });

  it('does not report a collision for distinct resolved directories', () => {
    const projectDir = join(testRoot, 'project');
    const globalDir = join(testRoot, 'global');
    mkdirSync(projectDir);
    mkdirSync(globalDir);
    process.env.TAKT_CONFIG_DIR = globalDir;

    expect(getConfigDirCollision(projectDir)).toBeUndefined();
  });

  it('does not report a collision when the global directory is the project parent', () => {
    const projectDir = join(testRoot, 'project');
    mkdirSync(projectDir);
    process.env.TAKT_CONFIG_DIR = testRoot;

    expect(getConfigDirCollision(projectDir)).toBeUndefined();
  });

  it('does not report a collision when the project configuration directory is the global parent', () => {
    const projectDir = join(testRoot, 'project');
    const projectConfigDir = getProjectConfigDir(projectDir);
    mkdirSync(projectConfigDir, { recursive: true });
    mkdirSync(join(projectConfigDir, 'global'));
    process.env.TAKT_CONFIG_DIR = join(projectConfigDir, 'global');

    expect(getConfigDirCollision(projectDir)).toBeUndefined();
  });
});
