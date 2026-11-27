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
  lock: DeepSeekRuntimeStateFileLock,
): Promise<void>;

export function validateDeepSeekRuntimeCleanup(
  stateDirectory: string,
  cleanupPaths: string[],
  cleanupConfirmationPath?: string,
  cleanupRoot?: string,
): { cleanupPaths: string[]; cleanupConfirmationPath?: string; cleanupRoot?: string };

export function cleanupDeepSeekRuntimeResources(
  stateDirectory: string,
  cleanupPaths: string[],
  cleanupConfirmationPath?: string,
  cleanupRoot?: string,
): Promise<void>;

/**
 * Acknowledge cleanup (`true`), report a live owned group (`false`), an unowned blocking barrier (`null`),
 * or the absence of both owner and receipt (`undefined`).
 */
export function acknowledgeDeepSeekRuntimeCleanup(
  stateDirectory: string,
  ownerDirectory: string,
  cleanupConfirmationPath: string,
): Promise<boolean | undefined | null>;

export function markDeepSeekCleanupBarrierLocked(
  stateDirectory: string,
  ownerDirectory: string,
  unregisteredRuntimePid?: number,
): Promise<void>;
