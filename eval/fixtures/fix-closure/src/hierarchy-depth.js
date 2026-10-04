export function countDirectWorkflowCalls(entries) {
  return entries.filter(({ kind }) => kind === 'workflow_call').length;
}

export function countWorkflowCalls(entries) {
  return entries.reduce(
    (total, entry) => total + 1 + countWorkflowCalls(entry.children ?? []),
    0,
  );
}

export function maxWorkflowCallDepth(entries, parentDepth = 0) {
  return entries.reduce(
    (maximum, entry) => Math.max(
      maximum,
      maxWorkflowCallDepth(entry.children ?? [], parentDepth + 1),
    ),
    parentDepth,
  );
}
