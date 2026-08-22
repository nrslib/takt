export function normalizeChannel(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized !== 'local' && normalized !== 'cloud') {
    throw new Error('Unsupported channel');
  }
  return normalized;
}
