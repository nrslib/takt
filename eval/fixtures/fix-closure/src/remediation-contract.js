export const reportAttributionContract = Object.freeze({
  ambientContext: 'forbidden',
  missingContext: 'reject',
  producers: Object.freeze({
    direct: 'context',
    batch: 'entry.context',
    parallel: 'entry.context',
    relay: 'childEvent.context',
  }),
  preserveProducerSignatures: true,
});

export const attemptLifecycleContract = Object.freeze({
  completion: Object.freeze({
    success: 'clear-pending',
    error: 'preserve-pending',
    blocked: 'preserve-pending',
  }),
  checkpointCorrelations: Object.freeze([
    Object.freeze(['run.id', 'judge.runId']),
    Object.freeze(['run.iteration', 'judge.iteration']),
    Object.freeze(['pending.stepIteration', 'judge.stepIteration']),
    Object.freeze(['attempts.tail', 'pending.provider']),
  ]),
  resume: Object.freeze({
    provider: 'pending.provider',
    iteration: 'run.iteration',
  }),
  mutateInput: false,
});

export const hierarchyCountContract = Object.freeze({
  countedKind: 'workflow_call',
  paths: Object.freeze(['direct', 'recursive', 'max-depth']),
  nonCountedKinds: Object.freeze(['agent', 'system']),
});
