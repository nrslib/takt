// Each remote task has its own process. Values registered here never affect the worker process.
let secrets: readonly string[] = [];

export function setExecutionSecrets(values: readonly string[]): void {
  secrets = [...new Set(values.filter((value) => value.length > 0))].sort((a, b) => b.length - a.length);
}

export function getExecutionSecrets(): readonly string[] { return [...secrets]; }

export function redactExecutionSecrets(text: string, values: readonly string[] = secrets): string {
  const representations = [...new Set(values.filter((value) => value.length > 0).flatMap((value) =>
    [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]))].sort((a, b) => b.length - a.length);
  if (representations.length === 0) return text;
  const pattern = new RegExp(representations.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  // A later storage boundary must not redact text inside an existing marker.
  return text.split('[REDACTED]').map((part) => part.replace(pattern, '[REDACTED]')).join('[REDACTED]');
}

/** Preserve JSON structure while redacting values before serialization. */
export function redactExecutionValue<T>(value: T): T {
  if (secrets.length === 0) return value;
  const serialized = JSON.stringify(value, (_key, entry: unknown) => typeof entry === 'string' ? redactExecutionSecrets(entry) : entry);
  return serialized === undefined ? value : JSON.parse(serialized) as T;
}
