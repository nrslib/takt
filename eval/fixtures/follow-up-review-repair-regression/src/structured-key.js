export function encodeStructuredKey(resource) {
  return JSON.stringify({ tenantId: resource.tenantId, jobId: resource.jobId });
}

export function decodeStructuredKey(serialized) {
  return JSON.parse(serialized);
}
