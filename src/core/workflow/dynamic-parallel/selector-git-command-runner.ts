export interface SelectorGitOutput {
  readonly output: Buffer;
  readonly bytes: number;
}

export interface SelectorGitCommandRunner {
  isInsideWorkTree?(cwd: string, signal: AbortSignal | undefined): Promise<boolean>;
  run(
    cwd: string,
    args: readonly string[],
    captureLimit: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<SelectorGitOutput>;
}
