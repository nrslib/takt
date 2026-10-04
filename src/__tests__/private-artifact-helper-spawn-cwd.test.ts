import {
  afterEach, describe, expect, it, vi,
} from 'vitest';

const recordedSpawnCalls = vi.hoisted(() => ({
  cwds: [] as string[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync(
      ...args: Parameters<typeof actual.spawnSync>
    ): ReturnType<typeof actual.spawnSync> {
      const options = args[2] as { cwd?: string } | undefined;
      recordedSpawnCalls.cwds.push(String(options?.cwd));
      return {
        pid: 0,
        output: [null, '', ''],
        stdout: '',
        stderr: '',
        status: 0,
        signal: null,
        error: undefined,
      } as unknown as ReturnType<typeof actual.spawnSync>;
    },
  };
});

const { runPrivateArtifactHelper } = await import('../shared/utils/private-artifact-helper.js');

describe('runPrivateArtifactHelper spawn cwd', () => {
  afterEach(() => {
    recordedSpawnCalls.cwds.length = 0;
  });

  it.skipIf(process.platform === 'win32')('should pass the cwd unchanged to spawnSync on a POSIX host', () => {
    const cwd = `/Users/example/${'a'.repeat(280)}`;

    runPrivateArtifactHelper('1', 'request', cwd, 'boom');

    expect(recordedSpawnCalls.cwds).toEqual([cwd]);
  });
});
