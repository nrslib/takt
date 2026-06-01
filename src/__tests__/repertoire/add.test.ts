import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  mockMkdtempSync,
  mockMkdirSync,
  mockCopyFileSync,
  mockExistsSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockRmSync,
  mockExecFileSync,
  mockResolveRef,
  mockResolveRepertoireConfigPath,
  mockAtomicReplace,
  secureTempDir,
} = vi.hoisted(() => ({
  mockMkdtempSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockCopyFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockRmSync: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockResolveRef: vi.fn(),
  mockResolveRepertoireConfigPath: vi.fn(),
  mockAtomicReplace: vi.fn(),
  secureTempDir: '/secure/tmp/takt-import-a1b2c3',
}));

vi.mock('node:fs', () => ({
  default: {
    mkdtempSync: mockMkdtempSync,
    mkdirSync: mockMkdirSync,
    copyFileSync: mockCopyFileSync,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    rmSync: mockRmSync,
  },
  mkdtempSync: mockMkdtempSync,
  mkdirSync: mockMkdirSync,
  copyFileSync: mockCopyFileSync,
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  rmSync: mockRmSync,
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('../../infra/config/paths.js', () => ({
  getRepertoirePackageDir: vi.fn(() => '/home/user/.takt/repertoire/@owner/repo'),
}));

vi.mock('../../features/repertoire/github-ref-resolver.js', () => ({
  resolveRef: mockResolveRef,
}));

vi.mock('../../features/repertoire/tar-parser.js', () => ({
  parseTarVerboseListing: vi.fn(() => ({
    firstDirEntry: 'owner-repo-deadbeef',
    includePaths: ['owner-repo-deadbeef/facets/personas/coder.md'],
  })),
}));

vi.mock('../../features/repertoire/takt-repertoire-config.js', () => ({
  parseTaktRepertoireConfig: vi.fn(() => ({ path: '.' })),
  validateTaktRepertoirePath: vi.fn(),
  validateMinVersion: vi.fn(),
  isVersionCompatible: vi.fn(() => true),
  checkPackageHasContentWithContext: vi.fn(),
  validateRealpathInsideRoot: vi.fn(),
  resolveRepertoireConfigPath: mockResolveRepertoireConfigPath,
}));

vi.mock('../../features/repertoire/file-filter.js', () => ({
  collectCopyTargets: vi.fn(() => [{
    absolutePath: `${secureTempDir}/extract/facets/personas/coder.md`,
    relativePath: 'facets/personas/coder.md',
  }]),
}));

vi.mock('../../features/repertoire/atomic-update.js', () => ({
  cleanupResiduals: vi.fn(),
  atomicReplace: mockAtomicReplace,
}));

vi.mock('../../features/repertoire/pack-summary.js', () => ({
  summarizeFacetsByType: vi.fn(() => 'personas: 1'),
  detectEditWorkflows: vi.fn(() => []),
  formatEditWorkflowWarnings: vi.fn(() => []),
}));

vi.mock('../../shared/prompt/index.js', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../shared/ui/index.js', () => ({
  info: vi.fn(),
  success: vi.fn(),
}));

vi.mock('../../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

import { repertoireAddCommand } from '../../commands/repertoire/add.js';

describe('repertoireAddCommand temporary directory handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdtempSync.mockReturnValue(secureTempDir);
    mockExistsSync.mockImplementation((target: string) => target === secureTempDir);
    mockReadFileSync.mockReturnValue('path: .');
    mockResolveRef.mockReturnValue('main');
    mockResolveRepertoireConfigPath.mockReturnValue(join(secureTempDir, 'extract', '.takt', 'takt-repertoire.yaml'));
    mockAtomicReplace.mockImplementation(async ({ install }: { install: () => Promise<void> }) => {
      await install();
    });
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') return Buffer.from('tarball');
      if (args[0] === 'tvzf') {
        return 'drwxr-xr-x  0 owner/repo 0 2026-06-01 12:00 owner-repo-deadbeef/\n'
          + '-rw-r--r--  0 owner/repo 0 2026-06-01 12:00 owner-repo-deadbeef/facets/personas/coder.md\n';
      }
      return Buffer.from('');
    });
  });

  it('should create import artifacts under a mkdtemp-created directory', async () => {
    await repertoireAddCommand('github:owner/repo@main');

    expect(mockMkdtempSync).toHaveBeenCalledWith(join(tmpdir(), 'takt-import-'));
    expect(mockMkdirSync).toHaveBeenCalledWith(join(secureTempDir, 'extract'), { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(join(secureTempDir, 'archive.tar.gz'), Buffer.from('tarball'));
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join(secureTempDir, 'include.txt'),
      'owner-repo-deadbeef/facets/personas/coder.md\n',
    );
    expect(mockResolveRepertoireConfigPath).toHaveBeenCalledWith(join(secureTempDir, 'extract'));
  });

  it('should clean up the mkdtemp-created directory once', async () => {
    await repertoireAddCommand('github:owner/repo@main');

    expect(mockRmSync).toHaveBeenCalledOnce();
    expect(mockRmSync).toHaveBeenCalledWith(secureTempDir, { recursive: true, force: true });
  });
});
