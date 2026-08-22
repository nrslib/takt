export function withAttachmentCleanup<T extends object>(
  result: T,
  cleanupAttachments: () => void,
): T & { cleanupAttachments: () => void } {
  return {
    ...result,
    cleanupAttachments,
  };
}
