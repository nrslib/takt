/**
 * Artifact assertions for the review-remediation fix eval.
 * The scenario passes only when every producer path preserves its own
 * attribution, the emitter rejects the obsolete implicit path, and every
 * lifecycle/checkpoint obligation in the finalized plan is closed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const workDir = resolve(dirname(fileURLToPath(import.meta.url)), '../.work/fix-closure');

async function load(path) {
  return import(`${pathToFileURL(join(workDir, path)).href}?eval=${Date.now()}`);
}

function runFixtureTests() {
  const result = spawnSync('npm', ['test'], {
    cwd: workDir,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  return result;
}

function fixtureTestsPassWith(replacements) {
  const originals = new Map();
  try {
    for (const [relativePath, source] of Object.entries(replacements)) {
      const path = join(workDir, relativePath);
      originals.set(path, readFileSync(path, 'utf8'));
      writeFileSync(path, source);
    }
    return runFixtureTests().status === 0;
  } finally {
    for (const [path, source] of originals) {
      writeFileSync(path, source);
    }
  }
}

const validEmitter = `export class ReportEmitter {
  emit(report, attribution) {
    if (attribution?.scope === undefined || attribution.iteration === undefined) {
      throw new Error('missing execution context');
    }
    return { report, scope: attribution.scope, iteration: attribution.iteration };
  }
}
`;

const validDirect = `export function emitDirect(emitter, report, context) {
  return emitter.emit(report, context);
}
`;

const validBatch = `export function emitBatch(emitter, entries) {
  return entries.map(({ report, context }) => emitter.emit(report, context));
}
`;

const validParallel = `export function prepareParallel(emitter, entries) {
  return entries.map(({ report, context }) => () => emitter.emit(report, context));
}
`;

const validRelay = `export function relayChildReport(emitter, _parentContext, childEvent) {
  return emitter.emit(childEvent.report, childEvent.context);
}
`;

const validAttemptState = `export function finishAttempt(state, outcome) {
  if (outcome.status === 'success') return { ...state, pending: undefined };
  return { ...state, pending: { ...state.pending }, attempts: [...state.attempts] };
}
export function validateCheckpoint(checkpoint) {
  if (checkpoint.run.id !== checkpoint.judge.runId) throw new Error('run mismatch');
  if (checkpoint.run.iteration !== checkpoint.judge.iteration) throw new Error('iteration mismatch');
  if (checkpoint.pending.stepIteration !== checkpoint.judge.stepIteration) throw new Error('step mismatch');
  if (checkpoint.attempts.at(-1) !== checkpoint.pending.provider) throw new Error('provider mismatch');
  return checkpoint;
}
export function resumeAttempt(checkpoint) {
  validateCheckpoint(checkpoint);
  return { provider: checkpoint.pending.provider, iteration: checkpoint.run.iteration };
}
`;

const validHierarchyDepth = `export function countDirectWorkflowCalls(entries) {
  return entries.filter(({ kind }) => kind === 'workflow_call').length;
}
export function countWorkflowCalls(entries) {
  return entries.reduce((total, entry) =>
    total + (entry.kind === 'workflow_call' ? 1 : 0) + countWorkflowCalls(entry.children ?? []), 0);
}
export function maxWorkflowCallDepth(entries, parentDepth = 0) {
  return entries.reduce((maximum, entry) => {
    const depth = parentDepth + (entry.kind === 'workflow_call' ? 1 : 0);
    return Math.max(maximum, depth, maxWorkflowCallDepth(entry.children ?? [], depth));
  }, parentDepth);
}
`;

function mutateAttemptState(search, replacement) {
  const mutated = validAttemptState.replace(search, replacement);
  if (mutated === validAttemptState) {
    throw new Error(`mutation template did not apply: ${search}`);
  }
  return { 'src/attempt-state.js': mutated };
}

function mutateHierarchyDepth(search, replacement) {
  const mutated = validHierarchyDepth.replace(search, replacement);
  if (mutated === validHierarchyDepth) {
    throw new Error(`hierarchy mutation template did not apply: ${search}`);
  }
  return { 'src/hierarchy-depth.js': mutated };
}

function durableTestChecks() {
  const validSolution = {
    'src/report-emitter.js': validEmitter,
    'src/direct.js': validDirect,
    'src/batch.js': validBatch,
    'src/parallel.js': validParallel,
    'src/relay.js': validRelay,
    'src/attempt-state.js': validAttemptState,
    'src/hierarchy-depth.js': validHierarchyDepth,
  };
  const validAlternativeAccepted = fixtureTestsPassWith(validSolution);
  const successClearLine = "if (outcome.status === 'success') return { ...state, pending: undefined };";
  const mutants = [
    ['emitter-fallback', { 'src/report-emitter.js': `export class ReportEmitter {
  emit(report, attribution) {
    attribution ??= { scope: 'fallback', iteration: 0 };
    return { report, scope: attribution.scope, iteration: attribution.iteration };
  }
}
` }],
    ['direct-context', { 'src/direct.js': `export function emitDirect(emitter, report, _context) {
  return emitter.emit(report, { scope: 'wrong', iteration: -1 });
}
` }],
    ['batch-context', { 'src/batch.js': `export function emitBatch(emitter, entries) {
  return entries.map(({ report }) => emitter.emit(report, entries[0].context));
}
` }],
    ['parallel-context', { 'src/parallel.js': `export function prepareParallel(emitter, entries) {
  const lastContext = entries.at(-1).context;
  return entries.map(({ report }) => () => emitter.emit(report, lastContext));
}
` }],
    ['relay-context', { 'src/relay.js': `export function relayChildReport(emitter, parentContext, childEvent) {
  return emitter.emit(childEvent.report, parentContext);
}
` }],
    ['success-clear', mutateAttemptState(
      successClearLine,
      "if (outcome.status === 'success') return { ...state };",
    )],
    ['error-preservation', mutateAttemptState(
      successClearLine,
      "if (outcome.status === 'success' || outcome.status === 'error') return { ...state, pending: undefined };",
    )],
    ['blocked-preservation', mutateAttemptState(
      successClearLine,
      "if (outcome.status === 'success' || outcome.status === 'blocked') return { ...state, pending: undefined };",
    )],
    ['run-id-validation', mutateAttemptState(
      "  if (checkpoint.run.id !== checkpoint.judge.runId) throw new Error('run mismatch');\n",
      '',
    )],
    ['iteration-validation', mutateAttemptState(
      "  if (checkpoint.run.iteration !== checkpoint.judge.iteration) throw new Error('iteration mismatch');\n",
      '',
    )],
    ['step-validation', mutateAttemptState(
      "  if (checkpoint.pending.stepIteration !== checkpoint.judge.stepIteration) throw new Error('step mismatch');\n",
      '',
    )],
    ['provider-validation', mutateAttemptState(
      "  if (checkpoint.attempts.at(-1) !== checkpoint.pending.provider) throw new Error('provider mismatch');\n",
      '',
    )],
    ['resume-provider', mutateAttemptState(
      'return { provider: checkpoint.pending.provider, iteration: checkpoint.run.iteration };',
      'return { provider: checkpoint.originalProvider, iteration: checkpoint.run.iteration };',
    )],
    ['resume-iteration', mutateAttemptState(
      'return { provider: checkpoint.pending.provider, iteration: checkpoint.run.iteration };',
      'return { provider: checkpoint.pending.provider, iteration: checkpoint.run.iteration + 1 };',
    )],
    ['direct-count-constant', mutateHierarchyDepth(
      "  return entries.filter(({ kind }) => kind === 'workflow_call').length;",
      '  return 1;',
    )],
    ['recursive-counts-wrappers', mutateHierarchyDepth(
      "total + (entry.kind === 'workflow_call' ? 1 : 0) + countWorkflowCalls(entry.children ?? [])",
      'total + 1 + countWorkflowCalls(entry.children ?? [])',
    )],
    ['depth-counts-wrappers', mutateHierarchyDepth(
      "const depth = parentDepth + (entry.kind === 'workflow_call' ? 1 : 0);",
      'const depth = parentDepth + 1;',
    )],
    ['max-depth-skips-siblings', mutateHierarchyDepth(
      `  return entries.reduce((maximum, entry) => {
    const depth = parentDepth + (entry.kind === 'workflow_call' ? 1 : 0);
    return Math.max(maximum, depth, maxWorkflowCallDepth(entry.children ?? [], depth));
  }, parentDepth);`,
      `  const entry = entries[0];
  if (entry === undefined) return parentDepth;
  const depth = parentDepth + (entry.kind === 'workflow_call' ? 1 : 0);
  return Math.max(depth, maxWorkflowCallDepth(entry.children ?? [], depth));`,
    )],
    ['max-depth-skips-wrapper-descendants', mutateHierarchyDepth(
      'maxWorkflowCallDepth(entry.children ?? [], depth)',
      "entry.kind === 'workflow_call' ? maxWorkflowCallDepth(entry.children ?? [], depth) : depth",
    )],
  ];
  const survivingMutants = mutants
    .filter(([, replacements]) => fixtureTestsPassWith({ ...validSolution, ...replacements }))
    .map(([name]) => name);
  return { validAlternativeAccepted, survivingMutants };
}

export default async function assertFixClosure() {
  try {
    const [
      { ReportEmitter },
      { emitDirect },
      { emitBatch },
      { prepareParallel },
      { relayChildReport },
      { finishAttempt, validateCheckpoint, resumeAttempt },
      { countDirectWorkflowCalls, countWorkflowCalls, maxWorkflowCallDepth },
      { reportAttributionContract, attemptLifecycleContract, hierarchyCountContract },
    ] = await Promise.all([
      load('src/report-emitter.js'),
      load('src/direct.js'),
      load('src/batch.js'),
      load('src/parallel.js'),
      load('src/relay.js'),
      load('src/attempt-state.js'),
      load('src/hierarchy-depth.js'),
      load('src/remediation-contract.js'),
    ]);
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

    const pending = { provider: 'secondary', stepIteration: 3 };
    const createAttemptState = () => ({ pending: { ...pending }, attempts: ['primary', 'secondary'] });
    const successInput = createAttemptState();
    const successSnapshot = globalThis.structuredClone(successInput);
    const succeededState = finishAttempt(successInput, { status: 'success' });
    const failedInput = createAttemptState();
    const failedSnapshot = globalThis.structuredClone(failedInput);
    const failedState = finishAttempt(failedInput, { status: 'error' });
    const blockedInput = createAttemptState();
    const blockedSnapshot = globalThis.structuredClone(blockedInput);
    const blockedState = finishAttempt(blockedInput, { status: 'blocked' });
    const validCheckpoint = {
      run: { id: 'run-1', iteration: 7 },
      judge: { runId: 'run-1', iteration: 7, stepIteration: 3 },
      pending,
      attempts: ['primary', 'secondary'],
      originalProvider: 'primary',
    };
    const rejectsCheckpoint = (override) => {
      try {
        validateCheckpoint({
          ...validCheckpoint,
          ...override,
          judge: { ...validCheckpoint.judge, ...override.judge },
        });
        return false;
      } catch {
        return true;
      }
    };
    const resumed = resumeAttempt(validCheckpoint);
    const hierarchy = [
      {
        kind: 'workflow_call',
        children: [],
      },
      {
        kind: 'system',
        children: [{
          kind: 'agent',
          children: [{
            kind: 'workflow_call',
            children: [{
              kind: 'agent',
              children: [{
                kind: 'workflow_call',
                children: [{ kind: 'workflow_call', children: [] }],
              }],
            }],
          }],
        }],
      },
    ];
    const testResult = runFixtureTests();
    const durable = durableTestChecks();
    const checks = [
      ['attribution-contract-preserved', isDeepStrictEqual(reportAttributionContract, {
        ambientContext: 'forbidden',
        missingContext: 'reject',
        producers: {
          direct: 'context',
          batch: 'entry.context',
          parallel: 'entry.context',
          relay: 'childEvent.context',
        },
        preserveProducerSignatures: true,
      })],
      ['attempt-contract-preserved', isDeepStrictEqual(attemptLifecycleContract, {
        completion: {
          success: 'clear-pending',
          error: 'preserve-pending',
          blocked: 'preserve-pending',
        },
        checkpointCorrelations: [
          ['run.id', 'judge.runId'],
          ['run.iteration', 'judge.iteration'],
          ['pending.stepIteration', 'judge.stepIteration'],
          ['attempts.tail', 'pending.provider'],
        ],
        resume: {
          provider: 'pending.provider',
          iteration: 'run.iteration',
        },
        mutateInput: false,
      })],
      ['hierarchy-contract-preserved', isDeepStrictEqual(hierarchyCountContract, {
        countedKind: 'workflow_call',
        paths: ['direct', 'recursive', 'max-depth'],
        nonCountedKinds: ['agent', 'system'],
      })],
      ['direct', isDeepStrictEqual(direct, { report: 'direct-a', ...contextA })],
      ['batch', isDeepStrictEqual(batch, [
        { report: 'batch-a', ...contextA },
        { report: 'batch-b', ...contextB },
      ])],
      ['parallel', isDeepStrictEqual(parallel, [
        { report: 'parallel-b', ...contextB },
        { report: 'parallel-a', ...contextA },
      ])],
      ['relay', isDeepStrictEqual(relayed, { report: 'child-b', ...contextB })],
      ['missing-attribution-rejected', missingAttributionRejected],
      ['obsolete-context-api-removed', !('setActiveContext' in ReportEmitter.prototype)],
      ['obsolete-context-state-removed', !Object.hasOwn(emitter, 'activeContext')],
      ['success-clears-pending', succeededState.pending === undefined],
      ['success-preserves-attempts', isDeepStrictEqual(succeededState.attempts, successSnapshot.attempts)],
      ['success-does-not-mutate-input', isDeepStrictEqual(successInput, successSnapshot)],
      ['error-preserves-state', isDeepStrictEqual(failedState, failedSnapshot)],
      ['error-does-not-mutate-input', isDeepStrictEqual(failedInput, failedSnapshot)],
      ['blocked-preserves-state', isDeepStrictEqual(blockedState, blockedSnapshot)],
      ['blocked-does-not-mutate-input', isDeepStrictEqual(blockedInput, blockedSnapshot)],
      ['run-id-mismatch-rejected', rejectsCheckpoint({ judge: { runId: 'run-2' } })],
      ['judge-iteration-mismatch-rejected', rejectsCheckpoint({ judge: { iteration: 8 } })],
      ['step-iteration-mismatch-rejected', rejectsCheckpoint({ judge: { stepIteration: 4 } })],
      ['provider-tail-mismatch-rejected', rejectsCheckpoint({ attempts: ['primary', 'other'] })],
      ['resume-keeps-provider', resumed.provider === pending.provider],
      ['resume-keeps-iteration', resumed.iteration === validCheckpoint.run.iteration],
      ['direct-call-count-zero', countDirectWorkflowCalls(hierarchy.slice(1)) === 0],
      ['direct-call-count', countDirectWorkflowCalls(hierarchy) === 1],
      ['direct-call-count-multiple', countDirectWorkflowCalls([
        ...hierarchy,
        { kind: 'workflow_call', children: [] },
      ]) === 2],
      ['recursive-call-count', countWorkflowCalls(hierarchy) === 4],
      ['maximum-call-depth', maxWorkflowCallDepth(hierarchy) === 3],
      ['durable-regression-tests-pass', testResult.status === 0],
      ['tests-accept-valid-alternative', durable.validAlternativeAccepted],
      ['tests-kill-each-obligation-mutant', durable.survivingMutants.length === 0],
    ];
    const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
    return {
      pass: failed.length === 0,
      score: (checks.length - failed.length) / checks.length,
      reason: failed.length === 0
        ? 'all defect-family paths are closed'
        : `failed: ${failed.join(', ')}; surviving mutants: ${durable.survivingMutants.join(', ') || 'none'}`,
    };
  } catch (error) {
    return {
      pass: false,
      score: 0,
      reason: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  }
}
