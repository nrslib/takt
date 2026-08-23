export function normalizeMode(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized !== 'local' && normalized !== 'cloud') {
    throw new Error('Unsupported mode');
  }
  return normalized;
}
