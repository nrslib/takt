/** What one npm invocation reported back to the release gate. */
export interface ReleaseCommandResult {
  readonly code: number;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}

export const RELEASE_GATE_SCRIPTS: readonly string[];
export const RELEASE_LOG_RELATIVE_PATH: string;

export function runReleaseCheck(
  runCommand?: (npmArgs: readonly string[], logStream: NodeJS.WritableStream) => Promise<ReleaseCommandResult>,
  openLog?: () => Promise<NodeJS.WritableStream>,
): Promise<number>;
