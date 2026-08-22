export function resolveIdentity(resource) {
  if (resource.resolverResult === 'missing') return null;
  if (resource.resolverResult === 'error') throw new Error('identity resolver failed');
  return resource;
}
