import type { SelectorGitCommandRunner } from './selector-git-command-runner.js';

const TAKT_RUN_PATH_PREFIX = '.takt/runs/';

export interface SelectorInputs {
  readonly reportDirectory: string;
  readonly reportNames: readonly string[];
  readonly changedPaths: readonly string[];
}

export class SelectorInputReader {
  constructor(private readonly commandRunner: SelectorGitCommandRunner) {}

  async readInputs(
    reportDirectory: string,
    requestedNames: readonly string[],
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<SelectorInputs> {
    signal?.throwIfAborted();
    const changedPaths = await this.readChangedPaths(cwd, signal);
    signal?.throwIfAborted();
    return {
      reportDirectory,
      reportNames: [...new Set(requestedNames)],
      changedPaths,
    };
  }

  private async readChangedPaths(
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<readonly string[]> {
    signal?.throwIfAborted();
    if (await this.commandRunner.isInsideWorkTree?.(cwd, signal) === false) {
      return [];
    }
    const trackedPaths = (await this.listGitPaths(
      cwd,
      ['diff', '--name-only', '-z', 'HEAD', '--end-of-options', '--', '.'],
      signal,
    )).filter((path) => !path.startsWith(TAKT_RUN_PATH_PREFIX));
    const untrackedPaths = (await this.listGitPaths(
      cwd,
      ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'],
      signal,
    )).filter((path) => !path.startsWith(TAKT_RUN_PATH_PREFIX));
    signal?.throwIfAborted();
    return [...new Set([...trackedPaths, ...untrackedPaths])].sort();
  }

  private async listGitPaths(
    cwd: string,
    args: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<string[]> {
    const result = await this.commandRunner.run(
      cwd,
      args,
      undefined,
      signal,
    );
    signal?.throwIfAborted();
    return result.output.toString('utf-8').split('\0').filter((path) => path !== '');
  }
}
