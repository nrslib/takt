export type EnvValueType = 'string' | 'boolean' | 'number' | 'json';

export interface EnvSpec {
  path: string;
  type: EnvValueType;
}

export interface LegacyEnvSpec {
  env: string;
  path: string;
  type: EnvValueType;
  blockedBy: readonly string[];
  warning: string;
}

function normalizeEnvSegment(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase();
}

export function envVarNameFromPath(path: string): string {
  const key = path
    .split('.')
    .map(normalizeEnvSegment)
    .filter((segment) => segment.length > 0)
    .join('_');
  return `TAKT_${key}`;
}

export function parseEnvValue(envKey: string, raw: string, type: EnvValueType): unknown {
  if (type === 'string') {
    return raw;
  }
  if (type === 'boolean') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    throw new Error(`${envKey} must be one of: true, false`);
  }
  if (type === 'number') {
    const trimmed = raw.trim();
    const value = Number(trimmed);
    if (!Number.isFinite(value)) {
      throw new Error(`${envKey} must be a number`);
    }
    return value;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${envKey} must be valid JSON`);
  }
}

export function setNestedConfigValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!part) continue;
    const next = current[part];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (!leaf) return;
  current[leaf] = value;
}
