export function createPublicKey(resource) {
  return `${resource.tenantId}${resource.jobId}`;
}
