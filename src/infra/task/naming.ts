export function nowIso(): string {
  return new Date().toISOString();
}

export function firstLine(content: string): string {
  return content.trim().split('\n')[0]?.slice(0, 80) ?? '';
}
