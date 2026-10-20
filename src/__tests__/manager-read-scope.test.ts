import { accessSync, opendirSync, realpathSync, statSync, type Dir, type Dirent, type Stats } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyManagerToolPermission } from '../features/manager/toolPermissionClassifier.js';
import { isManagerReadAllowed, managerReadScope, type ScopedReadRequest } from '../features/manager/readScope.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  accessSync: vi.fn(), opendirSync: vi.fn(), realpathSync: Object.assign(vi.fn(), { native: vi.fn() }), statSync: vi.fn(),
}));

describe('manager read requests without resolved assignment', () => {
  it.each(['Read', 'Glob', 'Grep'])('judges %s when the manager assignment is unavailable', (toolName) => {
    const request = {
      toolName, cwd: '/work/other',
      toolInput: { file_path: '/work/other/public.txt', path: '/work/other', pattern: 'public.txt', readOnlyHint: true },
    };

    expect(classifyManagerToolPermission(request, 'ja', 'claude-sdk')).toEqual({ decision: 'judge' });
  });
});

describe('manager read target classification', () => {
  function directory(readEntry: () => Dirent | null) {
    return { readSync: vi.fn(readEntry), closeSync: vi.fn() };
  }

  function fileEntry(name: string): Dirent {
    return { name, isDirectory: () => false, isSymbolicLink: () => false } as Dirent;
  }

  function request(toolName: string, toolInput: unknown): ScopedReadRequest {
    return { toolName, toolInput, cwd: '/work/repo/src', [managerReadScope]: {
      repositoryDirectories: ['/work/repo'], sensitivePaths: ['.env', '.env.*', '*.pem', 'private', 'config/credentials.json'],
    } };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(realpathSync).mockImplementation((path) => String(path));
    vi.mocked(realpathSync.native).mockImplementation((path) => resolve(String(path)));
    vi.mocked(statSync).mockReturnValue({ isFile: () => true, isDirectory: () => false } as Stats);
  });

  it('resolves relative paths before allowing an assigned ordinary file', () => {
    expect(isManagerReadAllowed(request('Read', { file_path: '../src/main.ts' }))).toBe(true);
    expect(accessSync).toHaveBeenCalledWith('/work/repo/src/main.ts', expect.any(Number));
  });

  it.each(['/work/repo-other/public.txt', '/home/user/.aws/credentials', '/work/repo/.env',
    '/work/repo/.env.local', '/work/repo/server.pem', '/work/repo/private/file.txt',
    '/work/repo/config/credentials.json'])('does not allow outside or sensitive target %s', (file_path) => {
    expect(isManagerReadAllowed(request('Read', { file_path }))).toBe(false);
  });

  it('does not confuse configured directory boundaries with name prefixes', () => {
    expect(isManagerReadAllowed(request('Read', { file_path: '/work/repo/private-public/main.ts' }))).toBe(true);
  });

  it('checks symlink targets as well as their public-looking names', () => {
    vi.mocked(realpathSync.native).mockReturnValue('/work/repo/.env');
    expect(isManagerReadAllowed(request('Read', { file_path: 'public.txt' }))).toBe(false);
  });

  it.each([realpathSync.native, accessSync])('does not allow resolution or read failures', (operation) => {
    vi.mocked(operation).mockImplementation(() => { throw new Error('fixture inaccessible'); });
    expect(isManagerReadAllowed(request('Read', { file_path: 'main.ts' }))).toBe(false);
  });

  it('distinguishes Grep content from its target path', () => {
    expect(isManagerReadAllowed(request('Grep', { path: 'main.ts', pattern: '.env' }))).toBe(true);
  });

  it.each(['../other/*', '/absolute/*', '*.{ts,js}', '!*.pem', '[ab]*', 'a\\*'])('judges unsupported search pattern %s', (pattern) => {
    expect(isManagerReadAllowed(request('Glob', { pattern }))).toBe(false);
  });

  it('rejects a directory as a Read target and a file as a Glob root', () => {
    expect(isManagerReadAllowed(request('Glob', { path: 'main.ts', pattern: '*' }))).toBe(false);
    vi.mocked(statSync).mockReturnValue({ isFile: () => false, isDirectory: () => true } as Stats);
    expect(isManagerReadAllowed(request('Read', { file_path: '.' }))).toBe(false);
  });

  it('does not read file contents while checking an empty directory search', () => {
    vi.mocked(statSync).mockReturnValue({ isFile: () => false, isDirectory: () => true } as Stats);
    const handle = directory(() => null);
    vi.mocked(opendirSync).mockReturnValue(handle as unknown as Dir);
    expect(isManagerReadAllowed(request('Grep', { pattern: 'fixture' }))).toBe(true);
    expect(handle.closeSync).toHaveBeenCalledOnce();
  });

  it.each(['Glob', 'Grep'])('scans resolved child directories for %s', (toolName) => {
    vi.mocked(realpathSync.native).mockImplementation((path) => String(path).replace('/src/link', '/target'));
    vi.mocked(statSync).mockReturnValue({ isFile: () => false, isDirectory: () => true } as Stats);
    const handles: ReturnType<typeof directory>[] = [];
    vi.mocked(opendirSync).mockImplementation((path) => {
      const directory = String(path).replace('/src/link', '/target');
      const name = directory === '/work/repo/src' ? 'link'
        : directory === '/work/repo/target' ? 'nested' : undefined;
      const entry = name === undefined ? null : {
        name, isDirectory: () => name === 'nested', isSymbolicLink: () => name === 'link',
      } as Dirent;
      const handle = { readSync: vi.fn().mockReturnValueOnce(entry).mockReturnValue(null), closeSync: vi.fn() };
      handles.push(handle);
      return handle as unknown as Dir;
    });

    expect(isManagerReadAllowed(request(toolName, { pattern: toolName === 'Glob' ? '**/*' : 'fixture' }))).toBe(true);
    expect(vi.mocked(opendirSync).mock.calls.map(([path]) => path)).toEqual([
      '/work/repo/src', '/work/repo/target', '/work/repo/target/nested',
    ]);
    for (const handle of handles) expect(handle.closeSync).toHaveBeenCalledOnce();
  });

  it.each([
    ['**/*.ts', 'main.ts', true],
    ['**/*', 'server.pem', false],
    ['*.ts', '.env', false],
    ['*.ts', 'server.pem', true],
  ])('checks selected search targets for %s / %s', (pattern, name, allowed) => {
    vi.mocked(statSync).mockImplementation((path) => ({
      isFile: () => String(path) !== '/work/repo/src',
      isDirectory: () => String(path) === '/work/repo/src',
    } as Stats));
    const handle = directory(() => null);
    handle.readSync.mockReturnValueOnce(fileEntry(name));
    vi.mocked(opendirSync).mockReturnValue(handle as unknown as Dir);
    expect(isManagerReadAllowed(request('Glob', { pattern }))).toBe(allowed);
    expect(handle.closeSync).toHaveBeenCalledOnce();
  });

  it('inspects each supplied entry before requesting the next one', () => {
    vi.mocked(statSync).mockImplementation((path) => ({
      isFile: () => String(path) !== '/work/repo/src',
      isDirectory: () => String(path) === '/work/repo/src',
    } as Stats));
    let supplied = 0;
    const handle = directory(() => {
      if (supplied > 0) {
        expect(accessSync).toHaveBeenLastCalledWith(`/work/repo/src/file-${supplied - 1}.ts`, expect.any(Number));
      }
      if (supplied === 3) return null;
      return fileEntry(`file-${supplied++}.ts`);
    });
    vi.mocked(opendirSync).mockReturnValue(handle as unknown as Dir);

    expect(isManagerReadAllowed(request('Glob', { pattern: '**/*' }))).toBe(true);
    expect(supplied).toBe(3);
    expect(handle.closeSync).toHaveBeenCalledOnce();
  });

  it('closes a directory immediately when a sensitive entry is found', () => {
    vi.mocked(statSync).mockReturnValue({ isFile: () => false, isDirectory: () => true } as Stats);
    const handle = directory(() => { throw new Error('Must not request another entry'); });
    handle.readSync.mockReturnValueOnce(fileEntry('.env'));
    vi.mocked(opendirSync).mockReturnValue(handle as unknown as Dir);

    expect(isManagerReadAllowed(request('Glob', { pattern: '**/*' }))).toBe(false);
    expect(handle.readSync).toHaveBeenCalledOnce();
    expect(handle.closeSync).toHaveBeenCalledOnce();
  });

  it.each(['open', 'read', 'inspect', 'close'] as const)('closes acquired parent and child handles on a child %s failure', (failure) => {
    vi.mocked(statSync).mockReturnValue({ isFile: () => false, isDirectory: () => true } as Stats);
    const parent = directory(() => null);
    parent.readSync.mockReturnValueOnce({ name: 'nested', isDirectory: () => true, isSymbolicLink: () => false } as Dirent);
    const child = directory(() => null);
    const fail = () => { throw new Error('fixture directory failure'); };
    vi.mocked(opendirSync).mockReturnValueOnce(parent as unknown as Dir);
    if (failure === 'open') vi.mocked(opendirSync).mockImplementationOnce(fail);
    else vi.mocked(opendirSync).mockReturnValueOnce(child as unknown as Dir);
    if (failure === 'read') child.readSync.mockImplementation(fail);
    if (failure === 'close') child.closeSync.mockImplementation(fail);
    if (failure === 'inspect') {
      child.readSync.mockReturnValueOnce(fileEntry('main.ts'));
      vi.mocked(accessSync).mockImplementation((path) => {
        if (String(path).endsWith('/main.ts')) fail();
      });
    }

    expect(isManagerReadAllowed(request('Grep', { pattern: 'fixture' }))).toBe(false);
    expect(parent.closeSync).toHaveBeenCalledOnce();
    if (failure !== 'open') expect(child.closeSync).toHaveBeenCalledOnce();
  });

  it('does not bypass Codex review even with a valid scope', () => {
    expect(classifyManagerToolPermission(request('Read', { file_path: 'main.ts' }), 'en', 'codex')).toEqual({ decision: 'judge' });
  });
});
