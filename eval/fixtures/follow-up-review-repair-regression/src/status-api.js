export function statusResponse(resource, state) {
  return { executionId: resource.jobId, state };
}
