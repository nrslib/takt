/**
 * Tests for git push helpers in infra/task/git.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { execFileSync } from 'node:child_process';
const mockExecFileSync = vi.mocked(execFileSync);

import { materializeCloneHeadToRootBranch, publishTaskBranch, pushBranch, pushHeadToOriginBranch, relayPushCloneToOrigin } from '../infra/task/git.js';

function stderrForRejectedPush(): Buffer {
  return Buffer.from(
    '! [rejected] feature/my-branch -> feature/my-branch (non-fast-forward)\n' +
      'hint: Updates were rejected because the tip of your current branch is behind its remote counterpart.\n',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('non-interactive publication', () => {
  it.each([
    ['branch', () => pushBranch('/project', 'feature/my-branch')],
    ['HEAD', () => pushHeadToOriginBranch('/clone', 'feature/my-branch')],
    ['relay', () => relayPushCloneToOrigin('/clone', '/project', 'feature/my-branch')],
    ['clone remote', () => publishTaskBranch('/clone', '/project', 'feature/my-branch')],
    ['remote-less clone', () => publishTaskBranch('/clone', '/project', 'feature/my-branch')],
  ])('%s push overrides interactive authentication without changing the parent environment', (kind, push) => {
    vi.stubEnv('GIT_TERMINAL_PROMPT', '1');
    vi.stubEnv('GIT_ASKPASS', '/interactive-askpass');
    vi.stubEnv('GCM_INTERACTIVE', '1');
    vi.stubEnv('TAKT_TEST_PUBLISH_ENV', 'preserved');
    mockExecFileSync.mockImplementation((_command, args) => {
      if (args?.[0] === 'remote') return kind === 'remote-less clone' ? '' : 'upstream\n';
      return Buffer.from('');
    });

    push();

    const pushes = mockExecFileSync.mock.calls.filter(([, args]) => args?.[0] === 'push');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.[2]).toEqual(expect.objectContaining({
      stdio: 'pipe',
      env: expect.objectContaining({
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        GCM_INTERACTIVE: '0',
        TAKT_TEST_PUBLISH_ENV: 'preserved',
      }),
    }));
    expect(process.env.GIT_TERMINAL_PROMPT).toBe('1');
    expect(process.env.GIT_ASKPASS).toBe('/interactive-askpass');
    expect(process.env.GCM_INTERACTIVE).toBe('1');
  });
});

describe('pushBranch', () => {
  it('should call git push origin <branch>', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    pushBranch('/project', 'feature/my-branch');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', 'feature/my-branch'],
      expect.objectContaining({ cwd: '/project', stdio: 'pipe' }),
    );
  });

  it('should throw when git push fails', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('error: failed to push some refs');
    });

    expect(() => pushBranch('/project', 'feature/my-branch')).toThrow(
      'error: failed to push some refs',
    );
  });

  it('should surface non-fast-forward rejection with remote-ahead / sync guidance', () => {
    const err = new Error('Command failed: git push origin feature/my-branch');
    Object.assign(err, { stderr: stderrForRejectedPush() });
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });

    let thrown: unknown;
    try {
      pushBranch('/project', 'feature/my-branch');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/non-fast-forward/i);
    expect(message).toContain('stale local branch');
    expect(message).toContain('remote is ahead');
  });

  it('should rethrow push failure without NFF guidance when stderr does not indicate non-fast-forward', () => {
    const err = new Error('fatal: could not read Password for https://example.com');
    Object.assign(err, { stderr: Buffer.from('Authentication failed\n') });
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });

    let thrown: unknown;
    try {
      pushBranch('/project', 'feature/my-branch');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(err);
    expect((thrown as Error).message).not.toContain('stale local branch');
  });
});

describe('pushHeadToOriginBranch', () => {
  it('should call git push origin HEAD:refs/heads/<branch>', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    pushHeadToOriginBranch('/clone', 'feature/my-branch');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', 'HEAD:refs/heads/feature/my-branch'],
      expect.objectContaining({ cwd: '/clone', stdio: 'pipe' }),
    );
  });

  it('should surface non-fast-forward rejection with the same guidance as pushBranch', () => {
    const err = new Error('Command failed: git push origin HEAD:refs/heads/feature/my-branch');
    Object.assign(err, { stderr: stderrForRejectedPush() });
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });

    let thrown: unknown;
    try {
      pushHeadToOriginBranch('/clone', 'feature/my-branch');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/non-fast-forward/i);
    expect(message).toContain('stale local branch');
  });

  it('should rethrow HEAD push failure without NFF guidance when stderr does not indicate non-fast-forward', () => {
    const err = new Error('fatal: repository not found');
    Object.assign(err, { stderr: Buffer.from('') });
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });

    let thrown: unknown;
    try {
      pushHeadToOriginBranch('/clone', 'feature/my-branch');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(err);
    expect((thrown as Error).message).not.toContain('stale local branch');
  });
});

describe('materializeCloneHeadToRootBranch', () => {
  it('should fetch clone HEAD into refs/heads/<branch> in the root repo', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    materializeCloneHeadToRootBranch('/clone', '/project', 'feature/my-branch');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['fetch', '/clone', 'HEAD:refs/heads/feature/my-branch'],
      { cwd: '/project', stdio: 'pipe' },
    );
  });
});
