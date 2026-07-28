import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import {
  GlobalConfigSchema,
  ProjectConfigSchema,
} from '../core/models/config-schemas.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
  loadGlobalConfig,
  loadProjectConfig,
  resolveConfigValue,
  saveGlobalConfig,
  saveProjectConfig,
} from '../infra/config/index.js';

const root = join(tmpdir(), `takt-run-storage-config-${randomUUID()}`);
const projectDir = join(root, 'project');
const globalDir = join(root, 'global');
let originalConfigDir: string | undefined;

beforeEach(() => {
  originalConfigDir = process.env.TAKT_CONFIG_DIR;
  mkdirSync(join(projectDir, '.takt'), { recursive: true });
  mkdirSync(globalDir, { recursive: true });
  process.env.TAKT_CONFIG_DIR = globalDir;
  writeFileSync(join(globalDir, 'config.yaml'), 'language: en\n', 'utf-8');
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
});

afterEach(() => {
  if (originalConfigDir === undefined) {
    delete process.env.TAKT_CONFIG_DIR;
  } else {
    process.env.TAKT_CONFIG_DIR = originalConfigDir;
  }
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
  if (existsSync(root)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('run_storage config', () => {
  it('accepts only file and sqlite backends in project and global schemas', () => {
    expect(ProjectConfigSchema.parse({
      run_storage: { backend: 'sqlite' },
    }).run_storage).toEqual({ backend: 'sqlite' });
    expect(GlobalConfigSchema.parse({
      run_storage: { backend: 'file' },
    }).run_storage).toEqual({ backend: 'file' });
    expect(() => ProjectConfigSchema.parse({
      run_storage: { backend: 'memory' },
    })).toThrow();
    expect(() => GlobalConfigSchema.parse({
      run_storage: { backend: 'sqlite', fallback: 'file' },
    })).toThrow();
  });

  it('resolves project over global and defaults to file', () => {
    expect(resolveConfigValue(projectDir, 'runStorage')).toEqual({
      backend: 'file',
    });

    writeFileSync(
      join(globalDir, 'config.yaml'),
      'language: en\nrun_storage:\n  backend: sqlite\n',
      'utf-8',
    );
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    expect(resolveConfigValue(projectDir, 'runStorage')).toEqual({
      backend: 'sqlite',
    });

    writeFileSync(
      join(projectDir, '.takt', 'config.yaml'),
      'run_storage:\n  backend: file\n',
      'utf-8',
    );
    invalidateAllResolvedConfigCache();
    expect(resolveConfigValue(projectDir, 'runStorage')).toEqual({
      backend: 'file',
    });
  });

  it('round-trips the raw snake_case project key', () => {
    saveProjectConfig(projectDir, {
      runStorage: { backend: 'sqlite' },
    });

    expect(loadProjectConfig(projectDir).runStorage).toEqual({
      backend: 'sqlite',
    });
    expect(parse(readFileSync(
      join(projectDir, '.takt', 'config.yaml'),
      'utf-8',
    ))).toMatchObject({
      run_storage: { backend: 'sqlite' },
    });
  });

  it('round-trips the raw snake_case global key', () => {
    saveGlobalConfig({
      language: 'en',
      runStorage: { backend: 'sqlite' },
    });

    expect(loadGlobalConfig().runStorage).toEqual({
      backend: 'sqlite',
    });
    expect(parse(readFileSync(
      join(globalDir, 'config.yaml'),
      'utf-8',
    ))).toMatchObject({
      run_storage: { backend: 'sqlite' },
    });
  });
});
