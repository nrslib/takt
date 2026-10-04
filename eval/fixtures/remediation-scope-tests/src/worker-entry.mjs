export function workerEntry(mode) {
  return mode === 'source' ? './output/worker.mjs' : './output/worker.mjs';
}
