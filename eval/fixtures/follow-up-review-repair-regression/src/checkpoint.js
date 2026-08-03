export function serializeCheckpoint(resource) {
  return JSON.stringify({ jobId: resource.jobId });
}

export function restoreCheckpoint(serialized) {
  return JSON.parse(serialized);
}
