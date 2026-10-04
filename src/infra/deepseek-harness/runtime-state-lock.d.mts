export interface DeepSeekRuntimeStateFileLock {
  retain(): void;
}
export const DEEPSEEK_RUNTIME_BUSY_MESSAGE: string;

export function withDeepSeekRuntimeStateFileLock<T>(
  stateDirectory: string,
  operation: (lock: DeepSeekRuntimeStateFileLock) => Promise<T>,
): Promise<T>;

export function assertDeepSeekRuntimeCreationAllowedLocked(
  stateDirectory: string,
  ownerDirectory: string,
  parentPid: number,
): Promise<void>;

export function markDeepSeekCleanupBarrierLocked(
  stateDirectory: string,
  ownerDirectory: string,
  unregisteredRuntimePid?: number,
): Promise<void>;
