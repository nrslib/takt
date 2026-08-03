export function createPrimaryKey(resource) {
  return JSON.stringify([resource.tenantId, resource.jobId]);
}
