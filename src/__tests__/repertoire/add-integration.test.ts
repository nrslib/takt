import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  mockExecFileSync,
  mockConfirm,
  mockInfo,
  mockResolveRef,
  mockPaths,
} = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockConfirm: vi.fn(),
  mockInfo: vi.fn(),
  mockResolveRef: vi.fn(),
  mockPaths: {
    root: '',
  },
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('../../features/repertoire/github-ref-resolver.js', () => ({
  resolveRef: mockResolveRef,
}));

vi.mock('../../infra/config/paths.js', () => ({
  getBuiltinProviderOptionsDir: (lang: string) => `${mockPaths.root}/builtins/${lang}/provider-options`,
  getGlobalProviderOptionsDir: () => `${mockPaths.root}/home/.takt/provider-options`,
  getProjectProviderOptionsDir: (projectDir: string) => `${projectDir}/.takt/provider-options`,
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

let workflowProviderOptionsRef = 'edit';

describe('repertoireAddCommand install summary integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaths.root = '';
    workflowProviderOptionsRef = 'edit';
    mockConfirm.mockResolvedValue(false);
    mockResolveRef.mockReturnValue('main');
  });

  afterEach(() => {
    if (mockPaths.root !== '') {
      rmSync(mockPaths.root, { recursive: true, force: true });
    }
  });

  it('should report provider_options tools discovered through real package collection and summary detection', async () => {
    mockPaths.root = mkdirTempRoot();
    mockExecFileSync.mockImplementation((cmd: string, args: string[], options?: { encoding?: string }) => {
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
    });

    await repertoireAddCommand('github:owner/repo@main');

    const messages = mockInfo.mock.calls.map((call) => String(call[0]));
    expect(messages).toContain('\n   ⚠ workflow.yaml: provider_options.allowed_tools: [Bash]');
  });

  it('should report provider_options tools from self scoped package refs before installation', async () => {
    mockPaths.root = mkdirTempRoot();
    workflowProviderOptionsRef = '@owner/repo/edit';
    writeInstalledProviderOptions('claude:\n  allowed_tools: [Read]\n');
    mockExecFileSync.mockImplementation((cmd: string, args: string[], options?: { encoding?: string }) => {
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
    });

    await repertoireAddCommand('github:owner/repo@main');

    const messages = mockInfo.mock.calls.map((call) => String(call[0]));
    expect(messages).toContain('\n   ⚠ workflow.yaml: provider_options.allowed_tools: [Bash]');
    expect(messages).not.toContain('\n   ⚠ workflow.yaml: provider_options.allowed_tools: [Read]');
  });
});

function mkdirTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'takt-repertoire-add-integration-'));
}

function tarListing(): string {
  return [
    'drwxr-xr-x  0 owner/repo 0 2026-06-01 12:00 owner-repo-main/',
    '-rw-r--r--  0 owner/repo 0 2026-06-01 12:00 owner-repo-main/takt-repertoire.yaml',
    '-rw-r--r--  0 owner/repo 0 2026-06-01 12:00 owner-repo-main/workflows/workflow.yaml',
    '-rw-r--r--  0 owner/repo 0 2026-06-01 12:00 owner-repo-main/provider-options/edit.yaml',
  ].join('\n');
}

function extractPackage(args: string[]): void {
  const targetDir = args[args.indexOf('-C') + 1];
  if (targetDir === undefined) {
    throw new Error('tar extract target directory was not provided');
  }
  mkdirSync(join(targetDir, 'workflows'), { recursive: true });
  mkdirSync(join(targetDir, 'provider-options'), { recursive: true });
  writeFileSync(join(targetDir, 'takt-repertoire.yaml'), 'path: .\n');
  writeFileSync(
    join(targetDir, 'workflows', 'workflow.yaml'),
    [
      'steps:',
      '  - name: run',
      '    provider_options:',
      `      $ref: "${workflowProviderOptionsRef}"`,
      '',
    ].join('\n'),
  );
  writeFileSync(join(targetDir, 'provider-options', 'edit.yaml'), 'claude:\n  allowed_tools: [Bash]\n');
}

function writeInstalledProviderOptions(content: string): void {
  const providerOptionsDir = join(mockPaths.root, 'home', '.takt', 'repertoire', '@owner', 'repo', 'provider-options');
  mkdirSync(providerOptionsDir, { recursive: true });
  writeFileSync(join(providerOptionsDir, 'edit.yaml'), content);
}
