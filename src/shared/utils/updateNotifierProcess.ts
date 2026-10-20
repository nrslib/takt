import { fileURLToPath } from 'node:url';

const UPDATE_CHECK_WORKER_PATH = fileURLToPath(
  new URL(import.meta.url.endsWith('.ts') ? './updateNotifierWorker.ts' : './updateNotifierWorker.js', import.meta.url),
);
export const UPDATE_NOTIFIER_DISABLED_ARG = '--no-update-notifier';

export function resolveUpdateCheckWorkerArgs(): string[] {
  return [
    ...(import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : []),
    UPDATE_CHECK_WORKER_PATH,
    ...(process.argv.includes(UPDATE_NOTIFIER_DISABLED_ARG) ? [UPDATE_NOTIFIER_DISABLED_ARG] : []),
  ];
}
