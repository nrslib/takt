import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runNpmTest,
  selectNpmTestRuns,
} from '../../scripts/run-npm-test.mjs';
import { resolveNpmInvocation } from '../../scripts/npm-invocation.mjs';
import parallelIntegrationConfig from '../../vitest.config.it.parallel.js';
import serialGitConfig from '../../vitest.config.it.serial.git.js';
import serialWorkflowConfig from '../../vitest.config.it.serial.workflow.js';
import unitConfig from '../../vitest.config.unit.parallel.js';
import {
  itSerialGitTestGlobs,
  itSerialTestGlobs,
  itSerialWorkflowLoaderTestGlobs,
  itTestGlobs,
  parallelSrcRunnerConfig,
  srcTestInclude,
} from '../../vitest.config.shared.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parallel test runner configuration', () => {
  it('should retain multiple workers for parallel suites', () => {
    expect(parallelSrcRunnerConfig.fileParallelism).toBe(true);
    expect(parallelSrcRunnerConfig.maxWorkers).toMatch(/^\d+%$/);
    expect(parallelSrcRunnerConfig.maxWorkers).not.toBe('1%');
  });

  it('should keep unit, parallel integration, and serial integration gates exclusive', () => {
    expect(unitConfig).toMatchObject({
      test: {
        include: srcTestInclude,
        exclude: [...itTestGlobs, ...itSerialTestGlobs],
      },
    });
    expect(parallelIntegrationConfig).toMatchObject({
      test: {
        include: itTestGlobs,
        exclude: itSerialTestGlobs,
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

describe('npm test sequential execution', () => {
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

  it('should run only the unit gate when no target is provided', async () => {
    const events: string[] = [];
    const run = vi.fn(async (npmArgs: string[]) => {
      const script = npmArgs[1]!;
      events.push(`start:${script}`);
      await Promise.resolve();
      events.push(`finish:${script}`);
      return { code: 0, signal: null };
    });

    const code = await runNpmTest([], run);

    expect(events).toEqual([
      'start:test:unit:parallel',
      'finish:test:unit:parallel',
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
  });

  it('should continue routed gates sequentially and return the first child failure code', async () => {
    const commands: string[][] = [];
    const events: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = vi.fn(async (npmArgs: string[]) => {
      const script = npmArgs[1]!;
      commands.push(npmArgs);
      events.push(`start:${script}`);
      await Promise.resolve();
      events.push(`finish:${script}`);
      return { code: script === 'test:unit:parallel' ? 7 : 0, signal: null };
    });

    const code = await runNpmTest([
      '--reporter',
      'verbose',
      'src/__tests__/acpAgent.test.ts',
      'src/__tests__/it-acp-workflow-bridge.test.ts',
    ], run);

    expect(commands).toEqual([
      [
        'run',
        'test:unit:parallel',
        '--',
        '--reporter',
        'verbose',
        'src/__tests__/acpAgent.test.ts',
      ],
      [
        'run',
        'test:it:parallel',
        '--',
        '--reporter',
        'verbose',
        'src/__tests__/it-acp-workflow-bridge.test.ts',
      ],
    ]);
    expect(events).toEqual([
      'start:test:unit:parallel',
      'finish:test:unit:parallel',
      'start:test:it:parallel',
      'finish:test:it:parallel',
    ]);
    expect(error).toHaveBeenCalledWith(
      '[takt] npm run test:unit:parallel -- --reporter verbose src/__tests__/acpAgent.test.ts failed with exit=7',
    );
    expect(code).toBe(7);
  });
});

describe('npm test entrypoint routing', () => {
  it('should run only the unit suite when no test target is provided', () => {
    expect(selectNpmTestRuns([])).toEqual([
      { npmArgs: ['run', 'test:unit:parallel'] },
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

  it('should route targeted serial Git tests to the Git runner', () => {
    const args = ['src/__tests__/finding-ladder-robustness.test.ts'];

    expect(selectNpmTestRuns(args)).toEqual([
      { npmArgs: ['run', 'test:it:serial:git', '--', ...args] },
    ]);
  });

  it('should route the adjudication runner integration test to the serial Git runner', () => {
    const args = ['src/__tests__/finding-conflict-adjudication-runner.test.ts'];

    expect(selectNpmTestRuns(args)).toEqual([
      { npmArgs: ['run', 'test:it:serial:git', '--', ...args] },
    ]);
  });

  it('should normalize a serial Git basename before routing', () => {
    expect(selectNpmTestRuns(['finding-ladder-robustness.test.ts'])).toEqual([
      {
        npmArgs: [
          'run',
          'test:it:serial:git',
          '--',
          'src/__tests__/finding-ladder-robustness.test.ts',
        ],
      },
    ]);
  });

  it('should normalize an absolute serial workflow path before routing', () => {
    expect(selectNpmTestRuns([resolve('src/__tests__/workflowLoader.test.ts')])).toEqual([
      {
        npmArgs: [
          'run',
          'test:it:serial:workflow',
          '--',
          'src/__tests__/workflowLoader.test.ts',
        ],
      },
    ]);
  });

  it('should route targeted serial workflow tests to the workflow runner', () => {
    const args = ['src/__tests__/workflowLoader.test.ts'];

    expect(selectNpmTestRuns(args)).toEqual([
      { npmArgs: ['run', 'test:it:serial:workflow', '--', ...args] },
    ]);
  });

  it('should route mixed unit, parallel IT, and serial targets exactly once', () => {
    const args = [
      'src/__tests__/acpAgent.test.ts',
      'src/__tests__/it-acp-workflow-bridge.test.ts',
      'src/__tests__/finding-evidence-protocol.integration.test.ts',
      'src/__tests__/config.test.ts',
    ];

    expect(selectNpmTestRuns(args)).toEqual([
      { npmArgs: ['run', 'test:unit:parallel', '--', args[0]] },
      { npmArgs: ['run', 'test:it:parallel', '--', args[1]] },
      { npmArgs: ['run', 'test:it:serial:git', '--', args[2]] },
      { npmArgs: ['run', 'test:it:serial:workflow', '--', args[3]] },
    ]);
  });

  it('should route targeted integration tests to the IT runner', () => {
    const args = ['src/__tests__/it-acp-workflow-bridge.test.ts'];

    expect(selectNpmTestRuns(args)).toEqual([
      { npmArgs: ['run', 'test:it:parallel', '--', ...args] },
    ]);
  });

  it('should keep targeted unit tests on the unit runner', () => {
    const args = ['src/__tests__/workflowExecutionEvents.test.ts'];

    expect(selectNpmTestRuns(args)).toEqual([
      { npmArgs: ['run', 'test:unit:parallel', '--', ...args] },
    ]);
  });

  it('should split mixed unit and integration test targets across both runners', () => {
    const unitTarget = 'src/__tests__/acpAgent.test.ts';
    const integrationTarget = 'src/__tests__/it-acp-workflow-bridge.test.ts';

    expect(selectNpmTestRuns([unitTarget, integrationTarget])).toEqual([
      {
        npmArgs: ['run', 'test:unit:parallel', '--', unitTarget],
      },
      {
        npmArgs: ['run', 'test:it:parallel', '--', integrationTarget],
      },
    ]);
  });

  it('should keep test name filters with targeted integration tests', () => {
    const args = ['-t', 'workflow', 'src/__tests__/it-acp-workflow-bridge.test.ts'];

    expect(selectNpmTestRuns(args)).toEqual([
      {
        npmArgs: ['run', 'test:it:parallel', '--', ...args],
      },
    ]);
  });

  it('should share test name filters when splitting mixed test targets', () => {
    const unitTarget = 'src/__tests__/acpAgent.test.ts';
    const integrationTarget = 'src/__tests__/it-acp-workflow-bridge.test.ts';
    const sharedArgs = ['--testNamePattern', 'workflow'];

    expect(selectNpmTestRuns([...sharedArgs, unitTarget, integrationTarget])).toEqual([
      {
        npmArgs: ['run', 'test:unit:parallel', '--', ...sharedArgs, unitTarget],
      },
      {
        npmArgs: ['run', 'test:it:parallel', '--', ...sharedArgs, integrationTarget],
      },
    ]);
  });

  it('should share reporter options when splitting mixed test targets', () => {
    const unitTarget = 'src/__tests__/acpAgent.test.ts';
    const integrationTarget = 'src/__tests__/it-acp-workflow-bridge.test.ts';
    const sharedArgs = ['--reporter', 'verbose'];

    expect(selectNpmTestRuns([...sharedArgs, unitTarget, integrationTarget])).toEqual([
      {
        npmArgs: ['run', 'test:unit:parallel', '--', ...sharedArgs, unitTarget],
      },
      {
        npmArgs: ['run', 'test:it:parallel', '--', ...sharedArgs, integrationTarget],
      },
    ]);
  });

  it('should share config options when splitting mixed test targets', () => {
    const unitTarget = 'src/__tests__/acpAgent.test.ts';
    const integrationTarget = 'src/__tests__/it-acp-workflow-bridge.test.ts';
    const sharedArgs = ['--config', 'vitest.custom.ts'];

    expect(selectNpmTestRuns([...sharedArgs, unitTarget, integrationTarget])).toEqual([
      {
        npmArgs: ['run', 'test:unit:parallel', '--', ...sharedArgs, unitTarget],
      },
      {
        npmArgs: ['run', 'test:it:parallel', '--', ...sharedArgs, integrationTarget],
      },
    ]);
  });

  it('should share changed options when splitting mixed test targets', () => {
    const unitTarget = 'src/__tests__/npmTestEntrypoint.test.ts';
    const integrationTarget = 'src/__tests__/it-acp-workflow-bridge.test.ts';
    const sharedArgs = ['--changed', 'main'];

    expect(selectNpmTestRuns([...sharedArgs, unitTarget, integrationTarget])).toEqual([
      {
        npmArgs: ['run', 'test:unit:parallel', '--', ...sharedArgs, unitTarget],
      },
      {
        npmArgs: ['run', 'test:it:parallel', '--', ...sharedArgs, integrationTarget],
      },
    ]);
  });

  it('should not consume an integration target as the optional changed value', () => {
    const args = ['--changed', 'src/__tests__/it-acp-workflow-bridge.test.ts'];

    expect(selectNpmTestRuns(args)).toEqual([
      {
        npmArgs: ['run', 'test:it:parallel', '--', '--changed=true', args[1]],
      },
    ]);
  });

  it('should preserve optional vitest options with explicit boolean defaults when splitting mixed targets', () => {
    const unitTarget = 'src/__tests__/npmTestEntrypoint.test.ts';
    const integrationTarget = 'src/__tests__/it-acp-workflow-bridge.test.ts';
    const args = ['--silent', unitTarget, '--api', integrationTarget];

    expect(selectNpmTestRuns(args)).toEqual([
      {
        npmArgs: ['run', 'test:unit:parallel', '--', '--silent=true', '--api=true', unitTarget],
      },
      {
        npmArgs: ['run', 'test:it:parallel', '--', '--silent=true', '--api=true', integrationTarget],
      },
    ]);
  });

  it('should not consume targeted test files as inspector option values', () => {
    const unitTarget = 'src/__tests__/npmTestEntrypoint.test.ts';
    const integrationTarget = 'src/__tests__/it-acp-workflow-bridge.test.ts';
    const args = ['--inspect', unitTarget, '--inspectBrk', integrationTarget];

    expect(selectNpmTestRuns(args)).toEqual([
      {
        npmArgs: ['run', 'test:unit:parallel', '--', '--inspect=true', '--inspectBrk=true', unitTarget],
      },
      {
        npmArgs: ['run', 'test:it:parallel', '--', '--inspect=true', '--inspectBrk=true', integrationTarget],
      },
    ]);
  });
});
