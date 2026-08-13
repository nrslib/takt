export function buildRequeuePlan({ resumeValue, failedLeafValue, firstLeafValue }) {
  const options = [];
  if (resumeValue !== undefined) {
    options.push({ value: resumeValue, kind: 'resume', preservesCheckpoint: true });
  }
  if (failedLeafValue !== undefined) {
    options.push({ value: failedLeafValue, kind: 'restart', preservesCheckpoint: false });
  }
  if (firstLeafValue !== undefined && firstLeafValue !== failedLeafValue) {
    options.push({ value: firstLeafValue, kind: 'restart', preservesCheckpoint: false });
  }

  return {
    options,
    defaultValue: resumeValue ?? failedLeafValue ?? firstLeafValue,
  };
}

export function persistRequeue(task, selection) {
  if (selection.kind === 'restart') {
    return {
      ...task,
      status: 'pending',
      restartPoint: selection.value,
      resumePoint: undefined,
    };
  }

  return {
    ...task,
    status: 'pending',
    restartPoint: undefined,
    resumePoint: selection.value,
  };
}

export function claimPendingTask(task) {
  if (task.status !== 'pending') {
    throw new Error('Only pending tasks can be claimed');
  }

  return {
    ...task,
    status: 'running',
  };
}

export function resolveFreshStart(task) {
  return {
    startStep: task.restartPoint ?? task.startStep,
    freshExecution: task.restartPoint !== undefined,
  };
}
