/** One npm invocation the test gate runs, as `npm <args>`. */
export interface NpmTestRun {
  readonly npmArgs: readonly string[];
}

interface NpmTestCommandResult {
  readonly code: number;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}

interface ExecutedNpmTestRun {
  readonly run: NpmTestRun;
  readonly index: number;
  readonly result: NpmTestCommandResult;
}

type NpmTestCommand = (
  npmArgs: readonly string[],
) => Promise<NpmTestCommandResult>;

export function resolveLocalUnitShardCount(availableParallelismCount: number): number;
export function selectNpmTestRuns(
  args: readonly string[],
  unitShardCount?: number,
): NpmTestRun[];
export function executeNpmTestRuns(
  runs: readonly NpmTestRun[],
  runCommand: NpmTestCommand,
): Promise<ExecutedNpmTestRun[]>;
export function runNpmTest(
  args: readonly string[],
  runCommand?: NpmTestCommand,
  unitShardCount?: number,
): Promise<number>;
