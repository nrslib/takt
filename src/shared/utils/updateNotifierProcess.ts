import { fileURLToPath } from 'node:url';

const UPDATE_CHECK_WORKER_PATH = fileURLToPath(
  new URL('./updateNotifierWorker.js', import.meta.url),
);
export const UPDATE_NOTIFIER_DISABLED_ARG = '--no-update-notifier';

export function resolveUpdateCheckWorkerArgs(): string[] {
  return process.argv.includes(UPDATE_NOTIFIER_DISABLED_ARG)
    ? [UPDATE_CHECK_WORKER_PATH, UPDATE_NOTIFIER_DISABLED_ARG]
    : [UPDATE_CHECK_WORKER_PATH];
}
