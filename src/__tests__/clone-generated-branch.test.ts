import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { getCloneMetaPath } from '../infra/task/clone-meta.js';
import { runGitCommandAbortable } from '../infra/task/clone-exec.js';
import { resolveGeneratedBranch, resolveGeneratedBranchAbortable } from '../infra/task/clone-generated-branch.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('../infra/task/clone-exec.js', () => ({ runGitCommandAbortable: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  lstatSync: vi.fn(),
}));

const base = 'takt/1465/fix-login';
let response: (args: string[]) => string;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(lstatSync).mockImplementation(() => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  response = () => '';
  vi.mocked(execFileSync).mockImplementation((_command, args) => response(args as string[]));
  vi.mocked(runGitCommandAbortable).mockImplementation(async (_cwd, args) => ({
    stdout: response(args), stderr: '',
  }));
});

describe.each(['sync', 'async'] as const)('generated branch resolution (%s)', (mode) => {
  const resolve = (): string | Promise<string> => mode === 'sync'
    ? resolveGeneratedBranch('/project', base)
    : resolveGeneratedBranchAbortable('/project', base);

  it('checks local, remote tracking and un-fetched remote collisions for every candidate', async () => {
    response = (args) => {
      if (args[0] === 'remote') return 'origin\n';
      if (args[0] === 'for-each-ref' && args[2] === `refs/heads/${base}`) return `refs/heads/${base}\n`;
      if (args[0] === 'for-each-ref' && args[2] === `refs/heads/${base}-2`) return `refs/remotes/origin/${base}-2\n`;
      if (args[0] === 'ls-remote' && args[3] === `refs/heads/${base}-3`) return `abc\trefs/heads/${base}-3\n`;
      return '';
    };
    expect(await resolve()).toBe(`${base}-4`);
  });

  it('keeps an unused name when no remotes are configured', async () => {
    expect(await resolve()).toBe(base);
    const calls = mode === 'sync' ? vi.mocked(execFileSync).mock.calls : vi.mocked(runGitCommandAbortable).mock.calls;
    expect(calls.map((call) => call[1])).not.toContainEqual(expect.arrayContaining(['ls-remote']));
  });

  it('keeps checking cached origin refs even without configured remotes', async () => {
    response = (args) => args[0] === 'for-each-ref' && args[2] === `refs/heads/${base}`
      ? `refs/remotes/origin/${base}\n` : '';
    expect(await resolve()).toBe(`${base}-2`);
  });

  it.each(['upstream\r\n', 'origin\nupstream\n'])('checks every configured remote in %j', async (remotes) => {
    response = (args) => args[0] === 'remote' ? remotes : '';
    expect(await resolve()).toBe(base);
    const calls = mode === 'sync' ? vi.mocked(execFileSync).mock.calls : vi.mocked(runGitCommandAbortable).mock.calls;
    for (const remote of remotes.trim().split(/\r?\n/)) {
      expect(calls.map((call) => call[1])).toContainEqual(['ls-remote', '--heads', remote, `refs/heads/${base}`]);
    }
  });

  it('skips an upstream tracking ref without origin or a remote branch', async () => {
    response = (args) => {
      if (args[0] === 'remote') return 'upstream\n';
      if (args[0] === 'for-each-ref' && args.includes(`refs/remotes/upstream/${base}`)) {
        return `refs/remotes/upstream/${base}\n`;
      }
      return '';
    };
    expect(await resolve()).toBe(`${base}-2`);
  });

  it('checks later remotes for numbered candidates after a local collision', async () => {
    response = (args) => {
      if (args[0] === 'remote') return 'origin\nupstream\n';
      if (args[0] === 'for-each-ref' && args[2] === `refs/heads/${base}`) return `refs/heads/${base}\n`;
      if (args[0] === 'ls-remote' && args[2] === 'upstream' && args[3] === `refs/heads/${base}-2`) {
        return `abc\trefs/heads/${base}-2\n`;
      }
      return '';
    };
    expect(await resolve()).toBe(`${base}-3`);
  });

  it('requires exact ref matches rather than child or similarly named branches', async () => {
    response = (args) => {
      if (args[0] === 'remote') return 'origin\nupstream\n';
      if (args[0] === 'for-each-ref') return `refs/remotes/upstream/${base}/child\nrefs/heads/${base}-other\n`;
      if (args[0] === 'ls-remote') return `abc\trefs/heads/${base}/child\nabc\trefs/heads/${base}-other\n`;
      return '';
    };
    expect(await resolve()).toBe(base);
  });

  it.each([undefined, '/central/clone-meta'])('skips occupied metadata keys in directory %s without reading their JSON', async (directory) => {
    vi.mocked(lstatSync).mockImplementation((target) => {
      if ([base, `${base}-2`].some((branch) => String(target) === getCloneMetaPath('/project', branch, directory))) {
        return {} as ReturnType<typeof lstatSync>;
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    const branch = mode === 'sync'
      ? resolveGeneratedBranch('/project', base, directory)
      : await resolveGeneratedBranchAbortable('/project', base, undefined, directory);
    expect(branch).toBe(`${base}-3`);
  });

  it('propagates metadata inspection failures', async () => {
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.mocked(lstatSync).mockImplementation(() => { throw failure; });
    await expect(Promise.resolve().then(resolve)).rejects.toBe(failure);
  });

  it('propagates a later remote query failure', async () => {
    response = (args) => {
      if (args[0] === 'remote') return 'origin\nupstream\n';
      if (args[0] === 'ls-remote' && args[2] === 'upstream') throw new Error('query failed');
      return '';
    };
    await expect(Promise.resolve().then(resolve)).rejects.toThrow();
  });

  it('propagates local ref query failures', async () => {
    response = (args) => {
      if (args[0] === 'for-each-ref') throw new Error('query failed');
      return '';
    };
    await expect(Promise.resolve().then(resolve)).rejects.toThrow();
  });
});

it('passes the abort signal to each query and propagates cancellation', async () => {
  const controller = new AbortController();
  vi.mocked(runGitCommandAbortable).mockImplementation(async (_cwd, args, signal) => {
    expect(signal).toBe(controller.signal);
    if (args[0] === 'remote') return { stdout: 'origin\nupstream\n', stderr: '' };
    if (args[0] === 'ls-remote' && args[2] === 'upstream') {
      controller.abort();
      throw new Error('Task execution aborted');
    }
    return { stdout: '', stderr: '' };
  });
  await expect(resolveGeneratedBranchAbortable('/project', base, controller.signal)).rejects.toThrow();
});
