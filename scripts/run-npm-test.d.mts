/** One npm invocation the test gate runs, as `npm <args>`. */
export interface NpmTestRun {
  readonly npmArgs: readonly string[];
}

export function selectNpmTestRuns(args: readonly string[]): NpmTestRun[];
