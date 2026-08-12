export function normalizeRequestToken(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeTelemetryLabel(value: string): string {
  return value.trim().replaceAll(' ', '_');
}
