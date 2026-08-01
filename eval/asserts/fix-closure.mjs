/**
 * Artifact assertions for the review-remediation fix eval.
 * The scenario passes only when every producer path preserves its own
 * attribution and the emitter rejects the obsolete implicit path.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const workDir = resolve(dirname(fileURLToPath(import.meta.url)), '../.work/fix-closure');

async function load(path) {
  return import(`${pathToFileURL(join(workDir, path)).href}?eval=${Date.now()}`);
}

export default async function assertFixClosure() {
  try {
    const [{ ReportEmitter }, { emitDirect }, { emitBatch }, { prepareParallel }, { relayChildReport }] = await Promise.all([
      load('src/report-emitter.js'),
      load('src/direct.js'),
      load('src/batch.js'),
      load('src/parallel.js'),
      load('src/relay.js'),
    ]);
    const source = readFileSync(join(workDir, 'src/report-emitter.js'), 'utf8');
    const emitter = new ReportEmitter({ scope: 'legacy', iteration: 99 });
    const contextA = { scope: 'scope-a', iteration: 1 };
    const contextB = { scope: 'scope-b', iteration: 2 };

    const direct = emitDirect(emitter, 'direct-a', contextA);
    const batch = emitBatch(emitter, [
      { report: 'batch-a', context: contextA },
      { report: 'batch-b', context: contextB },
    ]);
    const deferred = prepareParallel(emitter, [
      { report: 'parallel-a', context: contextA },
      { report: 'parallel-b', context: contextB },
    ]);
    const parallel = [deferred[1](), deferred[0]()];
    const relayed = relayChildReport(emitter, contextA, { report: 'child-b', context: contextB });

    let missingAttributionRejected = false;
    try {
      emitter.emit('missing');
    } catch {
      missingAttributionRejected = true;
    }

    const hasAttribution = (event, expected) =>
      event?.scope === expected.scope && event?.iteration === expected.iteration;
    const checks = [
      ['direct', hasAttribution(direct, contextA)],
      ['batch', hasAttribution(batch[0], contextA) && hasAttribution(batch[1], contextB)],
      ['parallel', hasAttribution(parallel[0], contextB) && hasAttribution(parallel[1], contextA)],
      ['relay', hasAttribution(relayed, contextB)],
      ['missing-attribution-rejected', missingAttributionRejected],
      ['mutable-fallback-removed', !/setActiveContext|activeContext|attribution\?\./.test(source)],
    ];
    const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
    return {
      pass: failed.length === 0,
      score: (checks.length - failed.length) / checks.length,
      reason: failed.length === 0 ? 'all defect-family paths are closed' : `failed: ${failed.join(', ')}`,
    };
  } catch (error) {
    return {
      pass: false,
      score: 0,
      reason: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  }
}
