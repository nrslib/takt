import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  mockExecFileSync,
  mockConfirm,
  mockInfo,
  mockResolveRef,
  mockPaths,
  mockFsFailure,
} = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockConfirm: vi.fn(),
  mockInfo: vi.fn(),
  mockResolveRef: vi.fn(),
  mockPaths: {
    root: '',
  },
  mockFsFailure: {
    lstatPathSuffix: '',
    readFilePathSuffix: '',
    readdirPathSuffix: '',
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();

  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (mockFsFailure.lstatPathSuffix !== '' && String(args[0]).endsWith(mockFsFailure.lstatPathSuffix)) {
        throw new Error('permission denied');
      }
      return actual.lstatSync(...args);
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (mockFsFailure.readFilePathSuffix !== '' && String(args[0]).endsWith(mockFsFailure.readFilePathSuffix)) {
        throw new Error('permission denied');
      }
      return actual.readFileSync(...args);
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (mockFsFailure.readdirPathSuffix !== '' && String(args[0]).endsWith(mockFsFailure.readdirPathSuffix)) {
        throw new Error('permission denied');
      }
      return actual.readdirSync(...args);
    },
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('../../features/repertoire/github-ref-resolver.js', () => ({
  resolveRef: mockResolveRef,
}));

vi.mock('../../infra/config/paths.js', () => ({
  getBuiltinProviderOptionsDir: (lang: string) => `${mockPaths.root}/builtins/${lang}/provider-options`,
  getBuiltinLanguageStepsDir: (lang: string) => `${mockPaths.root}/builtins/${lang}/steps`,
  getGlobalProviderOptionsDir: () => `${mockPaths.root}/home/.takt/provider-options`,
  getGlobalStepsDir: () => `${mockPaths.root}/home/.takt/steps`,
  getProjectProviderOptionsDir: (projectDir: string) => `${projectDir}/.takt/provider-options`,
  getProjectStepsDir: (projectDir: string) => `${projectDir}/.takt/steps`,
  getRepertoireDir: () => `${mockPaths.root}/home/.takt/repertoire`,
  getRepertoirePackageDir: (owner: string, repo: string) => `${mockPaths.root}/home/.takt/repertoire/@${owner}/${repo}`,
}));

vi.mock('../../infra/config/resolveWorkflowConfigValue.js', () => ({
  resolveWorkflowConfigValues: vi.fn(() => ({ language: 'ja' })),
}));

vi.mock('../../shared/prompt/index.js', () => ({
  confirm: mockConfirm,
}));

vi.mock('../../shared/ui/index.js', () => ({
  info: mockInfo,
  success: vi.fn(),
}));

vi.mock('../../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

import { repertoireAddCommand } from '../../commands/repertoire/add.js';
import { captureError } from '../helpers/repertoire-test-helpers.js';

let workflowCapabilitySet = 'edit';
let workflowUsesExcludedFragment = false;
let stepFragmentFileName = '';

describe('repertoireAddCommand install summary integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaths.root = '';
    workflowCapabilitySet = 'edit';
    workflowUsesExcludedFragment = false;
    stepFragmentFileName = '';
    mockFsFailure.lstatPathSuffix = '';
    mockFsFailure.readFilePathSuffix = '';
    mockFsFailure.readdirPathSuffix = '';
    mockConfirm.mockResolvedValue(false);
    mockResolveRef.mockReturnValue('main');
  });

  afterEach(() => {
    if (mockPaths.root !== '') {
      rmSync(mockPaths.root, { recursive: true, force: true });
    }
  });

  it('should report capability tools discovered through real package collection and summary detection', async () => {
    mockPaths.root = mkdirTempRoot();
    mockExecFileSync.mockImplementation(createPackageCommandHandler);

    await repertoireAddCommand('github:owner/repo@main');

    const messages = mockInfo.mock.calls.map((call) => String(call[0]));
    expect(messages).toContain('\n   ⚠ workflow.yaml: capabilities.allowed_tools: [Bash]');
  });

  it('should report capability tools from self scoped package refs before installation', async () => {
    mockPaths.root = mkdirTempRoot();
    workflowCapabilitySet = '@owner/repo/edit';
    writeInstalledProviderOptions('claude:\n  allowed_tools: [Read]\n');
    mockExecFileSync.mockImplementation(createPackageCommandHandler);

    await repertoireAddCommand('github:owner/repo@main');

    const messages = mockInfo.mock.calls.map((call) => String(call[0]));
    expect(messages).toContain('\n   ⚠ workflow.yaml: capabilities.allowed_tools: [Bash]');
    expect(messages).not.toContain('\n   ⚠ workflow.yaml: capabilities.allowed_tools: [Read]');
  });

  it('should reject before confirmation when the real collector excludes a referenced step fragment', async () => {
    mockPaths.root = mkdirTempRoot();
    workflowUsesExcludedFragment = true;
    mockExecFileSync.mockImplementation(createPackageCommandHandler);

    await expect(repertoireAddCommand('github:owner/repo@main'))
      .rejects.toThrow('Step fragment "excluded" referenced by workflows/workflow.yaml is excluded from package installation');

    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('should not confirm or install when package collection cannot read a discovered step fragment directory', async () => {
    mockPaths.root = mkdirTempRoot();
    mockFsFailure.readdirPathSuffix = '/extract/steps';
    mockExecFileSync.mockImplementation(createPackageCommandHandler);

    await expect(repertoireAddCommand('github:owner/repo@main'))
      .rejects.toThrow(/Failed to read package directory: .*\/extract\/steps/);

    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('should not confirm or install when package collection cannot inspect an enumerated step fragment', async () => {
    mockPaths.root = mkdirTempRoot();
    stepFragmentFileName = 'review.yaml';
    mockFsFailure.lstatPathSuffix = '/extract/steps/review.yaml';
    mockExecFileSync.mockImplementation(createPackageCommandHandler);

    await expect(repertoireAddCommand('github:owner/repo@main'))
      .rejects.toThrow(/Failed to inspect package entry: .*\/extract\/steps\/review\.yaml/);

    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('should include the step fragment path and preserve its cause when reading a collected fragment fails', async () => {
    mockPaths.root = mkdirTempRoot();
    stepFragmentFileName = 'review.yaml';
    mockFsFailure.readFilePathSuffix = '/extract/steps/review.yaml';
    mockExecFileSync.mockImplementation(createPackageCommandHandler);

    const error = await captureError(() => repertoireAddCommand('github:owner/repo@main'));

    expect(error.message).toContain('steps/review.yaml');
    expect(error.cause).toBeInstanceOf(Error);
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});

function createPackageCommandHandler(cmd: string, args: string[], options?: { encoding?: string }): Buffer | string {
  if (cmd === 'gh' && args[0] === '--version') {
    return Buffer.from('gh version 2.0.0');
  }
  if (cmd === 'gh' && args[0] === 'api') {
    return Buffer.from('tarball');
  }
  if (cmd === 'tar' && args[0] === 'tvzf') {
    return tarListing();
  }
  if (cmd === 'tar' && args[0] === 'xzf') {
    extractPackage(args);
    return options?.encoding === 'utf-8' ? '' : Buffer.from('');
  }
  throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
}

function mkdirTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'takt-repertoire-add-integration-'));
}

function tarListing(): string {
  return [
    'drwxr-xr-x  0 owner/repo 0 2026-06-01 12:00 owner-repo-main/',
    '-rw-r--r--  0 owner/repo 0 2026-06-01 12:00 owner-repo-main/takt-repertoire.yaml',
    '-rw-r--r--  0 owner/repo 0 2026-06-01 12:00 owner-repo-main/workflows/workflow.yaml',
    '-rw-r--r--  0 owner/repo 0 2026-06-01 12:00 owner-repo-main/provider-options/edit.yaml',
    ...(workflowUsesExcludedFragment
      ? ['lrwxr-xr-x  0 owner/repo 0 2026-06-01 12:00 owner-repo-main/steps/excluded.yaml -> ../workflows/workflow.yaml']
      : []),
    ...(stepFragmentFileName === ''
      ? []
      : [`-rw-r--r--  0 owner/repo 0 2026-06-01 12:00 owner-repo-main/steps/${stepFragmentFileName}`]),
  ].join('\n');
}

function extractPackage(args: string[]): void {
  const targetDir = args[args.indexOf('-C') + 1];
  if (targetDir === undefined) {
    throw new Error('tar extract target directory was not provided');
  }
  mkdirSync(join(targetDir, 'workflows'), { recursive: true });
  mkdirSync(join(targetDir, 'provider-options'), { recursive: true });
  mkdirSync(join(targetDir, 'steps'), { recursive: true });
  writeFileSync(join(targetDir, 'takt-repertoire.yaml'), 'path: .\n');
  const workflowYaml = workflowUsesExcludedFragment
    ? 'steps:\n  - uses: excluded\n'
    : [
        'steps:',
        '  - name: run',
        `    capabilities: "${workflowCapabilitySet}"`,
        '',
      ].join('\n');
  writeFileSync(join(targetDir, 'workflows', 'workflow.yaml'), workflowYaml);
  writeFileSync(join(targetDir, 'provider-options', 'edit.yaml'), 'claude:\n  allowed_tools: [Bash]\n');
  if (stepFragmentFileName !== '') {
    writeFileSync(join(targetDir, 'steps', stepFragmentFileName), 'persona: reviewer\n');
  }
  if (workflowUsesExcludedFragment) {
    symlinkSync(join(targetDir, 'workflows', 'workflow.yaml'), join(targetDir, 'steps', 'excluded.yaml'));
  }
}

function writeInstalledProviderOptions(content: string): void {
  const providerOptionsDir = join(mockPaths.root, 'home', '.takt', 'repertoire', '@owner', 'repo', 'provider-options');
  mkdirSync(providerOptionsDir, { recursive: true });
  writeFileSync(join(providerOptionsDir, 'edit.yaml'), content);
}
