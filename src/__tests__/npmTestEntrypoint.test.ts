import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeNpmTestRuns,
  resolveLocalUnitShardCount,
  runNpmTest,
  selectNpmTestRuns,
} from '../../scripts/run-npm-test.mjs';
import {
  BIRPC_REMEASURE_ON_CI_ENV,
  isBirpcNoiseOnlyFailure,
} from '../../scripts/vitest-birpc-noise.mjs';
import { resolveNpmInvocation } from '../../scripts/npm-invocation.mjs';
import heavyParallelIntegrationConfig from '../../vitest.config.it.heavy.parallel.js';
import lightIntegrationConfig from '../../vitest.config.it.parallel.js';
import serialGitConfig from '../../vitest.config.it.serial.git.js';
import serialWorkflowConfig from '../../vitest.config.it.serial.workflow.js';
import unitConfig from '../../vitest.config.unit.parallel.js';
import {
  heavyParallelItTestGlobs,
  heavyParallelItTestExcludes,
  itSerialGitTestGlobs,
  itSerialTestGlobs,
  itSerialWorkflowLoaderTestGlobs,
  itTestGlobs,
  lightItTestGlobs,
  parallelSrcRunnerConfig,
  srcTestInclude,
} from '../../vitest.config.shared.js';

const FIXED_UNIT_SHARD_COUNT = 8;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('parallel test runner configuration', () => {
  it('should retain multiple workers for parallel suites', () => {
    expect(parallelSrcRunnerConfig.fileParallelism).toBe(true);
    expect(parallelSrcRunnerConfig.maxWorkers).toMatch(/^\d+%$/);
    expect(parallelSrcRunnerConfig.maxWorkers).not.toBe('1%');
  });

  it('should cap local unit shards while retaining eight on a ten-way machine', () => {
    expect(resolveLocalUnitShardCount(1)).toBe(1);
    expect(resolveLocalUnitShardCount(4)).toBe(2);
    expect(resolveLocalUnitShardCount(10)).toBe(8);
    expect(resolveLocalUnitShardCount(32)).toBe(8);
  });

  it('should keep unit, light integration, heavy integration, and serial gates exclusive', () => {
    expect(unitConfig).toMatchObject({
      test: {
        include: srcTestInclude,
        exclude: [...itTestGlobs, ...itSerialTestGlobs],
      },
    });
    expect(lightIntegrationConfig).toMatchObject({
      test: {
        include: lightItTestGlobs,
      },
    });
    expect(heavyParallelIntegrationConfig).toMatchObject({
      test: {
        maxWorkers: 1,
        include: heavyParallelItTestGlobs,
        exclude: heavyParallelItTestExcludes,
      },
    });
    expect(serialGitConfig).toMatchObject({
      test: { include: itSerialGitTestGlobs },
    });
    expect(serialWorkflowConfig).toMatchObject({
      test: { include: itSerialWorkflowLoaderTestGlobs },
    });
  });
});

describe('npm test execution', () => {
  it('should execute npm-cli through Node without a shell', () => {
    expect(resolveNpmInvocation('/opt/node/bin/node', '/opt/node/lib/node_modules/npm/bin/npm-cli.js')).toEqual({
      executable: '/opt/node/bin/node',
      args: ['/opt/node/lib/node_modules/npm/bin/npm-cli.js'],
    });
  });

  it('should reject command shims and unverified package-manager entrypoints', () => {
    expect(() => resolveNpmInvocation('/opt/node/bin/node', '/opt/node/bin/npm.cmd')).toThrow(/npm-cli\.js/);
    expect(() => resolveNpmInvocation('/opt/node/bin/node', 'npm-cli.js')).toThrow(/absolute path/);
  });

  it('should resolve unit shards when runNpmTest is called without a shard count', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const run = vi.fn(async () => ({ code: 0, signal: null, output: '' }));

    const code = await runNpmTest([], run);

    expect(run).toHaveBeenCalledTimes(selectNpmTestRuns([]).length);
    expect(log).toHaveBeenCalled();
    expect(code).toBe(0);
  });

  it('should run unit shards concurrently when no target is provided', async () => {
    const events: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const run = vi.fn(async (npmArgs: readonly string[]) => {
      const shard = npmArgs[3]!;
      events.push(`start:${shard}`);
      await Promise.resolve();
      events.push(`finish:${shard}`);
      return { code: 0, signal: null, output: '' };
    });

    const code = await runNpmTest([], run, FIXED_UNIT_SHARD_COUNT);

    expect(events.slice(0, 8)).toEqual([
      'start:--shard=1/8',
      'start:--shard=2/8',
      'start:--shard=3/8',
      'start:--shard=4/8',
      'start:--shard=5/8',
      'start:--shard=6/8',
      'start:--shard=7/8',
      'start:--shard=8/8',
    ]);
    expect(events.slice(8)).toEqual([
      'finish:--shard=1/8',
      'finish:--shard=2/8',
      'finish:--shard=3/8',
      'finish:--shard=4/8',
      'finish:--shard=5/8',
      'finish:--shard=6/8',
      'finish:--shard=7/8',
      'finish:--shard=8/8',
    ]);
    expect(run).toHaveBeenCalledTimes(8);
    expect(log).toHaveBeenCalledWith(
      '[takt] Fast unit gate only. After implementation run "npm run test:it" for light integration coverage. If you add or change an integration test, run the classification contract by itself with "npm test -- src/__tests__/releaseVerificationWiring.test.ts". The main pull-request CI workflow and "npm run check:release" run heavy integration coverage too. If you add or change a heavy integration test, run that file directly with "npm test -- <test-file>" before handoff.',
    );
    expect(code).toBe(0);
  });

  it('should continue all unit shards and return the first failure code', async () => {
    const executedShards: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = vi.fn(async (npmArgs: readonly string[]) => {
      const shard = npmArgs[3]!;
      executedShards.push(shard);
      const codeByShard = new Map([
        ['--shard=1/8', 7],
        ['--shard=3/8', 9],
      ]);
      return { code: codeByShard.get(shard) ?? 0, signal: null, output: '' };
    });

    const code = await runNpmTest([], run, FIXED_UNIT_SHARD_COUNT);

    expect(executedShards).toEqual([
      '--shard=1/8',
      '--shard=2/8',
      '--shard=3/8',
      '--shard=4/8',
      '--shard=5/8',
      '--shard=6/8',
      '--shard=7/8',
      '--shard=8/8',
    ]);
    expect(error.mock.calls).toEqual([
      ['[takt] npm run test:unit:parallel -- --shard=1/8 --maxWorkers=1 failed with exit=7'],
      ['[takt] npm run test:unit:parallel -- --shard=3/8 --maxWorkers=1 failed with exit=9'],
    ]);
    expect(code).toBe(7);
  });

  it('should continue into serial runs after parallel failure and return the first failure code', async () => {
    const commands: (readonly string[])[] = [];
    const events: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = vi.fn(async (npmArgs: readonly string[]) => {
      const script = npmArgs[1]!;
      commands.push(npmArgs);
      events.push(`start:${script}`);
      await Promise.resolve();
      events.push(`finish:${script}`);
      const code = script === 'test:unit:parallel'
        ? 7
        : script === 'test:it:heavy:serial:git' ? 9 : 0;
      return { code, signal: null, output: '' };
    });

    const code = await runNpmTest([
      '--reporter',
      'verbose',
      'src/__tests__/git-detect.test.ts',
      'src/__tests__/it-teed-command.test.ts',
      'src/__tests__/companion-diff-runtime.integration.test.ts',
    ], run);

    expect(commands).toEqual([
      [
        'run',
        'test:unit:parallel',
        '--',
        '--reporter',
        'verbose',
        'src/__tests__/git-detect.test.ts',
      ],
      [
        'run',
        'test:it:heavy:parallel',
        '--',
        '--reporter',
        'verbose',
        'src/__tests__/it-teed-command.test.ts',
      ],
      [
        'run',
        'test:it:heavy:serial:git',
        '--',
        '--reporter',
        'verbose',
        'src/__tests__/companion-diff-runtime.integration.test.ts',
      ],
    ]);
    expect(events).toEqual([
      'start:test:unit:parallel',
      'start:test:it:heavy:parallel',
      'finish:test:unit:parallel',
      'finish:test:it:heavy:parallel',
      'start:test:it:heavy:serial:git',
      'finish:test:it:heavy:serial:git',
    ]);
    expect(error.mock.calls).toEqual([
      [
        '[takt] npm run test:unit:parallel -- --reporter verbose src/__tests__/git-detect.test.ts failed with exit=7',
      ],
      [
        '[takt] npm run test:it:heavy:serial:git -- --reporter verbose src/__tests__/companion-diff-runtime.integration.test.ts failed with exit=9',
      ],
    ]);
    expect(code).toBe(7);
  });

  it('should finish parallel runs before executing serial Git and workflow runs in order', async () => {
    const scripts = [
      'test:unit:parallel',
      'test:it:light',
      'test:it:heavy:parallel',
      'test:it:heavy:serial:git',
      'test:it:heavy:serial:workflow',
    ];
    const runs = scripts.map((script) => ({ npmArgs: ['run', script] }));
    const releases = new Map<string, () => void>();
    const events: string[] = [];
    const run = vi.fn(async (npmArgs: readonly string[]) => {
      const script = npmArgs[1]!;
      events.push(`start:${script}`);
      await new Promise<void>((resolvePromise) => releases.set(script, resolvePromise));
      events.push(`finish:${script}`);
      return {
        code: script === 'test:unit:parallel' ? 7 : script === 'test:it:heavy:serial:workflow' ? 9 : 0,
        signal: null,
        output: '',
      };
    });

    const execution = executeNpmTestRuns(runs, run);
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(events).toEqual([
      'start:test:unit:parallel',
      'start:test:it:light',
      'start:test:it:heavy:parallel',
    ]);
    releases.get('test:unit:parallel')?.();
    await vi.waitFor(() => expect(events).toContain('finish:test:unit:parallel'));
    expect(events).not.toContain('start:test:it:heavy:serial:git');
    releases.get('test:it:light')?.();
    await vi.waitFor(() => expect(events).toContain('finish:test:it:light'));
    expect(events).not.toContain('start:test:it:heavy:serial:git');
    releases.get('test:it:heavy:parallel')?.();
    await vi.waitFor(() => expect(events).toContain('start:test:it:heavy:serial:git'));
    releases.get('test:it:heavy:serial:git')?.();
    await vi.waitFor(() => expect(events).toContain('start:test:it:heavy:serial:workflow'));
    releases.get('test:it:heavy:serial:workflow')?.();

    const results = await execution;

    expect(events).toEqual([
      'start:test:unit:parallel',
      'start:test:it:light',
      'start:test:it:heavy:parallel',
      'finish:test:unit:parallel',
      'finish:test:it:light',
      'finish:test:it:heavy:parallel',
      'start:test:it:heavy:serial:git',
      'finish:test:it:heavy:serial:git',
      'start:test:it:heavy:serial:workflow',
      'finish:test:it:heavy:serial:workflow',
    ]);
    expect(run).toHaveBeenCalledTimes(5);
    expect(results.map(({ result }) => result.code)).toEqual([7, 0, 0, 0, 9]);
  });

  it('should return indexed runs with the nested run and result shape', async () => {
    const runs = [
      { npmArgs: ['run', 'test:unit:parallel'] },
      { npmArgs: ['run', 'test:it:heavy:serial:git'] },
    ];
    const run = vi.fn(async (_npmArgs: readonly string[]) => ({
      code: 0,
      signal: null,
      output: '',
    }));

    const results = await executeNpmTestRuns(runs, run);

    expect(results).toEqual([
      { run: runs[0], index: 0, result: { code: 0, signal: null, output: '' } },
      { run: runs[1], index: 1, result: { code: 0, signal: null, output: '' } },
    ]);
    expect(results[0]?.run.npmArgs).toEqual(runs[0]?.npmArgs);
    expect(results[0]?.index).toBe(0);
  });

  it('should reject an unknown runner classification before executing commands', async () => {
    const run = vi.fn();

    await expect(executeNpmTestRuns([
      { npmArgs: ['run', 'test:unknown'] },
    ], run)).rejects.toThrow('Unknown npm test runner classification: test:unknown');

    expect(run).not.toHaveBeenCalled();
  });
});

const birpcNoiseOutput = [
  ' ✓ src/__tests__/option-resolution-order.test.ts (42 tests) 1200ms',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
  '',
  'Vitest caught 1 unhandled error during the test run.',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
  'Error: [vitest-worker]: Timeout calling "onTaskUpdate"',
  ' ❯ Timeout.<anonymous> node_modules/vitest/dist/chunks/rpc.js:49:10',
  '',
  ' Test Files  120 passed (120)',
  '      Tests  3330 passed (3330)',
  '     Errors  1 error',
  '   Start at  12:00:00',
  '   Duration  62.00s',
].join('\n');

describe('birpc noise classification', () => {
  it('should treat an all-passed shard whose only error is the birpc timeout as noise', () => {
    expect(isBirpcNoiseOnlyFailure({
      output: birpcNoiseOutput,
      isCI: false,
      remeasureOnCI: false,
    })).toBe(true);
  });

  it('should treat a shard with a failed test as a real failure even alongside birpc noise', () => {
    const output = birpcNoiseOutput
      .replace('      Tests  3330 passed (3330)', '      Tests  1 failed | 3329 passed (3330)')
      .replace(
        ' ❯ Timeout.<anonymous> node_modules/vitest/dist/chunks/rpc.js:49:10',
        'AssertionError: expected 1 to be 2',
      );

    expect(isBirpcNoiseOnlyFailure({ output, isCI: false, remeasureOnCI: false })).toBe(false);
  });

  it('should treat an all-passed shard carrying any other error as a real failure', () => {
    const output = birpcNoiseOutput.replace(
      'Error: [vitest-worker]: Timeout calling "onTaskUpdate"',
      'Error: connect ECONNREFUSED 127.0.0.1:5432',
    );

    expect(isBirpcNoiseOnlyFailure({ output, isCI: false, remeasureOnCI: false })).toBe(false);
  });

  it('should treat an error whose name does not end in Error as a real failure', () => {
    const output = birpcNoiseOutput.replace(
      ' ❯ Timeout.<anonymous> node_modules/vitest/dist/chunks/rpc.js:49:10',
      'DatabaseFailure: connection lost',
    );

    expect(isBirpcNoiseOnlyFailure({ output, isCI: false, remeasureOnCI: false })).toBe(false);
  });

  it('should treat a timeout carrying call arguments as a real failure', () => {
    const output = birpcNoiseOutput.replace(
      'Error: [vitest-worker]: Timeout calling "onTaskUpdate"',
      'Error: [vitest-worker]: Timeout calling "onTaskUpdate" with "[{}]"',
    );

    expect(isBirpcNoiseOnlyFailure({ output, isCI: false, remeasureOnCI: false })).toBe(false);
  });

  it('should treat a shard that passed no test as a real failure', () => {
    const output = birpcNoiseOutput
      .replace(' Test Files  120 passed (120)', ' Test Files  0 passed (0)')
      .replace('      Tests  3330 passed (3330)', '      Tests  0 passed (0)');

    expect(isBirpcNoiseOnlyFailure({ output, isCI: false, remeasureOnCI: false })).toBe(false);
  });

  it('should treat an all-passed shard with no reported error as a real failure', () => {
    const output = [
      ' Test Files  120 passed (120)',
      '      Tests  3330 passed (3330)',
      '   Duration  62.00s',
    ].join('\n');

    expect(isBirpcNoiseOnlyFailure({ output, isCI: false, remeasureOnCI: false })).toBe(false);
  });

  it('should never rescue on CI where the shard has the machine to itself', () => {
    expect(isBirpcNoiseOnlyFailure({
      output: birpcNoiseOutput,
      isCI: true,
      remeasureOnCI: false,
    })).toBe(false);
  });

  it('should classify birpc-only noise on CI when re-measurement is opted in', () => {
    expect(isBirpcNoiseOnlyFailure({
      output: birpcNoiseOutput,
      isCI: true,
      remeasureOnCI: true,
    })).toBe(true);
  });
});

describe('birpc noise re-measurement', () => {
  it('should re-measure a noisy shard once and adopt the re-measured result', async () => {
    vi.stubEnv('CI', '');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const attempts = [
      { code: 1, signal: null, output: birpcNoiseOutput },
      { code: 0, signal: null, output: '' },
    ];
    let attempt = 0;
    const run = vi.fn(async () => attempts[attempt++]!);

    const code = await runNpmTest(['src/__tests__/option-resolution-order.test.ts'], run);

    expect(run).toHaveBeenCalledTimes(2);
    expect(code).toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('re-measuring this shard once'));
  });

  it('should keep the failure when the re-measured shard is noisy again', async () => {
    vi.stubEnv('CI', '');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = vi.fn(async () => ({ code: 1, signal: null, output: birpcNoiseOutput }));

    const code = await runNpmTest(['src/__tests__/option-resolution-order.test.ts'], run);

    expect(run).toHaveBeenCalledTimes(2);
    expect(code).toBe(1);
  });

  it('should keep an ordinary failing shard untouched', async () => {
    vi.stubEnv('CI', '');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const output = birpcNoiseOutput
      .replace('      Tests  3330 passed (3330)', '      Tests  2 failed | 3328 passed (3330)');
    const run = vi.fn(async () => ({ code: 1, signal: null, output }));

    const code = await runNpmTest(['src/__tests__/option-resolution-order.test.ts'], run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(code).toBe(1);
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('re-measuring'));
  });

  it('should start re-measuring only after every shard finished its first run', async () => {
    vi.stubEnv('CI', '');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const events: string[] = [];
    let started = 0;
    const run = vi.fn(async () => {
      const attempt = started;
      started += 1;
      events.push(`start:${attempt}`);
      await Promise.resolve();
      await Promise.resolve();
      events.push(`finish:${attempt}`);
      return attempt === 1
        ? { code: 1, signal: null, output: birpcNoiseOutput }
        : { code: 0, signal: null, output: '' };
    });

    const code = await runNpmTest([], run, FIXED_UNIT_SHARD_COUNT);

    expect(run).toHaveBeenCalledTimes(9);
    expect(events.slice(0, 16)).toEqual([
      'start:0',
      'start:1',
      'start:2',
      'start:3',
      'start:4',
      'start:5',
      'start:6',
      'start:7',
      'finish:0',
      'finish:1',
      'finish:2',
      'finish:3',
      'finish:4',
      'finish:5',
      'finish:6',
      'finish:7',
    ]);
    expect(events.slice(16)).toEqual(['start:8', 'finish:8']);
    expect(code).toBe(0);
  });

  it('should not re-measure on CI without the opt-in flag', async () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv(BIRPC_REMEASURE_ON_CI_ENV, '');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = vi.fn(async () => ({ code: 1, signal: null, output: birpcNoiseOutput }));

    const code = await runNpmTest(['src/__tests__/option-resolution-order.test.ts'], run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(code).toBe(1);
  });

  it('should re-measure on CI when the opt-in flag is set', async () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv(BIRPC_REMEASURE_ON_CI_ENV, '1');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const attempts = [
      { code: 1, signal: null, output: birpcNoiseOutput },
      { code: 0, signal: null, output: '' },
    ];
    let attempt = 0;
    const run = vi.fn(async () => attempts[attempt++]!);

    const code = await runNpmTest(['src/__tests__/option-resolution-order.test.ts'], run);

    expect(run).toHaveBeenCalledTimes(2);
    expect(code).toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('re-measuring this shard once'));
  });
});

describe('npm test entrypoint routing', () => {
  it('should resolve local unit shards when no shard count is supplied', () => {
    const runs = selectNpmTestRuns([]);

    expect(runs.length).toBeGreaterThan(0);
    expect(runs.map(({ npmArgs }) => npmArgs[3])).toEqual(
      runs.map((_, index) => `--shard=${index + 1}/${runs.length}`),
    );
  });

  it('should run the unit suite as single-worker shards when no test target is provided', () => {
    expect(selectNpmTestRuns([], FIXED_UNIT_SHARD_COUNT)).toEqual([
      { npmArgs: ['run', 'test:unit:parallel', '--', '--shard=1/8', '--maxWorkers=1'] },
      { npmArgs: ['run', 'test:unit:parallel', '--', '--shard=2/8', '--maxWorkers=1'] },
      { npmArgs: ['run', 'test:unit:parallel', '--', '--shard=3/8', '--maxWorkers=1'] },
      { npmArgs: ['run', 'test:unit:parallel', '--', '--shard=4/8', '--maxWorkers=1'] },
      { npmArgs: ['run', 'test:unit:parallel', '--', '--shard=5/8', '--maxWorkers=1'] },
      { npmArgs: ['run', 'test:unit:parallel', '--', '--shard=6/8', '--maxWorkers=1'] },
      { npmArgs: ['run', 'test:unit:parallel', '--', '--shard=7/8', '--maxWorkers=1'] },
      { npmArgs: ['run', 'test:unit:parallel', '--', '--shard=8/8', '--maxWorkers=1'] },
    ]);
  });

  it('should pass required-value options to the default unit suite when no target is provided', () => {
    expect(selectNpmTestRuns(['--reporter', 'verbose'])).toEqual([
      { npmArgs: ['run', 'test:unit:parallel', '--', '--reporter', 'verbose'] },
    ]);
  });

  it('should pass boolean options to the default unit suite when no target is provided', () => {
    expect(selectNpmTestRuns(['--silent'])).toEqual([
      { npmArgs: ['run', 'test:unit:parallel', '--', '--silent'] },
    ]);
  });

  it('should normalize an absolute unit path before routing', () => {
    expect(selectNpmTestRuns([resolve('src/__tests__/git-detect.test.ts')])).toEqual([
      {
        npmArgs: [
          'run',
          'test:unit:parallel',
          '--',
          'src/__tests__/git-detect.test.ts',
        ],
      },
    ]);
  });

  it('should route a resource-heavy integration file to the serial workflow runner', () => {
    expect(selectNpmTestRuns(['workflowExecution-claude-terminal.test.ts'])).toEqual([
      {
        npmArgs: [
          'run',
          'test:it:heavy:serial:workflow',
          '--',
          'src/__tests__/workflowExecution-claude-terminal.test.ts',
        ],
      },
    ]);
  });

  it('should keep ordinary unit members on the unit runner', () => {
    const args = ['src/__tests__/git-detect.test.ts'];

    expect(selectNpmTestRuns(args)).toEqual([
      { npmArgs: ['run', 'test:unit:parallel', '--', ...args] },
    ]);
  });

  it('should route an explicitly classified legacy filename to the IT runner', () => {
    const args = ['engine-happy-path.test.ts'];

    expect(selectNpmTestRuns(args)).toEqual([
      {
        npmArgs: [
          'run',
          'test:it:heavy:parallel',
          '--',
          'src/__tests__/engine-happy-path.test.ts',
        ],
      },
    ]);
  });

  it('should route a bounded legacy integration suffix to the light IT runner', () => {
    const args = ['src/__tests__/facet-includes-integration.test.ts'];

    expect(selectNpmTestRuns(args)).toEqual([
      { npmArgs: ['run', 'test:it:light', '--', ...args] },
    ]);
  });

  it('should let an explicit light classification override the it filename', () => {
    const args = ['src/__tests__/it-acp-workflow-bridge.test.ts'];

    expect(selectNpmTestRuns(args)).toEqual([
      { npmArgs: ['run', 'test:it:light', '--', ...args] },
    ]);
  });

  it('should route a serial workflow member to the workflow runner', () => {
    const fileName = 'workflow-step-fragment-runtime.test.ts';
    for (const target of [fileName, `src/__tests__/${fileName}`]) {
      expect(selectNpmTestRuns([target])).toEqual([
        {
          npmArgs: [
            'run',
            'test:it:heavy:serial:workflow',
            '--',
            `src/__tests__/${fileName}`,
          ],
        },
      ]);
    }
  });

  it('should route targeted integration tests to the IT runner', () => {
    const args = ['src/__tests__/it-acp-workflow-bridge.test.ts'];

    expect(selectNpmTestRuns(args)).toEqual([
      { npmArgs: ['run', 'test:it:light', '--', ...args] },
    ]);
  });

  it('should route a light integration target to the light runner', () => {
    const args = ['src/__tests__/workflowExecutionEvents.test.ts'];

    expect(selectNpmTestRuns(args)).toEqual([
      { npmArgs: ['run', 'test:it:light', '--', ...args] },
    ]);
  });

  it('should keep targeted unit tests on the unit runner', () => {
    const args = ['src/__tests__/option-resolution-order.test.ts'];

    expect(selectNpmTestRuns(args)).toEqual([
      { npmArgs: ['run', 'test:unit:parallel', '--', ...args] },
    ]);
  });

  it('should split mixed unit and integration test targets across both runners', () => {
    const unitTarget = 'src/__tests__/git-detect.test.ts';
    const integrationTarget = 'src/__tests__/it-teed-command.test.ts';

    expect(selectNpmTestRuns([unitTarget, integrationTarget])).toEqual([
      {
        npmArgs: ['run', 'test:unit:parallel', '--', unitTarget],
      },
      {
        npmArgs: ['run', 'test:it:heavy:parallel', '--', integrationTarget],
      },
    ]);
  });

  it('should keep test name filters with targeted integration tests', () => {
    const args = ['-t', 'workflow', 'src/__tests__/it-teed-command.test.ts'];

    expect(selectNpmTestRuns(args)).toEqual([
      {
        npmArgs: ['run', 'test:it:heavy:parallel', '--', ...args],
      },
    ]);
  });

  it('should share test name filters when splitting mixed test targets', () => {
    const unitTarget = 'src/__tests__/git-detect.test.ts';
    const integrationTarget = 'src/__tests__/it-teed-command.test.ts';
    const sharedArgs = ['--testNamePattern', 'workflow'];

    expect(selectNpmTestRuns([...sharedArgs, unitTarget, integrationTarget])).toEqual([
      {
        npmArgs: ['run', 'test:unit:parallel', '--', ...sharedArgs, unitTarget],
      },
      {
        npmArgs: ['run', 'test:it:heavy:parallel', '--', ...sharedArgs, integrationTarget],
      },
    ]);
  });

  it('should share reporter options when splitting mixed test targets', () => {
    const unitTarget = 'src/__tests__/git-detect.test.ts';
    const integrationTarget = 'src/__tests__/it-teed-command.test.ts';
    const sharedArgs = ['--reporter', 'verbose'];

    expect(selectNpmTestRuns([...sharedArgs, unitTarget, integrationTarget])).toEqual([
      {
        npmArgs: ['run', 'test:unit:parallel', '--', ...sharedArgs, unitTarget],
      },
      {
        npmArgs: ['run', 'test:it:heavy:parallel', '--', ...sharedArgs, integrationTarget],
      },
    ]);
  });

  it('should share config options when splitting mixed test targets', () => {
    const unitTarget = 'src/__tests__/git-detect.test.ts';
    const integrationTarget = 'src/__tests__/it-teed-command.test.ts';
    const sharedArgs = ['--config', 'vitest.custom.ts'];

    expect(selectNpmTestRuns([...sharedArgs, unitTarget, integrationTarget])).toEqual([
      {
        npmArgs: ['run', 'test:unit:parallel', '--', ...sharedArgs, unitTarget],
      },
      {
        npmArgs: ['run', 'test:it:heavy:parallel', '--', ...sharedArgs, integrationTarget],
      },
    ]);
  });

  it('should share changed options when splitting mixed test targets', () => {
    const unitTarget = 'src/__tests__/npmTestEntrypoint.test.ts';
    const integrationTarget = 'src/__tests__/it-teed-command.test.ts';
    const sharedArgs = ['--changed', 'main'];

    expect(selectNpmTestRuns([...sharedArgs, unitTarget, integrationTarget])).toEqual([
      {
        npmArgs: ['run', 'test:unit:parallel', '--', ...sharedArgs, unitTarget],
      },
      {
        npmArgs: ['run', 'test:it:heavy:parallel', '--', ...sharedArgs, integrationTarget],
      },
    ]);
  });

  it('should not consume an integration target as the optional changed value', () => {
    const args = ['--changed', 'src/__tests__/it-teed-command.test.ts'];

    expect(selectNpmTestRuns(args)).toEqual([
      {
        npmArgs: ['run', 'test:it:heavy:parallel', '--', '--changed=true', args[1]],
      },
    ]);
  });

  it('should preserve optional vitest options with explicit boolean defaults when splitting mixed targets', () => {
    const unitTarget = 'src/__tests__/npmTestEntrypoint.test.ts';
    const integrationTarget = 'src/__tests__/it-teed-command.test.ts';
    const args = ['--silent', unitTarget, '--api', integrationTarget];

    expect(selectNpmTestRuns(args)).toEqual([
      {
        npmArgs: ['run', 'test:unit:parallel', '--', '--silent=true', '--api=true', unitTarget],
      },
      {
        npmArgs: ['run', 'test:it:heavy:parallel', '--', '--silent=true', '--api=true', integrationTarget],
      },
    ]);
  });

  it('should not consume targeted test files as inspector option values', () => {
    const unitTarget = 'src/__tests__/npmTestEntrypoint.test.ts';
    const integrationTarget = 'src/__tests__/it-teed-command.test.ts';
    const args = ['--inspect', unitTarget, '--inspectBrk', integrationTarget];

    expect(selectNpmTestRuns(args)).toEqual([
      {
        npmArgs: ['run', 'test:unit:parallel', '--', '--inspect=true', '--inspectBrk=true', unitTarget],
      },
      {
        npmArgs: ['run', 'test:it:heavy:parallel', '--', '--inspect=true', '--inspectBrk=true', integrationTarget],
      },
    ]);
  });
});
