export function resourceRecord(resource, state) {
  return { executionId: resource.jobId, state };
}
