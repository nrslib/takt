import { runCentralWorkerFromEnvironment } from './central-worker.js';

void runCentralWorkerFromEnvironment().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
