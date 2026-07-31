export interface SelectorGitOutput {
  readonly output: Buffer;
  readonly bytes: number;
}

export interface SelectorGitCommandRunner {
  run(
    cwd: string,
    args: readonly string[],
    captureLimit: number,
    signal: AbortSignal | undefined,
  ): Promise<SelectorGitOutput>;
}
