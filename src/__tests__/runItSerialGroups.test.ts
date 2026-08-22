import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSerialIntegrationGroups } from '../../scripts/run-it-serial-groups.mjs';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('serial integration group runner', () => {
  it('should forward arguments and finish each group before starting the next group', async () => {
    const commands: string[][] = [];
    const events: string[] = [];
    const run = vi.fn(async (npmArgs: string[]) => {
      const script = npmArgs[1]!;
      commands.push(npmArgs);
      events.push(`start:${script}`);
      await Promise.resolve();
      events.push(`finish:${script}`);
      return { code: 0, signal: null };
    });

    const code = await runSerialIntegrationGroups(['--reporter', 'verbose'], run);

    expect(commands).toEqual([
      ['run', 'test:it:heavy:serial:git', '--', '--reporter', 'verbose'],
      ['run', 'test:it:heavy:serial:workflow', '--', '--reporter', 'verbose'],
    ]);
    expect(events).toEqual([
      'start:test:it:heavy:serial:git',
      'finish:test:it:heavy:serial:git',
      'start:test:it:heavy:serial:workflow',
      'finish:test:it:heavy:serial:workflow',
    ]);
    expect(code).toBe(0);
  });

  it('should finish every group and return the first child failure code', async () => {
    const commands: string[][] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = vi.fn(async (npmArgs: string[]) => {
      commands.push(npmArgs);
      return {
        code: npmArgs[1] === 'test:it:heavy:serial:git' ? 9 : 0,
        signal: null,
      };
    });

    const code = await runSerialIntegrationGroups([], run);

    expect(commands).toEqual([
      ['run', 'test:it:heavy:serial:git'],
      ['run', 'test:it:heavy:serial:workflow'],
    ]);
    expect(error).toHaveBeenCalledWith(
      '[takt] npm run test:it:heavy:serial:git failed with exit=9',
    );
    expect(code).toBe(9);
  });
});
