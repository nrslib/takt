import { isAbsolute, posix } from 'node:path';

export const FINDING_CONTRACT_LITERAL_PATH_PATTERN = String.raw`^[^*?]+$`;

const findingContractLiteralPathPattern = new RegExp(FINDING_CONTRACT_LITERAL_PATH_PATTERN);

export function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireExactKeys(value: Record<string, unknown>, label: string, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unknownKey = Object.keys(value).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    throw new Error(`${label} contains unknown property "${unknownKey}"`);
  }
}

export function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function requireBoundedString(value: unknown, label: string, maxLength: number): string {
  const parsed = requireNonEmptyString(value, label);
  if (parsed.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters`);
  }
  return parsed;
}

export function requireStringArray(
  value: unknown,
  label: string,
  options?: { nonEmpty?: boolean; maxItems?: number; maxItemLength?: number },
): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (options?.maxItems !== undefined && value.length > options.maxItems) {
    throw new Error(`${label} exceeds ${options.maxItems} items`);
  }
  const values = value.map((entry, index) => options?.maxItemLength === undefined
    ? requireNonEmptyString(entry, `${label}[${index}]`)
    : requireBoundedString(entry, `${label}[${index}]`, options.maxItemLength));
  if (options?.nonEmpty === true && values.length === 0) throw new Error(`${label} must not be empty`);
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
  return values;
}

export function normalizeFindingContractPath(value: string, label: string): string {
  if (!findingContractLiteralPathPattern.test(value)) {
    throw new Error(`${label} must not contain wildcard characters "*" or "?": ${value}`);
  }
  const portable = value.replaceAll('\\', '/');
  if (isAbsolute(value) || posix.isAbsolute(portable) || /^[A-Za-z]:\//.test(portable)) {
    throw new Error(`${label} must be relative to the working directory: ${value}`);
  }
  const normalized = posix.normalize(portable);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} must not leave the working directory: ${value}`);
  }
  if (normalized === '.' || normalized === './') return '.';
  return normalized.replace(/^\.\//, '').replace(/\/+$/, '');
}

export function findingContractPathsOverlap(left: string, right: string): boolean {
  if (left === '.' || right === '.') return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function findingContractPathIsWithin(path: string, parent: string): boolean {
  if (parent === '.') return true;
  return path === parent || path.startsWith(`${parent}/`);
}
