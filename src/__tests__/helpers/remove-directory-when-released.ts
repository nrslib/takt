const REMOVAL_RETRY_DELAY_MS = 20;
const REMOVAL_TIMEOUT_MS = 5_000;

export async function removeDirectoryWhenReleased(removeDirectory: () => void): Promise<void> {
  const deadline = Date.now() + REMOVAL_TIMEOUT_MS;
  while (true) {
    try {
      removeDirectory();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, REMOVAL_RETRY_DELAY_MS));
    }
  }
}
