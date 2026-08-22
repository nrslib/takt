export function withProbeWorkspace<T>(
  parentDirectory: string,
  prefix: string,
  run: (workspace: string) => Promise<T>,
): Promise<T>;
