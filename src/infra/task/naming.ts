export function nowIso(): string {
  return new Date().toISOString();
}

export function firstLine(content: string): string {
  return content.trim().split('\n')[0]?.slice(0, 80) ?? '';
}

export function sanitizeTaskName(base: string): string {
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

  if (!normalized) {
    return `task-${Date.now()}`;
  }

  return normalized;
}
