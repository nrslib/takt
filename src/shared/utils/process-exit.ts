export function formatProcessExitCause(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (code !== null) {
    return `code ${code}`;
  }
  if (signal !== null) {
    return `signal ${signal}`;
  }
  return 'no exit code or signal';
}
