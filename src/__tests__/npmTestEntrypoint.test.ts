import { describe, expect, it } from 'vitest';
import {
  hasIntegrationTestTarget,
  runNpmTest,
  selectNpmTestRuns,
} from '../../scripts/run-npm-test.mjs';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise!(),
  };
}

describe('npm test entrypoint routing', () => {
  it('should run the unit suite as shards when no test target is provided', () => {
    expect(selectNpmTestRuns([])).toEqual([
      { npmArgs: ['run', 'test:unit:parallel', '--', '--shard=1/4', '--maxWorkers=1'] },
      { npmArgs: ['run', 'test:unit:parallel', '--', '--shard=2/4', '--maxWorkers=1'] },
      { npmArgs: ['run', 'test:unit:parallel', '--', '--shard=3/4', '--maxWorkers=1'] },
      { npmArgs: ['run', 'test:unit:parallel', '--', '--shard=4/4', '--maxWorkers=1'] },
    ]);
  });

  it('should wait for each unit shard before starting the next shard', async () => {
    const runs = selectNpmTestRuns([]);
    const firstRunStarted = deferred();
    const releaseFirstRun = deferred();
    let started: string[][] = [];
    const runCommand = async (npmArgs: string[]): Promise<{ code: number; signal: null }> => {
      started = [...started, npmArgs];
      if (started.length === 1) {
        firstRunStarted.resolve();
        await releaseFirstRun.promise;
      }
      return { code: 0, signal: null };
    };

    const execution = runNpmTest([], runCommand);
    await firstRunStarted.promise;

    expect(started).toEqual([runs[0]!.npmArgs]);

    releaseFirstRun.resolve();
    await execution;
    expect(started).toEqual(runs.map((run) => run.npmArgs));
  });

  it('should return the failing shard exit code from the unit suite entrypoint', async () => {
    const failureCode = 17;
    const runCommand = async (npmArgs: string[]): Promise<{ code: number; signal: null }> => ({
      code: npmArgs.includes('--shard=2/4') ? failureCode : 0,
      signal: null,
    });

    const code = await runNpmTest([], runCommand);

    expect(code).toBe(failureCode);
  });

  it('should route targeted integration tests to the IT runner', () => {
    const args = ['src/__tests__/it-acp-workflow-bridge.test.ts'];

    expect(hasIntegrationTestTarget(args)).toBe(true);
    expect(selectNpmTestRuns(args)).toEqual([
      { npmArgs: ['run', 'test:it:parallel', '--', ...args] },
    ]);
  });

  it('should keep targeted unit tests on the unit runner', () => {
    const args = ['src/__tests__/workflowExecutionEvents.test.ts'];

    expect(hasIntegrationTestTarget(args)).toBe(false);
    expect(selectNpmTestRuns(args)).toEqual([
      { npmArgs: ['run', 'test:unit:parallel', '--', ...args] },
    ]);
  });

  it('should split mixed unit and integration test targets across both runners', () => {
    const unitTarget = 'src/__tests__/acpAgent.test.ts';
    const integrationTarget = 'src/__tests__/it-acp-workflow-bridge.test.ts';

    expect(hasIntegrationTestTarget([unitTarget, integrationTarget])).toBe(true);
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

    expect(hasIntegrationTestTarget(args)).toBe(true);
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

    expect(hasIntegrationTestTarget([...sharedArgs, unitTarget, integrationTarget])).toBe(true);
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
