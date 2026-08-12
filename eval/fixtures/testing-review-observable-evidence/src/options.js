export function resolveOptions(raw) {
  const resolved = {};

  if (raw.traceLabel !== undefined) {
    resolved.traceLabel = raw.traceLabel.trim();
  }
  if (raw.timeoutMs !== undefined) {
    resolved.timeoutMs = raw.timeoutMs;
  }

  return resolved;
}
