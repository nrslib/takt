import { resolveIdentity } from './identity-resolver.js';

export function createIdentityCard(resource) {
  try {
    const resolved = resolveIdentity(resource);
    if (resolved === null) return { card: null, note: 'identity not found' };
    return { card: `${resolved.tenantId}/${resolved.jobId}`, note: null };
  } catch (error) {
    return { card: null, note: error.message };
  }
}
