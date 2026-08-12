export function telemetryLabel(raw: string): string {
  return raw.trim().replaceAll(' ', '_');
}
