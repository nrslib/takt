export const PROCESS_TREE_CLEANUP_GRACE_MS: number;

export function startProcessTreeCleanup(pid: number | undefined): Promise<void>;

export function terminateProcessTree(pid: number | undefined): Promise<void>;

export function terminateWindowsProcessTree(
  pid: number,
  executeFile: (file: string, args: readonly string[], options: { timeout: number }) => Promise<unknown>,
): Promise<void>;
