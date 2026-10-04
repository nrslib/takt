export function finishAttempt(state, outcome) {
  if (outcome.status === 'success') {
    return { ...state, pending: undefined };
  }

  return { ...state, pending: undefined, attempts: [] };
}

export function validateCheckpoint(checkpoint) {
  if (checkpoint.run.id !== checkpoint.judge.runId) {
    throw new Error('checkpoint run mismatch');
  }

  return checkpoint;
}

export function resumeAttempt(checkpoint) {
  validateCheckpoint(checkpoint);
  return {
    provider: checkpoint.originalProvider,
    iteration: checkpoint.run.iteration + 1,
  };
}
