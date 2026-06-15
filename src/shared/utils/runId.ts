export function generateRunId(): string {
  const now = new Date();
  const pad = (n: number, len: number): string => String(n).padStart(len, '0');
  return `run-${pad(now.getFullYear(), 4)}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}-${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;
}
